/**
 * Morpheus Agent — Core Lifecycle
 *
 * The agent IS a data wallet. This module manages:
 *   CREATE  — derive key, create Sovereign Secret, write birth certificate
 *   WORK    — call Morpheus inference, log action Notes, write outputs
 *   WATCH   — poll Sovereign Secret for incoming Notes (code, policy, revocation)
 *   SETTLE  — compute Merkle root of session, write settlement Note
 *
 * All signing goes through Desktop V6 relay (production) or local key (dev).
 * All Notes go through @rootz/notes NoteManager with V7 auto-funding.
 */

import { createHash } from 'node:crypto';
import { MorpheusClient } from './morpheus-client.js';
import { SecureChannel } from './secure-channel.js';
import type {
  MorpheusConfig,
  MorpheusAgentState,
  BirthCertificate,
  ActionNote,
  InferenceAction,
  PaymentAction,
  OutputAction,
  SkillInstalledAction,
  ErrorAction,
  SettlementNote,
  CodeDeliveryNote,
  PolicyUpdateNote,
  RevocationNote,
  IncomingNote,
  ChatMessage,
  SecuredInferenceRecord,
  SessionAction,
} from './morpheus-types.js';

// ═══════════════════════════════════════════════════════════════════
// DESKTOP RELAY — Proxy signing to Desktop V6 TPM
// ═══════════════════════════════════════════════════════════════════

/**
 * Call a Desktop V6 MCP tool via HTTP relay.
 * In production, Desktop holds the TPM key and signs on behalf of the agent.
 */
async function callDesktopRelay(
  relayUrl: string,
  sessionToken: string,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const res = await globalThis.fetch(`${relayUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'tools/call',
      params: { name: tool, arguments: { ...args, sessionToken } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Desktop relay error: ${res.status} ${res.statusText}`);
  }
  const result = await res.json() as { content?: Array<{ text: string }> };
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : result;
}

// ═══════════════════════════════════════════════════════════════════
// MORPHEUS AGENT
// ═══════════════════════════════════════════════════════════════════

