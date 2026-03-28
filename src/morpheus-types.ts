/**
 * Morpheus Agent Data Wallet — Type Definitions
 *
 * All Note schemas for the agent wallet:
 *   - Birth Certificate (Note 0) — agent origin, parents, initial policy
 *   - Action Notes — inference calls, payments, outputs
 *   - Code Delivery Notes — skills, updates, removals
 *   - Settlement Notes — Merkle root of session, on-chain anchor
 *
 * Follows the same layered pattern as Agent TEE types:
 *   AGENT LAYER: birth cert, action logging, wallet-watch
 *   MORPHEUS LAYER: inference API, model routing, MOR economics
 */

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

/** Startup configuration — CLI args or env vars */
export interface MorpheusConfig {
  /** Morpheus inference API base URL */
  apiBaseUrl: string;
  /** Morpheus API key (Bearer token) */
  apiKey: string;
  /** Default model for inference calls */
  defaultModel: string;
  /** Agent's Sovereign Secret address (Polygon) */
  sovereignSecretAddress: string;
  /** KeyVault block on the Sovereign Secret */
  kvBlock: number;
  /** Polygon RPC URL */
  rpcUrl: string;
  /** Chain ID (137 = Polygon mainnet) */
  chainId: number;
  /** Key source for signing */
  keySource: 'relay' | 'env' | 'file';
  /** Desktop MCP relay URL (production) */
  relayUrl?: string;
  /** Use local mode (no gas, dev only) */
  local?: boolean;
  /** V7 Registry address for auto-funding Notes */
  registryAddress?: string;
  /** MCP transport mode */
  transport: 'stdio' | 'http';
  /** HTTP port if transport=http */
  httpPort?: number;
}

/** Morpheus API available models */
export type MorpheusModel =
  | 'kimi-k2.5'
  | 'glm-4.7'
  | 'glm-4.7-flash'
  | string; // Allow custom model IDs

// ═══════════════════════════════════════════════════════════════════
// BIRTH CERTIFICATE — Note 0 on Sovereign Secret
// ═══════════════════════════════════════════════════════════════════

/**
 * The birth certificate names the agent's two parents:
 *   1. The AI — which factory, model, provider, and TEE state at creation
 *   2. The Authorizer — which human, their wallet, their signature
 *
 * Follows TCG DICE: identity composed from layers (hardware → platform → agent → session).
 */
export interface BirthCertificate {
  type: 'morpheus-birth-certificate';
  version: '1.0';
  agent: {
    /** Agent wallet address (secp256k1) */
    address: string;
    /** BIP-32 derivation path from owner seed */
    derivationPath: string;
    /** ISO 8601 creation timestamp */
    created: string;
  };
  parents: {
    ai: {
      /** AI provider network */
      factory: string;
      /** Model used at creation */
      model: string;
      /** Provider wallet address (Morpheus provider) */
      provider?: string;
      /** TEE attestation quote hash at creation time */
      teeAttestation?: string;
      /** Morpheus API base URL */
      apiEndpoint: string;
    };
    authorizer: {
      /** Owner wallet address */
      address: string;
      /** Human-readable name */
      name?: string;
      /** Identity contract address (if using multi-device) */
      identityContract?: string;
      /** Owner's signature over the birth certificate content */
      signature: string;
    };
  };
  policy: {
    /** Daily spending allowance */
    dailyAllowance: number;
    /** Currency for allowance */
    currency: string;
    /** Approved models */
    models: string[];
    /** Agent scope description */
    scope: string;
  };
  /** NIST assurance level (0-4) */
  nistLevel: number;
  /** Key protection method */
  keyProtection: 'software' | 'tpm-sealed' | 'hsm' | 'mpc';
}

// ═══════════════════════════════════════════════════════════════════
// ACTION NOTES — Agent's chain of experience
// ═══════════════════════════════════════════════════════════════════

/** All possible action types */
export type ActionType =
  | 'inference'
  | 'payment'
  | 'output'
  | 'skill_installed'
  | 'skill_removed'
  | 'policy_updated'
  | 'attestation'
  | 'error';

