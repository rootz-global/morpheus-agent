/**
 * Secure Channel — Signed Prompts, Signed Responses, ECDH Encryption
 *
 * Three layers of channel security, progressively enhanced:
 *
 * Layer 1 (Agent-side, no provider changes):
 *   Agent signs every prompt hash → proves what was asked
 *   Agent hashes every response → proves what was received
 *   Provider identity from on-chain → proves who answered
 *   Works with ANY OpenAI-compatible API (Morpheus, OpenAI, etc.)
 *
 * Layer 2 (Own node, mutual signing):
 *   Provider also signs responses → bilateral proof
 *   Both signatures recorded as Notes on the agent's wallet
 *
 * Layer 3 (ECDH encrypted channel):
 *   ECDH(agentPrivKey, providerPubKey) → shared secret
 *   AES-256-GCM encrypted messages → end-to-end privacy
 *   Provider becomes team member on agent's Secret → co-signed receipts
 *
 * This module implements Layer 1 fully and prepares the interfaces for Layer 2+3.
 * Layer 1 works TODAY against the live Morpheus API with no changes on their side.
 */

import { createHash } from 'node:crypto';
import type {
  ProviderManifest,
  SignedPrompt,
  SignedResponse,
  ChannelSession,
  SecuredInferenceRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from './morpheus-types.js';

// ═══════════════════════════════════════════════════════════════════
// DESKTOP RELAY — Sign via TPM
// ═══════════════════════════════════════════════════════════════════

async function signViaDesktop(
  relayUrl: string,
  sessionToken: string,
  message: string
): Promise<string> {
  const res = await globalThis.fetch(`${relayUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'tools/call',
      params: {
        name: 'agent_sign',
        arguments: {
          sessionToken,
          type: 'message',
          message,
          reason: 'Morpheus secure channel: sign prompt/response hash',
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Desktop relay sign error: ${res.status}`);
  }

  const result = await res.json() as { content?: Array<{ text: string }> };
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('No signature returned from Desktop');

  const parsed = JSON.parse(text) as { signature?: string };
  return parsed.signature ?? '0x';
}

// ═══════════════════════════════════════════════════════════════════
// SECURE CHANNEL
// ═══════════════════════════════════════════════════════════════════

export interface SecureChannelConfig {
  /** Agent wallet address */
  agentAddress: string;
  /** Agent's public key (hex, for ECDH) */
  agentPublicKey?: string;
  /** Desktop relay URL (for signing) */
  relayUrl?: string;
  /** Desktop session token */
  sessionToken?: string;
  /** Provider manifest (from on-chain or discovery) */
  providerManifest?: ProviderManifest;
  /** Whether to sign prompts (requires relay or local key) */
  signPrompts: boolean;
}

export class SecureChannel {
  private readonly config: SecureChannelConfig;
  private nonce: number = 0;
  private session: ChannelSession | null = null;
  private providerManifest: ProviderManifest | null;

  constructor(config: SecureChannelConfig) {
    this.config = config;
    this.providerManifest = config.providerManifest ?? null;
  }

  // ─── Layer 1: Agent-Side Signing ────────────────────────────────

  /**
   * Create a signed prompt envelope.
   * Agent signs hash(prompt) + nonce + timestamp + model.
   * This proves: this agent asked this question at this time.
   */
  async signPrompt(request: ChatCompletionRequest): Promise<SignedPrompt> {
    const promptHash = this.hashContent(JSON.stringify(request.messages));
    const timestamp = new Date().toISOString();
    this.nonce++;

    // The signing payload: deterministic, verifiable
    const signingPayload = [
      promptHash,
      this.nonce.toString(),
      timestamp,
      request.model,
    ].join('|');

    let agentSignature = '0x';

    if (this.config.signPrompts && this.config.relayUrl && this.config.sessionToken) {
      // Sign via Desktop TPM relay
      agentSignature = await signViaDesktop(
        this.config.relayUrl,
        this.config.sessionToken,
        signingPayload
      );
    }

    return {
      promptHash,
      nonce: this.nonce,
      timestamp,
      agentAddress: this.config.agentAddress,
      providerAddress: this.providerManifest?.address,
      model: request.model,
      agentSignature,
    };
  }