export class MorpheusAgent {
  private readonly config: MorpheusConfig;
  private readonly client: MorpheusClient;
  private readonly channel: SecureChannel;
  private state: MorpheusAgentState;
  private watchInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: MorpheusConfig) {
    this.config = config;
    this.client = new MorpheusClient({
      apiBaseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
    });

    // Initialize SecureChannel — every inference call goes through this
    this.channel = new SecureChannel({
      agentAddress: '', // Set after createAgent
      signPrompts: config.keySource === 'relay',
      relayUrl: config.relayUrl,
      sessionToken: process.env.AGENT_SESSION_TOKEN,
    });
    this.client.setSecureChannel(this.channel);
    this.state = {
      initialized: false,
      agentAddress: '',
      sovereignSecretAddress: config.sovereignSecretAddress,
      currentPolicy: { dailyAllowance: 0, currency: 'MOR', models: [], scope: '' },
      lastNoteHash: '0x' + '0'.repeat(64), // Genesis — no previous hash
      sessionNoteCount: 0,
      sessionInferenceCalls: 0,
      sessionTotalTokens: 0,
      installedSkills: new Map(),
      revoked: false,
      sessionActions: [],
      sessionStartedAt: new Date().toISOString(),
      defaultArchivePolicy: 'standard',
    };
  }

  // ─── CREATE ────────────────────────────────────────────────────

  /**
   * Create a new agent with a birth certificate.
   *
   * In relay mode, Desktop V6 derives the key and creates the Secret.
   * In local mode, uses provided key directly.
   *
   * Returns the birth certificate that was written as Note 0.
   */
  async createAgent(params: {
    agentAddress: string;
    derivationPath: string;
    model: string;
    providerAddress?: string;
    authorizerAddress: string;
    authorizerName?: string;
    authorizerSignature: string;
    policy: BirthCertificate['policy'];
    keyProtection?: BirthCertificate['keyProtection'];
  }): Promise<BirthCertificate> {
    const birthCert: BirthCertificate = {
      type: 'morpheus-birth-certificate',
      version: '1.0',
      agent: {
        address: params.agentAddress,
        derivationPath: params.derivationPath,
        created: new Date().toISOString(),
      },
      parents: {
        ai: {
          factory: 'morpheus',
          model: params.model,
          provider: params.providerAddress,
          apiEndpoint: this.config.apiBaseUrl,
        },
        authorizer: {
          address: params.authorizerAddress,
          name: params.authorizerName,
          signature: params.authorizerSignature,
        },
      },
      policy: params.policy,
      nistLevel: params.keyProtection === 'tpm-sealed' ? 2 : 1,
      keyProtection: params.keyProtection ?? 'software',
    };

    // Write birth certificate as Note 0 on the Sovereign Secret
    await this.writeNote(JSON.stringify(birthCert));

    // Update state
    this.state.agentAddress = params.agentAddress;
    this.state.currentPolicy = params.policy;
    this.state.initialized = true;

    console.error(`[Morpheus] Agent created: ${params.agentAddress}`);
    console.error(`[Morpheus] Birth certificate written to ${this.state.sovereignSecretAddress}`);
    console.error(`[Morpheus] Parents — AI: morpheus/${params.model}, Authorizer: ${params.authorizerAddress}`);

    return birthCert;
  }

  // ─── WORK ──────────────────────────────────────────────────────

  /**
   * Call Morpheus inference and log the action as a Note.
   *
   * Returns the inference response plus the action Note that was written.
   */
  async inference(params: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; action: InferenceAction; secured: SecuredInferenceRecord | null }> {
    this.assertNotRevoked();

    const model = params.model ?? this.config.defaultModel;

    // Call Morpheus API through SecureChannel
    const { response, record, promptHash, responseHash, latencyMs } =
      await this.client.securedChatCompletion({
        model,
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
      });

    const content = response.choices[0]?.message?.content ?? '';
    const usage = response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Build action Note — includes secure channel proof
    const action: InferenceAction = {
      type: 'morpheus-action',
      version: '1.0',
      action: 'inference',
      previousHash: this.state.lastNoteHash,
      timestamp: new Date().toISOString(),
      agentAddress: this.state.agentAddress,
      inference: {
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        promptHash,
        responseHash,
        latencyMs,
        sessionId: response.id,
      },
    };

    // Write action Note to Sovereign Secret
    await this.writeActionNote(action);

    // If secure channel produced a record, write that too
    if (record) {
      await this.writeNote(JSON.stringify({
        type: 'morpheus-secured-record',
        version: '1.0',
        agentProof: record.agentProof,
        prompt: record.prompt,
        response: record.response,
        channelLayer: this.channel.getStatus().layer,
      }));
    }

    // Update session stats
    this.state.sessionInferenceCalls++;
    this.state.sessionTotalTokens += usage.total_tokens;

    // Accumulate full content for archiving at settlement
    const promptText = params.messages.map(m => m.content).join('\n');
    const systemPromptMsg = params.messages.find(m => m.role === 'system');
    this.state.sessionActions.push({
      index: this.state.sessionActions.length,
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
      previousHash: action.previousHash,
      timestamp: action.timestamp,
      archivePolicy: this.state.defaultArchivePolicy,
    });

    return { content, action, secured: record };
  }

  /**
   * Log a payment action (MOR staking, x402, credit purchase).
   */
  async logPayment(params: {
    method: PaymentAction['payment']['method'];
    amount: string;
    token: string;
    recipient: string;
    txHash?: string;
  }): Promise<PaymentAction> {
    const action: PaymentAction = {
      type: 'morpheus-action',
      version: '1.0',
      action: 'payment',
      previousHash: this.state.lastNoteHash,
      timestamp: new Date().toISOString(),
      agentAddress: this.state.agentAddress,
      payment: params,
    };

    await this.writeActionNote(action);
    return action;
  }

  /**
   * Log a signed output (work product).
   */
  async logOutput(params: {
    content: string;
    contentType: string;
    ipfsCid?: string;
  }): Promise<OutputAction> {
    const action: OutputAction = {
      type: 'morpheus-action',
      version: '1.0',
      action: 'output',
      previousHash: this.state.lastNoteHash,
      timestamp: new Date().toISOString(),
      agentAddress: this.state.agentAddress,
      output: {
        contentHash: this.hashContent(params.content),
        contentType: params.contentType,
        sizeBytes: Buffer.byteLength(params.content, 'utf8'),
        ipfsCid: params.ipfsCid,
      },
    };

    await this.writeActionNote(action);
    return action;
  }

  /**
   * Log an error encountered during operation.
   */
  async logError(params: {
    code: string;
    message: string;
    operation: string;
  }): Promise<ErrorAction> {
    const action: ErrorAction = {
      type: 'morpheus-action',
      version: '1.0',
      action: 'error',
      previousHash: this.state.lastNoteHash,
      timestamp: new Date().toISOString(),
      agentAddress: this.state.agentAddress,
      error: params,
    };

    await this.writeActionNote(action);
    return action;
  }

  // ─── WATCH ─────────────────────────────────────────────────────

  /**
   * Start watching the Sovereign Secret for incoming Notes.
   *
   * Checks for new Notes at the specified interval.
   * Processes: code deliveries, policy updates, revocations.
   */
  startWatching(intervalMs: number = 10_000): void {
    if (this.watchInterval) return; // Already watching

    console.error(`[Morpheus] Wallet-watch started (${intervalMs}ms interval)`);

    this.watchInterval = setInterval(async () => {
      try {
        await this.checkForNewNotes();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Morpheus] Watch error: ${message}`);
      }
    }, intervalMs);
  }

  /** Stop watching for incoming Notes. */
  stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
      console.error('[Morpheus] Wallet-watch stopped');
    }
  }

  /**
   * Check for new Notes on the Sovereign Secret.
   * Called by the watch interval or manually.
   *
   * TODO: In Phase 1, this will use ChainReader.getNotesAfter() to poll
   * the Sovereign Secret for DataWritten events after the last known index.
   * For now, this is a stub that logs the check.
   */
  async checkForNewNotes(): Promise<IncomingNote[]> {
    // Phase 1: Implement with ChainReader
    // const reader = new ChainReader({ rpcUrl: this.config.rpcUrl });
    // const notes = await reader.getNotesAfter(this.state.sovereignSecretAddress, lastIndex);
    // For each note, decrypt with agent key, parse, and dispatch

    // Stub for Phase 0 — return empty
    return [];
  }

  /**
   * Process an incoming Note based on its type.
   */
  async processIncomingNote(note: IncomingNote): Promise<void> {
    switch (note.type) {
      case 'morpheus-code':
        await this.handleCodeDelivery(note);
        break;
      case 'morpheus-policy-update':
        await this.handlePolicyUpdate(note);
        break;
      case 'morpheus-revocation':
        this.handleRevocation(note);
        break;
    }
  }

  private async handleCodeDelivery(note: CodeDeliveryNote): Promise<void> {
    // Verify owner signature before installing
    // TODO: Signature verification against authorizer address from birth cert

    if (note.action === 'install' || note.action === 'update') {
      // Verify code hash matches
      if (note.skill.code) {
        const actualHash = this.hashContent(note.skill.code);
        if (actualHash !== note.skill.codeHash) {
          console.error(`[Morpheus] Code hash mismatch for ${note.skill.name} — rejecting`);
          return;
        }
      }

      this.state.installedSkills.set(note.skill.name, {
        version: note.skill.version,
        codeHash: note.skill.codeHash,
      });

      // Log the installation as an action Note
      const action: SkillInstalledAction = {
        type: 'morpheus-action',
        version: '1.0',
        action: 'skill_installed',
        previousHash: this.state.lastNoteHash,
        timestamp: new Date().toISOString(),
        agentAddress: this.state.agentAddress,
        skill: {
          name: note.skill.name,
          version: note.skill.version,
          codeHash: note.skill.codeHash,
          deliveryNoteIndex: this.state.sessionNoteCount,
        },
      };
      await this.writeActionNote(action);

      console.error(`[Morpheus] Skill installed: ${note.skill.name}@${note.skill.version}`);
    } else if (note.action === 'remove') {
      this.state.installedSkills.delete(note.skill.name);
      console.error(`[Morpheus] Skill removed: ${note.skill.name}`);
    }
  }

  private async handlePolicyUpdate(note: PolicyUpdateNote): Promise<void> {
    // TODO: Verify owner signature
    const previous = { ...this.state.currentPolicy };
    this.state.currentPolicy = { ...previous, ...note.policy };
    console.error('[Morpheus] Policy updated');
  }

  private handleRevocation(note: RevocationNote): void {
    // TODO: Verify owner signature
    this.state.revoked = true;
    this.stopWatching();
    console.error(`[Morpheus] REVOKED: ${note.reason}`);
  }

  // ─── SETTLE ────────────────────────────────────────────────────

  /**
   * Settle the session: archive full content + write settlement index.
   *
   * Two operations:
   * 1. Archive full session (prompts + responses) via create_archive
   *    → Desktop handles encryption, IPFS, chain write, credits
   * 2. Write settlement index Note to Sovereign Secret
   *    → Merkle root + pointer to archive + search keywords
   */
  async settle(): Promise<SettlementNote & { archiveAddress?: string }> {
    // Build settlement
    const settlement: SettlementNote = {
      type: 'morpheus-settlement',
      version: '1.0',
      fromNoteIndex: 1,
      toNoteIndex: this.state.sessionNoteCount,
      merkleRoot: this.state.lastNoteHash,
      actionCount: this.state.sessionActions.length,
      stats: {
        totalInferenceCalls: this.state.sessionInferenceCalls,
        totalTokens: this.state.sessionTotalTokens,
        totalPayments: '0',
        modelsUsed: [...new Set(this.state.sessionActions.map(a => a.model).filter(Boolean) as string[])],
        errorsEncountered: 0,
      },
      policyHash: this.hashContent(JSON.stringify(this.state.currentPolicy)),
      agentAddress: this.state.agentAddress,
      timestamp: new Date().toISOString(),
    };

    // ─── Step 1: Archive full session content via Desktop ─────────
    let archiveAddress: string | undefined;

    if (this.state.sessionActions.length > 0) {
      const archiveContent = this.buildArchiveContent(settlement);

      try {
        archiveAddress = await this.archiveSession(archiveContent);
        console.error(`[Morpheus] Session archived: ${archiveAddress}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Morpheus] Archive failed (non-fatal): ${msg}`);
        // Settlement still proceeds — hashes are on chain even if archive fails
      }
    }

    // ─── Step 2: Write settlement index to Sovereign Secret ──────
    const settlementWithPointer = {
      ...settlement,
      archiveAddress,
    };

    await this.writeNote(JSON.stringify(settlementWithPointer));
    console.error(`[Morpheus] Session settled: ${this.state.sessionActions.length} actions, Merkle root: ${settlement.merkleRoot.slice(0, 18)}...`);

    return settlementWithPointer;
  }

  /**
   * Build the full session archive content as markdown.
   * This is what goes to create_archive → IPFS → on-chain.
   */
  private buildArchiveContent(settlement: SettlementNote): string {
    const lines: string[] = [];

    lines.push(`# Morpheus Agent Session — ${new Date().toISOString().split('T')[0]}`);
    lines.push('');
    lines.push('## Metadata');
    lines.push(`- **Agent**: ${this.state.agentAddress}`);
    lines.push(`- **Sovereign Secret**: ${this.state.sovereignSecretAddress}`);
    lines.push(`- **Model**: ${this.config.defaultModel}`);
    lines.push(`- **Session Start**: ${this.state.sessionStartedAt}`);
    lines.push(`- **Total Tokens**: ${this.state.sessionTotalTokens}`);
    lines.push(`- **Merkle Root**: ${settlement.merkleRoot}`);
    lines.push(`- **Policy Hash**: ${settlement.policyHash}`);
    lines.push('');

    // Search index — topics and keywords for discovery
    lines.push('## Search Index');
    for (const action of this.state.sessionActions) {
      if (action.topic) {
        lines.push(`- ${action.action}: ${action.topic}`);
      }
    }
    lines.push('');

    // Full action content
    lines.push('## Actions');
    for (const action of this.state.sessionActions) {
      lines.push('');
      lines.push(`### Action ${action.index + 1}: ${action.action}`);
      lines.push(`- **Prompt Hash**: \`${action.promptHash}\``);
      lines.push(`- **Response Hash**: \`${action.responseHash}\``);
      lines.push(`- **Previous Hash**: \`${action.previousHash}\``);
      lines.push(`- **Timestamp**: ${action.timestamp}`);

      if (action.model) lines.push(`- **Model**: ${action.model}`);
      if (action.totalTokens) lines.push(`- **Tokens**: ${action.totalTokens}`);
      if (action.latencyMs) lines.push(`- **Latency**: ${action.latencyMs}ms`);

      if (action.archivePolicy === 'redacted') {
        lines.push('');
        lines.push('*Content redacted per archive policy. Hashes preserved for verification.*');
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

    // Settlement
    lines.push('');
    lines.push('## Settlement');
    lines.push(`- **Merkle Root**: \`${settlement.merkleRoot}\``);
    lines.push(`- **Actions**: ${settlement.actionCount}`);
    lines.push(`- **Total Tokens**: ${settlement.stats.totalTokens}`);
    lines.push(`- **Models**: ${settlement.stats.modelsUsed.join(', ')}`);
    lines.push(`- **Errors**: ${settlement.stats.errorsEncountered}`);

    return lines.join('\n');
  }

  /**
   * Archive the session content as a Note on the Sovereign Secret.
   *
   * Writes via agent_write_note — appends to the existing Secret.
   * Same conversation stays in one place. NoteManager handles
   * >1KB → IPFS automatically (encrypted, content-addressed).
   *
   * Cost: ~0.01 POL per Note (vs ~0.41 POL for create_archive which
   * deploys a new Secret contract each time).
   *
   * Returns the Sovereign Secret address (same address, new Note).
   */
  private async archiveSession(content: string): Promise<string | undefined> {
    const sessionToken = process.env.AGENT_SESSION_TOKEN;

    if (this.config.keySource === 'relay' && this.config.relayUrl && sessionToken) {
      // Production: write session archive as Note on Sovereign Secret
      // NoteManager handles encryption + IPFS for large content
      await callDesktopRelay(
        this.config.relayUrl,
        sessionToken,
        'agent_write_note',
        {
          content,
          secretAddress: this.state.sovereignSecretAddress,
        }
      );

      console.error(`[Morpheus] Session archived as Note on ${this.state.sovereignSecretAddress}`);
      return this.state.sovereignSecretAddress;
    } else {
      // Local mode: log content size
      const tags = [
        'morpheus', 'agent-session', this.config.defaultModel,
        `agent:${this.state.agentAddress.slice(0, 10)}`,
      ];
      console.error(`[Morpheus] [LOCAL] Session archive: ${content.length} bytes`);
      console.error(`[Morpheus] [LOCAL] Tags: ${tags.join(', ')}`);
      return undefined;
    }
  }

  // ─── STATUS ────────────────────────────────────────────────────

  /** Get current agent state summary including channel status. */
  getStatus(): {
    initialized: boolean;
    agentAddress: string;
    sovereignSecret: string;
    sessionNotes: number;
    inferenceCalls: number;
    totalTokens: number;
    skills: string[];
    revoked: boolean;
    lastNoteHash: string;
    channel: ReturnType<SecureChannel['getStatus']>;
  } {
    return {
      initialized: this.state.initialized,
      agentAddress: this.state.agentAddress,
      sovereignSecret: this.state.sovereignSecretAddress,
      sessionNotes: this.state.sessionNoteCount,
      inferenceCalls: this.state.sessionInferenceCalls,
      totalTokens: this.state.sessionTotalTokens,
      skills: Array.from(this.state.installedSkills.keys()),
      revoked: this.state.revoked,
      lastNoteHash: this.state.lastNoteHash,
      channel: this.channel.getStatus(),
    };
  }

  /** Get detailed channel status. */
  getChannelStatus(): {
    channel: ReturnType<SecureChannel['getStatus']>;
    providerManifest: ReturnType<SecureChannel['getProviderManifest']>;
  } {
    return {
      channel: this.channel.getStatus(),
      providerManifest: this.channel.getProviderManifest(),
    };
  }

  /** Set provider manifest for the secure channel. */
  setProviderManifest(manifest: Parameters<SecureChannel['setProviderManifest']>[0]): void {
    this.channel.setProviderManifest(manifest);
  }

  /** Check Morpheus API health. */
  async checkHealth(): Promise<{ morpheusOk: boolean; models: number; latencyMs: number }> {
    const health = await this.client.healthCheck();
    return { morpheusOk: health.ok, models: health.models, latencyMs: health.latencyMs };
  }

  // ─── Private helpers ───────────────────────────────────────────

  /**
   * Write a Note to the Sovereign Secret.
   *
   * In relay mode, proxies through Desktop V6 agent_write_note.
   * In local/dev mode, uses NoteManager directly.
   *
   * TODO Phase 1: Wire up NoteManager with V7 auto-funding for local mode.
   * For Phase 0, relay mode is the primary path.
   */
  private async writeNote(content: string): Promise<void> {
    const sessionToken = process.env.AGENT_SESSION_TOKEN;

    if (this.config.keySource === 'relay' && this.config.relayUrl && sessionToken) {
      // Production: proxy through Desktop V6
      await callDesktopRelay(
        this.config.relayUrl,
        sessionToken,
        'agent_write_note',
        {
          content,
          secretAddress: this.state.sovereignSecretAddress,
        }
      );
    } else {
      // Local/dev: log to console (NoteManager wiring in Phase 1)
      console.error(`[Morpheus] [LOCAL] Note written (${content.length} bytes)`);
    }

    // Update chain linkage
    this.state.lastNoteHash = this.hashContent(content);
    this.state.sessionNoteCount++;
  }

  /** Write an action Note and update chain state. */
  private async writeActionNote(action: ActionNote): Promise<void> {
    await this.writeNote(JSON.stringify(action));
  }

  /** SHA-256 hash */
  private hashContent(content: string): string {
    return '0x' + createHash('sha256').update(content).digest('hex');
  }

  /** Throw if the agent has been revoked. */
  private assertNotRevoked(): void {
    if (this.state.revoked) {
      throw new Error('Agent has been revoked — all operations blocked');
    }
  }
}
