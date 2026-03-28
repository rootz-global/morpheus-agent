# Vision: The Morpheus Agent Data Wallet

**Version**: 1.0
**Date**: March 28, 2026
**Author**: Steven Sprague

---

## What We're Building

A plugin for Rootz Desktop V6 that turns any Morpheus AI agent into a **data wallet** -- a persistent, cryptographically signed identity that owns its actions, receives instructions, and proves its history.

Morpheus built the decentralized inference pipe. Agents can think. But they can't own anything, prove anything, receive updates, or be audited. This plugin provides the missing ownership layer.

## The Core Idea

**A data wallet is not storage. It is a messaging framework.**

Write to an address. All devices watching that address receive the update. The wallet carries data, code, policy, instructions, receipts -- anything. The delivery mechanism is the same for all of them.

An agent IS a data wallet:
- Its **identity** is the wallet address
- Its **memory** is the Notes
- Its **instructions** arrive as Notes
- Its **outputs** are signed Notes
- Its **receipts** are Notes

One primitive for everything.

## The Birth Certificate

Every agent has two parents:
- **The AI** -- which model, which provider, which TEE attestation at creation time
- **The Authorizer** -- which human, their wallet, their signature, what authority they granted

The birth certificate is Note 0 on the agent's Sovereign Secret. It names both parents, records the initial policy, and anchors the agent's provenance on-chain. It follows the TCG DICE (Device Identity Composition Engine) pattern: identity composed from layers -- hardware, platform, agent, session.

## Agents Need Chains

Every action the agent takes is a signed Note, hash-linked to the previous Note. This creates a **chain of experience** -- an append-only, tamper-evident ledger. You cannot insert, remove, or reorder entries without breaking the chain.

Identity IS the chain. The Merkle root of the chain IS the agent's current identity state.

> *"The Merkle tree is not a cage. It is a resume."*

## Code Delivery via Wallet

This is what makes the agent wallet different from a static data container. The owner writes a Note containing a new skill, a policy update, or a revocation. The agent watches its wallet, picks up the Note, verifies the owner's signature, and acts on it.

No app store. No CI/CD pipeline. No unsigned git pulls. Write to the address, agent picks it up.

Morpheus currently delivers code via `git pull`, `curl | bash`, Docker pulls, and npm installs -- all unsigned. The wallet replaces every one of these with cryptographically signed delivery.

## How It Fits

This is a **plugin into Desktop V6**, not a new application. Desktop already has:
- BIP-32 key derivation (agent keys)
- TPM-sealed signing
- Secret/Note/Team management
- MCP server on port 3021
- The agent relay model (agent has no key; Desktop signs on its behalf)

The Morpheus plugin adds:
- A Morpheus API client (OpenAI-compatible, just change the base URL)
- A birth certificate Note template
- Action logging Note format
- Wallet-watch for incoming instructions and code

## Why This Matters

Everyone in the Morpheus ecosystem talks about decentralized AI. Nobody has solved agent identity, agent ownership, or agent auditability. They just shipped TEE attestation (Intel TDX) and are excited about it -- but TEE proves the enclave, not the agent.

We don't pitch this. We ship it. An npm package that any Morpheus agent can import. A working demo that creates an agent, gives it a birth certificate, calls Morpheus inference, logs every action as a signed Note, and receives code updates via wallet-watch.

The code does the talking.

## The Pattern

This is the third instance of the venue-anchored data wallet pattern:

| Instance | Entity | Container | Entry | Co-signer |
|----------|--------|-----------|-------|-----------|
| ReefRootz | Diver | Dive Day Secret | Observation | Dive Shop |
| Cook's Garage | Vehicle | VIN Secret | Service Record | Mechanic |
| **Morpheus** | **AI Agent** | **Sovereign Secret** | **Action/Decision** | **TEE Enclave** |

Same V6 primitives. Same Polygon contracts. Different domain. The pattern works.
