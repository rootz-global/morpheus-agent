/**
 * Provider Manifest Collector
 *
 * Reads provider identity from the Morpheus Diamond Proxy on BASE.
 * Collects: wallet address, endpoint, stake, models, bid prices.
 *
 * Diamond Proxy (BASE Mainnet): 0x6aBE1d282f72B474E54527D93b979A4f64d3030a
 * Contains facets: ProviderRegistry, ModelRegistry, Marketplace, SessionRouter
 *
 * This gives us the AI parent's on-chain identity for the birth certificate
 * and SecureChannel provider manifest.
 */

import { ethers } from 'ethers';
import type { ProviderManifest, ProviderModel } from './morpheus-types.js';

// ═══════════════════════════════════════════════════════════════════
// BASE CHAIN CONSTANTS
// ═══════════════════════════════════════════════════════════════════

/** BASE Mainnet chain ID */
export const BASE_CHAIN_ID = 8453;

/** BASE Mainnet RPC */
export const BASE_RPC_URL = 'https://mainnet.base.org';

/** Morpheus Diamond Proxy on BASE */
export const DIAMOND_ADDRESS = '0x6aBE1d282f72B474E54527D93b979A4f64d3030a';

/** ERC-8004 Agent Registry on BASE */
export const AGENT_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

/** MOR Token on BASE */
export const MOR_TOKEN_ADDRESS = '0x7431aDa8a591C955a994a21710752EF9b882b8e3';

// ═══════════════════════════════════════════════════════════════════
// MINIMAL ABIs — Only the functions we need to read provider data
// ═══════════════════════════════════════════════════════════════════

/** ProviderRegistry facet — provider info */
const PROVIDER_REGISTRY_ABI = [
  'function providerMap(address provider) view returns (string endpoint, uint256 stake, uint128 createdAt, bool isDeleted)',
  'function getActiveProviders(uint256 offset, uint8 limit) view returns (address[] memory, tuple(string endpoint, uint256 stake, uint128 createdAt, bool isDeleted)[] memory)',
];

/** ModelRegistry facet — model info */
const MODEL_REGISTRY_ABI = [
  'function modelMap(bytes32 modelId) view returns (bytes32 ipfsCID, uint256 fee, uint256 stake, address owner, string name, string[] tags, uint128 createdAt, bool isDeleted)',
];

/** Marketplace facet — bid info */
const MARKETPLACE_ABI = [
  'function bidMap(bytes32 bidId) view returns (address provider, bytes32 modelId, uint256 pricePerSecond, uint256 nonce, uint128 createdAt, uint128 deletedAt)',
];

// ═══════════════════════════════════════════════════════════════════
// MANIFEST COLLECTOR
// ═══════════════════════════════════════════════════════════════════

export interface ManifestCollectorConfig {
  /** BASE RPC URL (default: https://mainnet.base.org) */
  baseRpcUrl?: string;
  /** Diamond proxy address (default: mainnet) */
  diamondAddress?: string;
}

/**
 * Collect a provider's manifest from the BASE chain.
 *
 * Reads:
 *   - Provider registration (endpoint, stake, creation time)
 *   - Active model bids (which models at what price)
 *
 * Returns a ProviderManifest ready for use in SecureChannel.
 */
export async function collectProviderManifest(
  providerAddress: string,
  config?: ManifestCollectorConfig
): Promise<ProviderManifest | null> {
  const rpcUrl = config?.baseRpcUrl ?? BASE_RPC_URL;
  const diamondAddr = config?.diamondAddress ?? DIAMOND_ADDRESS;

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Read provider registration
    const registry = new ethers.Contract(diamondAddr, PROVIDER_REGISTRY_ABI, provider);
    const providerInfo = await registry.providerMap(providerAddress);

    if (!providerInfo || providerInfo.isDeleted) {
      console.error(`[Manifest] Provider ${providerAddress} not found or deleted on BASE`);
      return null;
    }

    const endpoint = providerInfo.endpoint;
    const stake = ethers.formatEther(providerInfo.stake);
    const createdAt = Number(providerInfo.createdAt);

    console.error(`[Manifest] Provider found: ${providerAddress}`);
    console.error(`[Manifest]   Endpoint: ${endpoint}`);
    console.error(`[Manifest]   Stake: ${stake} MOR`);
    console.error(`[Manifest]   Registered at block: ${createdAt}`);

    const manifest: ProviderManifest = {
      address: providerAddress,
      endpoint,
      stake: `${stake} MOR`,
      registeredAtBlock: createdAt,
      models: [], // TODO: query active bids for this provider
      collectedAt: new Date().toISOString(),
    };

    return manifest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Manifest] Error collecting manifest: ${message}`);
    return null;
  }
}

/**
 * List active providers on the Morpheus network.
 * Returns up to `limit` providers starting from `offset`.
 */
export async function listActiveProviders(
  offset: number = 0,
  limit: number = 10,
  config?: ManifestCollectorConfig
): Promise<Array<{ address: string; endpoint: string; stake: string }>> {
  const rpcUrl = config?.baseRpcUrl ?? BASE_RPC_URL;
  const diamondAddr = config?.diamondAddress ?? DIAMOND_ADDRESS;

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const registry = new ethers.Contract(diamondAddr, PROVIDER_REGISTRY_ABI, provider);

    const [addresses, infos] = await registry.getActiveProviders(offset, limit);

    const providers = [];
    for (let i = 0; i < addresses.length; i++) {
      providers.push({
        address: addresses[i],
        endpoint: infos[i].endpoint,
        stake: ethers.formatEther(infos[i].stake),
      });
    }

    console.error(`[Manifest] Found ${providers.length} active providers`);
    return providers;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Manifest] Error listing providers: ${message}`);
    return [];
  }
}

/**
 * Fetch TEE attestation from a provider's attestation endpoint.
 *
 * Morpheus TEE providers expose attestation on port 29343:
 *   GET https://{endpoint}:29343/cpu → raw attestation quote
 *
 * TODO Phase 2: Parse the quote, extract RTMR3, verify against
 * golden values from Sigstore-signed CI/CD hashes.
 */
export async function fetchTeeAttestation(
  providerEndpoint: string
): Promise<{ type: string; quoteHash: string } | null> {
  try {
    // TEE attestation is on port 29343
    const attestUrl = providerEndpoint.replace(/:(\d+)/, ':29343') + '/cpu';
    const res = await globalThis.fetch(attestUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const quote = await res.text();
    const quoteHash = '0x' + (await import('node:crypto'))
      .createHash('sha256').update(quote).digest('hex');

    console.error(`[Manifest] TEE attestation fetched, quote hash: ${quoteHash.slice(0, 18)}...`);

    return {
      type: 'intel-tdx', // Morpheus uses TDX
      quoteHash,
    };
  } catch {
    console.error(`[Manifest] TEE attestation not available at ${providerEndpoint}`);
    return null;
  }
}
