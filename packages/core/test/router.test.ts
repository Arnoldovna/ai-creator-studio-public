import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenRouterProvider } from '../src/providers/openrouter';
import { ROUTING_POLICIES, USE_CASES } from '../src/router/policies';
import { findModel, MODEL_REGISTRY } from '../src/router/registry';
import { MIN_RATINGS_FOR_ROUTING, routeModel, type RouteRequest } from '../src/router/select';

const base: Omit<RouteRequest, 'useCase'> = {
  availableGateways: ['openrouter'], confidential: false, confidentialAllowedFamilies: [], budgetRemainingUsd: 15,
};

describe('model registry', () => {
  it('documents every model with verification date, prices and separated capabilities', () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.pricing.inputPerMTok).toBeGreaterThan(0);
      // gateway path never claims more than the model itself accepts
      for (const x of m.gatewayInput) expect(m.model.inputModalities).toContain(x);
      for (const b of Object.values(m.benchmarks)) if (b) expect(b.source).toMatch(/arena\.ai/);
    }
  });
  it('video-capable models are still reached via keyframe images only', () => {
    const gemini = findModel('google/gemini-3.8-flash')!;
    expect(gemini.model.inputModalities).toContain('video');
    expect(gemini.gatewayInput).not.toContain('video');
  });
  it('has a policy for every use case', () => {
    for (const u of USE_CASES) {
      const p = ROUTING_POLICIES[u];
      const w = Object.values(p.benchmarkWeights).reduce((a, b) => a + b, 0);
      expect(w).toBeCloseTo(1);
      expect(Object.values(p.evalWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    }
  });
});

