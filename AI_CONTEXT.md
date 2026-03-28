# @rootz/morpheus-agent — AI Context

**Version**: 0.2.0
**Location**: `rootz-v6/apps/morpheus-agent/`
**Role**: Morpheus AI agent as a Rootz data wallet
**Status**: Development — v0.2.0 full session archiving

---

## What This Is

The Morpheus Agent plugin turns Morpheus decentralized AI agents into Rootz data wallets. It runs as an **MCP server** alongside the Agent TEE, providing tools to create agents with birth certificates, log inference actions, deliver code via wallet-watch, and settle session chains on-chain.

**Key principle**: The agent IS a data wallet. Its identity is a wallet address. Its memory, instructions, outputs, and receipts all flow as signed Notes on a single Sovereign Secret.

---

## Architecture

```
Desktop V6 (HSM — holds TPM keys, signs everything)
    │
    ├── Agent TEE (existing — policy enforcement, internal chain)
    │
    └── Morpheus Agent (THIS PLUGIN — Morpheus-specific workflows)
            │
            ├── morpheus-types.ts    — Note schemas (birth cert, action, receipt, code)
            ├── morpheus-client.ts   — OpenAI-compatible API client for Morpheus inference
            ├── morpheus-agent.ts    — Agent lifecycle (create, work, watch, settle)
            ├── morpheus-mcp-tools.ts — MCP tool definitions
            └── index.ts             — Entry point, CLI args, MCP server startup
```

### Relationship to Agent TEE

This plugin does NOT replace Agent TEE. It builds on top of it:

- **Agent TEE** provides: policy enforcement, internal chain, signing relay, attestation
- **Morpheus Agent** provides: Morpheus API integration, birth certificates, action logging, code delivery

In production, both run together. The Morpheus Agent calls Agent TEE tools (via Desktop relay) for signing and policy checks, then adds Morpheus-specific Note formats on top.

For Phase 0 (this build), the Morpheus Agent can also run standalone using Desktop V6 directly — it doesn't require Agent TEE to be running.

---

## Dependencies (V6 Packages Used)

| Package | Class/Function | What We Use It For |
|---------|---------------|-------------------|
| `@rootz/crypto` | `RootzCrypto` | ECDH encryption, AES-256-GCM for Notes |
| `@rootz/notes` | `NoteManager` | Writing encrypted Notes to Secrets |
| `@rootz/chain-reader` | `ChainReader` | Reading Notes from chain (wallet-watch) |
| `@rootz/integration` | `RootzClient`, `FACTORY_ABI` | Secret creation, contract interaction |
| `@rootz/tee-policy` | `TEEPolicy` | Policy schema (reused from Agent TEE) |
| `ethers` | `JsonRpcProvider`, `Wallet` | Blockchain interaction |
| `@modelcontextprotocol/sdk` | `Server`, `StdioServerTransport` | MCP server |

### Package Usage Rules

Follow the V6 conventions documented in the root `CLAUDE.md`:

1. **RootzSigner interface is sacred** — never break ethers.Signer compatibility
2. **NoteManager handles credit auto-funding** — don't reimplement credit logic
3. **SecretOrchestrator handles Secret creation** — use the 7-step flow, don't shortcut
4. **ChainReader for reading** — don't make raw contract calls when ChainReader has a method
5. **Desktop relay for signing** — in production, agent has no key; Desktop signs via session token

---

## Key Concepts

### Birth Certificate (Note 0)

The first Note on every agent's Sovereign Secret. Names the parents:

```typescript
interface BirthCertificate {
  type: 'morpheus-birth-certificate';
  version: '1.0';
  agent: {
    address: string;           // Agent wallet address
    derivationPath: string;    // BIP-32 path (e.g., m/44'/60'/0'/1/0)
    created: string;           // ISO 8601
  };
  parents: {
    ai: {
      factory: string;         // "morpheus"
      model: string;           // "kimi-k2.5"
      provider: string;        // Provider wallet address
      teeAttestation?: string; // TEE quote hash if available
    };
    authorizer: {
      address: string;         // Owner wallet address
      name?: string;           // Human-readable
      signature: string;       // Owner signs the birth certificate
    };
  };
  policy: {
    dailyAllowance: number;
    currency: string;          // "MOR" | "USDC" | "POL"
    models: string[];
    scope: string;
  };
}
```

### Action Notes

Every inference call, payment, and output logged as a Note:

