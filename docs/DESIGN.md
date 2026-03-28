# Morpheus Agent — Technical Design

**Version**: 0.2.0
**Date**: March 28, 2026
**Status**: Design

---

## Architecture Principle

**Use what's built. Don't reinvent.**

The Desktop V6 already handles secrets, notes, IPFS, encryption, credit management,
and async sync. The morpheus-agent is a plugin that produces content and uses the
existing infrastructure to persist it. The agent never manages its own storage pipeline.

---

## How Archiving Works (Using Existing Desktop V6)

The Desktop V6 archive system is a 13-phase production system. It handles:
- Local SQLite cache (ArchiveDatabase, sql.js)
- Chain writes (SecretOrchestrator → V6/V7 contracts)
- IPFS upload for large content (Pinata, encrypted, >1KB threshold)
- V7 credit auto-funding (NoteManager handles vault balance)
- Async scheduling (TranscriptScheduler, configurable intervals)
- Full-text search (LIKE-based, semantic search via local embeddings)
- Knowledge extraction (fact types, relationships, decisions)

The morpheus-agent does NOT build any of this. It uses it.

### The Two Paths

**Path 1: `create_archive`** — Creates a new Secret or writes to an existing one.
Desktop handles encryption, IPFS, chain write, credits. Returns address + TX hash.
Use for: birth certificates, session archives, full-content captures.

```
Agent → create_archive { title, content, tags, templateType }
  → Desktop API (port 3020)
  → IPC: mcp:createSecret
  → SecretOrchestrator (7-step flow)
  → Blockchain + IPFS
  ← Returns: { address, txHash }
```

**Path 2: `agent_write_note`** — Writes a Note to an existing Secret.
Desktop handles encryption, IPFS (if >1KB), credit management.
Use for: action hashes, settlements, session indexes, metadata.

```
Agent → agent_write_note { sessionToken, content, secretAddress }
  → Desktop MCP relay (port 3021)
  → NoteManager.writeNote()
  → If content > 1KB: encrypt → IPFS → small metadata Note on-chain
  → If content < 1KB: encrypt → directly on-chain
  ← Returns: { secretAddress }
```

Both paths are async from the agent's perspective. The agent calls and continues.
The Desktop pipeline handles caching, retries, and confirmation.

### During a Session (Local Accumulation)

The agent accumulates actions in memory. Each inference call stores:
- The full prompt text
- The full response text
- Metadata: model, tokens, latency, hashes
- Chain linkage: previousHash connecting to the prior action

This is the working state. Fast, free, no I/O. The lightning chain model.

### At Settlement (Archive + Index)

When the session settles, two things happen:

**1. Full content archive** via `create_archive`:
- Builds markdown document with all prompts, responses, metadata
- Tags: `morpheus`, `agent-session`, model name, topic keywords
- templateType: `RESEARCH` (or future `AGENT_SESSION`)
- Desktop encrypts, uploads to IPFS, writes on-chain
- Returns the archive Secret address

**2. Settlement index** via `agent_write_note` to Sovereign Secret:
- Merkle root covering all session actions
- Pointer to the full archive (archive Secret address)
- Session stats (token count, model, duration)
- Search keywords for discovery

The Sovereign Secret is the index. The archive Secret is the content.
One address (Sovereign Secret) leads to everything.

### Recovery

1. Read Sovereign Secret → birth certificate + settlement Notes
2. Each settlement Note contains a pointer to an archive Secret
3. Fetch archive → decrypt → full prompts + responses
4. Verify: hash each action → Merkle tree → compare to on-chain root
5. Existing ChainReader + NoteManager + ArchiveDatabase handle mechanics

### Search and Discovery

The archive tags and content feed into the existing search infrastructure:
- LIKE-based search across content (ArchiveDatabase)
- Semantic search via local embeddings (@xenova/transformers)
- Knowledge extraction (fact types from agent conversations)
- Session metadata (topics, tools used, entities mentioned)

When Secrets are scanned into the archive index, the tags on agent session
archives make them findable: `morpheus`, `kimi-k2.5`, `agent-identity`, etc.

---

## Session Content Structure

The content passed to `create_archive` at settlement:

