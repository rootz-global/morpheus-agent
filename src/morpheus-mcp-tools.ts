/**
 * Morpheus Agent MCP Tools
 *
 * Five tools exposed to Claude Code (or any MCP client):
 *   morpheus_create_agent  — Create agent wallet + write birth certificate
 *   morpheus_inference     — Call Morpheus API + log action Note
 *   morpheus_status        — Agent chain summary
 *   morpheus_deliver_code  — Owner writes code/skill Note to agent wallet
 *   morpheus_settle        — Compute Merkle root + write settlement Note
 *
 * Follows the agent-tee pattern: TOOLS constant array, registered via
 * server.setRequestHandler(ListToolsRequestSchema / CallToolRequestSchema).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MorpheusAgent } from './morpheus-agent.js';

// ═══════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: 'morpheus_create_agent',
    description:
      'Create a new Morpheus agent with a birth certificate. ' +
      'The birth certificate names two parents: the AI (Morpheus model/provider) ' +
      'and the Authorizer (human owner). Written as Note 0 on the Sovereign Secret.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agentAddress: {
          type: 'string',
          description: 'Agent wallet address (derived from owner seed via BIP-32)',
        },
        derivationPath: {
          type: 'string',
          description: 'BIP-32 derivation path (e.g., m/44\'/60\'/0\'/1/0)',
        },
        model: {
          type: 'string',
          description: 'Morpheus model (e.g., kimi-k2.5, glm-4.7)',
        },
        providerAddress: {
          type: 'string',
          description: 'Morpheus provider wallet address (optional)',
        },
        authorizerAddress: {
          type: 'string',
          description: 'Owner wallet address (the human who authorizes this agent)',
        },
        authorizerName: {
          type: 'string',
          description: 'Human-readable name for the authorizer (optional)',
        },
        dailyAllowance: {
          type: 'number',
          description: 'Daily spending allowance (default: 100)',
        },
        currency: {
          type: 'string',
          description: 'Allowance currency: MOR, USDC, or POL (default: MOR)',
        },
        scope: {
          type: 'string',
          description: 'Agent scope description (e.g., research, code, trading)',
        },
      },
      required: ['agentAddress', 'authorizerAddress'],
    },
  },
  {
    name: 'morpheus_inference',
    description:
      'Call Morpheus decentralized inference and log the action as a signed Note. ' +
      'Every inference call is recorded with model, token count, prompt hash, and latency. ' +
      'Never stores raw prompts or responses — only hashes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'The prompt to send to Morpheus',
        },
        systemPrompt: {
          type: 'string',
          description: 'System prompt (optional)',
        },
        model: {
          type: 'string',
          description: 'Model to use (default: from config)',
        },
        temperature: {
          type: 'number',
          description: 'Temperature (0-2, default: model default)',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum completion tokens',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'morpheus_status',
    description:
      'Get the current status of the Morpheus agent. ' +
      'Shows: birth certificate info, session stats (inference calls, tokens), ' +
      'installed skills, chain state (last Note hash), and revocation status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        includeHealth: {
          type: 'boolean',
          description: 'Also check Morpheus API health (adds latency)',
        },
      },
    },
  },
  {
    name: 'morpheus_deliver_code',
    description:
      'Deliver a skill/code update to the agent via its wallet. ' +
      'Owner writes a code delivery Note to the Sovereign Secret. ' +
      'Agent verifies owner signature and code hash before installing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillName: {
          type: 'string',
          description: 'Skill name',
        },
        skillVersion: {
          type: 'string',
          description: 'Semantic version (e.g., 1.0.0)',
        },
        code: {
          type: 'string',
          description: 'Base64-encoded skill module',
        },
        action: {
          type: 'string',
          enum: ['install', 'update', 'remove'],
          description: 'Delivery action (default: install)',
        },
      },
      required: ['skillName', 'skillVersion'],
    },
  },
  {
    name: 'morpheus_channel_status',
    description:
      'Get the secure channel status — shows provider identity, TEE verification, ' +
      'signing mode (Layer 1/2/3), nonce count, and provider manifest details. ' +
      'Also allows setting a provider manifest for the channel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        setProvider: {
          type: 'object',
          description: 'Set provider manifest (optional). Properties: address, endpoint, stake, teeType',
          properties: {
            address: { type: 'string', description: 'Provider wallet address' },
            endpoint: { type: 'string', description: 'Provider API endpoint URL' },
            stake: { type: 'string', description: 'MOR staked (e.g., "200")' },
            teeType: { type: 'string', enum: ['intel-tdx', 'amd-sev', 'none'], description: 'TEE type' },
          },
        },
      },
    },
  },
  {
    name: 'morpheus_settle',
    description:
      'Settle the current session — compute Merkle root of all action Notes ' +
      'and write a settlement Note to the Sovereign Secret. ' +
      'Creates a permanent, verifiable record of everything the agent did.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
] as const;

// ═══════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handleToolCall(
  agent: MorpheusAgent,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'morpheus_create_agent': {
      const birthCert = await agent.createAgent({
        agentAddress: args.agentAddress as string,
        derivationPath: (args.derivationPath as string) ?? "m/44'/60'/0'/1/0",
        model: (args.model as string) ?? 'kimi-k2.5',
        providerAddress: args.providerAddress as string | undefined,
        authorizerAddress: args.authorizerAddress as string,
        authorizerName: args.authorizerName as string | undefined,
        authorizerSignature: '0x', // TODO: sign via Desktop relay
        policy: {
          dailyAllowance: (args.dailyAllowance as number) ?? 100,
          currency: (args.currency as string) ?? 'MOR',
          models: [(args.model as string) ?? 'kimi-k2.5'],
          scope: (args.scope as string) ?? 'general',
        },
      });
      return JSON.stringify(birthCert, null, 2);
    }

    case 'morpheus_inference': {
      const messages = [];
      if (args.systemPrompt) {
        messages.push({ role: 'system' as const, content: args.systemPrompt as string });
      }
      messages.push({ role: 'user' as const, content: args.prompt as string });

      const { content, action, secured } = await agent.inference({
        messages,
        model: args.model as string | undefined,
        temperature: args.temperature as number | undefined,
        maxTokens: args.maxTokens as number | undefined,
      });

      return JSON.stringify({
        content,
        model: action.inference.model,
        tokens: action.inference.totalTokens,
        latencyMs: action.inference.latencyMs,
        actionLogged: true,
        noteHash: action.previousHash,
        securedChannel: secured ? {
          layer: agent.getChannelStatus().channel.layer,
          promptHash: secured.agentProof.promptHash,
          responseHash: secured.agentProof.responseHash,
          agentSigned: secured.agentProof.agentSignature !== '0x',
          providerSigned: secured.response?.providerSignature !== '0x',
          nonce: secured.prompt.nonce,
        } : null,
      }, null, 2);
    }

    case 'morpheus_status': {
      const status = agent.getStatus();

      let health = null;
      if (args.includeHealth) {
        health = await agent.checkHealth();
      }

      return JSON.stringify({ ...status, health }, null, 2);
    }

    case 'morpheus_deliver_code': {
      // Build code delivery Note and process it
      const codeHash = args.code
        ? '0x' + (await import('node:crypto')).createHash('sha256')
            .update(args.code as string).digest('hex')
        : '0x';

      const codeNote = {
        type: 'morpheus-code' as const,
        version: '1.0' as const,
        action: (args.action as 'install' | 'update' | 'remove') ?? 'install',
        skill: {
          name: args.skillName as string,
          version: args.skillVersion as string,
          codeHash,
          code: args.code as string | undefined,
        },
        ownerSignature: '0x', // TODO: sign via Desktop relay
        timestamp: new Date().toISOString(),
      };

      await agent.processIncomingNote(codeNote);
      return JSON.stringify({
        delivered: true,
        skill: codeNote.skill.name,
        version: codeNote.skill.version,
        action: codeNote.action,
      }, null, 2);
    }

    case 'morpheus_channel_status': {
      // Optionally set a provider manifest
      if (args.setProvider) {
        const sp = args.setProvider as Record<string, string>;
        const { SecureChannel: SC } = await import('./secure-channel.js');
        const manifest = SC.buildManifest({
          address: sp.address ?? 'unknown',
          endpoint: sp.endpoint ?? 'unknown',
          stake: sp.stake,
          teeType: (sp.teeType as 'intel-tdx' | 'amd-sev' | 'none') ?? 'none',
        });
        agent.setProviderManifest(manifest);
      }

      const { channel, providerManifest } = agent.getChannelStatus();
      return JSON.stringify({
        channel,
        providerManifest,
        explanation: {
          layer1: 'Agent signs prompt hashes, hashes responses (works with any API)',
          layer2: 'Provider also signs responses (requires own node)',
          layer3: 'ECDH encrypted channel + provider as team member (full security)',
          current: `Layer ${channel.layer}`,
        },
      }, null, 2);
    }

    case 'morpheus_settle': {
      const settlement = await agent.settle();
      return JSON.stringify({
        ...settlement,
        actionsArchived: settlement.actionCount,
        fullContentArchived: settlement.archiveAddress ? true : false,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// MCP SERVER
// ═══════════════════════════════════════════════════════════════════

/**
 * Start the MCP server on stdio transport.
 * Registers all 5 Morpheus tools and dispatches calls to handlers.
 */
export async function startMcpServer(agent: MorpheusAgent): Promise<void> {
  const server = new Server(
    {
      name: 'rootz-morpheus-agent',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool list
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(agent, name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Log error to agent chain
      try {
        await agent.logError({ code: 'TOOL_ERROR', message, operation: name });
      } catch {
        // Don't let error logging failures cascade
      }

      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[Morpheus] MCP server started on stdio');
}
