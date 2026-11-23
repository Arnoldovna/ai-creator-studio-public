import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtures } from '../../../scripts/make-video-fixtures.mjs';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

let dir: string;
let landscape: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-generations-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', HIGGSFIELD_MONTHLY_CREDITS: '2000' });
  await seedApprovedStrategy();
  const ff = await import('@/server/ffmpeg');
  landscape = makeFixtures(path.join(dir, 'fx'), (await ff.ffmpegPath())!).find((f) => f.endsWith('landscape.mp4'))!;
}, 120_000);
afterAll(async () => {
  delete process.env.HIGGSFIELD_MONTHLY_CREDITS;
  delete process.env.HIGGSFIELD;
  (await import('@/server/higgsfield')).setHiggsfieldAdapter(null);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // a finishing job may still write (ENOTEMPTY under load)
});

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const finished = (j: { status: string }) => j.status !== 'queued' && j.status !== 'running';

/** Project with an approved script and an approved storyboard holding two AI asset briefs (scene 0 B-roll, scene 1 a product scene). */
async function setup(kind: 'PERSONAL_CONTENT' | 'UGC_CLIENT' = 'PERSONAL_CONTENT') {
  const projects = await import('@/server/services/projects');
  const content = await import('@/server/services/content');
  const agents = await import('@/server/services/scriptAgents');
  const { write } = await import('@/server/store');
  const project = await projects.createProject(kind === 'UGC_CLIENT'
    ? { title: 'Kunde', kind, client: { clientName: 'Garnladen', product: 'Merinogarn' } }
    : { title: 'B-Roll', kind });
  const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Wolle färben', lengthSeconds: 15 });
  await passFit(concepts[0]!.id);
  const script = await content.selectConceptAndWrite(concepts[0]!.id);
  await write((db) => {
    const s = db.scripts.find((x) => x.id === script.id)!;
    s.body.scenes[0]!.shotType = 'b_roll';
    s.body.scenes[1]!.shotType = 'product';
  });
  await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
  const board = await agents.runScriptAgent('storyboard', script.id);
  await write((db) => {
    const b = db.scriptOutputs.find((o) => o.id === board.id)!;
    if (b.kind !== 'storyboard') throw new Error('kind');
    Object.assign(b, { status: 'approved', approvedAt: new Date().toISOString(), clientConsentNote: null }); // client consent: tested separately
    b.output.aiAssetBriefs = [0, 1].map((sceneIndex) => ({
      sceneIndex, purpose: 'Stimmung', prompt: 'Wollstränge trocknen im Morgenlicht, langsamer Schwenk',
      disclosureLabel: 'KI-generierte Bildelemente', requiresApproval: true as const, clientApprovalRequired: kind === 'UGC_CLIENT',
    }));
  });
  return { project, script, board };
}

