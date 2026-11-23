import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Per-model behaviour of the fake OpenRouter adapter (no network, no cost). */
const behaviour: Record<string, 'ok' | 'fail-retryable' | 'fail-schema' | 'fail-auth'> = {};
const calls: string[] = [];
let slowMs = 0;

vi.mock('@studio/core', async (orig) => {
  const core = await orig<typeof import('@studio/core')>();
  class FakeOpenRouter {
    readonly name = 'openrouter' as const;
    readonly supportsVision = true;
    readonly model: string;
    constructor(_key: string, entry: { id: string }, readonly opts: { confidential: boolean }) {
      this.model = entry.id;
    }
    async generate<T>(req: { schema: { parse: (x: unknown) => T }; mock: () => unknown }) {
      calls.push(this.model);
      if (behaviour[this.model] === undefined && slowMs) await new Promise((r) => setTimeout(r, slowMs));
      const b = behaviour[this.model] ?? 'ok';
      if (b === 'fail-retryable') throw new core.ProviderError('503 upstream', true);
      if (b === 'fail-schema') throw new core.ProviderError('Schema', true, true);
      if (b === 'fail-auth') throw new core.ProviderError('API-Key ungültig');
      return { output: req.schema.parse(req.mock()), provider: 'openrouter', model: this.model, usage: { inputTokens: 10, outputTokens: 10 }, costEstimateUsd: 0.001, costSource: 'reported' };
    }
  }
  return { ...core, OpenRouterProvider: FakeOpenRouter };
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-router-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-key', AI_MONTHLY_BUDGET_USD: '15' });
});
afterAll(async () => {
  for (const k of ['AI_PROVIDER', 'OPENROUTER_API_KEY', 'AI_MONTHLY_BUDGET_USD', 'CONFIDENTIAL_ALLOWED_FAMILIES']) delete process.env[k];
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(behaviour)) delete behaviour[k];
});

