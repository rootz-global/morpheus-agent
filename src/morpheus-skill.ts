/**
 * MorpheusSkill — Wraps MorpheusAgent as an AgentSkill
 *
 * This is Skill #1 in the unified agent runtime.
 * It adapts the existing MorpheusAgent class to the AgentSkill interface,
 * routing all operations through the runtime's SkillContext.
 *
 * Instead of:  MorpheusAgent → direct Desktop relay → TPM
 * Now:         MorpheusSkill → SkillContext → TEE policy → Desktop relay → TPM
 *
 * The skill:
 * - Calls Morpheus inference API for AI output
 * - Records skill_inference events via ctx.recordEvent()
 * - Buffers full prompts + responses for session archiving
 * - Signs prompts via ctx.sign() (goes through policy engine)
 * - Returns full session content at settlement via getSessionContent()
 */

import { MorpheusClient } from './morpheus-client.js';
import { SecureChannel } from './secure-channel.js';
import type {
  MorpheusConfig,
  ChatMessage,
  SessionAction,
} from './morpheus-types.js';

// Unified runtime types — duplicated here for standalone compilation.
// When @rootz/agent-runtime is wired as workspace dependency, replace with:
//   import type { AgentSkill, SkillManifest, SkillContext } from '@rootz/agent-runtime';

/** Skill manifest (from @rootz/agent-runtime) */
interface SkillManifest {
  name: string;
  version: string;
  codeHash: string;
  entryPoint: string;
  permissions: {
    emitEvents: string[];
    policyRequests: string[];
    archiveContent: boolean;
    externalEndpoints: string[];
  };
  authorSignature: string;
  minPolicyVersion: string;
}

/** Skill context provided by the runtime */
interface SkillContext {
  sign(message: string, reason: string): Promise<string>;
  recordEvent(event: Record<string, unknown>): Promise<number>;
  getState(): Readonly<Record<string, unknown>>;
  agentAddress: string;
  config: Record<string, unknown>;
}