/** Base fields shared by all action Notes */
export interface ActionNoteBase {
  type: 'morpheus-action';
  version: '1.0';
  action: ActionType;
  /** Hash of the previous Note (chain linkage) */
  previousHash: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent address (for verification) */
  agentAddress: string;
}

/** Inference call action */
export interface InferenceAction extends ActionNoteBase {
  action: 'inference';
  inference: {
    /** Model used */
    model: string;
    /** Prompt token count */
    promptTokens: number;
    /** Completion token count */
    completionTokens: number;
    /** Total tokens */
    totalTokens: number;
    /** SHA-256 hash of the prompt (never raw content) */
    promptHash: string;
    /** SHA-256 hash of the response */
    responseHash: string;
    /** Cost in model's native pricing */
    cost?: string;
    /** Morpheus session ID */
    sessionId?: string;
    /** Response latency in milliseconds */
    latencyMs: number;
  };
}

/** Payment action (MOR staking or x402) */
export interface PaymentAction extends ActionNoteBase {
  action: 'payment';
  payment: {
    /** Payment type */
    method: 'mor-stake' | 'x402' | 'credit-purchase';
    /** Amount (as string for precision) */
    amount: string;
    /** Token symbol */
    token: string;
    /** Recipient address */
    recipient: string;
    /** Transaction hash (if on-chain) */
    txHash?: string;
  };
}

/** Output action (signed work product) */
export interface OutputAction extends ActionNoteBase {
  action: 'output';
  output: {
    /** SHA-256 hash of the output content */
    contentHash: string;
    /** Content type */
    contentType: string;
    /** Size in bytes */
    sizeBytes: number;
    /** IPFS CID (if stored off-chain) */
    ipfsCid?: string;
  };
}

/** Skill installed via code delivery */
export interface SkillInstalledAction extends ActionNoteBase {
  action: 'skill_installed';
  skill: {
    name: string;
    version: string;
    codeHash: string;
    /** Address of the Note that delivered the code */
    deliveryNoteIndex: number;
  };
}

/** Skill removed */
export interface SkillRemovedAction extends ActionNoteBase {
  action: 'skill_removed';
  skill: {
    name: string;
    reason: string;
  };
}

/** Policy updated via owner Note */
export interface PolicyUpdatedAction extends ActionNoteBase {
  action: 'policy_updated';
  policyUpdate: {
    /** What changed */
    field: string;
    /** Previous value (hash if complex) */
    previousHash: string;
    /** New value (hash if complex) */
    newHash: string;
  };
}

/** TEE attestation recorded */
export interface AttestationAction extends ActionNoteBase {
  action: 'attestation';
  attestation: {
    /** TEE type */
    teeType: string;
    /** Policy hash at attestation time */
    policyHash: string;
    /** Chain Merkle root */
    chainRoot: string;
    /** Chain height */
    chainHeight: number;
    /** Attestation signature */
    signature: string;
  };
}

/** Error recorded */
export interface ErrorAction extends ActionNoteBase {
  action: 'error';
  error: {
    /** Error code */
    code: string;
    /** Error message (sanitized, no secrets) */
    message: string;
    /** Operation that failed */
    operation: string;
  };
}

/** Union of all action Note types */
export type ActionNote =
  | InferenceAction
  | PaymentAction
  | OutputAction
  | SkillInstalledAction
  | SkillRemovedAction
  | PolicyUpdatedAction
  | AttestationAction
  | ErrorAction;

// ═══════════════════════════════════════════════════════════════════
// CODE DELIVERY — Owner writes code to agent wallet
// ═══════════════════════════════════════════════════════════════════