describe('routeModel', () => {
  it('is deterministic and explains its choice', () => {
    const a = routeModel({ ...base, useCase: 'reference_image_analysis' });
    const b = routeModel({ ...base, useCase: 'reference_image_analysis' });
    expect(a.chosen?.id).toBe(b.chosen?.id);
    expect(a.reasons.length).toBeGreaterThan(0);
    expect(a.fallbacks.map((f) => f.id)).not.toContain(a.chosen!.id);
  });

  it('picks different models for different tasks', () => {
    const chosen = new Set(USE_CASES.map((u) => routeModel({ ...base, useCase: u }).chosen?.id));
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('prefers a cheaper model when it is within the quality tolerance', () => {
    const d = routeModel({ ...base, useCase: 'reference_image_analysis' });
    const best = [d.chosen!, ...d.fallbacks].sort((x, y) => (y.quality ?? 0) - (x.quality ?? 0))[0]!;
    expect(d.chosen!.estCostUsd).toBeLessThanOrEqual(best.estCostUsd);
    expect(d.chosen!.quality!).toBeGreaterThanOrEqual(best.quality! - ROUTING_POLICIES.reference_image_analysis.qualityTolerance);
  });

  it('treats Meta like any other provider: evidence decides, not the brand', () => {
    // Llama 4 (older, weak benchmarks) never wins; Muse Spark 1.3 competes on its arena scores.
    for (const u of USE_CASES) expect(routeModel({ ...base, useCase: u }).chosen?.id).not.toMatch(/^meta-llama\//);
    const muse = routeModel({ ...base, useCase: 'growth_analysis' });
    expect([muse.chosen, ...muse.fallbacks].some((c) => c?.id === 'meta/muse-spark-1.3') || muse.rejected.every((r) => r.id !== 'meta/muse-spark-1.3')).toBe(true);
  });

  it('blocks confidential client data unless the family is explicitly allowed and has strict ZDR endpoints', () => {
    const none = routeModel({ ...base, useCase: 'ugc_scriptwriting', confidential: true });
    expect(none.chosen).toBeNull();
    const allowed = routeModel({ ...base, useCase: 'ugc_scriptwriting', confidential: true, confidentialAllowedFamilies: ['anthropic', 'google'] });
    expect(allowed.chosen?.id).toMatch(/^anthropic\//);
    for (const c of [allowed.chosen!, ...allowed.fallbacks]) expect(findModel(c.id)!.privacy.strictZdrProviders.length).toBeGreaterThan(0);
    expect(allowed.rejected.find((r) => r.id === 'google/gemini-3.8-flash')?.reason).toMatch(/ohne Datenspeicherung/);
  });

  it('respects the remaining budget (worst case)', () => {
    const d = routeModel({ ...base, useCase: 'reference_video_analysis', budgetRemainingUsd: 0.01 });
    for (const c of [d.chosen, ...d.fallbacks].filter(Boolean)) expect(c!.worstCaseCostUsd).toBeLessThanOrEqual(0.01);
    expect(d.rejected.some((r) => /Restbudget/.test(r.reason))).toBe(true);
  });

  it('uses the pinned model when eligible and says why', () => {
    const d = routeModel({ ...base, useCase: 'content_strategy', preferredModelId: 'openai/gpt-6.1-sol' });
    expect(d.chosen?.id).toBe('openai/gpt-6.1-sol');
    expect(d.reasons[0]).toMatch(/festgelegt/);
  });

  it('ignores user ratings below the minimum and uses them once there are enough', () => {
    const cheapWinner = routeModel({ ...base, useCase: 'content_strategy' }).chosen!.id;
    const other = 'openai/gpt-6.1-sol';
    const few = routeModel({ ...base, useCase: 'content_strategy', userStats: { [other]: { n: 1, mean: 1 }, [cheapWinner]: { n: 1, mean: 0 } } });
    expect(few.chosen!.id).toBe(cheapWinner);
    const n = MIN_RATINGS_FOR_ROUTING * 3;
    const many = routeModel({ ...base, useCase: 'content_strategy', userStats: { [other]: { n, mean: 1 }, [cheapWinner]: { n, mean: 0.1 } } });
    expect(many.chosen!.id).toBe(other);
    expect(many.reasons[0]).toMatch(/Bewertungen/);
  });

  it('without a gateway the decision is still computed (preview), never with a cost limit', () => {
    const d = routeModel({ ...base, availableGateways: [], budgetRemainingUsd: Infinity, useCase: 'growth_analysis' });
    expect(d.chosen).not.toBeNull();
  });

  it('rejections carry machine-readable codes', () => {
    const d = routeModel({ ...base, useCase: 'ugc_scriptwriting', confidential: true, budgetRemainingUsd: 0.0001 });
    const codes = new Set(d.rejected.map((r) => r.code));
    expect(codes.has('confidential_family')).toBe(true);
  });

  it('cost bounds grow with the real request size', () => {
    const small = routeModel({ ...base, useCase: 'content_strategy' }).chosen!;
    const big = routeModel({ ...base, useCase: 'content_strategy', size: { inputTokens: 40_000 } }).chosen!;
    const sameModel = routeModel({ ...base, useCase: 'content_strategy', size: { inputTokens: 40_000 }, preferredModelId: small.id }).chosen!;
    expect(sameModel.worstCaseCostUsd).toBeGreaterThan(small.worstCaseCostUsd);
    expect(big).toBeDefined();
  });
});

describe('OpenRouterProvider (fake fetch, no network)', () => {
  const schema = z.object({ title: z.string() });
  const req = { agent: 't', promptVersion: 'p', system: 'sys', instruction: 'do', schema, schemaName: 'T', mock: () => ({ title: 'x' }) };
  const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const completion = (content: string, usage: Record<string, number>) => ({
    id: 'gen-1', object: 'chat.completion', created: 1, model: 'anthropic/claude-sonnet-5.5',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage,
  });

  it('sends privacy routing + schema and reads the billed cost', async () => {
    let sent: Record<string, unknown> = {};
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return respond(completion('{"title":"Hallo"}', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0123 }))();
    }) as typeof fetch;
    const p = new OpenRouterProvider('k', findModel('anthropic/claude-sonnet-5.5')!, { confidential: true, maxOutputTokens: 1234, worstCaseUsd: 0.05, fetch: fetchFn });
    const r = await p.generate(req);
    expect(r.output).toEqual({ title: 'Hallo' });
    expect(r.costEstimateUsd).toBe(0.0123);
    expect(r.costSource).toBe('reported');
    expect(sent.provider).toMatchObject({ data_collection: 'deny', zdr: true, only: ['google-vertex'], allow_fallbacks: false, require_parameters: true });
    expect(JSON.stringify(sent.response_format)).toContain('json_schema');
    expect(sent.max_tokens).toBe(1234); // policy cap, not a hidden default
  });

  it('records the router worst case when no usage is reported', async () => {
    const noUsage = { ...completion('{"title":"x"}', {}), usage: undefined };
    const p = new OpenRouterProvider('k', findModel('anthropic/claude-sonnet-5.5')!, { confidential: false, maxOutputTokens: 1000, worstCaseUsd: 0.05, fetch: respond(noUsage) as typeof fetch });
    const r = await p.generate(req);
    expect(r).toMatchObject({ costSource: 'worst_case', costEstimateUsd: 0.05 });
  });

  it('turns network failures into retryable errors (so the router can fall back)', async () => {
    const p = new OpenRouterProvider('k', findModel('anthropic/claude-sonnet-5.5')!, { confidential: false, maxOutputTokens: 1000, worstCaseUsd: 0.05, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(p.generate(req)).rejects.toMatchObject({ name: 'ProviderError', retryable: true, billed: false });
  });

  it('falls back to token pricing when no cost is reported', async () => {
    const p = new OpenRouterProvider('k', findModel('anthropic/claude-sonnet-5.5')!, { confidential: false, maxOutputTokens: 1000, worstCaseUsd: 0.05, fetch: respond(completion('{"title":"x"}', { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000 })) as typeof fetch });
    const r = await p.generate(req);
    expect(r.costSource).toBe('tokens');
    expect(r.costEstimateUsd).toBeCloseTo(3); // 1M × 2 + 0.1M × 10 USD/MTok
  });

  it('maps schema mismatches to a retryable, billed provider error', async () => {
    const p = new OpenRouterProvider('k', findModel('anthropic/claude-sonnet-5.5')!, { confidential: false, maxOutputTokens: 1000, worstCaseUsd: 0.05, fetch: respond(completion('{"nope":1}', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })) as typeof fetch });
    await expect(p.generate(req)).rejects.toMatchObject({ retryable: true, billed: true });
  });

  it('maps HTTP errors without leaking the key', async () => {
    const p = new OpenRouterProvider('secret-key', findModel('anthropic/claude-sonnet-5.5')!, { confidential: false, maxOutputTokens: 1000, worstCaseUsd: 0.05, fetch: respond({ error: { message: 'No endpoints found', code: 404 } }, 404) as typeof fetch });
    const err = await p.generate(req).catch((e: Error) => e);
    expect(err).toMatchObject({ retryable: true });
    expect(String((err as Error).message)).not.toContain('secret-key');
  });
});

describe('evaluation scoring', () => {
  it('weights ratings per use case and ignores unrated criteria', async () => {
    const { scoreRatings, criteriaFor } = await import('../src/router/policies');
    expect(scoreRatings('content_strategy', {})).toBeNull();
    expect(scoreRatings('content_strategy', { creativity: 5 })).toBe(1);
    expect(scoreRatings('content_strategy', { creativity: 1 })).toBe(0);
    // creativity (0.35) 5 + factuality (0.1) 1 → weighted towards creativity
    expect(scoreRatings('content_strategy', { creativity: 5, factuality: 1 })!).toBeCloseTo(0.35 / 0.45);
    // criteria that do not matter for the task are ignored
    expect(scoreRatings('reference_image_analysis', { creativity: 5 })).toBeNull();
    expect(criteriaFor('reference_image_analysis')[0]).toBe('accuracy');
  });
});