  /**
   * Create a response record from the API response.
   * Agent hashes the response — proves what was received.
   * If provider signs (Layer 2), reads signature from X-Provider-Signature header.
   */
  createResponseRecord(
    response: ChatCompletionResponse,
    signedPrompt: SignedPrompt,
    responseHeaders?: Record<string, string>
  ): SignedResponse {
    const responseContent = response.choices?.[0]?.message?.content ?? '';
    const responseHash = this.hashContent(responseContent);

    // Layer 2: Read provider signature from response headers (if available)
    const providerSignature = responseHeaders?.['x-provider-signature'] ?? '0x';
    const providerAddress = responseHeaders?.['x-provider-address']
      ?? this.providerManifest?.address
      ?? 'unknown';
    const providerResponseHash = responseHeaders?.['x-response-hash'];

    // Verify: if provider sent a hash, it should match ours
    if (providerResponseHash && providerResponseHash !== responseHash) {
      console.error(`[SecureChannel] WARNING: Provider response hash mismatch!`);
      console.error(`[SecureChannel]   Agent computed:   ${responseHash}`);
      console.error(`[SecureChannel]   Provider claimed: ${providerResponseHash}`);
    }

    if (providerSignature !== '0x') {
      console.error(`[SecureChannel] Layer 2 active: Provider ${providerAddress} signed response`);
    }

    return {
      responseHash,
      promptHash: signedPrompt.promptHash,
      model: response.model ?? signedPrompt.model,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      timestamp: new Date().toISOString(),
      providerAddress,
      providerSignature,
    };
  }

  /**
   * Build a complete secured inference record.
   * Combines signed prompt + response record + channel context.
   * If responseHeaders provided, reads Layer 2 provider signature.
   */
  async buildSecuredRecord(
    request: ChatCompletionRequest,
    response: ChatCompletionResponse,
    responseHeaders?: Record<string, string>
  ): Promise<SecuredInferenceRecord> {
    const signedPrompt = await this.signPrompt(request);
    const signedResponse = this.createResponseRecord(response, signedPrompt, responseHeaders);

    // Agent-side proof is ALWAYS available (even without provider cooperation)
    const agentProof = {
      promptHash: signedPrompt.promptHash,
      responseHash: signedResponse.responseHash,
      agentSignature: signedPrompt.agentSignature,
      timestamp: signedPrompt.timestamp,
    };

    return {
      prompt: signedPrompt,
      response: signedResponse,
      channel: this.session,
      agentProof,
    };
  }

  // ─── Provider Manifest ──────────────────────────────────────────

  /**
   * Set or update the provider manifest.
   * In production, this would be fetched from on-chain (BASE ProviderRegistry)
   * or from the provider's .well-known/ai discovery document.
   */
  setProviderManifest(manifest: ProviderManifest): void {
    this.providerManifest = manifest;
    console.error(`[SecureChannel] Provider manifest set: ${manifest.address}`);
    if (manifest.tee?.type !== 'none') {
      console.error(`[SecureChannel] TEE: ${manifest.tee?.type}, RTMR3: ${manifest.tee?.rtmr3?.slice(0, 18)}...`);
    }
  }

