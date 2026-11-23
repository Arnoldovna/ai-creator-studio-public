import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtures } from '../../../scripts/make-video-fixtures.mjs';

/** Etappe 8, part 2: whisper filler prompt, silence scan (job + backfill), side-effect-free suggestions, client claims. */
let dir: string;
let landscape: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-cutsugg-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', TRANSCRIPTION: 'mock' });
  const ff = await import('@/server/ffmpeg');
  landscape = makeFixtures(path.join(dir, 'fx'), (await ff.ffmpegPath())!).find((f) => f.endsWith('landscape.mp4'))!;
}, 120_000);
afterAll(async () => {
  delete process.env.TRANSCRIPTION;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup(kind: 'PERSONAL_CONTENT' | 'UGC_CLIENT', productClaims = ['Garn mit lauwarmem Wasser']) {
  const projects = await import('@/server/services/projects');
  const footage = await import('@/server/services/footage');
  const { write } = await import('@/server/store');
  const p = await projects.createProject({ title: 'Füllwörter', kind, ...(kind === 'UGC_CLIENT' ? { client: { clientName: 'K', productClaims } } : {}) });
  const { asset } = await footage.uploadFootage(p.id, new Blob([await readFile(landscape)]).stream(), { name: 'take.mp4', origin: kind === 'UGC_CLIENT' ? 'client' : 'own', rightsConfirmed: true, rightsNote: kind === 'UGC_CLIENT' ? 'Vertrag' : undefined }, null);
  await write((db) => {
    const a = db.mediaAssets.find((x) => x.id === asset.id)!;
    a.probe ??= { durationSec: 3, width: 640, height: 360, rotation: 0, displayWidth: 640, displayHeight: 360, orientation: 'landscape', fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' };
    a.status = 'probed';
  });
  return { p, asset };
}

/** A transcript version with real word timings (as whisper with the prompt would write it) plus a silence scan. */
async function seed(projectId: string, assetId: string, opts: { scan: boolean; claimText?: string }) {
  const { write, newId, now } = await import('@/server/store');
  const id = newId();
  const storagePath = `transcripts/${projectId}/${id}.json`;
  const w = (text: string, startSec: number, endSec: number, atSec: number) => ({ text, startSec, endSec, atSec });
  const body = { language: 'de', segments: [
    { startSec: 0, endSec: 1.2, text: 'Hallo, äh, ihr.', words: [w('Hallo,', 0, 0.4, 0.2), w('äh,', 0.6, 0.7, 0.65), w('ihr.', 0.9, 1.2, 1)] },
    { startSec: 1.5, endSec: 2.9, text: opts.claimText ?? 'Garn mit lauwarmem Wasser, hm, ja.', words: [w('Garn', 1.5, 1.7, 1.6), w('mit', 1.7, 1.8, 1.75), w('lauwarmem', 1.8, 2.1, 2), w('Wasser,', 2.1, 2.3, 2.2), w('hm,', 2.45, 2.5, 2.47), w('ja.', 2.7, 2.9, 2.8)] },
  ] };
  await mkdir(path.join(dir, 'transcripts', projectId), { recursive: true });
  await writeFile(path.join(dir, storagePath), JSON.stringify(body));
  await write((db) => {
    db.transcripts.push({ id, projectId, assetId, version: 9, parentId: null, source: 'whisper', model: 'ggml-large-v3-turbo-q5_0.bin', language: 'de', storagePath, segmentCount: 2, createdAt: now(), fillerPrompt: true });
    db.silenceScans = db.silenceScans.filter((s) => s.assetId !== assetId);
    if (opts.scan) db.silenceScans.push({ id: newId(), projectId, assetId, params: { noiseDb: -38.5, minSilenceSec: 0.15, meanDb: -18.5 }, durationSec: 3,
      ranges: [{ startSec: 0.45, endSec: 0.58 }, { startSec: 0.75, endSec: 0.88 }, { startSec: 2.36, endSec: 2.43 }, { startSec: 2.55, endSec: 2.68 }], createdAt: now() });
  });
}

describe('whisper arguments (flags checked against whisper-cli 1.9.5 --help)', () => {
  it('adds the fixed filler prompt and DTW for known models; both can be switched off', async () => {
    const { whisperArgs, dtwPreset } = await import('@/server/whisper');
    const { FILLER_PROMPT } = await import('@studio/core');
    const cfg = { threads: 8, vadModel: null, fillerPrompt: true, dtw: true };
    const on = whisperArgs('/m/ggml-large-v3-turbo-q5_0.bin', 'a.wav', 'out', cfg);
    expect(on.args).toEqual(['-m', '/m/ggml-large-v3-turbo-q5_0.bin', '-l', 'de', '-t', '8', '-ojf', '-of', 'out', '-pp', '-np',
      '--prompt', FILLER_PROMPT, '--carry-initial-prompt', '-dtw', 'large.v3.turbo', '-nfa', '-f', 'a.wav']);
    expect(on).toMatchObject({ fillerPrompt: true, dtw: true });
    const off = whisperArgs('/m/ggml-large-v3-turbo-q5_0.bin', 'a.wav', 'out', { ...cfg, fillerPrompt: false, dtw: false });
    expect(off.args).toEqual(['-m', '/m/ggml-large-v3-turbo-q5_0.bin', '-l', 'de', '-t', '8', '-ojf', '-of', 'out', '-pp', '-np', '-f', 'a.wav']);
    expect(dtwPreset('/x/ggml-medium-q5_0.bin')).toBe('medium');
    expect(dtwPreset('ggml-small.en.bin')).toBe('small.en');
    expect(dtwPreset('ggml-large-v3-q5_0.bin')).toBe('large.v3');
    expect(dtwPreset('my-model.bin')).toBeNull();
    const { transcriptionConfig } = await import('@/server/env');
    process.env.WHISPER_FILLER_PROMPT = '0';
    expect(transcriptionConfig().fillerPrompt).toBe(false);
    delete process.env.WHISPER_FILLER_PROMPT;
    expect(transcriptionConfig()).toMatchObject({ fillerPrompt: true, dtw: true });
  });
});

describe('silence scan and cut suggestions', () => {
  it('the transcription job also scans the silence (relative threshold); the backfill job replaces the scan', async () => {
    const tr = await import('@/server/services/transcripts');
    const cuts = await import('@/server/services/cuts');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const { asset } = await setup('PERSONAL_CONTENT');
    const { job } = await tr.startTranscription(asset.id);
    expect((await until(() => getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running')).status).toBe('succeeded');
    const first = await read((db) => tr.latestSilenceScan(db, asset.id));
    // the fixture is a constant 440 Hz tone: measured, no silence in it
    expect(first).toMatchObject({ assetId: asset.id, ranges: [], params: { minSilenceSec: 0.15 } });
    expect(first!.params.noiseDb).toBeCloseTo(Math.min(-30, Math.max(-60, first!.params.meanDb - 20)), 1);
    expect(await read((db) => tr.latestTranscript(db, asset.id)!.fillerPrompt)).toBe(false); // mock: no whisper prompt

    const scanJob = (await cuts.startSilenceScan(asset.id)).job;
    await expect(cuts.startSilenceScan(asset.id)).rejects.toMatchObject({ status: 409 });
    expect((await until(() => getJob(scanJob.id), (j) => j.status !== 'queued' && j.status !== 'running')).status).toBe('succeeded');
    const scans = await read((db) => db.silenceScans.filter((s) => s.assetId === asset.id));
    expect(scans).toHaveLength(1);
    expect(scans[0]!.id).not.toBe(first!.id);
  }, 120_000);

  it('GET suggestions is side-effect free; without a scan it only says so', async () => {
    const cuts = await import('@/server/services/cuts');
    const { read } = await import('@/server/store');
    const { p, asset } = await setup('PERSONAL_CONTENT');
    await seed(p.id, asset.id, { scan: false });
    const before = await read((db) => JSON.stringify(db));
    const none = await cuts.getCutSuggestions(p.id, { assetId: asset.id, inSec: '0', outSec: '3' });
    expect(none).toMatchObject({ status: 'no_scan', suggestions: [], scan: null, transcript: { version: 9, fillerPrompt: true } });
    expect(await read((db) => JSON.stringify(db))).toBe(before); // no job queued, nothing written

    await seed(p.id, asset.id, { scan: true });
    const snapshot = await read((db) => JSON.stringify(db));
    const r = await cuts.getCutSuggestions(p.id, { assetId: asset.id, inSec: '0', outSec: '3' });
    expect(await read((db) => JSON.stringify(db))).toBe(snapshot);
    expect(r.status).toBe('ready');
    expect(r.dtw).toBe(true);
    expect(r.suggestions.filter((s) => s.kind === 'filler').map((s) => [s.word, s.startSec, s.endSec, s.safe])).toEqual([['äh', 0.515, 0.815, true], ['hm', 2.395, 2.615, true]]);
    await expect(cuts.getCutSuggestions(p.id, { assetId: asset.id, inSec: '2', outSec: '1' })).rejects.toThrow();
  });

  it('client projects: suggestions in a claim sentence are blocked and such cuts are refused at save', async () => {
    const cuts = await import('@/server/services/cuts');
    const { p, asset } = await setup('UGC_CLIENT');
    await seed(p.id, asset.id, { scan: true });
    const r = await cuts.getCutSuggestions(p.id, { assetId: asset.id, inSec: '0', outSec: '3' });
    expect(r.clientProject).toBe(true);
    const hm = r.suggestions.find((s) => s.word === 'hm')!;
    expect(hm).toMatchObject({ safe: false });
    expect(hm.blocked).toMatch(/Kunden-Claim/);
    expect(r.suggestions.find((s) => s.word === 'äh')).toMatchObject({ blocked: null, safe: true });

    const body = (reason: 'filler' | 'manual') => ({ clips: [{ sceneIndex: 0, assetId: asset.id, inSec: 0, outSec: 3, cuts: [{ startSec: hm.startSec, endSec: hm.endSec, reason, word: 'hm' }] }] });
    await expect(cuts.assertNoClaimCuts(p.id, body('filler'))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Kunden-Claim/) });
    await expect(cuts.assertNoClaimCuts(p.id, body('manual'))).resolves.toBeUndefined(); // the user's own cut
  });

  it('client claims come from the whole allowlist (verified brief facts, script verifiedClaims) and survive fillers', async () => {
    const cuts = await import('@/server/services/cuts');
    const { write } = await import('@/server/store');
    const { BriefInput } = await import('@studio/core');
    // no productClaims at all: the claim lives only in the brief's verified facts, and whisper wrote a filler into it
    const { p, asset } = await setup('UGC_CLIENT', []);
    await seed(p.id, asset.id, { scan: true, claimText: 'Garn mit, hm, lauwarmem Wasser, ja.' });
    const before = await cuts.getCutSuggestions(p.id, { assetId: asset.id, inSec: '0', outSec: '3' });
    expect(before.suggestions.find((s) => s.word === 'hm')).toMatchObject({ blocked: null, safe: true });
    await write((db) => {
      db.briefs.push({ id: 'brief-claim', projectId: p.id, input: BriefInput.parse({ projectId: p.id, topic: 'Wolle', verifiedFacts: ['Garn mit lauwarmem Wasser'] }), createdAt: new Date().toISOString() });
    });
    const r = await cuts.getCutSuggestions(p.id, { assetId: asset.id, inSec: '0', outSec: '3' });
    const hm = r.suggestions.find((s) => s.word === 'hm')!;
    expect(hm.blocked).toMatch(/Kunden-Claim/);
    expect(hm.safe).toBe(false);
    const body = { clips: [{ sceneIndex: 0, assetId: asset.id, inSec: 0, outSec: 3, cuts: [{ startSec: hm.startSec, endSec: hm.endSec, reason: 'filler', word: 'hm' }] }] };
    await expect(cuts.assertNoClaimCuts(p.id, body)).rejects.toMatchObject({ status: 400 });

    // a claim only in the plan script's verifiedClaims
    await write((db) => { db.briefs = db.briefs.filter((b) => b.id !== 'brief-claim'); });
    await expect(cuts.assertNoClaimCuts(p.id, body)).resolves.toBeUndefined();
    await write((db) => {
      db.scripts.push({ id: 'script-claim', projectId: p.id, verifiedClaims: ['lauwarmem Wasser'], body: { verifiedClaims: ['lauwarmem Wasser'] } } as unknown as (typeof db.scripts)[number]);
    });
    await expect(cuts.assertNoClaimCuts(p.id, body, 'script-claim')).rejects.toMatchObject({ status: 400 });
    // a manual cut that touches a filler cut is joined as a filler cut and still refused
    const joined = { clips: [{ ...body.clips[0]!, cuts: [{ startSec: hm.startSec - 0.3, endSec: hm.startSec, reason: 'manual', word: '' }, { startSec: hm.startSec, endSec: hm.endSec, reason: 'filler', word: 'hm' }] }] };
    await expect(cuts.assertNoClaimCuts(p.id, joined, 'script-claim')).rejects.toMatchObject({ status: 400 });
    await write((db) => { db.scripts = db.scripts.filter((x) => x.id !== 'script-claim'); });
  });

  it('suggestions use the same claim list as the save gate: the plan script is passed and must belong to the project', async () => {
    const cuts = await import('@/server/services/cuts');
    const { write } = await import('@/server/store');
    const { p, asset } = await setup('UGC_CLIENT', []);
    await seed(p.id, asset.id, { scan: true, claimText: 'Garn mit, hm, lauwarmem Wasser, ja.' });
    await write((db) => {
      db.scripts.push({ id: 'script-only-claim', projectId: p.id, body: { verifiedClaims: ['lauwarmem Wasser'] } } as unknown as (typeof db.scripts)[number]);
      db.scripts.push({ id: 'script-foreign', projectId: 'other-project', body: { verifiedClaims: [] } } as unknown as (typeof db.scripts)[number]);
    });
    const q = { assetId: asset.id, inSec: '0', outSec: '3' };
    expect((await cuts.getCutSuggestions(p.id, q)).suggestions.find((s) => s.word === 'hm')).toMatchObject({ blocked: null, safe: true });
    expect((await cuts.getCutSuggestions(p.id, { ...q, scriptId: '' })).suggestions.find((s) => s.word === 'hm')).toMatchObject({ blocked: null });
    const scripted = (await cuts.getCutSuggestions(p.id, { ...q, scriptId: 'script-only-claim' })).suggestions.find((s) => s.word === 'hm')!;
    expect(scripted).toMatchObject({ safe: false });
    expect(scripted.blocked).toMatch(/Kunden-Claim/);
    await expect(cuts.getCutSuggestions(p.id, { ...q, scriptId: 'script-foreign' })).rejects.toMatchObject({ status: 404 });
    await write((db) => { db.scripts = db.scripts.filter((x) => !x.id.startsWith('script-only-claim') && x.id !== 'script-foreign'); });
  });

  it('approval and render run the claim-cut gate again (claims added after the save, derived versions)', async () => {
    const cuts = await import('@/server/services/cuts');
    const edit = await import('@/server/services/edit');
    const { write, now } = await import('@/server/store');
    const { BriefInput, EditPlanBody } = await import('@studio/core');
    const { p, asset } = await setup('UGC_CLIENT', []);
    await seed(p.id, asset.id, { scan: true, claimText: 'Garn mit, hm, lauwarmem Wasser, ja.' });
    const hm = (await cuts.getCutSuggestions(p.id, { assetId: asset.id, inSec: '0', outSec: '3' })).suggestions.find((s) => s.word === 'hm')!;
    const body = EditPlanBody.parse({ clips: [{ sceneIndex: 0, assetId: asset.id, inSec: 0, outSec: 3, cuts: [{ startSec: hm.startSec, endSec: hm.endSec, reason: 'filler', word: 'hm' }] }] });
    // saved while no claim matched; the verified fact arrives later
    await expect(cuts.assertNoClaimCuts(p.id, body)).resolves.toBeUndefined();
    const plan = (status: 'draft' | 'approved', id: string) => ({ id, projectId: p.id, scriptId: null, version: 1, parentId: null, status, body, durationSec: 2.8,
      disclosures: [], warnings: [], clientConsentNote: null, styleBibleVersionId: null, voiceGuideVersionId: null, createdAt: now(), approvedAt: status === 'approved' ? now() : null });
    await write((db) => {
      db.editPlans.push(plan('draft', 'plan-claim-draft'), plan('approved', 'plan-claim-approved'));
      db.briefs.push({ id: 'brief-late', projectId: p.id, input: BriefInput.parse({ projectId: p.id, topic: 'Wolle', verifiedFacts: ['Garn mit lauwarmem Wasser'] }), createdAt: now() });
    });
    await expect(edit.approveEditPlan('plan-claim-draft')).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Kunden-Claim/) });
    await expect(edit.startRender('plan-claim-approved', {})).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Kunden-Claim/) });
    await write((db) => {
      db.editPlans = db.editPlans.filter((x) => !x.id.startsWith('plan-claim-'));
      db.briefs = db.briefs.filter((b) => b.id !== 'brief-late');
    });
  });

  it('reports a failed pause measurement newer than the latest scan, with its error', async () => {
    const cuts = await import('@/server/services/cuts');
    const { write, newId } = await import('@/server/store');
    const { p, asset } = await setup('PERSONAL_CONTENT');
    await seed(p.id, asset.id, { scan: false });
    const q = { assetId: asset.id, inSec: '0', outSec: '3' };
    expect(await cuts.getCutSuggestions(p.id, q)).toMatchObject({ status: 'no_scan', scanError: null });
    const job = (kind: 'silence_scan' | 'transcribe', status: 'failed' | 'succeeded', finishedAt: string, extra: object) => ({
      id: newId(), kind, projectId: p.id, idempotencyKey: null, status, attempts: 1, progress: null, progressNote: '', input: { assetId: asset.id },
      result: null, error: null, cancelRequested: false, createdAt: finishedAt, startedAt: finishedAt, finishedAt, updatedAt: finishedAt, ...extra,
    });
    await write((db) => {
      db.mediaJobs.push(job('silence_scan', 'failed', '2030-01-01T00:00:00.000Z', { error: 'Keine messbare Tonspur (Stille oder unlesbar).' }));
    });
    expect(await cuts.getCutSuggestions(p.id, q)).toMatchObject({ status: 'no_scan', scanError: 'Keine messbare Tonspur (Stille oder unlesbar).' });
    // a later transcription whose own scan failed is reported too
    await write((db) => {
      db.mediaJobs.push(job('transcribe', 'succeeded', '2030-01-02T00:00:00.000Z', { result: { scanError: 'ffmpeg exit 1' } }));
    });
    expect((await cuts.getCutSuggestions(p.id, q)).scanError).toBe('ffmpeg exit 1');
    // a scan newer than the failures: no error any more
    await seed(p.id, asset.id, { scan: true });
    await write((db) => { db.silenceScans.find((x) => x.assetId === asset.id)!.createdAt = '2030-01-03T00:00:00.000Z'; });
    expect(await cuts.getCutSuggestions(p.id, q)).toMatchObject({ status: 'ready', scanError: null });
    await write((db) => { db.mediaJobs = db.mediaJobs.filter((j) => (j.input as { assetId?: string } | null)?.assetId !== asset.id); });
  });

  it('deleting the footage removes its scans', async () => {
    const footage = await import('@/server/services/footage');
    const { read } = await import('@/server/store');
    const { p, asset } = await setup('PERSONAL_CONTENT');
    await seed(p.id, asset.id, { scan: true });
    await footage.deleteFootage(asset.id);
    expect(await read((db) => db.silenceScans.filter((s) => s.assetId === asset.id))).toEqual([]);
  });
});
