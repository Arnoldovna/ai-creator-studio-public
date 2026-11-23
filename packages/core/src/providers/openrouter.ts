import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { APICallError, generateText, NoObjectGeneratedError, Output } from 'ai';
import { priceUsd, type ModelEntry } from '../router/registry';
import { buildRequestSystem, chatMessages } from './prompt';
import { ProviderError, type LlmProvider, type StructuredRequest, type StructuredResult } from './types';

export interface OpenRouterCallOptions {
  /** Confidential data: restrict to strict zero-data-retention endpoints of this model. */
  confidential: boolean;
  /** Output cap from the routing policy (the router's worst case assumes exactly this). */
  maxOutputTokens: number;
  /** Router's worst-case cost for this call; recorded when the gateway reports no usage. */
  worstCaseUsd: number;
  /** Test seam: custom fetch (no network in tests). */
  fetch?: typeof fetch;
}

/**
 * One adapter for every registry model via OpenRouter (Vercel AI SDK 7, `generateText` + `Output.object`).
 * Privacy: never lets providers collect data for training; confidential calls are pinned to the model's
 * strict-ZDR endpoints (no safety retention) and may not fall back to other endpoints.
 * Gateway-level retries are disabled – fallbacks are decided by our router, not silently by the SDK.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter' as const;
  readonly supportsVision: boolean;
  readonly model: string;
  readonly pricing: ModelEntry['pricing'];
  readonly family: ModelEntry['family'];
  private client: ReturnType<typeof createOpenRouter>;

  constructor(apiKey: string, private entry: ModelEntry, private opts: OpenRouterCallOptions) {
    this.client = createOpenRouter({ apiKey, compatibility: 'strict', fetch: opts.fetch });
    this.model = entry.id;
    this.pricing = entry.pricing;
    this.family = entry.family;
    this.supportsVision = entry.gatewayInput.includes('image');
  }

  async generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const turns = chatMessages(req);
    const final = turns.pop()!;
    const content: ({ type: 'text'; text: string } | { type: 'file'; mediaType: string; data: string })[] = [];
    for (const img of req.images ?? []) {
      if (img.label) content.push({ type: 'text', text: img.label });
      content.push({ type: 'file', mediaType: img.mediaType, data: img.base64 });
    }
    content.push({ type: 'text', text: final.text });
    const { maxOutputTokens } = this.opts;
    const provider = this.opts.confidential
      ? { data_collection: 'deny' as const, zdr: true, only: this.entry.privacy.strictZdrProviders, allow_fallbacks: false, require_parameters: true }
      : { data_collection: 'deny' as const, require_parameters: true };

    let result;
    try {
      result = await generateText({
        model: this.client.chat(this.entry.id, { usage: { include: true } }),
        instructions: buildRequestSystem(req),
        messages: [...turns.map((t) => ({ role: t.role, content: t.text })), { role: 'user' as const, content }],
        output: Output.object({ schema: req.schema, name: req.schemaName }),
        maxOutputTokens,
        maxRetries: 0,
        providerOptions: { openrouter: { provider } },
      });
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e)) throw new ProviderError(`${this.entry.label}: Antwort entsprach nicht dem Schema.`, true, true);
      if (APICallError.isInstance(e)) {
        const status = e.statusCode ?? 0;
        if (status === 401 || status === 403) throw new ProviderError('OpenRouter: API-Key ungültig oder ohne Berechtigung.');
        if (status === 402) throw new ProviderError('OpenRouter: Guthaben aufgebraucht.');
        throw new ProviderError(`OpenRouter ${status || ''} (${this.entry.label}): ${e.message.slice(0, 200)}`, e.isRetryable || status === 404 || status === 429 || status >= 500);
      }
      // network failure, timeout, malformed gateway response: nothing usable came back → try a fallback
      throw new ProviderError(`OpenRouter (${this.entry.label}): ${(e as Error).message.slice(0, 200)}`, true);
    }

    // The SDK reports 0/0 when the gateway sent no usage – a real completion always has output tokens.
    const { inputTokens, outputTokens } = result.usage;
    const usage = inputTokens != null && outputTokens ? { inputTokens, outputTokens } : null;
    const reported = (result.finalStep.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined)?.usage?.cost;
    // Cost: billed amount if reported; else tokens × list price; else the router's conservative upper bound.
    const [costEstimateUsd, costSource] = typeof reported === 'number'
      ? [reported, 'reported' as const]
      : usage
        ? [priceUsd(this.pricing, usage.inputTokens, usage.outputTokens), 'tokens' as const]
        : [this.opts.worstCaseUsd, 'worst_case' as const];
    return { output: result.output as T, provider: 'openrouter', model: this.entry.id, usage, costEstimateUsd, costSource };
  }
}
