import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import { MockProvider } from './mock';
import { OpenAIProvider } from './openai';
import { MODEL_FAMILIES, type ModelFamily } from '../router/registry';
import type { LlmProvider, ProviderName } from './types';

export * from './types';
export { MockProvider } from './mock';
export { OpenRouterProvider } from './openrouter';
export { buildRequestSystem, buildSystem, buildUserText, chatMessages, CHAT_GUARD, renderUntrusted } from './prompt';

export interface ProviderConfig {
  requested: ProviderName;
  active: ProviderName;
  /** Fixed model for direct providers; 'router' when the model router chooses per use case. */
  model: string;
  /** Why the requested provider is not active (missing key / budget). */
  reason: string | null;
  monthlyBudgetUsd: number;
  /** Fraction of the budget at which the studio warns (default 0.8). */
  budgetWarnFraction: number;
  /** Hard cap for one Evaluation-Lab comparison run. */
  evalMaxUsdPerRun: number;
  /** Model families explicitly allowed to receive confidential UGC client data (strict ZDR only). */
  confidentialAllowedFamilies: ModelFamily[];
  /** Server-side only; never serialized to the client. */
  openrouterApiKey: string | null;
}

type Env = Record<string, string | undefined>;

const num = (v: string | undefined): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Resolve the provider from server env. Paid providers are only activated when
 * BOTH an API key and a positive AI_MONTHLY_BUDGET_USD are configured; otherwise
 * the studio stays in mock mode and says so.
 */
export function resolveProvider(env: Env): { provider: LlmProvider; config: ProviderConfig } {
  const requested = (['mock', 'anthropic', 'openai', 'openrouter'].includes(env.AI_PROVIDER ?? '') ? env.AI_PROVIDER : 'mock') as ProviderName;
  const budget = num(env.AI_MONTHLY_BUDGET_USD) ?? 0;
  const common = {
    monthlyBudgetUsd: budget,
    budgetWarnFraction: num(env.AI_BUDGET_WARN_FRACTION) ?? 0.8,
    evalMaxUsdPerRun: num(env.EVAL_MAX_USD_PER_RUN) ?? 0.5,
    confidentialAllowedFamilies: (env.CONFIDENTIAL_ALLOWED_FAMILIES ?? '').split(',').map((s) => s.trim()).filter((s): s is ModelFamily => (MODEL_FAMILIES as readonly string[]).includes(s)),
    openrouterApiKey: null,
  };
  const mock = new MockProvider();
  const fallback = (reason: string) => ({
    provider: mock,
    config: { ...common, requested, active: 'mock' as const, model: mock.model, reason },
  });
  if (requested === 'mock') return fallback('AI_PROVIDER=mock');
  if (budget <= 0) return fallback('Kein AI_MONTHLY_BUDGET_USD > 0 konfiguriert – kostenpflichtige Aufrufe sind gesperrt.');
  if (requested === 'openrouter') {
    if (!env.OPENROUTER_API_KEY) return fallback('OPENROUTER_API_KEY fehlt.');
    // The concrete model is chosen per call by the router; `provider` is only the offline default.
    return { provider: mock, config: { ...common, requested, active: 'openrouter', model: 'router', reason: null, openrouterApiKey: env.OPENROUTER_API_KEY } };
  }
  if (requested === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) return fallback('ANTHROPIC_API_KEY fehlt.');
    const model = env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL;
    const pin = num(env.ANTHROPIC_INPUT_USD_PER_MTOK), pout = num(env.ANTHROPIC_OUTPUT_USD_PER_MTOK);
    const p = new AnthropicProvider(env.ANTHROPIC_API_KEY, model, pin != null && pout != null ? [pin, pout] : undefined);
    return { provider: p, config: { ...common, requested, active: 'anthropic', model, reason: null } };
  }
  if (!env.OPENAI_API_KEY) return fallback('OPENAI_API_KEY fehlt.');
  if (!env.OPENAI_MODEL) return fallback('OPENAI_MODEL fehlt (bitte ein vision-fähiges Modell konfigurieren).');
  const pin = num(env.OPENAI_INPUT_USD_PER_MTOK), pout = num(env.OPENAI_OUTPUT_USD_PER_MTOK);
  if (pin == null || pout == null) return fallback('OPENAI_INPUT_USD_PER_MTOK / OPENAI_OUTPUT_USD_PER_MTOK fehlen – ohne Preise kann das Budget nicht geprüft werden.');
  const p = new OpenAIProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL, [pin, pout]);
  return { provider: p, config: { ...common, requested, active: 'openai', model: env.OPENAI_MODEL, reason: null } };
}
