# Morpheus Agent — Build Instructions

## Quick Reference

```bash
cd apps/morpheus-agent
npm run build          # TypeScript compile
npm run dev            # Watch mode
npm run start          # Run compiled
npm run test           # Run tests
```

## Project Rules

1. **Read AI_CONTEXT.md first** when resuming work
2. **Use V6 packages** — don't reimplement crypto, notes, chain-reading, or signing
3. **Follow the agent-tee pattern** — same MCP tool registration, same types.ts conventions
4. **Desktop relay is production** — agent never holds a private key in production
5. **NoteManager handles credits** — don't bypass the auto-funding flow
6. **Types go in morpheus-types.ts** — single source of truth for all interfaces
7. **No hardcoded addresses** — use config or CLI args
8. **Commit format**: `@rootz/morpheus-agent@x.y.z: description`

## Component Change Protocol

Before modifying code:
1. Read `AI_CONTEXT.md` "Current State" section
2. Check `.ai/changelog.jsonl` for recent changes

After modifying code:
1. Append event to `.ai/changelog.jsonl`
2. Update "Current State" in `AI_CONTEXT.md`
3. Run `npm run build` to verify clean compile

## Architecture

```
This Plugin (morpheus-agent)
    │
    │ Uses for signing + policy:
    ├──→ Desktop V6 MCP (port 3021) via agent_sign, agent_write_note
    │
    │ Uses for inference:
    ├──→ Morpheus API (api.mor.org) via OpenAI-compatible HTTP
    │
    │ Uses for blockchain:
    ├──→ @rootz/notes (NoteManager) for writing Notes
    ├──→ @rootz/chain-reader (ChainReader) for wallet-watch
    ├──→ @rootz/secret-orchestrator for Secret creation
    └──→ @rootz/crypto for ECDH + AES-256-GCM
```

## Key Files (in order of importance)

1. `src/morpheus-types.ts` — All type definitions
2. `src/morpheus-agent.ts` — Core agent lifecycle
3. `src/morpheus-client.ts` — Morpheus API client
4. `src/morpheus-mcp-tools.ts` — MCP tools (what Claude Code calls)
5. `src/index.ts` — Entry point

## Testing

```bash
npm run test           # Vitest
```

Tests should cover:
- Birth certificate creation and validation
- Action Note formatting and hash-linking
- Morpheus API client (mocked HTTP)
- Wallet-watch polling logic
- MCP tool input/output schemas

## Version History

| Version | Date | Status | Change |
|---------|------|--------|--------|
| 0.1.0 | 2026-03-28 | Dev | Initial build — types, client, agent, MCP tools |
