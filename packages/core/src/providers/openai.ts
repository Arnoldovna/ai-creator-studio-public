import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { priceUsd } from '../router/registry';
import { buildRequestSystem, chatMessages } from './prompt';
import { ProviderError, type LlmProvider, type StructuredRequest, type StructuredResult } from './types';

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly family = 'openai' as const;
  readonly pricing: { inputPerMTok: number; outputPerMTok: number } | null;
  readonly supportsVision = true;
  private client: OpenAI;
  /** prices: USD per million tokens [input, output]; must be configured for cost estimates. */
  constructor(apiKey: string, readonly model: string, prices: [number, number] | null) {
    this.pricing = prices ? { inputPerMTok: prices[0], outputPerMTok: prices[1] } : null;
    this.client = new OpenAI({ apiKey });
  }

  async generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const turns = chatMessages(req);
    const final = turns.pop()!;
    const content: OpenAI.Responses.ResponseInputContent[] = [{ type: 'input_text', text: final.text }];
    for (const img of req.images ?? []) {
      if (img.label) content.push({ type: 'input_text', text: img.label });
      content.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}`, detail: 'auto' });
    }
    let res;
    try {
      res = await this.client.responses.parse({
        model: this.model,
        instructions: buildRequestSystem(req),
        input: [...turns.map((t) => ({ role: t.role, content: t.text })), { role: 'user', content }],
        max_output_tokens: req.maxTokens ?? 16000,
        text: { format: zodTextFormat(req.schema, req.schemaName) },
      });
    } catch (e) {
      if (e instanceof OpenAI.RateLimitError) throw new ProviderError('OpenAI: Rate limit erreicht', true);
      if (e instanceof OpenAI.AuthenticationError) throw new ProviderError('OpenAI: API-Key ungültig');
      if (e instanceof OpenAI.APIError) throw new ProviderError(`OpenAI API-Fehler ${e.status ?? ''}: ${e.message}`);
      throw e;
    }
    if (res.output_parsed == null) throw new ProviderError('OpenAI-Antwort entsprach nicht dem Schema oder wurde verweigert.');
    const usage = res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : null;
    return {
      output: res.output_parsed as T,
      provider: 'openai',
      model: res.model ?? this.model,
      usage,
      costEstimateUsd: usage && this.pricing ? priceUsd(this.pricing, usage.inputTokens, usage.outputTokens) : null,
      costSource: usage && this.pricing ? 'tokens' : 'none',
    };
  }
}