describe('Generated B-roll via Higgsfield (Release 3, Etappe 7)', () => {
  it('is off by default and gated by opt-in, approved storyboard and real footage for product scenes', async () => {
    const g = await import('@/server/services/generations');
    const { project, board } = await setup();
    const quote = { action: 'quote', storyboardId: board.id, briefIndex: 0, model: 'seedance_2_5', durationSec: 5 };
    expect((await g.getAiBrollState(project.id)).status).toMatchObject({ mode: 'off', state: 'disabled' });
    await expect(g.quoteGeneration(project.id, quote)).rejects.toMatchObject({ status: 503 });

    process.env.HIGGSFIELD = 'mock';
    await expect(g.quoteGeneration(project.id, quote)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Opt-in/) });
    await g.setAiBroll(project.id, { enabled: true, creditBudget: 30 });
    await expect(g.quoteGeneration(project.id, { ...quote, briefIndex: 1 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Produktszenen/) });
    await expect(g.quoteGeneration(project.id, { ...quote, model: 'text2image_soul_v2' })).rejects.toThrow(); // only whitelisted text-to-video models
    await expect(g.quoteGeneration(project.id, { ...quote, model: 'kling3_0', resolution: '1080p' })).rejects.toThrow(/vom Modell vorgegeben/); // Kling/Veo have no resolution param

    const { write } = await import('@/server/store');
    await write((db) => {
      db.scriptOutputs.find((o) => o.id === board.id)!.status = 'draft';
    });
    await expect(g.quoteGeneration(project.id, quote)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Storyboard/) });
    const state = await g.getAiBrollState(project.id);
    expect(state.briefs).toEqual([]); // only approved storyboards offer briefs
  });

  it('client projects need the documented consent on the storyboard', async () => {
    process.env.HIGGSFIELD = 'mock';
    const g = await import('@/server/services/generations');
    const { project, board } = await setup('UGC_CLIENT');
    await g.setAiBroll(project.id, { enabled: true, creditBudget: 30 });
    await expect(g.quoteGeneration(project.id, { action: 'quote', storyboardId: board.id, briefIndex: 0, model: 'seedance_2_5', durationSec: 5 }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Zustimmung der Kundin/) });
  });

  it('quote → approve within budget → one create → download → asset review → new EDL version → render with the AI label', async () => {
    const hf = await import('@/server/higgsfield');
    const mock = hf.mockAdapter({ pollMs: 20 });
    hf.setHiggsfieldAdapter(mock);
    const g = await import('@/server/services/generations');
    const edit = await import('@/server/services/edit');
    const footage = await import('@/server/services/footage');
    const { getJob } = await import('@/server/services/videoJobs');
    const { ffmpegStatus } = await import('@/server/ffmpeg');
    const { read } = await import('@/server/store');
    const { project, script, board } = await setup();
    await g.setAiBroll(project.id, { enabled: true, creditBudget: 30 });

    const q = await g.quoteGeneration(project.id, { storyboardId: board.id, briefIndex: 0, model: 'seedance_2_5', durationSec: 5 });
    expect(q).toMatchObject({ status: 'quoted', quotedCredits: 25, mock: true, briefId: `${board.id}:0`, sceneIndex: 0 });
    expect(mock.creates).toBe(0); // a quote never creates a job

    // gates on the approval: below the quote, over the project budget, no monthly budget
    await expect(g.approveGeneration(q.id, { approvedMaxCredits: 20 })).rejects.toMatchObject({ status: 409 });
    await expect(g.approveGeneration(q.id, { approvedMaxCredits: 31 })).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/Projektbudget/) });
    process.env.HIGGSFIELD_MONTHLY_CREDITS = '0';
    await expect(g.approveGeneration(q.id, { approvedMaxCredits: 25 })).rejects.toMatchObject({ status: 402, message: expect.stringMatching(/monatliches Credit-Budget/) });
    process.env.HIGGSFIELD_MONTHLY_CREDITS = '2000';
    expect(mock.creates).toBe(0);

    const { job } = await g.approveGeneration(q.id, { approvedMaxCredits: 25 });
    await expect(g.approveGeneration(q.id, { approvedMaxCredits: 25 })).rejects.toMatchObject({ status: 409 }); // approved once
    expect((await until(() => getJob(job.id), finished)).status).toBe('succeeded');
    expect(mock.creates).toBe(1);
    let state = await g.getAiBrollState(project.id);
    const gen = state.generations.find((x) => x.id === q.id)!;
    expect(gen).toMatchObject({ status: 'review', creditsCharged: 25 });
    expect(gen.asset).toMatchObject({ origin: 'generated', generation: { review: 'pending', briefId: `${board.id}:0`, mock: true } });
    expect(state.budget).toMatchObject({ projectCommitted: 25, projectLimit: 30 });
    expect(gen.asset!.name).toMatch(/MOCK/);

    // an EDL with a clip from real footage
    const { asset: own } = await footage.uploadFootage(project.id, new Blob([await readFile(landscape)]).stream(), { name: 'take.mp4', origin: 'own', rightsConfirmed: true }, null);
    const plan = await edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 1, assetId: own.id, inSec: 0, outSec: 2 }], loudness: 'off' } });
    // not reviewed yet → refused, both directly in a plan and via the helper
    await expect(edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId: gen.assetId!, inSec: 0, outSec: 2, briefId: gen.briefId }] } }))
      .rejects.toThrow(/noch nicht geprüft/);
    await expect(edit.addGeneratedClip(plan.id, { generationId: q.id })).rejects.toMatchObject({ status: 409 });

    await expect(g.reviewGeneration(q.id, { decision: 'reject' })).rejects.toMatchObject({ status: 400 }); // reasons required
    expect((await g.reviewGeneration(q.id, { decision: 'approve' })).status).toBe('approved');
    // the clip only fits its own brief
    await expect(edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId: gen.assetId!, inSec: 0, outSec: 2, briefId: 'x:9' }] } }))
      .rejects.toThrow(/anderen Asset-Brief/);
    const v2 = await edit.addGeneratedClip(plan.id, { generationId: q.id });
    expect(v2).toMatchObject({ status: 'draft', parentId: plan.id, version: plan.version + 1, disclosures: ['KI-generierte Bildelemente'] });
    expect(v2.body.clips.map((c) => [c.sceneIndex, c.assetId])).toEqual([[0, gen.assetId], [1, own.id]]);

    await edit.approveEditPlan(v2.id);
    if (!(await ffmpegStatus()).subtitles) {
      await expect(edit.startRender(v2.id, {})).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/KI-Label/) });
    } else {
      const r = await edit.startRender(v2.id, {});
      expect((await until(() => getJob(r.job.id), finished, 120_000)).status).toBe('succeeded');
      expect(await read((db) => db.renders.find((x) => x.id === r.render!.id)!.disclosures)).toEqual(['KI-generierte Bildelemente']);
    }
    state = await g.getAiBrollState(project.id);
    expect(state.generations[0]!.status).toBe('approved');
  }, 180_000);

  it('failures: nsfw / ip_detected end the job without retry and count as charged; 429 backs off; timeout and cancel', async () => {
    const hf = await import('@/server/higgsfield');
    const g = await import('@/server/services/generations');
    const { getJob, cancelJob } = await import('@/server/services/videoJobs');
    const { project, board } = await setup();
    await g.setAiBroll(project.id, { enabled: true, creditBudget: 1000 });
    const quote = () => g.quoteGeneration(project.id, { storyboardId: board.id, briefIndex: 0, model: 'kling3_0', durationSec: 5 });
    const runWith = async (adapter: ReturnType<typeof hf.mockAdapter>) => {
      hf.setHiggsfieldAdapter(adapter);
      const q = await quote();
      const { job } = await g.approveGeneration(q.id, { approvedMaxCredits: q.quotedCredits });
      const j = await until(() => getJob(job.id), finished);
      return { q, j, gen: (await g.getAiBrollState(project.id)).generations.find((x) => x.id === q.id)! };
    };

    for (const failWith of ['nsfw', 'ip_detected'] as const) {
      const mock = hf.mockAdapter({ pollMs: 10, failWith });
      const { q, j, gen } = await runWith(mock);
      expect(j.status).toBe('failed');
      expect(gen).toMatchObject({ status: 'failed', failure: failWith, creditsCharged: q.quotedCredits, assetId: null });
      expect(gen.error).toMatch(failWith === 'nsfw' ? /nsfw/ : /ip_detected/);
      expect(mock.creates).toBe(1);
      // no automatic or manual retry of the same approval
      await expect(g.approveGeneration(q.id, { approvedMaxCredits: q.quotedCredits })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nicht automatisch wiederholt/) });
      expect(mock.creates).toBe(1);
    }

    const limited = hf.mockAdapter({ pollMs: 10, failWith: 'rate_limited_once' });
    expect((await runWith(limited)).gen.status).toBe('review'); // one HTTP 429 while polling → backoff, then done

    const slow = hf.mockAdapter({ pollMs: 10, never: true, timeoutMs: 200 });
    const t = await runWith(slow);
    expect(t.gen).toMatchObject({ status: 'failed', failure: 'timeout', creditsCharged: t.q.quotedCredits });

    hf.setHiggsfieldAdapter(hf.mockAdapter({ pollMs: 20, never: true }));
    const q = await quote();
    const { job } = await g.approveGeneration(q.id, { approvedMaxCredits: q.quotedCredits });
    await until(() => g.getAiBrollState(project.id), (s) => s.generations.find((x) => x.id === q.id)!.higgsfieldJobId != null);
    await cancelJob(job.id);
    await until(() => getJob(job.id), finished);
    const c = (await g.getAiBrollState(project.id)).generations.find((x) => x.id === q.id)!;
    expect(c).toMatchObject({ status: 'cancelled', creditsCharged: q.quotedCredits }); // the job may still run at Higgsfield
  }, 120_000);

  it('a job without approval never reaches Higgsfield; deleting the project keeps the credits counted, not the prompt', async () => {
    const hf = await import('@/server/higgsfield');
    const mock = hf.mockAdapter({ pollMs: 10 });
    hf.setHiggsfieldAdapter(mock);
    const g = await import('@/server/services/generations');
    const projects = await import('@/server/services/projects');
    const { enqueueJob } = await import('@/server/worker');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const { project, board } = await setup();
    await g.setAiBroll(project.id, { enabled: true, creditBudget: 100 });
    const q = await g.quoteGeneration(project.id, { storyboardId: board.id, briefIndex: 0, model: 'seedance_2_5', durationSec: 5 });
    const { job } = await enqueueJob('generate', { generationId: q.id }, { projectId: project.id }); // bypassing the approval
    expect((await until(() => getJob(job.id), finished)).error).toMatch(/nicht freigegeben/);
    expect(mock.creates).toBe(0);

    const ok = await g.approveGeneration(q.id, { approvedMaxCredits: 25 });
    await until(() => getJob(ok.job.id), finished);
    const before = (await g.getAiBrollState(project.id)).budget.monthCommitted;
    await projects.deleteProject(project.id);
    const left = await read((db) => db.generations.find((x) => x.id === q.id)!);
    expect(left).toMatchObject({ creditsCharged: 25, assetId: null, params: { prompt: '[Projekt gelöscht]' } });
    expect(await read((db) => db.mediaAssets.filter((a) => a.projectId === project.id).length)).toBe(0);
    const other = await setup();
    expect((await g.getAiBrollState(other.project.id)).budget.monthCommitted).toBe(before);
  }, 120_000);

  it('regressions from review: mode switch, deleting a clip before review, deleting a project mid-run', async () => {
    const hf = await import('@/server/higgsfield');
    const g = await import('@/server/services/generations');
    const footage = await import('@/server/services/footage');
    const projects = await import('@/server/services/projects');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const { project, board } = await setup();
    await g.setAiBroll(project.id, { enabled: true, creditBudget: 1000 });
    const quote = () => g.quoteGeneration(project.id, { storyboardId: board.id, briefIndex: 0, model: 'seedance_2_5', durationSec: 5 });

    // a mock quote cannot be approved once the CLI is active (and the other way round)
    hf.setHiggsfieldAdapter(hf.mockAdapter({ pollMs: 10 }));
    const m = await quote();
    hf.setHiggsfieldAdapter({ ...hf.mockAdapter({ pollMs: 10 }), mode: 'cli' });
    await expect(g.approveGeneration(m.id, { approvedMaxCredits: m.quotedCredits })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/anderen Higgsfield-Modus/) });

    // deleting the generated clip before its review closes the review
    hf.setHiggsfieldAdapter(hf.mockAdapter({ pollMs: 10 }));
    const q = await quote();
    const { job } = await g.approveGeneration(q.id, { approvedMaxCredits: q.quotedCredits });
    await until(() => getJob(job.id), finished);
    const assetId = (await read((db) => db.generations.find((x) => x.id === q.id)!.assetId))!;
    await footage.deleteFootage(assetId);
    expect(await read((db) => db.generations.find((x) => x.id === q.id)!.status)).toBe('rejected');

    // deleting the project while a generation runs: closed as cancelled, credits counted, no clip left
    hf.setHiggsfieldAdapter(hf.mockAdapter({ pollMs: 20, never: true }));
    const r = await quote();
    await g.approveGeneration(r.id, { approvedMaxCredits: r.quotedCredits });
    await until(() => read((db) => db.generations.find((x) => x.id === r.id)!.higgsfieldJobId), (x) => x != null);
    await projects.deleteProject(project.id);
    expect(await read((db) => db.generations.find((x) => x.id === r.id)!)).toMatchObject({ status: 'cancelled', creditsCharged: r.quotedCredits });
  }, 120_000);
});
