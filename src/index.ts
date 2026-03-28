#!/usr/bin/env node
/**
 * Rootz Morpheus Agent — Entry Point v0.1.0
 *
 * A Morpheus AI agent as a Rootz data wallet.
 *
 * The agent IS a data wallet:
 *   CREATE  — birth certificate (Note 0) names AI parent + human authorizer
 *   WORK    — inference calls logged as signed, hash-linked Notes
 *   WATCH   — wallet-watch for code delivery, policy updates, revocation
 *   SETTLE  — Merkle root of session anchored on-chain
 *
 * Usage:
 *   # Production: relay mode (Desktop V6 TPM signs everything)
 *   AGENT_SESSION_TOKEN=0x... MORPHEUS_API_KEY=... \
 *     node dist/index.js --config-secret 0x... --key-source relay
 *
 *   # Development: local mode (no gas, logs to console)
 *   MORPHEUS_API_KEY=... node dist/index.js --local --config-secret 0xTEST
 */

import { MorpheusAgent } from './morpheus-agent.js';
import { startMcpServer } from './morpheus-mcp-tools.js';
import type { MorpheusConfig } from './morpheus-types.js';

async function main(): Promise<void> {
  const config = parseArgs();

  console.error('╔═══════════════════════════════════════════════╗');
  console.error('║     Rootz Morpheus Agent v0.1.0               ║');
  console.error('║     AI Agent as a Data Wallet                 ║');
  console.error('╚═══════════════════════════════════════════════╝');
  console.error(`[Morpheus] API: ${config.apiBaseUrl}`);
  console.error(`[Morpheus] Model: ${config.defaultModel}`);
  console.error(`[Morpheus] Key source: ${config.keySource}`);
  console.error(`[Morpheus] Secret: ${config.sovereignSecretAddress}`);

  // Create agent
  const agent = new MorpheusAgent(config);

  // Start MCP server FIRST (so Claude Code handshake doesn't time out)
  await startMcpServer(agent);

  // Start wallet-watch (poll for incoming Notes)
  if (!config.local) {
    agent.startWatching(10_000); // 10 second poll interval
  }

  console.error('[Morpheus] Ready — use morpheus_create_agent to create birth certificate');

  // Graceful shutdown
  const shutdown = async () => {
    agent.stopWatching();
    console.error('[Morpheus] Shutting down');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function parseArgs(): MorpheusConfig {
  const args = process.argv.slice(2);

  let keySource: 'relay' | 'env' | 'file' = 'env';
  let configSecretAddress = '';
  let rpcUrl = process.env.RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com';
  let chainId = parseInt(process.env.CHAIN_ID ?? '137', 10);
  let transport: 'stdio' | 'http' = 'stdio';
  let httpPort = 3040;
  let local = false;
  let relayUrl: string | undefined;
  let apiBaseUrl = process.env.MORPHEUS_API_URL ?? 'https://api.mor.org/api/v1';
  let apiKey = process.env.MORPHEUS_API_KEY ?? '';
  let defaultModel = process.env.MORPHEUS_MODEL ?? 'kimi-k2.5';
  let kvBlock = 0;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--key-source':
        keySource = args[++i] as 'relay' | 'env' | 'file';
        break;
      case '--relay-url':
        relayUrl = args[++i];
        keySource = 'relay';
        break;
      case '--config-secret':
        configSecretAddress = args[++i];
        break;
      case '--kv-block':
        kvBlock = parseInt(args[++i], 10);
        break;
      case '--rpc-url':
        rpcUrl = args[++i];
        break;
      case '--chain-id':
        chainId = parseInt(args[++i], 10);
        break;
      case '--local':
        local = true;
        break;
      case '--transport':
        transport = args[++i] as 'stdio' | 'http';
        break;
      case '--http-port':
        httpPort = parseInt(args[++i], 10);
        break;
      case '--api-url':
        apiBaseUrl = args[++i];
        break;
      case '--api-key':
        apiKey = args[++i];
        break;
      case '--model':
        defaultModel = args[++i];
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  // Env fallbacks
  if (!configSecretAddress) {
    configSecretAddress = process.env.MORPHEUS_CONFIG_SECRET ?? '';
  }
  if (!configSecretAddress && !local) {
    console.error('Error: --config-secret or MORPHEUS_CONFIG_SECRET is required');
    printHelp();
    process.exit(1);
  }
  if (!apiKey) {
    console.error('Warning: No MORPHEUS_API_KEY set — inference calls will fail');
  }

  // Auto-detect relay mode
  if (keySource === 'env' && process.env.AGENT_SESSION_TOKEN) {
    keySource = 'relay';
    console.error('[Morpheus] AGENT_SESSION_TOKEN detected — relay mode (Desktop V6 as HSM)');
  }

  if (keySource === 'relay' && !relayUrl) {
    relayUrl = process.env.RELAY_URL ?? 'http://localhost:3021';
  }

  return {
    apiBaseUrl,
    apiKey,
    defaultModel,
    sovereignSecretAddress: configSecretAddress || '0xTEST',
    kvBlock,
    rpcUrl,
    chainId,
    keySource,
    relayUrl,
    local,
    transport,
    httpPort,
  };
}

function printHelp(): void {
  console.error(`
Rootz Morpheus Agent v0.1.0 — AI Agent as a Data Wallet

USAGE:
  node dist/index.js --config-secret <address> [options]

REQUIRED:
  --config-secret <addr>  Sovereign Secret address for this agent
                          (or set MORPHEUS_CONFIG_SECRET env var)

MORPHEUS:
  --api-url <url>         Morpheus API base URL (default: https://api.mor.org/api/v1)
  --api-key <key>         Morpheus API key (or set MORPHEUS_API_KEY env var)
  --model <name>          Default model (default: kimi-k2.5)

KEY SOURCE:
  --key-source relay      Desktop V6 TPM is HSM (PRODUCTION)
  --relay-url <url>       Desktop MCP URL (default: http://localhost:3021)
  --key-source env        Read from env (DEV ONLY)

OPTIONS:
  --kv-block <num>        KeyVault block number (default: 0)
  --rpc-url <url>         Polygon RPC URL
  --chain-id <num>        Chain ID (default: 137 = Polygon)
  --transport stdio|http  MCP transport (default: stdio)
  --http-port <num>       HTTP port if transport=http (default: 3040)
  --local                 Local dev mode (no gas, console logging)

ENVIRONMENT:
  MORPHEUS_API_KEY        Morpheus inference API key
  MORPHEUS_API_URL        Morpheus API base URL
  MORPHEUS_MODEL          Default model
  MORPHEUS_CONFIG_SECRET  Sovereign Secret address
  AGENT_SESSION_TOKEN     Desktop V6 session token (relay mode)
  RELAY_URL               Desktop MCP relay URL
  RPC_URL                 Polygon RPC URL
  CHAIN_ID                Chain ID

EXAMPLES:
  # Local dev (no blockchain, console logging)
  MORPHEUS_API_KEY=your-key node dist/index.js --local --config-secret 0xTEST

  # Production (Desktop V6 relay, real blockchain)
  AGENT_SESSION_TOKEN=0x... MORPHEUS_API_KEY=your-key \\
    node dist/index.js --config-secret 0x4cac... --key-source relay
`);
}

main().catch((err) => {
  console.error(`[Morpheus] Fatal error: ${err.message}`);
  process.exit(1);
});
