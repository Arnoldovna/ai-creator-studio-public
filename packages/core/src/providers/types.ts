import type { z } from 'zod';
import type { ModelFamily } from '../router/registry';

export type ProviderName = 'mock' | 'anthropic' | 'openai' | 'openrouter';
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export interface ImageInput {
  mediaType: ImageMediaType;
  base64: string;
  label?: string;
}

/**
 * One turn of a chat (Etappe 15, E5). `user` turns are HER messages: instructions, like `instruction`. `assistant` turns
 * are earlier answers of the studio chat. Documents, references and transcripts never go here – they stay in
 * `untrustedContext` (wrapped in <untrusted_data>).
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface StructuredRequest<T> {
  agent: string;
  promptVersion: string;
  /** Trusted operator instructions. */
  system: string;
  /** Trusted task instruction. */
  instruction: string;
  /** Untrusted content (user notes, briefs, extracted text). Wrapped & labelled as data. */
  untrustedContext?: Record<string, unknown>;
  images?: ImageInput[];
  /**
   * Chat history ending with her current message (role `user`). Providers send it as alternating messages; the
   * instruction and the untrusted context are attached to the LAST user message (fresh studio state each turn).
   */
  conversation?: ConversationTurn[];
  schema: z.ZodType<T>;
  schemaName: string;
  /** Deterministic output used by the mock provider. */
  mock: () => T;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredResult<T> {
  output: T;
  provider: ProviderName;
  model: string;
  usage: Usage | null;
  costEstimateUsd: number | null;
  /** reported = billed cost from the gateway; tokens = computed from token usage × list price; worst_case = usage missing, conservative upper bound. */
  costSource?: 'reported' | 'tokens' | 'worst_case' | 'none';
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  readonly supportsVision: boolean;
  /** USD per 1M tokens; used for worst-case accounting when usage is missing. null = free (mock). */
  readonly pricing: { inputPerMTok: number; outputPerMTok: number } | null;
  /** Model family receiving the data (privacy allowlist for confidential client data); null = stays local. */
  readonly family: ModelFamily | null;
  generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export class ProviderError extends Error {
  /** `billed`: the model produced output (e.g. schema mismatch) – count a conservative cost. */
  constructor(message: string, readonly retryable = false, readonly billed = false) {
    super(message);
    this.name = 'ProviderError';
  }
}
