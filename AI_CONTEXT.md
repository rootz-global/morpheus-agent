# @rootz/morpheus-agent — AI Context

**Version**: 0.3.0
**Location**: `rootz-v6/apps/morpheus-agent/`
**Role**: Morpheus AI inference as a Rootz agent skill (Skill #1)
**Status**: Active build — v0.3.0 MorpheusSkill adapter + session archiving

---

## FOR AI ASSISTANTS: Read This First

This is the Morpheus integration for the Rootz agent runtime. It does TWO things:
1. **Standalone MCP server** (6 tools) — works independently for demos and testing
2. **MorpheusSkill** (AgentSkill implementation) — loads into the TEE runtime as Skill #1

If you're adding Morpheus features, modify this package.
If you're changing how skills work, modify `@rootz/agent-runtime`.
If you're changing signing/policy, modify `apps/agent-tee`.

---

## Quick Start

### As standalone MCP server (demo/testing)
```bash
MORPHEUS_API_KEY=your-key node dist/index.js --local --config-secret 0xTEST
```

### As skill loaded into TEE (production)
```typescript
import { MorpheusSkill } from './morpheus-skill.js';

const skill = new MorpheusSkill(morpheusConfig);
await teeCore.loadSkill(skill);
// Now morpheus_inference calls go through TEE policy → chain → Desktop TPM
```

---

## File Map (in order of importance)

| File | Lines | Purpose |
|------|-------|---------|
| `src/morpheus-skill.ts` | ~250 | **AgentSkill implementation** — wraps MorpheusAgent for the unified runtime |
| `src/morpheus-agent.ts` | ~400 | Agent lifecycle: create, inference, settle, watch, archive |
| `src/morpheus-types.ts` | ~600 | All types: BirthCertificate, ActionNote, SessionAction, SecureChannel types |
| `src/morpheus-client.ts` | ~180 | OpenAI-compatible HTTP client for Morpheus API |
| `src/secure-channel.ts` | ~280 | Three-layer signed channel (agent signs, provider signs, ECDH) |
| `src/morpheus-mcp-tools.ts` | ~320 | 6 MCP tools for Claude Code |
| `src/provider-manifest.ts` | ~180 | Reads provider identity from BASE chain |
| `src/index.ts` | ~170 | Entry point, CLI args |

---

## MCP Tools (6)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `morpheus_create_agent` | Birth certificate + agent identity | Once per agent |
| `morpheus_inference` | Call Morpheus AI + log action Note | Every query |
| `morpheus_status` | Agent chain summary + channel info | Diagnostics |
| `morpheus_channel_status` | Secure channel layer + provider manifest | Security review |
| `morpheus_deliver_code` | Owner pushes skill/code to agent | Updates |
| `morpheus_settle` | Merkle root + archive full session | End of session |

---

## Two Operating Modes

### Mode 1: Standalone (current demos)
```
Claude Code → morpheus-agent MCP → Morpheus API → hash chain → settle
```
Agent manages its own hash chain. Signs with `0x` stubs (local mode) or Desktop relay. Archives via `create_archive` or `write_note`.

### Mode 2: TEE Skill (target architecture)
```
Claude Code → TEE MCP → MorpheusSkill → Morpheus API
                ↓                            ↓
          policy check              ctx.recordEvent()
                ↓                            ↓
          Desktop TPM sign          unified Merkle chain
```
Skill signs through SkillContext. Events go to the TEE's single chain. Settlement includes skill content.

---

## Session Archiving

At settlement, full session content is archived:
- **Prompts**: Full text of every query
- **Responses**: Full AI output
- **Hashes**: SHA-256 of both (chain-linked)
- **Metadata**: Model, tokens, latency, timestamps

Archive goes to Sovereign Secret as a Note (lightweight, ~$0.005).
NoteManager handles >1KB → IPFS automatically. Desktop encrypts everything.

---

## Morpheus Network Details

| Item | Value |
|------|-------|
| Inference API | `https://api.mor.org/api/v1` |
| Format | OpenAI-compatible (drop-in) |
| Models | kimi-k2.5, glm-4.7, glm-4.7-flash |
| Chain | BASE (Coinbase L2, chain ID 8453) |
| Diamond Proxy | `0x6aBE1d282f72B474E54527D93b979A4f64d3030a` |

---

## Live On-Chain Data

| Artifact | Address / Link |
|----------|---------------|
| Sovereign Secret | `0x70b893e3b519255166a1fb64dcde920d056a2d5c` (Polygon) |
| Birth Certificate | [View](https://rootz.global/s/0x70b893e3b519255166a1fb64dcde920d056a2d5c?k=yTFRhjNRGsOGstZ--xQ9B6drM3tL3c6FZ6s0qomPa6o) |
| Session Archive | [View](https://rootz.global/s/0x136a5ec90d58fd09506409e46edb5acf1ea34ece?k=maofU5YgcagMjCTLbGs5vLrX2vDGAP2umkXv2C3A21c) |
| GitHub | [rootz-global/morpheus-agent](https://github.com/rootz-global/morpheus-agent) |
| Website | [proof.rootz.global](https://proof.rootz.global) |

---

## Secure Channel (Three Layers)

| Layer | What | Status |
|-------|------|--------|
| 1 | Agent signs prompt hashes, hashes responses | **Working** |
| 2 | Provider signs responses (via Go middleware patch) | Patch ready |
| 3 | ECDH encrypted channel + TEE attestation | Designed |

Layer 2 patch: `patches/response-signing-middleware.go` + `patches/INTEGRATION.md`

---

## Dependencies

| Package | What We Use |
|---------|-------------|
| `@rootz/agent-runtime` | AgentSkill, SkillManifest, SkillContext interfaces |
| `@rootz/notes` | NoteManager for writing Notes |
| `@rootz/chain-reader` | Reading Notes from chain (wallet-watch) |
| `@rootz/crypto` | ECDH encryption |
| `@modelcontextprotocol/sdk` | MCP server |
| `ethers` | Blockchain interaction |

---

## Related Documents

| Document | Location |
|----------|----------|
| Design (unified runtime) | `rootz-v6/docs/DESIGN-unified-agent-runtime.md` |
| Design (data wallet) | `claud project/docs/DESIGN-morpheus-agent-data-wallet.md` |
| Vision | `docs/VISION.md` |
| Test Report 1 (simulated) | `docs/TEST-REPORT-2026-03-28.md` |
| Test Report 2 (live) | `docs/TEST-REPORT-2-LIVE-2026-03-28.md` |
| Session Archive (Session 2) | `docs/SESSION-ARCHIVE-2026-03-29-SESSION2.md` |

---

## Current State
- **Last Change**: MorpheusSkill adapter + session archiving
- **By**: steven / claude-opus-4-6
- **Status**: compiling clean, 4 demo sessions run (15,846 tokens total)
- **Next**: Zod validation for skill manifests, unified TEE demo

---

*Last updated: 2026-03-31 by Claude Opus 4.6*
