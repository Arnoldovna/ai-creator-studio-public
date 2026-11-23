import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockProvider } from '@studio/core';
import { seedApprovedStrategy, withPhase } from './helpers/strategy';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-insights-'));
  process.env.STUDIO_DATA_DIR = dir;
  process.env.AI_PROVIDER = 'mock';
  await seedApprovedStrategy({ phase: 'public' });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const metrics = (reach: number, saves: number) => ({ reach, views: reach * 2, saves, shares: 3 });

describe('Growth Analyst and Research Analyst (mock provider)', () => {
  it('growth: personal data by default, client data only on request and never for ideation; approved report feeds the strategist', async () => {
    const projects = await import('@/server/services/projects');
    const analytics = await import('@/server/services/analytics');
    const insights = await import('@/server/services/insights');
    const content = await import('@/server/services/content');
    const { read, write } = await import('@/server/store');

    await expect(insights.analyzeGrowth({})).rejects.toMatchObject({ status: 400 });

    const own = await projects.createProject({ title: 'Mein Account', kind: 'PERSONAL_CONTENT' });
    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT' });
    for (const [p, reach, saves] of [[own, 1000, 30], [own, 800, 10], [client, 5000, 400]] as const) {
      const pub = await analytics.createPublication({ projectId: p.id, title: `${p.title} ${reach}`, publishedAt: '2026-11-01' });
      await analytics.addSnapshot({ publicationId: pub.id, window: '7d', metrics: metrics(reach, saves) });
    }

    const r1 = await insights.analyzeGrowth({});
    expect(r1).toMatchObject({ includesClientData: false, projectIds: [own.id], status: 'draft' });
    expect(r1.output.windows).toEqual([{ window: '7d', posts: 2 }]);
    const run1 = await read((db) => db.agentRuns.find((r) => r.id === r1.agentRunId)!);
    expect(run1).toMatchObject({ agent: 'growth_analyst', useCase: 'growth_analysis', routing: { confidential: false } });

    const r2 = await insights.analyzeGrowth({ includeClient: true });
    expect(r2.includesClientData).toBe(true);
    expect((await read((db) => db.agentRuns.find((r) => r.id === r2.agentRunId)!)).routing?.confidential).toBe(true);
    await expect(insights.setGrowthReportUse(r2.id, { use: true })).rejects.toMatchObject({ status: 409 });

    // Only after "Für Ideation verwenden" does the strategist see it – as a test idea, never as a rule
    await insights.setGrowthReportUse(r1.id, { use: true });
    const { context } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: own.id, topic: 'Strick' });
    expect(context.growthHypothesis).toMatch(/^\[MOCK\] Freigegebene Growth-Analyse:/);
    await insights.setGrowthReportUse(r1.id, { use: false });
    expect((await content.generateConcepts({ pillarId: 'werkstatt', projectId: own.id, topic: 'Strick' })).context.growthHypothesis).not.toMatch(/Freigegebene/);

    // An older approved report stays approved (and withdrawable) when a newer draft exists
    await insights.setGrowthReportUse(r1.id, { use: true });
    expect(insights.approvedGrowthReport(await read((db) => db))?.id).toBe(r1.id);

    // Client data never reaches personal ideation via the rule-based fallback; the approved report never reaches client projects
    await insights.setGrowthReportUse(r1.id, { use: false });
    const personal = (await content.generateConcepts({ pillarId: 'werkstatt', projectId: own.id, topic: 'Strick' })).context.growthHypothesis ?? '';
    expect(personal).not.toMatch(/Kunde/);
    await insights.setGrowthReportUse(r1.id, { use: true });
    const forClient = (await content.generateConcepts({ pillarId: 'werkstatt', projectId: client.id, topic: 'Strick' })).context.growthHypothesis ?? '';
    expect(forClient).not.toMatch(/Freigegebene/);
    expect(forClient).toMatch(/Kunde 5000/);

    // Mock reports keep their label in ideation
    expect((await content.generateConcepts({ pillarId: 'werkstatt', projectId: own.id, topic: 'Strick' })).context.growthHypothesis).toMatch(/^\[MOCK\] Freigegebene Growth-Analyse:/);

    // A report with unverified numbers cannot be used for ideation
    await write((db) => { db.growthReports.find((r) => r.id === r1.id)!.output.unverifiedNumbers = ['45']; });
    await insights.setGrowthReportUse(r1.id, { use: false });
    await expect(insights.setGrowthReportUse(r1.id, { use: true })).rejects.toMatchObject({ status: 409 });
    await write((db) => { db.growthReports.find((r) => r.id === r1.id)!.output.unverifiedNumbers = []; });
    await insights.setGrowthReportUse(r1.id, { use: true });

    // Deleting a snapshot withdraws approval; deleting a publication removes the reports built on it
    const ownPubs = await read((db) => db.publications.filter((p) => p.projectId === own.id).map((p) => p.id));
    const snap = await read((db) => db.metricSnapshots.find((s) => s.publicationId === ownPubs[0])!);
    await analytics.deleteSnapshot(snap.id);
    expect((await insights.growthReports()).find((r) => r.id === r1.id)?.status).toBe('draft');
    await analytics.deletePublication(ownPubs[0]!);
    expect((await insights.growthReports()).map((r) => r.id)).not.toContain(r1.id);

    await projects.deleteProject(client.id);
    expect(await insights.growthReports()).toEqual([]); // the report built from client data is gone too
  });

  it('research: own sources only, confidential for client projects, stored with provenance, cascades', async () => {
    const projects = await import('@/server/services/projects');
    const insights = await import('@/server/services/insights');
    const content = await import('@/server/services/content');
    const { read } = await import('@/server/store');
    const client = await projects.createProject({ title: 'Kunde 2', kind: 'UGC_CLIENT' });
    await expect(insights.runResearch({ projectId: client.id, topic: 'Garn', sources: [] })).rejects.toThrow();
    const rep = await insights.runResearch({
      projectId: client.id, topic: 'Garn',
      sources: [{ title: 'Produktblatt', url: 'https://example.com', text: 'Das Garn ist aus Merinowolle. Es ist bei 30 Grad waschbar.' }],
    });
    expect(rep.output.facts[0]).toMatchObject({ sourceIndex: 0, quote: 'Das Garn ist aus Merinowolle.' });
    expect((await read((db) => db.agentRuns.find((r) => r.id === rep.agentRunId)!)).routing?.confidential).toBe(true);
    expect((await content.getContent(client.id)).researchReports.map((r) => r.id)).toEqual([rep.id]);
    await projects.deleteProject(client.id);
    expect(await read((db) => db.researchReports.length)).toBe(0);
  });
});