```typescript
interface ActionNote {
  type: 'morpheus-action';
  version: '1.0';
  action: 'inference' | 'payment' | 'output' | 'skill_installed' | 'policy_updated';
  // ... action-specific fields
  previousHash: string;        // Hash of previous Note (chain linkage)
  timestamp: string;
}
```

### Code Delivery Notes

Owner writes executable content to agent's wallet:

```typescript
interface CodeDeliveryNote {
  type: 'morpheus-code';
  version: '1.0';
  action: 'install' | 'update' | 'remove';
  skill: {
    name: string;
    version: string;
    codeHash: string;          // SHA-256 of code content
    code: string;              // Base64-encoded module
  };
  ownerSignature: string;      // Owner must sign code deliveries
}
```

### Wallet-Watch

The agent polls its Sovereign Secret for new Notes. When a Note arrives from an authorized team member (owner, provider), the agent processes it:

- `morpheus-code` → install/update/remove skill
- `policy_update` → reload spending limits and model restrictions
- `revocation` → cease all operations

---

## File Structure

```
apps/morpheus-agent/
├── src/
│   ├── index.ts              — Entry point, CLI args, MCP server startup
│   ├── morpheus-types.ts     — All TypeScript types (birth cert, action, code, etc.)
│   ├── morpheus-client.ts    — Morpheus inference API client (OpenAI-compatible)
│   ├── morpheus-agent.ts     — Agent lifecycle: create, work, watch, settle
│   └── morpheus-mcp-tools.ts — MCP tool definitions and handlers
├── tests/
│   └── morpheus-agent.test.ts
├── docs/
│   ├── VISION.md             — What we're building and why
│   └── DESIGN.md             — Technical architecture
├── .ai/
│   └── changelog.jsonl       — Component Change Protocol log
├── AI_CONTEXT.md             — This file
├── CLAUDE.md                 — Build instructions
├── package.json
├── tsconfig.json
└── dist/                     — Compiled output
```

---

## MCP Tools (5)

| Tool | Purpose |
|------|---------|
| `morpheus_create_agent` | Create agent wallet + write birth certificate |
| `morpheus_inference` | Call Morpheus API + log action Note |
| `morpheus_status` | Agent chain summary (birth cert, actions, attestations) |
| `morpheus_deliver_code` | Owner writes code/skill Note to agent wallet |
| `morpheus_settle` | Compute Merkle root + write settlement Note |

---

## Morpheus Network Details

| Item | Value |
|------|-------|
| Inference API | `https://api.mor.org/api/v1` |
| API format | OpenAI-compatible (drop-in replacement) |
| Models | `kimi-k2.5`, `glm-4.7`, `glm-4.7-flash` |
| Chain | BASE (Coinbase L2, chain ID 8453) |
| Diamond Proxy | `0x6aBE1d282f72B474E54527D93b979A4f64d3030a` |
| Agent Registry (ERC-8004) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| MOR Token (BASE) | `0x7431aDa8a591C955a994a21710752EF9b882b8e3` |

### Testnet

| Item | Value |
|------|-------|
| Chain | BASE Sepolia (chain ID 84532) |
| MOR Token | `0x5C80Ddd187054E1E4aBBfFCD750498e81d34FfA3` |
| Diamond Proxy | `0x6e4d0B775E3C3b02683A6F277Ac80240C4aFF930` |

---

## Quick Start

```bash
# Build
cd apps/morpheus-agent && npm run build

# Run (local dev mode — standalone, no Desktop required)
MORPHEUS_API_KEY=your-key-here node dist/index.js --local --config-secret 0xTEST

# Run (relay mode — Desktop V6 as HSM)
AGENT_SESSION_TOKEN=0x... MORPHEUS_API_KEY=your-key-here \
  node dist/index.js --config-secret 0x4cac... --key-source relay
```

---

## Related Files

- `apps/agent-tee/AI_CONTEXT.md` — Agent TEE architecture (signing, policy, internal chain)
- `packages/notes/AI_CONTEXT.md` — NoteManager API, credit system, auto-funding
- `packages/secret-orchestrator/AI_CONTEXT.md` — Secret creation flow
- `packages/wallet/AI_CONTEXT.md` — RootzSigner, key derivation, storage adapters
- `packages/crypto/AI_CONTEXT.md` — ECDH, AES-256-GCM
- `docs/DESIGN-morpheus-agent-data-wallet.md` — Full design document (in claud project)

---

*Last updated: 2026-03-28 by Claude Opus 4.6*
*Version: 0.1.0 — initial build*