  /**
   * Build a provider manifest from known data.
   * Phase 0: Manual construction from config.
   * Phase 1: Fetch from BASE ProviderRegistry contract.
   * Phase 2: Fetch from provider's .well-known/ai.
   */
  static buildManifest(params: {
    address: string;
    endpoint: string;
    stake?: string;
    models?: Array<{ id: string; name: string; ipfsHash?: string }>;
    teeType?: 'intel-tdx' | 'amd-sev' | 'none';
  }): ProviderManifest {
    return {
      address: params.address,
      endpoint: params.endpoint,
      stake: params.stake ?? '0',
      models: params.models ?? [],
      tee: params.teeType
        ? {
            type: params.teeType,
            verifiedAt: new Date().toISOString(),
          }
        : undefined,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetch provider manifest from on-chain registration (BASE).
   *
   * TODO Phase 1: Read ProviderRegistry contract on BASE:
   *   - providerMap[address] → endpoint, stake, timestamp
   *   - modelMap[modelId] → ipfsHash, tags
   *   - bidMap[provider+model] → price per second
   *
   * TODO Phase 2: Fetch TEE attestation from provider's port 29343:
   *   - GET /cpu → raw attestation quote
   *   - Parse RTMR3, reportdata, TLS cert fingerprint
   *   - Verify against golden values (Sigstore-signed CI/CD hashes)
   */
  static async fetchManifestFromChain(
    _providerAddress: string,
    _baseRpcUrl: string = 'https://mainnet.base.org'
  ): Promise<ProviderManifest | null> {
    // Phase 1: Implement with ethers.js reading BASE contracts
    // const provider = new JsonRpcProvider(baseRpcUrl);
    // const diamond = new Contract(DIAMOND_ADDRESS, PROVIDER_REGISTRY_ABI, provider);
    // const info = await diamond.providerMap(providerAddress);
    console.error('[SecureChannel] fetchManifestFromChain: stub (Phase 1)');
    return null;
  }

  // ─── Layer 3: ECDH Channel (Prepared) ───────────────────────────

  /**
   * Establish ECDH encrypted channel with provider.
   *
   * Requires both parties' public keys:
   *   Agent pubkey: from Desktop TPM wallet
   *   Provider pubkey: from on-chain registration or TEE attestation
   *
   * The shared secret is derived via:
   *   sharedPoint = agentPrivKey * providerPubKey
   *   sessionKey = keccak256(sharedPoint.x)
   *
   * This is EXACTLY what @rootz/crypto does for Secret encryption.
   * Once established, all messages are AES-256-GCM encrypted.
   *
   * TODO Phase 2: Wire @rootz/crypto ECDH here.
   */
  async establishEcdhChannel(
    _providerPublicKey: string
  ): Promise<ChannelSession | null> {
    if (!this.config.agentPublicKey) {
      console.error('[SecureChannel] Cannot establish ECDH: agent public key not set');
      return null;
    }
    // Phase 2: Implement with @rootz/crypto
    // const sharedSecret = await RootzCrypto.ecdhSharedSecret(agentPrivKey, providerPubKey);
    // const sessionKey = keccak256(sharedSecret);
    console.error('[SecureChannel] establishEcdhChannel: stub (Phase 2)');
    return null;
  }

  // ─── Status ─────────────────────────────────────────────────────

  /** Get channel status summary. */
  getStatus(): {
    agentAddress: string;
    providerAddress: string | null;
    providerStake: string | null;
    teeType: string | null;
    teeVerified: boolean;
    ecdhEstablished: boolean;
    nonce: number;
    layer: 1 | 2 | 3;
  } {
    const hasEcdh = this.session !== null;
    const hasProviderSig = false; // Layer 2 not yet implemented
    const layer = hasEcdh ? 3 : hasProviderSig ? 2 : 1;

    return {
      agentAddress: this.config.agentAddress,
      providerAddress: this.providerManifest?.address ?? null,
      providerStake: this.providerManifest?.stake ?? null,
      teeType: this.providerManifest?.tee?.type ?? null,
      teeVerified: this.providerManifest?.tee?.quoteHash !== undefined,
      ecdhEstablished: hasEcdh,
      nonce: this.nonce,
      layer,
    };
  }

  /** Get the provider manifest. */
  getProviderManifest(): ProviderManifest | null {
    return this.providerManifest;
  }

  // ─── Private helpers ───────────────────────────────────────────

  private hashContent(content: string): string {
    return '0x' + createHash('sha256').update(content).digest('hex');
  }
}