/** Code delivery Note — owner writes to agent's Sovereign Secret */
export interface CodeDeliveryNote {
  type: 'morpheus-code';
  version: '1.0';
  action: 'install' | 'update' | 'remove';
  skill: {
    /** Skill name */
    name: string;
    /** Semantic version */
    version: string;
    /** SHA-256 hash of the code content */
    codeHash: string;
    /** Base64-encoded module (for install/update) */
    code?: string;
    /** Entry point file */
    entryPoint?: string;
  };
  /** Owner's signature over (name + version + codeHash) */
  ownerSignature: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════
// SETTLEMENT — Session Merkle root anchored on-chain
// ═══════════════════════════════════════════════════════════════════

/** Settlement Note — written at end of session or daily */
export interface SettlementNote {
  type: 'morpheus-settlement';
  version: '1.0';
  /** Range of action Notes covered */
  fromNoteIndex: number;
  toNoteIndex: number;
  /** Merkle root of all action Notes in range */
  merkleRoot: string;
  /** Number of actions settled */
  actionCount: number;
  /** Summary statistics */
  stats: {
    totalInferenceCalls: number;
    totalTokens: number;
    totalPayments: string;
    modelsUsed: string[];
    errorsEncountered: number;
  };
  /** Policy hash at settlement time */
  policyHash: string;
  /** Agent address */
  agentAddress: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** TEE co-signature (if running in enclave) */
  teeSignature?: string;
}

// ═══════════════════════════════════════════════════════════════════
// WALLET-WATCH — Incoming Note types the agent processes
// ═══════════════════════════════════════════════════════════════════

/** Policy update Note — owner changes agent's limits */
export interface PolicyUpdateNote {
  type: 'morpheus-policy-update';
  version: '1.0';
  policy: Partial<BirthCertificate['policy']>;
  /** Owner's signature */
  ownerSignature: string;
  timestamp: string;
}

/** Revocation Note — owner kills the agent */
export interface RevocationNote {
  type: 'morpheus-revocation';
  version: '1.0';
  reason: string;
  /** Owner's signature */
  ownerSignature: string;
  timestamp: string;
}

/** Union of all Note types the agent watches for */
export type IncomingNote =
  | CodeDeliveryNote
  | PolicyUpdateNote
  | RevocationNote;

// ═══════════════════════════════════════════════════════════════════
// MORPHEUS API — OpenAI-compatible types
// ═══════════════════════════════════════════════════════════════════

/** Chat completion request (OpenAI-compatible) */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/** Chat message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Chat completion response (OpenAI-compatible) */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Model list response */
export interface ModelsResponse {
  object: 'list';
  data: {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }[];
}

// ═══════════════════════════════════════════════════════════════════
// SECURE CHANNEL — Signed prompts, signed responses, ECDH encryption
// ═══════════════════════════════════════════════════════════════════

/**
 * Provider manifest — collected from on-chain registration + TEE attestation.
 * This is the AI parent's identity document.
 */
export interface ProviderManifest {
  /** Provider wallet address (registered on BASE) */
  address: string;
  /** Provider endpoint URL */
  endpoint: string;
  /** MOR staked (proves economic commitment) */
  stake: string;
  /** On-chain registration block (BASE) */
  registeredAtBlock?: number;
  /** Models served by this provider */
  models: ProviderModel[];
  /** TEE attestation (if available) */
  tee?: {
    /** TEE type */
    type: 'intel-tdx' | 'amd-sev' | 'none';
    /** RTMR3 register value (software measurement) */
    rtmr3?: string;
    /** TLS certificate fingerprint (bound to reportdata) */
    tlsCertFingerprint?: string;
    /** Raw attestation quote hash */
    quoteHash?: string;
    /** When attestation was verified */
    verifiedAt: string;
  };
  /** When this manifest was collected */
  collectedAt: string;
  /** SHA-256 hash of the manifest (for signing) */
  manifestHash?: string;
}

/** Model registered by a provider */
export interface ProviderModel {
  /** Model identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** IPFS hash of model weights (proof of specific version) */
  ipfsHash?: string;
  /** Bid price (MOR per second) */
  bidPrice?: string;
}

/**
 * Signed envelope wrapping a prompt.
 * Agent signs the prompt hash — proves what was asked, by whom, when.
 */
export interface SignedPrompt {
  /** SHA-256 hash of the prompt content */
  promptHash: string;
  /** Monotonically increasing (replay protection) */
  nonce: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Agent wallet address */
  agentAddress: string;
  /** Provider address this prompt is directed to */
  providerAddress?: string;
  /** Model requested */
  model: string;
  /** Agent's secp256k1 signature over (promptHash + nonce + timestamp + model) */
  agentSignature: string;
}

/**
 * Signed envelope wrapping a response.
 * Provider signs the response hash — proves what was answered, by which model, when.
 */
export interface SignedResponse {
  /** SHA-256 hash of the response content */
  responseHash: string;
  /** Echo of the request's prompt hash (binds response to request) */
  promptHash: string;
  /** Model that generated the response */
  model: string;
  /** Token usage */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Provider wallet address */
  providerAddress: string;
  /** Provider's secp256k1 signature over (responseHash + promptHash + model + timestamp) */
  providerSignature: string;
}

/**
 * ECDH channel session between agent and provider.
 * Derived from both parties' secp256k1 keys.
 */
export interface ChannelSession {
  /** Agent wallet address */
  agentAddress: string;
  /** Agent's public key (compressed, hex) */
  agentPublicKey: string;
  /** Provider wallet address */
  providerAddress: string;
  /** Provider's public key (compressed, hex) */
  providerPublicKey: string;
  /** ECDH shared secret hash (keccak256 of raw shared point) — used to derive AES key */
  sessionKeyHash: string;
  /** When the channel was established */
  establishedAt: string;
  /** Provider manifest snapshot at channel establishment */
  providerManifest: ProviderManifest;
  /** Whether the provider's TEE attestation was verified */
  teeVerified: boolean;
}

/**
 * Channel-secured inference record.
 * Combines signed prompt + signed response + channel context.
 * This is the full proof: who asked, who answered, what was said, all signed.
 */
export interface SecuredInferenceRecord {
  /** The signed prompt */
  prompt: SignedPrompt;
  /** The signed response (null if provider doesn't sign) */
  response: SignedResponse | null;
  /** Channel session (null if no ECDH established) */
  channel: ChannelSession | null;
  /** Agent-side hashes (always available, even without provider cooperation) */
  agentProof: {
    promptHash: string;
    responseHash: string;
    agentSignature: string;
    timestamp: string;
  };
}

// ═══════════════════════════════════════════════════════════════════
// AGENT STATE
// ═══════════════════════════════════════════════════════════════════

/**
 * A recorded session action — stores full content for archiving.
 * Accumulated in memory during the session, archived at settlement.
 */
export interface SessionAction {
  /** Action index within this session (0-based) */
  index: number;
  /** Action type */
  action: ActionType;
  /** Full prompt text (for inference actions) */
  promptText?: string;
  /** System prompt text (for inference actions) */
  systemPromptText?: string;
  /** Full response text (for inference actions) */
  responseText?: string;
  /** Short topic summary (for search indexing) */
  topic?: string;
  /** Model used */
  model?: string;
  /** Token counts */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Latency in milliseconds */
  latencyMs?: number;
  /** Prompt hash (SHA-256) */
  promptHash: string;
  /** Response hash (SHA-256) */
  responseHash: string;
  /** Hash of previous action (chain linkage) */
  previousHash: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Archive policy for this action */
  archivePolicy: 'permanent' | 'standard' | 'redacted' | 'ephemeral';
}

/** Runtime state of the Morpheus agent */
export interface MorpheusAgentState {
  /** Whether the agent is initialized */
  initialized: boolean;
  /** Agent wallet address */
  agentAddress: string;
  /** Sovereign Secret address */
  sovereignSecretAddress: string;
  /** Current policy (from birth cert or latest update) */
  currentPolicy: BirthCertificate['policy'];
  /** Hash of previous Note (for chain linkage) */
  lastNoteHash: string;
  /** Number of Notes written this session */
  sessionNoteCount: number;
  /** Total inference calls this session */
  sessionInferenceCalls: number;
  /** Total tokens this session */
  sessionTotalTokens: number;
  /** Installed skills */
  installedSkills: Map<string, { version: string; codeHash: string }>;
  /** Whether a revocation has been received */
  revoked: boolean;
  /** Accumulated session actions — full content stored for archiving at settlement */
  sessionActions: SessionAction[];
  /** Session start time */
  sessionStartedAt: string;
  /** Default archive policy */
  defaultArchivePolicy: 'permanent' | 'standard' | 'redacted' | 'ephemeral';
}