describe('runAgent with the model router (fake OpenRouter)', () => {
  it('routes, logs the decision and the billed cost', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    const { runContentStrategist, BriefInput } = await import('@studio/core');
    const ctx = { brief: BriefInput.parse({ projectId: 'p', topic: 'Test' }), projectKind: 'PERSONAL_CONTENT' as const, client: null, style: null, voice: null, growthHypothesis: null, strategy: null, profile: null };
    const { run, routing } = await runAgent({ agent: 'content_strategist', useCase: 'content_strategy', projectId: null, input: 1 }, (p) => runContentStrategist(p, ctx));
    expect(run.provider).toBe('openrouter');
    expect(run.model).toBe(routing.chosen!.id);
    expect(run.routing?.reasons.length).toBeGreaterThan(0);
    expect(run.costSource).toBe('reported');
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toEqual([routing.chosen!.id]);
  });

  it('falls back on a retryable failure and records both attempts', async () => {
    const { runAgent, } = await import('@/server/services/agentRuns');
    const { routeModel } = await import('@studio/core');
    const { read } = await import('@/server/store');
    const first = routeModel({ useCase: 'growth_analysis', availableGateways: ['openrouter'], confidential: false, confidentialAllowedFamilies: [], budgetRemainingUsd: 15 });
    behaviour[first.chosen!.id] = 'fail-schema';
    const { run } = await runAgent({ agent: 'x', useCase: 'growth_analysis', projectId: null, input: 2 }, (p) =>
      p.generate({ agent: 'x', promptVersion: 'v', system: 's', instruction: 'i', schema: { parse: (x: unknown) => x } as never, schemaName: 'X', mock: () => ({ ok: true }) }).then((r) => ({ ...r, promptVersion: 'v' })),
    );
    expect(calls).toEqual([first.chosen!.id, first.fallbacks[0]!.id]);
    expect(run.routing?.attempt).toBe(1);
    const failed = await read((db) => db.agentRuns.filter((r) => r.status === 'failed' && r.useCase === 'growth_analysis'));
    expect(failed).toHaveLength(1);
    // schema failure = output was produced → counted conservatively
    expect(failed[0]!.costSource).toBe('worst_case');
    expect(failed[0]!.costEstimateUsd).toBeGreaterThan(0);
  });

  it('does not fall back on non-retryable errors (e.g. invalid key)', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    const { routeModel } = await import('@studio/core');
    const first = routeModel({ useCase: 'voice_analysis', availableGateways: ['openrouter'], confidential: false, confidentialAllowedFamilies: [], budgetRemainingUsd: 15 });
    behaviour[first.chosen!.id] = 'fail-auth';
    await expect(runAgent({ agent: 'x', useCase: 'voice_analysis', projectId: null, input: 3 }, (p) => p.generate({} as never) as never)).rejects.toThrow(/API-Key/);
    expect(calls).toHaveLength(1);
  });

  it('refuses confidential client data unless a model family is explicitly allowed', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    await expect(runAgent({ agent: 'x', useCase: 'ugc_scriptwriting', projectId: null, input: 4, confidential: true, clientData: true }, (p) => p.generate({} as never) as never)).rejects.toThrow(/Kein geeignetes Modell/);
    expect(calls).toHaveLength(0);
    process.env.CONFIDENTIAL_ALLOWED_FAMILIES = 'anthropic';
    const { routing } = await runAgent({ agent: 'x', useCase: 'ugc_scriptwriting', projectId: null, input: 5, confidential: true, clientData: true }, (p) =>
      p.generate({ agent: 'x', promptVersion: 'v', system: 's', instruction: 'i', schema: { parse: (x: unknown) => x } as never, schemaName: 'X', mock: () => ({}) }).then((r) => ({ ...r, promptVersion: 'v' })),
    );
    expect(routing.chosen!.id).toMatch(/^anthropic\//);
    delete process.env.CONFIDENTIAL_ALLOWED_FAMILIES;
  });

  it('hard-stops when the budget is used up', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    const { write } = await import('@/server/store');
    await write((db) => void (db.agentRuns = []));
    await write((db) => void db.agentRuns.push({ id: 'big', agent: 'x', promptVersion: 'v', provider: 'openrouter', model: 'm', projectId: null, inputHash: '', status: 'succeeded', error: null, costEstimateUsd: 14.999, usage: null, createdAt: new Date().toISOString() }));
    await expect(runAgent({ agent: 'x', useCase: 'style_synthesis', projectId: null, input: 6 }, (p) => p.generate({} as never) as never)).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/Budget-Sperre/) });
    expect(calls).toHaveLength(0);
    const { getShellStatus } = await import('@/server/services/status');
    expect((await getShellStatus()).budget).toMatchObject({ warn: true });
  });

  it('reserves worst-case cost so parallel calls cannot overshoot the hard limit', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    const { routeModel } = await import('@studio/core');
    const { write } = await import('@/server/store');
    const d = routeModel({ useCase: 'instagram_copywriting', availableGateways: ['openrouter'], confidential: false, confidentialAllowedFamilies: [], budgetRemainingUsd: 15, preferredModelId: 'openai/gpt-6.1-sol' });
    const wc = d.chosen!.worstCaseCostUsd;
    // remaining budget fits exactly one worst case of the pinned model
    await write((db) => {
      db.agentRuns = [{ id: 'spent', agent: 'x', promptVersion: 'v', provider: 'openrouter', model: 'm', projectId: null, inputHash: '', status: 'succeeded', error: null, costEstimateUsd: 15 - wc * 1.5, usage: null, createdAt: new Date().toISOString() }];
      db.routerPreferences.instagram_copywriting = 'openai/gpt-6.1-sol';
    });
    slowMs = 30;
    const call = () => runAgent({ agent: 'x', useCase: 'instagram_copywriting', projectId: null, input: Math.random() }, (p) =>
      p.generate({ agent: 'x', promptVersion: 'v', system: 's', instruction: 'i', schema: { parse: (x: unknown) => x } as never, schemaName: 'X', mock: () => ({}) }).then((r) => ({ ...r, promptVersion: 'v' })));
    const results = await Promise.allSettled([call(), call()]);
    slowMs = 0;
    // The 2nd call sees the 1st call's reservation: the pinned model no longer fits, so it either
    // gets a cheaper model that does fit or is refused – the sum of worst cases never exceeds the budget.
    const worst = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.routing.chosen!.worstCaseCostUsd] : []));
    expect(worst.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(wc * 1.5 + 1e-9);
    expect(new Set(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.run.model] : []))).size).toBe(results.filter((r) => r.status === 'fulfilled').length);
    expect(calls[0]).toBe('openai/gpt-6.1-sol');
    expect(calls[1]).not.toBe('openai/gpt-6.1-sol');
    await write((db) => { db.agentRuns = []; db.routerPreferences = {}; });
  });

  it('persists the reservation while a paid call is in flight and releases it afterwards', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    const { read, PROCESS_ID } = await import('@/server/store');
    slowMs = 200;
    const call = runAgent({ agent: 'x', useCase: 'instagram_copywriting', projectId: null, input: 'reservation' }, (p) =>
      p.generate({ agent: 'x', promptVersion: 'v', system: 's', instruction: 'i', schema: { parse: (x: unknown) => x } as never, schemaName: 'X', mock: () => ({}) }).then((r) => ({ ...r, promptVersion: 'v' })));
    await new Promise((r) => setTimeout(r, 100));
    const during = await read((db) => db.budgetReservations);
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ processId: PROCESS_ID, purpose: expect.stringMatching(/^x · /) });
    expect(during[0]!.amountUsd).toBeGreaterThan(0);
    const { run } = await call;
    slowMs = 0;
    // released in the same write that stores the run's cost
    expect(await read((db) => ({ res: db.budgetReservations.length, saved: db.agentRuns.some((r) => r.id === run.id) }))).toEqual({ res: 0, saved: true });
  });

  it('direct providers obey the same confidentiality rule (nothing is sent)', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    Object.assign(process.env, { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-anthropic' });
    try {
      let called = false;
      await expect(runAgent({ agent: 'x', useCase: 'ugc_scriptwriting', projectId: null, input: 7, confidential: true, clientData: true }, async () => { called = true; throw new Error('must not run'); }))
        .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nichts wurde gesendet/) });
      expect(called).toBe(false);
      // model comparisons are only offered via OpenRouter or mock
      await expect(runAgent({ agent: 'x', useCase: 'content_strategy', projectId: null, input: 8, forceModelId: 'openai/gpt-6.1-sol' }, async () => { throw new Error('must not run'); }))
        .rejects.toMatchObject({ status: 409 });
    } finally {
      process.env.AI_PROVIDER = 'openrouter';
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('never exposes the API key in the public status', async () => {
    const { getStatus } = await import('@/server/services/status');
    expect(JSON.stringify(await getStatus())).not.toContain('test-key');
  });

  it('an input error raised before the model is called is the user\'s 400: no call, no fallback, no cost', async () => {
    const { runAgent } = await import('@/server/services/agentRuns');
    const { runVoiceDirector } = await import('@studio/core');
    const { read } = await import('@/server/store');
    const before = await read((db) => db.agentRuns.length);
    await expect(
      runAgent({ agent: 'voice_director', useCase: 'voice_analysis', projectId: null, input: 1 }, (p) => runVoiceDirector(p, { samples: ['zu kurz'], userTraits: [], userAvoid: [] })),
    ).rejects.toMatchObject({ name: 'ValidationError', status: 400 });
    expect(calls).toEqual([]);
    expect(await read((db) => db.agentRuns.length)).toBe(before);
  });
});

