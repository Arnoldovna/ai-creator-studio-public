import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { priceUsd } from '../router/registry';
import { buildRequestSystem, chatMessages } from './prompt';
import { ProviderError, type LlmProvider, type StructuredRequest, type StructuredResult } from './types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
/** USD per million tokens (input, output) for cost estimates; override via env. */
const DEFAULT_PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly family = 'anthropic' as const;
  readonly pricing: { inputPerMTok: number; outputPerMTok: number };
  readonly supportsVision = true;
  private client: Anthropic;
  constructor(apiKey: string, readonly model: string = ANTHROPIC_DEFAULT_MODEL, prices?: [number, number]) {
    this.client = new Anthropic({ apiKey });
    const [inputPerMTok, outputPerMTok] = prices ?? DEFAULT_PRICES[model] ?? [4, 20];
    this.pricing = { inputPerMTok, outputPerMTok };
  }

  async generate<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // earlier chat turns as plain text; images, instruction and untrusted context go with the final user message
    const turns = chatMessages(req);
    const final = turns.pop()!;
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const img of req.images ?? []) {
      if (img.label) content.push({ type: 'text', text: img.label });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    }
    content.push({ type: 'text', text: final.text });
    const messages: Anthropic.Beta.BetaMessageParam[] = [...turns.map((t) => ({ role: t.role, content: t.text })), { role: 'user', content }];

    let msg;
    try {
      msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        // Refusal fallback: on a policy decline the API reruns on a fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: betaZodOutputFormat(req.schema) },
        system: buildRequestSystem(req),
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) throw new ProviderError('Anthropic: Rate limit erreicht', true);
      if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('Anthropic: API-Key ungültig');
      if (e instanceof Anthropic.APIConnectionError) throw new ProviderError('Anthropic: Verbindung fehlgeschlagen', true);
      if (e instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API-Fehler ${e.status ?? ''}: ${e.message}`, (e.status ?? 0) >= 500);
      throw e;
    }
    if (msg.stop_reason === 'refusal') throw new ProviderError('Anthropic hat die Anfrage abgelehnt (refusal).');
    if (msg.stop_reason === 'max_tokens') throw new ProviderError('Antwort abgeschnitten (max_tokens).', true);
    if (msg.parsed_output == null) throw new ProviderError('Antwort entsprach nicht dem Schema.');
    const usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
    return {
      output: msg.parsed_output as T,
      provider: 'anthropic',
      model: msg.model ?? this.model,
      usage,
      costEstimateUsd: priceUsd(this.pricing, usage.inputTokens, usage.outputTokens),
      costSource: 'tokens',
    };
  }
}
