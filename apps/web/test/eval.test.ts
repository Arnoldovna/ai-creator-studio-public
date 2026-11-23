import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedApprovedStrategy } from './helpers/strategy';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-eval-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock' });
  await seedApprovedStrategy();
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('Evaluation Lab (mock mode)', () => {
  it('compares models side by side without touching studio data; mock ratings never steer routing', async () => {
    const refs = await import('@/server/services/references');
    const evals = await import('@/server/services/eval');
    const { read } = await import('@/server/store');
    const { reference } = await refs.createReference(new File([PNG], 'a.png', { type: 'image/png' }), null);

    const run = await evals.runEval({ useCase: 'reference_image_analysis', input: { kind: 'reference', referenceId: reference.id }, modelIds: ['openai/gpt-6-luna', 'meta/muse-spark-1.3'] });
    expect(run.mock).toBe(true);
    expect(run.results.map((r) => r.modelId)).toEqual(['openai/gpt-6-luna', 'meta/muse-spark-1.3']);
    expect(run.results.every((r) => r.output && !r.error)).toBe(true);
    // no observations/analyses were created by the comparison
    expect(await read((db) => [db.analyses.length, db.observations.length])).toEqual([0, 0]);

    const rating = await evals.rateEval(run.id, { modelId: 'meta/muse-spark-1.3', ratings: { accuracy: 5, styleFidelity: 4 } });
    expect(rating.mock).toBe(true);
    expect(rating.score).toBeGreaterThan(0.8);
    // re-rating replaces
    await evals.rateEval(run.id, { modelId: 'meta/muse-spark-1.3', ratings: { accuracy: 3 } });
    expect(await read((db) => db.evalRatings.length)).toBe(1);
    const { userStatsFor } = await import('@/server/services/agentRuns');
    expect(await read((db) => userStatsFor(db, 'reference_image_analysis'))).toEqual({});

    await expect(evals.rateEval(run.id, { modelId: 'meta/muse-spark-1.3', ratings: { creativity: 5 } })).rejects.toThrow(/mindestens ein Kriterium/);
    await expect(evals.runEval({ useCase: 'reference_image_analysis', input: { kind: 'reference', referenceId: reference.id }, modelIds: ['openai/gpt-6-luna'] })).rejects.toThrow();
    // task and input must match (schema) – and an image is not a video task
    await expect(evals.runEval({ useCase: 'content_strategy', input: { kind: 'reference', referenceId: reference.id }, modelIds: ['openai/gpt-6-luna', 'meta/muse-spark-1.3'] })).rejects.toThrow();
    await expect(evals.runEval({ useCase: 'reference_video_analysis', input: { kind: 'reference', referenceId: reference.id }, modelIds: ['openai/gpt-6-luna', 'meta/muse-spark-1.3'] })).rejects.toMatchObject({ status: 400 });
  });

  it('pinning a model changes the router choice; client projects cannot be compared', async () => {
    const evals = await import('@/server/services/eval');
    const projects = await import('@/server/services/projects');
    await evals.setPreference({ useCase: 'content_strategy', modelId: 'meta/muse-spark-1.3' });
    const overview = await evals.getEvalOverview();
    expect(overview.useCases.find((u) => u.useCase === 'content_strategy')).toMatchObject({ preferred: 'meta/muse-spark-1.3', routerChoice: 'meta/muse-spark-1.3' });
    await evals.setPreference({ useCase: 'content_strategy', modelId: null });

    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT' });
    await expect(evals.runEval({ useCase: 'content_strategy', input: { kind: 'brief', brief: { projectId: client.id, topic: 'x' } }, modelIds: ['openai/gpt-6-luna', 'meta/muse-spark-1.3'] }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('paid comparisons need an explicit cost approval within the per-run cap', async () => {
    const evals = await import('@/server/services/eval');
    const projects = await import('@/server/services/projects');
    const p = await projects.createProject({ title: 'Ich', kind: 'PERSONAL_CONTENT' });
    // a personal brief is not confidential any more (Etappe 10): no allowed families needed
    Object.assign(process.env, { AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-key', AI_MONTHLY_BUDGET_USD: '15', EVAL_MAX_USD_PER_RUN: '0.5', CONFIDENTIAL_ALLOWED_FAMILIES: '' });
    try {
      const req = { useCase: 'content_strategy', input: { kind: 'brief', brief: { projectId: p.id, topic: 'Stricken', pillarId: 'werkstatt' } }, modelIds: ['openai/gpt-6-luna', 'deepseek/deepseek-v4.1-flash'] };
      // the quote is the number the UI asks the user to approve; less than that is refused
      const quote = await evals.quoteEval(req);
      expect(quote.worstTotalUsd).toBeGreaterThan(0);
      expect(quote.worstTotalUsd).toBeGreaterThanOrEqual(quote.estTotalUsd);
      await expect(evals.runEval(req)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/freigeben/) });
      await expect(evals.runEval({ ...req, approvedMaxUsd: quote.worstTotalUsd * 0.9 })).rejects.toMatchObject({ status: 409 });
      // the summed worst case must fit the remaining monthly budget, not each model alone
      const { write } = await import('@/server/store');
      await write((db) => void db.agentRuns.push({ id: 'spent', agent: 'x', promptVersion: 'v', provider: 'openrouter', model: 'm', projectId: null, inputHash: '', status: 'succeeded', error: null, costEstimateUsd: 15 - quote.worstTotalUsd * 0.75, usage: null, createdAt: new Date().toISOString() }));
      await expect(evals.quoteEval(req)).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/Budget-Sperre/) });
      await write((db) => void (db.agentRuns = db.agentRuns.filter((r) => r.id !== 'spent')));
      process.env.EVAL_MAX_USD_PER_RUN = '0.0001';
      await expect(evals.runEval({ ...req, approvedMaxUsd: 1 })).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/Limit pro Lauf/) });
    } finally {
      for (const k of ['OPENROUTER_API_KEY', 'AI_MONTHLY_BUDGET_USD', 'EVAL_MAX_USD_PER_RUN', 'CONFIDENTIAL_ALLOWED_FAMILIES']) delete process.env[k];
      process.env.AI_PROVIDER = 'mock';
    }
  });

  it('refuses comparisons up front with a fixed direct provider (nothing stored)', async () => {
    const evals = await import('@/server/services/eval');
    const projects = await import('@/server/services/projects');
    const { read } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Ich 2', kind: 'PERSONAL_CONTENT' });
    const before = await read((db) => db.evalRuns.length);
    Object.assign(process.env, { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AI_MONTHLY_BUDGET_USD: '15' });
    try {
      await expect(evals.runEval({ useCase: 'content_strategy', input: { kind: 'brief', brief: { projectId: p.id, topic: 'x', pillarId: 'werkstatt' } }, modelIds: ['openai/gpt-6-luna', 'meta/muse-spark-1.3'], approvedMaxUsd: 1 }))
        .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/OpenRouter/) });
      expect(await read((db) => db.evalRuns.length)).toBe(before);
    } finally {
      for (const k of ['ANTHROPIC_API_KEY', 'AI_MONTHLY_BUDGET_USD']) delete process.env[k];
      process.env.AI_PROVIDER = 'mock';
    }
  });
});