describe('confidential routing (Etappe 10: only client data, not personal strategy/profile)', () => {
  it('PERSONAL_CONTENT with an active strategy is not confidential: every router candidate is eligible', async () => {
    const { seedApprovedStrategy } = await import('./helpers/strategy');
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const evals = await import('@/server/services/eval');
    const { read, write } = await import('@/server/store');
    await write((db) => { db.agentRuns = []; db.budgetReservations = []; db.routerPreferences = {}; });
    const { strategyVersionId } = await seedApprovedStrategy();
    const p = await projects.createProject({ title: 'Ich', kind: 'PERSONAL_CONTENT' });
    const brief = { projectId: p.id, topic: 'Holz ölen', pillarId: 'werkstatt' };
    const { task } = await content.prepareStrategyTask(brief);
    expect(task.meta).toMatchObject({ clientData: false, strategyVersionId, aiContextHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // CONFIDENTIAL_ALLOWED_FAMILIES is empty, still the call goes through, unrestricted
    await content.generateConcepts(brief);
    expect(await read((db) => db.agentRuns.at(-1))).toMatchObject({ provider: 'openrouter', status: 'succeeded', routing: { confidential: false }, strategyVersionId });
    expect(calls).toHaveLength(1);
    // a model without a zero-retention endpoint may be compared too
    const q = await evals.quoteEval({ useCase: 'content_strategy', input: { kind: 'brief', brief }, modelIds: ['google/gemini-4-argon', 'openai/gpt-6-luna'] });
    expect(q.worstTotalUsd).toBeGreaterThan(0);
  });

  it('UGC_CLIENT stays confidential: refused without allowed families, ZDR-only routing with them', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const { read } = await import('@/server/store');
    const client = await projects.createProject({ title: 'Kunde R', kind: 'UGC_CLIENT', client: { clientName: 'Holzladen', productClaims: [] } });
    const brief = { projectId: client.id, topic: 'Hobel' };
    const { task } = await content.prepareStrategyTask(brief);
    expect(task.meta).toMatchObject({ clientData: true, strategyVersionId: null, profileVersionId: null });
    const before = calls.length;
    await expect(content.generateConcepts(brief)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(before);
    process.env.CONFIDENTIAL_ALLOWED_FAMILIES = 'openai';
    try {
      await content.generateConcepts(brief);
      expect(await read((db) => db.agentRuns.at(-1))).toMatchObject({ provider: 'openrouter', status: 'succeeded', routing: { confidential: true } });
      expect(calls.at(-1)).toMatch(/^openai\//);
    } finally {
      delete process.env.CONFIDENTIAL_ALLOWED_FAMILIES;
    }
  });

  it('Model Lab in mock mode: a personal strategy brief is allowed, a client brief is still refused', async () => {
    const projects = await import('@/server/services/projects');
    const evals = await import('@/server/services/eval');
    process.env.AI_PROVIDER = 'mock';
    try {
      const p = await projects.createProject({ title: 'Ich 2', kind: 'PERSONAL_CONTENT' });
      const run = await evals.runEval({ useCase: 'content_strategy', input: { kind: 'brief', brief: { projectId: p.id, topic: 'Werkbank', pillarId: 'werkstatt' } }, modelIds: ['google/gemini-4-argon', 'meta/muse-spark-1.3'] });
      expect(run.mock).toBe(true);
      expect(run.results.map((r) => r.error)).toEqual([null, null]);
      const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Holzladen', productClaims: [] } });
      await expect(evals.runEval({ useCase: 'content_strategy', input: { kind: 'brief', brief: { projectId: client.id, topic: 'Hobel' } }, modelIds: ['openai/gpt-6-luna', 'meta/muse-spark-1.3'] }))
        .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/vertraulichen Kundendaten/) });
    } finally {
      process.env.AI_PROVIDER = 'openrouter';
    }
  });
});