```markdown
# Morpheus Agent Session — {date}

## Metadata
- Agent: {address}
- Sovereign Secret: {address}
- Model: {model}
- Total Tokens: {count}
- Merkle Root: {hash}
- Archive Policy: {permanent|standard|redacted}

## Search Index
- Topics: {per-action topic summaries}
- Keywords: {extracted entities and concepts}

## Actions
### Action 1: {topic}
- Prompt Hash: {hash}
- Response Hash: {hash}
- Tokens: {count}
- Prompt: {full text}
- Response: {full text}

### Action 2: ...

## Settlement
- Merkle Root: {hash}
- Policy Hash: {hash}
```

This is markdown — same format as every other archive in the system.
The tags include `morpheus`, `agent-session`, model name, and topic keywords.
The `templateType` is `RESEARCH` or a new `AGENT_SESSION` type.

---

## Archive Policy

The birth certificate includes a default archive policy.
Individual actions can override.

| Policy | Full Text Archived | Hashes On-Chain | Search Keywords |
|--------|-------------------|-----------------|-----------------|
| `permanent` | Yes (IPFS + Secret) | Yes | Yes |
| `standard` | Yes (IPFS + Secret) | Yes | Summary only |
| `redacted` | No (hashes only) | Yes | No |
| `ephemeral` | No | No | No |

Default: `standard` for inference calls, `permanent` for birth certs and settlements.

---

---

## Architectural Decision: Archives Now, Notes Later

The V6 Secret contract supports two access patterns:

**Archive pattern** (bulk): One encrypted blob per session. Fetch the whole thing.
Good for: session replay, search indexing, bulk recovery, audit trail.
Desktop `create_archive` handles this today.

**Notes/KeyVault pattern** (granular): Each KeyVault is independently addressable.
Each can have its own schema, its own team members, its own encryption.
You can read Note 3 without loading Notes 1, 2, 4, 5.
Good for: provider reading just their receipt Notes, auditor reading just
attestation Notes, skill delivery reading just the latest code Note.

**Decision: Start with archives for agent sessions.**

A session is a unit — you want it whole for search, recovery, and audit. Archive
is the right model. The Desktop archive pipeline handles encryption, IPFS,
credit management, and search indexing.

**Future: Add per-type KeyVaults when access patterns demand it.**

The contract already supports multiple KeyVaults per Secret. When we need:
- Providers reading just their receipts → receipts KeyVault (provider on team)
- Auditors reading just attestations → attestation KeyVault (auditor on team)
- Owner delivering code to agent → code KeyVault (owner writes, agent reads)
- Agent writing action hashes → action KeyVault (agent writes, settlement reads)

Each KeyVault has its own schema and team list. The Sovereign Secret becomes
a directory of KeyVaults, each with different access control:

```
Sovereign Secret (0x70b893...)
  ├── KV 0: Birth Certificate (owner + agent on team)
  ├── KV 1: Session Archives (owner only — archive blobs)
  ├── KV 2: Action Hashes (agent writes, owner reads)
  ├── KV 3: Receipts (agent + provider on team — bilateral)
  ├── KV 4: Code Delivery (owner writes, agent reads)
  └── KV 5: Attestations (agent writes, public reads)
```

This is the file-system model on top of the contract. Each KV is a channel
with its own team. Not needed today — sessions are the unit. But the contract
is ready for it, and the architecture scales when the access patterns arrive.

---

## Module Structure (v0.2.0)

No new archiver module. The existing `morpheus-agent.ts` settle() method:

1. Builds the session content string (markdown with full text)
2. Calls `create_archive` via Desktop MCP relay (same as current `agent_write_note`)
3. Records the archive address/ID as a Note on the Sovereign Secret
4. Resets session state

The Desktop handles encryption, IPFS, chain writes, credits, and async sync.
The agent just produces content and calls one tool.

---

## What Stays the Same

- `morpheus-types.ts` — no changes
- `morpheus-client.ts` — no changes (already captures full responses)
- `secure-channel.ts` — no changes
- `morpheus-mcp-tools.ts` — settle tool updated to include archive call
- `index.ts` — no changes

## What Changes in v0.2.0

- `morpheus-agent.ts`:
  - `inference()` now stores full prompt + response text in session state (not just hashes)
  - `settle()` builds markdown content string, calls `create_archive`, records pointer
  - New `sessionActions` array holds full action data until settlement
  - Archive policy field in birth certificate and per-action override

That's it. One file changes. The rest is existing infrastructure.
