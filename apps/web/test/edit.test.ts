import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

const run = promisify(execFile);
let dir: string;
let ff: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-edit-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
  await seedApprovedStrategy();
  ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true });
});

/** Synthetic fixture clip (no real footage in the repo): test pattern, optional 440 Hz tone. */
async function fixture(name: string, opts: { seconds: number; size: string; audio: boolean }) {
  const out = path.join(dir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${opts.size}:rate=25:duration=${opts.seconds}`];
  if (opts.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${opts.seconds}`, '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', '-y', out);
  await run(ff, args);
  return out;
}

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 120000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const fileStream = async (p: string) => new Blob([await readFile(p)]).stream();

describe('EDL and first cut (Release 3, Etappe 4)', () => {
  it('versions an EDL, gates approval and render review, and renders a vertical 1080x1920 MP4 with FFmpeg', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const footage = await import('@/server/services/footage');
    const edit = await import('@/server/services/edit');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read, write } = await import('@/server/store');

    const project = await projects.createProject({ title: 'Reel', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Stricken am Morgen', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const scenes = script.body.scenes.length;
    expect(scenes).toBeGreaterThan(1);

    // landscape clip with sound, portrait clip without sound
    const wide = await footage.uploadFootage(project.id, await fileStream(await fixture('wide.mp4', { seconds: 4, size: '640x360', audio: true })), { name: 'wide.mp4', origin: 'own', rightsConfirmed: true }, null);
    const tall = await footage.uploadFootage(project.id, await fileStream(await fixture('tall.mp4', { seconds: 3, size: '360x640', audio: false })), { name: 'tall.mp4', origin: 'own', rightsConfirmed: true }, null);
    // ffprobe may be missing: set the probe the way ffprobe would report it (real ffprobe: test/realProbe.test.ts)
    await write((db) => {
      for (const [a, d, audio] of [[wide.asset, 4, true], [tall.asset, 3, false]] as const) {
        const x = db.mediaAssets.find((m) => m.id === a.id)!;
        x.probe ??= { durationSec: d, width: null, height: null, rotation: 0, displayWidth: null, displayHeight: null, orientation: null, fps: 25, videoCodec: 'h264', audioCodec: audio ? 'aac' : null, hasAudio: audio, container: 'mov,mp4' };
        x.status = 'probed';
      }
    });

    const body = { clips: [
      { sceneIndex: 0, assetId: wide.asset.id, inSec: 0.5, outSec: 2 },
      { sceneIndex: 1, assetId: tall.asset.id, inSec: 0, outSec: 1.5 },
      { sceneIndex: 1, assetId: wide.asset.id, inSec: 3, outSec: 4 },
    ] };
    await expect(edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ ...body.clips[0], outSec: 9 }] } })).rejects.toThrow(/hinter dem Ende/);
    const v1 = await edit.saveEditPlan(project.id, { scriptId: script.id, body });
    expect(v1).toMatchObject({ version: 1, status: 'draft', durationSec: 4, disclosures: [], styleBibleVersionId: script.styleBibleVersionId });
    expect(v1.warnings.join(' ')).toMatch(/ohne Ton/);

    // Etappe 10, personal project: no approval click and no approved script needed – rendering the draft
    // approves it (client projects keep both gates, see strategyGate.test.ts)
    expect((await read((db) => db.scripts.find((x) => x.id === script.id)!)).status).toBe('draft');
    const { job, render } = await edit.startRender(v1.id, {});
    expect(render).toMatchObject({ status: 'rendering', editPlanId: v1.id });
    expect(await read((db) => db.editPlans.find((x) => x.id === v1.id)!)).toMatchObject({ status: 'approved', approvedAt: expect.any(String) });
    await expect(edit.startRender(v1.id, {})).rejects.toMatchObject({ status: 409 }); // one render per plan at a time
    const done = await until(() => getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running');
    expect(done.error).toBeNull();
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    expect(r).toMatchObject({ status: 'pending_review', loudness: { preset: 'streaming_-14' } });
    expect(r.loudness!.measured).not.toBeNull(); // two-pass loudnorm measured the tone
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    const abs = path.join(dir, r.storagePath!);
    expect((await stat(abs)).size).toBe(r.size);

    // the output: 1080x1920, 30 fps, H.264 + AAC 48 kHz, about 4 s
    const info = await run(ff, ['-hide_banner', '-i', abs]).catch((e: { stderr: string }) => ({ stderr: e.stderr }));
    expect(info.stderr).toMatch(/Video: h264.*1080x1920.*30 fps/);
    expect(info.stderr).toMatch(/Audio: aac.*48000 Hz, stereo/);
    const dur = /Duration: 00:00:(\d+\.\d+)/.exec(info.stderr);
    expect(Number(dur![1])).toBeGreaterThan(3.8);
    expect(Number(dur![1])).toBeLessThan(4.3);

    // footage under an approved EDL cannot be deleted; a rejected script blocks the render approval
    await expect(footage.deleteFootage(wide.asset.id)).rejects.toMatchObject({ status: 409 });
    await content.setScriptStatus(script.id, 'rejected');
    await expect(edit.reviewRender(r.id, { decision: 'approve' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Skript wurde verworfen/) });
    await content.setScriptStatus(script.id, 'draft');

    // render review: approve, or reject/revise with a reason; revise creates a new draft version
    await expect(edit.reviewRender(r.id, { decision: 'revise' })).rejects.toMatchObject({ status: 400 });
    const { revision } = await edit.reviewRender(r.id, { decision: 'revise', note: 'Szene 2 zu kurz' });
    expect(revision).toMatchObject({ version: 2, status: 'draft', parentId: v1.id, body: v1.body });
    expect((await read((db) => db.renders.find((x) => x.id === r.id)!)).status).toBe('rejected');
    await expect(edit.reviewRender(r.id, { decision: 'approve' })).rejects.toMatchObject({ status: 409 });

    // the render streams through the private media route and goes with the project
    const { getMediaRecord } = await import('@/server/services/references');
    expect(await getMediaRecord(r.id)).toEqual({ storagePath: r.storagePath, mime: 'video/mp4' });
    await projects.deleteProject(project.id);
    await expect(stat(abs)).rejects.toThrow();
    expect(await read((db) => [db.editPlans.length, db.renders.length])).toEqual([0, 0]);
  });

  it('a cancelled render ends as cancelled and leaves no file', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const footage = await import('@/server/services/footage');
    const edit = await import('@/server/services/edit');
    const { cancelJob, getJob } = await import('@/server/services/videoJobs');
    const { read, write } = await import('@/server/store');
    const project = await projects.createProject({ title: 'Lang', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Wolle', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    const clip = await footage.uploadFootage(project.id, await fileStream(await fixture('long.mp4', { seconds: 60, size: '1280x720', audio: true })), { name: 'long.mp4', origin: 'own', rightsConfirmed: true }, null);
    await write((db) => {
      const x = db.mediaAssets.find((m) => m.id === clip.asset.id)!;
      x.probe ??= { durationSec: 60, width: 1280, height: 720, rotation: 0, displayWidth: 1280, displayHeight: 720, orientation: 'landscape', fps: 25, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' };
    });
    const plan = await edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId: clip.asset.id, inSec: 0, outSec: 60 }], loudness: 'off' } });
    await edit.approveEditPlan(plan.id);
    const { job, render } = await edit.startRender(plan.id, { idempotencyKey: 'render-key-1' });
    await until(() => getJob(job.id), (j) => j.status === 'running');
    // the same key for another plan is refused, never attached to this render
    const other = await edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId: clip.asset.id, inSec: 0, outSec: 5 }], loudness: 'off' } });
    await edit.approveEditPlan(other.id);
    await expect(edit.startRender(other.id, { idempotencyKey: 'render-key-1' })).rejects.toMatchObject({ status: 409 });
    await cancelJob(job.id);
    await until(() => getJob(job.id), (j) => j.status === 'cancelled');
    await expect(edit.startRender(other.id, { idempotencyKey: 'render-key-1' })).rejects.toMatchObject({ status: 409 }); // also after it ended
    expect(await read((db) => db.renders.find((x) => x.id === render!.id)!.status)).toBe('cancelled');
    // what n8n (WF-06) polls: states only, no paths
    const view = await edit.getJobView(job.id);
    expect(view).toEqual({ jobId: job.id, kind: 'render', status: 'cancelled', progress: expect.anything(), error: 'Abgebrochen', done: true, render: { id: render!.id, status: 'cancelled', reviewRequired: false } });
    expect(JSON.stringify(view)).not.toContain(dir);
    // a failed job's tool output with local paths reaches n8n without them
    await write((db) => { db.mediaJobs.find((j) => j.id === job.id)!.error = `FFmpeg ist mit Code 1 beendet: ${dir}/footage/x/a.mp4: No such file or directory /Users/someone/other/file.mov`; });
    const failed = await edit.getJobView(job.id);
    expect(failed.error).toBe('FFmpeg ist mit Code 1 beendet: <daten><pfad>: No such file or directory <pfad>');
    await expect(stat(path.join(dir, 'jobs', job.id))).rejects.toThrow();
    await expect(stat(path.join(dir, 'renders', project.id, `${render!.id}.mp4`))).rejects.toThrow();
    // a cancelled render can be deleted; it is not a reviewed record
    await edit.deleteRender(render!.id);
  });
});