describe('phase „Private Erprobung“ pauses growth (D7)', () => {
  it('analyzeGrowth and the Model Lab answer 409 phase_private_trial; personal ideation gets no hypothesis; public restores it', async () => {
    const projects = await import('@/server/services/projects');
    const analytics = await import('@/server/services/analytics');
    const insights = await import('@/server/services/insights');
    const content = await import('@/server/services/content');
    const evals = await import('@/server/services/eval');
    const { read } = await import('@/server/store');
    const own = await projects.createProject({ title: 'Phase', kind: 'PERSONAL_CONTENT' });
    const pub = await analytics.createPublication({ projectId: own.id, title: 'Phase 1', publishedAt: '2026-11-02' });
    await analytics.addSnapshot({ publicationId: pub.id, window: '7d', metrics: metrics(900, 20) });
    const usable = await insights.analyzeGrowth({});
    await insights.setGrowthReportUse(usable.id, { use: true });

    await withPhase('private_trial');
    const runs = await read((db) => db.agentRuns.length);
    await expect(insights.analyzeGrowth({})).rejects.toMatchObject({ status: 409, code: 'phase_private_trial', message: 'Growth-Analyse ist in der privaten Erprobungsphase pausiert.' });
    await expect(evals.runEval({ useCase: 'growth_analysis', input: { kind: 'growth' }, modelIds: ['openai/gpt-6-luna', 'meta/muse-spark-1.3'] }))
      .rejects.toMatchObject({ status: 409, code: 'phase_private_trial' });
    expect(await read((db) => db.agentRuns.length)).toBe(runs); // nothing ran

    const captured: unknown[] = [];
    const original = MockProvider.prototype.generate;
    const spy = vi.spyOn(MockProvider.prototype, 'generate').mockImplementation(function (this: MockProvider, req) {
      if (req.agent === 'content_strategist') captured.push(structuredClone(req.untrustedContext));
      return original.call(this, req);
    } as typeof original);
    try {
      const paused = await content.generateConcepts({ pillarId: 'werkstatt', projectId: own.id, topic: 'Strick' });
      expect(paused.context.growthHypothesis).toBeNull();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ growthHypothesis: null });

      await withPhase('public');
      expect((await content.generateConcepts({ pillarId: 'werkstatt', projectId: own.id, topic: 'Strick' })).context.growthHypothesis).toMatch(/Freigegebene Growth-Analyse/);
      expect(captured[1]).toMatchObject({ growthHypothesis: expect.stringMatching(/Freigegebene Growth-Analyse/) });
    } finally {
      spy.mockRestore();
    }
    expect((await insights.analyzeGrowth({})).status).toBe('draft');
  });
});
