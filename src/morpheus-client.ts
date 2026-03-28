/**
 * Morpheus Inference API Client
 *
 * OpenAI-compatible HTTP client for the Morpheus decentralized inference network.
 * Drop-in replacement: same endpoints, same request/response format.
 *
 * Usage:
 *   const client = new MorpheusClient({ apiBaseUrl: 'https://api.mor.org/api/v1', apiKey: '...' });
 *   const response = await client.chatCompletion({ model: 'kimi-k2.5', messages: [...] });
 */

import { createHash } from 'node:crypto';
import { SecureChannel } from './secure-channel.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelsResponse,
  MorpheusModel,
  SecuredInferenceRecord,
} from './morpheus-types.js';

export interface MorpheusClientConfig {
  /** Morpheus API base URL (default: https://api.mor.org/api/v1) */
  apiBaseUrl: string;
  /** Bearer token for authentication */
  apiKey: string;
  /** Default model (default: kimi-k2.5) */
  defaultModel?: MorpheusModel;
  /** Request timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
}

export class MorpheusClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private secureChannel: SecureChannel | null = null;

  constructor(config: MorpheusClientConfig) {
    // Normalize base URL — strip trailing slash
    this.baseUrl = config.apiBaseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ?? 'kimi-k2.5';
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  /** Attach a SecureChannel for signed inference. */
  setSecureChannel(channel: SecureChannel): void {
    this.secureChannel = channel;
  }

  /** Get the attached SecureChannel (if any). */
  getSecureChannel(): SecureChannel | null {
    return this.secureChannel;
  }

  /**
   * Send a chat completion request to Morpheus.
   * Returns the response plus timing metadata for action logging.
   */
  async chatCompletion(
    request: Partial<ChatCompletionRequest> & { messages: ChatCompletionRequest['messages'] }
  ): Promise<{
    response: ChatCompletionResponse;
    promptHash: string;
    responseHash: string;
    latencyMs: number;
    responseHeaders: Record<string, string>;
  }> {
    const fullRequest: ChatCompletionRequest = {
      model: request.model ?? this.defaultModel,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: false, // Non-streaming for action logging
    };

    // Hash the prompt for the action log (never store raw content)
    const promptHash = this.hashContent(JSON.stringify(fullRequest.messages));

    const startTime = Date.now();

    const { data: response, headers: responseHeaders } =
      await this.fetch<ChatCompletionResponse>(
        '/chat/completions',
        'POST',
        fullRequest
      );

    const latencyMs = Date.now() - startTime;

    // Hash the response content
    const responseContent = response.choices?.[0]?.message?.content ?? '';
    const responseHash = this.hashContent(responseContent);

    return { response, promptHash, responseHash, latencyMs, responseHeaders };
  }

  /**
   * Send a secured chat completion — signed prompt + hashed response + channel proof.
   * Uses the attached SecureChannel to create a full SecuredInferenceRecord.
   * Falls back to unsigned if no channel is attached.
   */
  async securedChatCompletion(
    request: Partial<ChatCompletionRequest> & { messages: ChatCompletionRequest['messages'] }
  ): Promise<{
    response: ChatCompletionResponse;
    record: SecuredInferenceRecord | null;
    promptHash: string;
    responseHash: string;
    latencyMs: number;
  }> {
    const result = await this.chatCompletion(request);

    let record: SecuredInferenceRecord | null = null;
    if (this.secureChannel) {
      const fullRequest: ChatCompletionRequest = {
        model: request.model ?? this.defaultModel,
        messages: request.messages,
        stream: false,
      };
      // Pass response headers to SecureChannel — Layer 2 reads provider signature from headers
      record = await this.secureChannel.buildSecuredRecord(
        fullRequest,
        result.response,
        result.responseHeaders
      );
    }

    return { ...result, record };
  }

  /**
   * List available models on the Morpheus network.
   */
  async listModels(): Promise<ModelsResponse> {
    const { data } = await this.fetch<ModelsResponse>('/models', 'GET');
    return data;
  }

  /**
   * Health check — verify the API is reachable and the key is valid.
   */
  async healthCheck(): Promise<{ ok: boolean; models: number; latencyMs: number }> {
    const startTime = Date.now();
    try {
      const models = await this.listModels();
      return {
        ok: true,
        models: models.data?.length ?? 0,
        latencyMs: Date.now() - startTime,
      };
    } catch {
      return { ok: false, models: 0, latencyMs: Date.now() - startTime };
    }
  }

  // ─── Private helpers ───────────────────────────────────────────

  private async fetch<T>(
    path: string,
    method: string,
    body?: unknown
  ): Promise<{ data: T; headers: Record<string, string> }> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await globalThis.fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => 'unknown');
        throw new Error(
          `Morpheus API error ${res.status}: ${res.statusText} — ${errorBody}`
        );
      }

      // Capture response headers (Layer 2: provider signature lives here)
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      const data = (await res.json()) as T;
      return { data, headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** SHA-256 hash of content — used for action logging (never store raw prompts/responses) */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