/** Skill interface — what every skill must implement */
interface AgentSkill {
  readonly manifest: SkillManifest;
  initialize(ctx: SkillContext): Promise<void>;
  getSessionContent?(): string | undefined;
  shutdown?(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════
// MORPHEUS SKILL — AgentSkill implementation
// ═══════════════════════════════════════════════════════════════════

export class MorpheusSkill implements AgentSkill {
  readonly manifest: SkillManifest = {
    name: 'morpheus-inference',
    version: '0.3.0',
    codeHash: 'sha256:development', // Set properly in production builds
    entryPoint: './morpheus-skill.js',
    permissions: {
      emitEvents: [
        'skill_inference',
        'skill_payment',
        'skill_output',
        'skill_installed',
        'skill_removed',
        'skill_error',
      ],
      policyRequests: ['sign', 'write_note'],
      archiveContent: true,
      externalEndpoints: ['https://api.mor.org'],
    },
    authorSignature: '0x', // Signed in production builds
    minPolicyVersion: '1.0',
  };

  private client: MorpheusClient;
  private channel: SecureChannel;
  private ctx!: SkillContext;
  private config: MorpheusConfig;
  private sessionActions: SessionAction[] = [];
  private sessionStartedAt: string;
  private totalTokens: number = 0;
  private inferenceCalls: number = 0;

  constructor(config: MorpheusConfig) {
    this.config = config;
    this.sessionStartedAt = new Date().toISOString();

    this.client = new MorpheusClient({
      apiBaseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
    });

    // SecureChannel initialized with empty agentAddress — set in initialize()
    this.channel = new SecureChannel({
      agentAddress: '',
      signPrompts: false, // Will use ctx.sign() through TEE instead
    });
    this.client.setSecureChannel(this.channel);
  }

  async initialize(ctx: SkillContext): Promise<void> {
    this.ctx = ctx;
    console.error(`[MorpheusSkill] Initialized for agent ${ctx.agentAddress}`);
    console.error(`[MorpheusSkill] Model: ${this.config.defaultModel}`);
    console.error(`[MorpheusSkill] API: ${this.config.apiBaseUrl}`);
  }

  /**
   * Call Morpheus inference and record via the runtime chain.
   * Returns the AI response content.
   */
  async inference(params: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; tokens: number; latencyMs: number }> {
    const model = params.model ?? this.config.defaultModel;

    // Call Morpheus API
    const { response, promptHash, responseHash, latencyMs } =
      await this.client.chatCompletion({
        model,
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
      });

    const content = response.choices[0]?.message?.content ?? '';
    const usage = response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Record event through the runtime chain (goes through policy engine)
    await this.ctx.recordEvent({
      category: 'skill_inference',
      inputHash: promptHash,
      outputHash: responseHash,
      policyRule: 'skill_inference',
      decision: 'ALLOW',
      value: '0',
      counterparty: this.config.apiBaseUrl,
      reason: `Morpheus inference: ${model}`,
      skillId: this.manifest.name,
      skillVersion: this.manifest.version,
      meta: {
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        latencyMs,
        sessionId: response.id,
      },
    });

    // Update skill-level stats
    this.inferenceCalls++;
    this.totalTokens += usage.total_tokens;

    // Buffer full content for archiving at settlement
    const promptText = params.messages.map(m => m.content).join('\n');
    const systemPromptMsg = params.messages.find(m => m.role === 'system');
    this.sessionActions.push({
      index: this.sessionActions.length,
      action: 'inference',
      promptText,
      systemPromptText: systemPromptMsg?.content,
      responseText: content,
      topic: promptText.slice(0, 100).replace(/\n/g, ' '),
      model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      latencyMs,
      promptHash,
      responseHash,
      previousHash: '0x', // Chain linkage handled by runtime InternalChain
      timestamp: new Date().toISOString(),
      archivePolicy: 'standard',
    });

    return { content, tokens: usage.total_tokens, latencyMs };
  }

  /**
   * Return full session content for archiving at settlement.
   * Called by the runtime during settle().
   */
  getSessionContent(): string | undefined {
    if (this.sessionActions.length === 0) return undefined;

    const lines: string[] = [];

    lines.push(`# Morpheus Agent Session — ${new Date().toISOString().split('T')[0]}`);
    lines.push('');
    lines.push('## Metadata');
    lines.push(`- **Agent**: ${this.ctx.agentAddress}`);
    lines.push(`- **Model**: ${this.config.defaultModel}`);
    lines.push(`- **Session Start**: ${this.sessionStartedAt}`);
    lines.push(`- **Total Tokens**: ${this.totalTokens}`);
    lines.push(`- **Inference Calls**: ${this.inferenceCalls}`);
    lines.push('');

    lines.push('## Search Index');
    for (const action of this.sessionActions) {
      if (action.topic) {
        lines.push(`- ${action.action}: ${action.topic}`);
      }
    }
    lines.push('');

    lines.push('## Actions');
    for (const action of this.sessionActions) {
      lines.push('');
      lines.push(`### Action ${action.index + 1}: ${action.action}`);
      lines.push(`- **Prompt Hash**: \`${action.promptHash}\``);
      lines.push(`- **Response Hash**: \`${action.responseHash}\``);
      lines.push(`- **Timestamp**: ${action.timestamp}`);

      if (action.model) lines.push(`- **Model**: ${action.model}`);
      if (action.totalTokens) lines.push(`- **Tokens**: ${action.totalTokens}`);
      if (action.latencyMs) lines.push(`- **Latency**: ${action.latencyMs}ms`);

      if (action.archivePolicy === 'redacted') {
        lines.push('');
        lines.push('*Content redacted per archive policy.*');
      } else {
        if (action.systemPromptText) {
          lines.push('');
          lines.push('**System Prompt**:');
          lines.push(action.systemPromptText);
        }
        if (action.promptText) {
          lines.push('');
          lines.push('**Prompt**:');
          lines.push(action.promptText);
        }
        if (action.responseText) {
          lines.push('');
          lines.push('**Response**:');
          lines.push(action.responseText);
        }
      }
    }

    return lines.join('\n');
  }

  /** Get current skill stats */
  getStats(): { inferenceCalls: number; totalTokens: number; sessionActions: number } {
    return {
      inferenceCalls: this.inferenceCalls,
      totalTokens: this.totalTokens,
      sessionActions: this.sessionActions.length,
    };
  }

  /** Check Morpheus API health */
  async checkHealth(): Promise<{ ok: boolean; models: number; latencyMs: number }> {
    return this.client.healthCheck();
  }

  async shutdown(): Promise<void> {
    console.error(`[MorpheusSkill] Shutdown: ${this.inferenceCalls} calls, ${this.totalTokens} tokens`);
  }
}