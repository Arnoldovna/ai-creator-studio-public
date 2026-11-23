import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

/** Etappe 8, part 0+1: „Freier Schnitt“ (scriptless plans), cuts and zoom, with real FFmpeg renders. */
const run = promisify(execFile);
let dir: string;
let ff: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-effects-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
  await seedApprovedStrategy();
  ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // a finishing job may still write (ENOTEMPTY under load)
});

async function fixture(name: string, opts: { seconds: number; size: string; codec?: 'libx264' | 'libx265'; rotate90?: boolean }) {
  const out = path.join(dir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${opts.size}:rate=30:duration=${opts.seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${opts.seconds}`, '-c:a', 'aac',
    '-c:v', opts.codec ?? 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(opts.codec === 'libx265' ? ['-tag:v', 'hvc1', '-x265-params', 'log-level=error'] : []), '-shortest', '-y', out];
  await run(ff, args);
  if (!opts.rotate90) return out;
  // like an iPhone portrait clip: landscape pixels with a 90° display rotation in the container
  const rotated = out.replace(/\.(\w+)$/, '-rot.$1');
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-display_rotation:v:0', '90', '-i', out, '-c', 'copy', '-y', rotated]);
  return rotated;
}

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 240000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Video size and the exact end of each stream, from the packet list (`framecrc`: pts + duration per
 * packet in the stream's timebase), without ffprobe (which may be missing).
 */
async function streams(file: string) {
  const info = await run(ff, ['-hide_banner', '-i', file]).catch((e: { stderr: string }) => ({ stderr: e.stderr }));
  const { stdout } = await run(ff, ['-hide_banner', '-loglevel', 'error', '-i', file, '-c', 'copy', '-f', 'framecrc', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const tb = new Map([...stdout.matchAll(/^#tb (\d+): (\d+)\/(\d+)$/gm)].map((m) => [Number(m[1]), Number(m[2]) / Number(m[3])]));
  const end = new Map<number, number>();
  for (const m of stdout.matchAll(/^(\d+),\s*-?\d+,\s*(-?\d+),\s*(\d+),/gm)) {
    const st = Number(m[1]);
    end.set(st, Math.max(end.get(st) ?? 0, (Number(m[2]) + Number(m[3])) * tb.get(st)!));
  }
  return { size: /Video: h264.*?(\d{3,4}x\d{3,4})/.exec(info.stderr)?.[1], video: end.get(0)!, audio: end.get(1)! };
}

const fileStream = async (p: string) => new Blob([await readFile(p)]).stream();

async function setup(kind: 'PERSONAL_CONTENT' | 'UGC_CLIENT', clipSec: number, opts: Parameters<typeof fixture>[1] = { seconds: clipSec, size: '640x360' }) {
  const projects = await import('@/server/services/projects');
  const footage = await import('@/server/services/footage');
  const { write } = await import('@/server/store');
  const project = await projects.createProject({ title: `Frei ${kind}`, kind });
  const file = await fixture(`take-${project.id}.${opts.codec === 'libx265' ? 'mov' : 'mp4'}`, opts);
  const clip = await footage.uploadFootage(project.id, await fileStream(file), { name: 'take.mov', origin: kind === 'UGC_CLIENT' ? 'client' : 'own', rightsConfirmed: true, rightsNote: kind === 'UGC_CLIENT' ? 'Vertrag vom 1.11.' : undefined }, null);
  await write((db) => {
    const x = db.mediaAssets.find((m) => m.id === clip.asset.id)!;
    x.probe ??= { durationSec: clipSec, width: null, height: null, rotation: 0, displayWidth: null, displayHeight: null, orientation: null, fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' };
    x.status = 'probed';
  });
  return { project, assetId: clip.asset.id };
}

describe('Freier Schnitt (scriptless plans), cuts and zoom', () => {
  it('saves, approves and renders a scriptless plan with cuts and push-in: 1080x1920, A/V in sync, timeline length', async () => {
    const edit = await import('@/server/services/edit');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read, write } = await import('@/server/store');
    const { buildTimeline } = await import('@studio/core');
    const { project, assetId } = await setup('PERSONAL_CONTENT', 6);
    // lineage: only the style version approved right now is pinned, never a draft
    await write((db) => {
      const rules = {} as never;
      db.styleBibles.push(
        { id: 'style-draft', profileId: project.profileId, version: 9, status: 'draft', rules, createdAt: new Date().toISOString(), approvedAt: null },
        { id: 'style-ok', profileId: project.profileId, version: 8, status: 'approved', rules, createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() },
      );
    });

    const body = { clips: [{ assetId, inSec: 0, outSec: 6, cuts: [{ startSec: 4, endSec: 4.4 }, { startSec: 1.2, endSec: 1.7, reason: 'filler', word: 'ähm' }], zoom: { kind: 'push_in', amount: 1.08 } }] };
    await expect(edit.saveEditPlan(project.id, { body })).rejects.toThrow(); // scriptId must be stated (null = free cut)
    const v1 = await edit.saveEditPlan(project.id, { scriptId: null, body });
    expect(v1).toMatchObject({ scriptId: null, version: 1, status: 'draft', styleBibleVersionId: 'style-ok', voiceGuideVersionId: null });
    expect(v1.body.clips[0]!.cuts.map((c) => [c.startSec, c.endSec, c.reason])).toEqual([[1.2, 1.7, 'filler'], [4, 4.4, 'manual']]); // sorted
    const expected = buildTimeline(v1.body.clips).durationSec;
    expect(v1.durationSec).toBe(expected);
    expect(expected).toBeCloseTo(6 - 0.5 - 0.4, 1);
    // versions of free cuts count per project; a parent must be a free cut of the same project
    const v2 = await edit.saveEditPlan(project.id, { scriptId: null, parentId: v1.id, body });
    expect(v2.version).toBe(2);
    await write((db) => { db.styleBibles = db.styleBibles.filter((v) => !v.id.startsWith('style-')); }); // placeholder rules, not for the agents

    // Etappe 10: no approval click and no FitCheck: rendering the saved draft approves it implicitly
    const { job, render } = await edit.startRender(v1.id, {});
    expect(await read((db) => db.editPlans.find((x) => x.id === v1.id)!.status)).toBe('approved');
    const done = await until(() => getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running');
    expect(done.error).toBeNull();
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    expect(r.status).toBe('pending_review');
    const s = await streams(path.join(dir, r.storagePath!));
    expect(s.size).toBe('1080x1920');
    // two-pass loudnorm works in 100 ms blocks and may add up to one block of tail (all renders, not only cuts)
    expect(s.audio - s.video).toBeGreaterThanOrEqual(-1 / 30);
    expect(s.audio - s.video).toBeLessThanOrEqual(0.1 + 1 / 30);
    expect(Math.abs(s.video - expected)).toBeLessThanOrEqual(0.1);

    // review: revise makes a new free-cut draft with the same cuts; approve still works on the original
    const { revision } = await edit.reviewRender(r.id, { decision: 'revise', note: 'Zoom etwas schwächer' });
    expect(revision).toMatchObject({ scriptId: null, version: 3, parentId: v1.id, status: 'draft' });
    expect(revision!.body.clips[0]!.cuts).toHaveLength(2);
  });

  it('renders 40 cuts with audio and video stream lengths equal within one frame (loudness off: no loudnorm tail)', async () => {
    const edit = await import('@/server/services/edit');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const { project, assetId } = await setup('PERSONAL_CONTENT', 30);
    // 40 cuts of 0.27 s between pieces of ~0.46 s (not frame multiples, so quantisation matters)
    const cuts = Array.from({ length: 40 }, (_, k) => ({ startSec: 0.4 + k * 0.73, endSec: 0.67 + k * 0.73 }));
    const plan = await edit.saveEditPlan(project.id, { scriptId: null, body: { clips: [{ assetId, inSec: 0, outSec: 30, cuts, zoom: { kind: 'none', punchOnCuts: true, amount: 1.05 } }], loudness: 'off' } });
    await passFit(plan.id, 'edit_plan');
    await edit.approveEditPlan(plan.id);
    const { job, render } = await edit.startRender(plan.id, {});
    const done = await until(() => getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running');
    expect(done.error).toBeNull();
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    const s = await streams(path.join(dir, r.storagePath!));
    expect(s.size).toBe('1080x1920');
    expect(Math.abs(s.video - s.audio)).toBeLessThanOrEqual(1 / 30);
    expect(Math.abs(s.video - plan.durationSec)).toBeLessThanOrEqual(1 / 30); // the timeline is frame-exact
    expect(Math.abs(s.video - plan.durationSec)).toBeLessThanOrEqual(0.1);
  });

  it('cuts a rotated HEVC clip (like an iPhone portrait take) and logs the render memory', async () => {
    const { buildRender, buildTimeline, EditPlanBody, renderSegments } = await import('@studio/core');
    const file = await fixture('iphone.mov', { seconds: 12, size: '1920x1080', codec: 'libx265', rotate90: true });
    const body = EditPlanBody.parse({ clips: [{ assetId: 'x', inSec: 0, outSec: 12, cuts: Array.from({ length: 19 }, (_, k) => ({ startSec: 0.5 + k * 0.6, endSec: 0.7 + k * 0.6 })), zoom: { kind: 'push_in' } }] });
    const tl = buildTimeline(body.clips);
    const out = path.join(dir, 'iphone-cut.mp4');
    const args = buildRender(renderSegments(tl, body.clips, [{ path: file, hasAudio: true }]), out, { preset: 'off', measured: null });
    // macOS `time -l` reports the peak RSS of the FFmpeg process (bytes); elsewhere only the render is checked
    const timed = process.platform === 'darwin';
    const res = await run(timed ? '/usr/bin/time' : ff, [...(timed ? ['-l', ff] : []), '-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { maxBuffer: 16 * 1024 * 1024 });
    const rss = /(\d+)\s+maximum resident set size/.exec(res.stderr)?.[1];
    console.log(`[render memory] ${tl.segments.length} HEVC inputs (1920x1080, rotation 90), push-in: peak RSS ${rss ? `${Math.round(Number(rss) / 1048576)} MB` : 'n/a'}`);
    const s = await streams(out);
    expect(s.size).toBe('1080x1920');
    expect(Math.abs(s.video - tl.durationSec)).toBeLessThanOrEqual(0.1);
  });

  it('refuses free cuts for client work, generated clips in a free cut and a parent from a scripted plan', async () => {
    const edit = await import('@/server/services/edit');
    const content = await import('@/server/services/content');
    const client = await setup('UGC_CLIENT', 3);
    await expect(edit.saveEditPlan(client.project.id, { scriptId: null, clientConsentNote: 'x', body: { clips: [{ assetId: client.assetId, inSec: 0, outSec: 3 }] } }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/nur für eigenen Content/) });

    const own = await setup('PERSONAL_CONTENT', 3);
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: own.project.id, topic: 'Wolle', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const scripted = await edit.saveEditPlan(own.project.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId: own.assetId, inSec: 0, outSec: 3 }] } });
    await expect(edit.saveEditPlan(own.project.id, { scriptId: null, parentId: scripted.id, body: { clips: [{ assetId: own.assetId, inSec: 0, outSec: 3 }] } })).rejects.toMatchObject({ status: 404 });
    // a scripted plan's clip still needs its scene
    await expect(edit.saveEditPlan(own.project.id, { scriptId: script.id, body: { clips: [{ assetId: own.assetId, inSec: 0, outSec: 3 }] } })).rejects.toThrow(/Szene fehlt/);
    const free = await edit.saveEditPlan(own.project.id, { scriptId: null, body: { clips: [{ assetId: own.assetId, inSec: 0, outSec: 3 }] } });
    await expect(edit.addGeneratedClip(free.id, { generationId: 'g' })).rejects.toMatchObject({ status: 409 });
    expect(free.version).toBe(1); // numbered apart from the script's versions
  });

  it('reads a stored plan from before Etappe 8 (no cuts/zoom keys) through the parser everywhere and renders it', async () => {
    const edit = await import('@/server/services/edit');
    const content = await import('@/server/services/content');
    const { getJob } = await import('@/server/services/videoJobs');
    const { write, read, newId, now } = await import('@/server/store');
    const { project, assetId } = await setup('PERSONAL_CONTENT', 3);
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Alt', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    const id = newId();
    // exactly what Etappe 4–7 stored: no cuts, no zoom, sceneIndex required
    const oldBody = { clips: [{ sceneIndex: 0, assetId, inSec: 0.5, outSec: 2.5, subtitle: '', briefId: null }], loudness: 'off', subtitles: 'off' };
    await write((db) => {
      db.editPlans.push({ id, projectId: project.id, scriptId: script.id, version: 1, parentId: null, status: 'approved', body: oldBody as never, durationSec: 2, disclosures: [], warnings: [], clientConsentNote: null, styleBibleVersionId: null, voiceGuideVersionId: null, createdAt: now(), approvedAt: now() });
    });
    const state = await edit.getEditState(project.id);
    expect(state.plans.find((p) => p.id === id)!.body.clips[0]).toMatchObject({ cuts: [], zoom: { kind: 'none' } });
    expect(state.plans.find((p) => p.id === id)!.bodyError).toBe(false);
    // a body the parser rejects is flagged (the UI shows „beschädigt“ and does not offer „Laden“), not thrown
    const broken = newId();
    await write((db) => {
      db.editPlans.push({ id: broken, projectId: project.id, scriptId: script.id, version: 2, parentId: null, status: 'draft', body: { clips: 'kaputt' } as never, durationSec: 0, disclosures: [], warnings: [], clientConsentNote: null, styleBibleVersionId: null, voiceGuideVersionId: null, createdAt: now(), approvedAt: null });
    });
    expect((await edit.getEditState(project.id)).plans.find((p) => p.id === broken)!.bodyError).toBe(true);
    await write((db) => { db.editPlans = db.editPlans.filter((p) => p.id !== broken); });
    const { job, render } = await edit.startRender(id, {});
    const done = await until(() => getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running');
    expect(done.error).toBeNull();
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    expect(r.durationSec).toBe(2);
    expect((await streams(path.join(dir, r.storagePath!))).size).toBe('1080x1920');
    expect((await edit.reviewRender(r.id, { decision: 'approve' })).render.status).toBe('approved');
    // the stored body itself is untouched (approved versions never change)
    expect(await read((db) => db.editPlans.find((p) => p.id === id)!.body)).toEqual(oldBody);
  });
});
