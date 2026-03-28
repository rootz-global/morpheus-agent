# Rootz Morpheus Agent — AI with Proof of Origin

Every AI output should have a provable origin. This plugin gives Morpheus decentralized AI agents a **birth certificate**, a **cryptographic audit chain**, and **signed session archives** — all anchored on Polygon.

## What This Does

- **Birth Certificate** — Every agent has a permanent record naming its two parents: the AI model that powers it and the human who authorized it
- **Signed Action Chain** — Every inference call is recorded as a hash-linked Note: prompt hash, response hash, model, tokens, latency
- **Secure Channel** — Agent signs every prompt; provider signatures supported for bilateral proof
- **Session Archives** — Full prompts and responses archived via IPFS, encrypted, recoverable from one wallet address
- **Settlement** — Merkle root covers the entire session in a single on-chain write

## How It Works

```
Agent birth → Birth certificate (Note 0 on Sovereign Secret)
    ↓
Agent calls Morpheus inference → Action Note (hash-linked to previous)
    ↓
Agent calls again → Another Note (chain grows)
    ↓
Settlement → Merkle root + full archive to IPFS + index on chain
```

The agent IS a data wallet. Its identity is a wallet address. Its memory, instructions, outputs, and receipts all flow as signed Notes on a single Sovereign Secret.

## Quick Start

```bash
# Build
cd apps/morpheus-agent && npm run build

# Run (local dev — no blockchain, console logging)
MORPHEUS_API_KEY=your-key node dist/index.js --local --config-secret 0xTEST

# Run (production — Desktop V6 signs via TPM)
AGENT_SESSION_TOKEN=0x... MORPHEUS_API_KEY=your-key \
  node dist/index.js --config-secret 0x70b8... --key-source relay
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `morpheus_create_agent` | Create agent + write birth certificate |
| `morpheus_inference` | Call Morpheus + log signed action Note |
| `morpheus_status` | Agent chain summary |
| `morpheus_channel_status` | Secure channel diagnostics |
| `morpheus_deliver_code` | Owner delivers skill via wallet |
| `morpheus_settle` | Archive session + write Merkle root |

## Architecture

```
Desktop V6 (TPM wallet, signing HSM)
    │
    ├── Morpheus Agent (this plugin)
    │     ├── morpheus-types.ts      — All types
    │     ├── morpheus-client.ts     — OpenAI-compatible API client
    │     ├── morpheus-agent.ts      — Agent lifecycle
    │     ├── secure-channel.ts      — Signed prompts/responses
    │     ├── provider-manifest.ts   — On-chain provider identity
    │     ├── morpheus-mcp-tools.ts  — 6 MCP tools
    │     └── index.ts               — Entry point
    │
    ├── Agent TEE (policy enforcement, internal chain)
    └── Desktop Archive (IPFS, encryption, credits, search)
```

## Four Layers of Provable AI

| Layer | What It Proves | Status |
|-------|---------------|--------|
| 1. Agent-Side | Agent signed prompt hash, hashed response, chain order | **Working** |
| 2. Provider-Side | Provider signs response (bilateral proof) | Patch ready |
| 3. Encrypted Channel | TEE attestation + ECDH encryption | Designed |
| 4. Model Provenance | Model built from signed sources | Spec phase |

## First Test — March 28, 2026

Created the first AI agent with a birth certificate on Polygon mainnet:
- **Agent**: `0xB29A12a4741430e707E596F71e9d7Bca722ffaA6`
- **Sovereign Secret**: `0x70b893e3b519255166a1fb64dcde920d056a2d5c`
- **Model**: Kimi K2.5 via Morpheus decentralized inference
- **Authorizer**: Steven Sprague
- 3 inference calls, 4,213 tokens, hash-linked chain, settlement Merkle root

See `docs/TEST-REPORT-2-LIVE-2026-03-28.md` for full details.

## Dependencies

- [Rootz V6](https://rootz.global) — Data wallet infrastructure (Polygon)
- [Morpheus](https://mor.org) — Decentralized AI inference
- [Desktop V6](https://rootz.global) — TPM signing, archive pipeline

## License

MIT

## Author

Steven Sprague — [rootz.global](https://rootz.global)
