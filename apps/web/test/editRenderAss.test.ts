import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

/**
 * Etappe 8, part 3: the render handler's hook/overlay path WITHOUT libass on the machine. FFmpeg is stubbed:
 * `ffmpegStatus().subtitles` is true and `runFfmpeg` captures the written subtitles.ass instead of encoding,
 * so the handler steps (stored body → timeline → look snapshot → ASS with hook, overlays and the AI label,
 * font warnings from the render log) are checked on every run.
 */
const captured: { ass: string | null; renderArgs: string[] | null } = { ass: null, renderArgs: null };
let releaseBlocker: () => void = () => undefined;
const blocker = new Promise<void>((r) => (releaseBlocker = r));
/** libass log of the render: the requested family resolved to another font (silent fallback). */
const RENDER_LOG = '[Parsed_subtitles_0 @ 0x1] fontselect: (Avenir Next, 700, 0) -> /System/Library/Fonts/Helvetica.ttc, 0, Helvetica-Bold\n';

vi.mock('@/server/ffmpeg', async (orig) => {
  const real = await orig<typeof import('@/server/ffmpeg')>();
  return {
    ...real,
    ffmpegStatus: async () => ({ ...(await real.ffmpegStatus()), available: true, subtitles: true }),
    runFfmpeg: async (args: string[], opts?: Parameters<typeof real.runFfmpeg>[1]) => {
      const out = args[args.length - 1]!;
      if (out.endsWith('selftest.mp4')) {
        await blocker; // holds the single worker slot until the test released it
        await writeFile(out, 'x');
        return { stderr: '' };
      }
      if (out.endsWith('render.mp4')) {
        captured.renderArgs = args;
        captured.ass = await readFile(path.join(path.dirname(out), 'subtitles.ass'), 'utf8');
        await writeFile(out, 'not a real video');
        return { stderr: RENDER_LOG };
      }
      return real.runFfmpeg(args, opts);
    },
  };
});

const run = promisify(execFile);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-render-ass-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
  await seedApprovedStrategy();
});
afterAll(async () => {
  releaseBlocker();
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('render handler: hook and overlays into the ASS file (FFmpeg stubbed)', () => {
  it('writes the exact script hook, the overlays and the AI label last, in the snapshotted look, with subtitles off', async () => {
    const core = await import('@studio/core');
    const { ffmpegPath } = await import('@/server/ffmpeg');
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const content = await import('@/server/services/content');
    const edit = await import('@/server/services/edit');
    const jobs = await import('@/server/services/videoJobs');
    const { read, write, now } = await import('@/server/store');

    const project = await projects.createProject({ title: 'ASS', kind: 'PERSONAL_CONTENT' });
    const file = path.join(dir, 'take.mp4');
    await run((await ffmpegPath())!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file]);
    const own = (await footage.uploadFootage(project.id, new Blob([await readFile(file)]).stream(), { name: 'take.mp4', origin: 'own', rightsConfirmed: true }, null)).asset;

    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Wolle färben', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    await write((db) => {
      const s = db.scripts.find((x) => x.id === script.id)!;
      s.body.scenes[0]!.dialogue = 'Heute färbe ich Wolle mit Zwiebelschalen.';
      s.body.scenes[1]!.shotType = 'b_roll';
    });
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    const hookText = (await read((db) => db.scripts.find((x) => x.id === script.id)!.body.selectedHook)).replace(/\s+/g, ' ').trim();
    expect(hookText).not.toBe('');

    // a reviewed generated clip for scene 2 (records as Etappe 7 leaves them), so the AI label is burned in too
    await write((db) => {
      const a = db.mediaAssets.find((x) => x.id === own.id)!;
      a.probe ??= { durationSec: 4, width: 640, height: 360, rotation: 0, displayWidth: 640, displayHeight: 360, orientation: 'landscape', fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' } as never;
      db.mediaAssets.push({ ...a, id: 'gen-asset', origin: 'generated', generation: { generationId: 'gen-1', briefId: 'brief-1', model: 'seedance_2_5', prompt: 'Wolle', higgsfieldJobId: 'h', credits: 1, mock: true, review: 'approved' } });
      db.generations.push({ id: 'gen-1', projectId: project.id, scriptId: script.id, briefId: 'brief-1', sceneIndex: 1, status: 'approved', assetId: 'gen-asset' } as never);
      db.styleBibles.push({ id: 'sb-pin', profileId: project.profileId, version: 1, status: 'approved', rules: { visual: { palette: ['#C8553D', '#20302A'] } } as never, createdAt: now(), approvedAt: now() });
    });

    const plan = await edit.saveEditPlan(project.id, { scriptId: script.id, body: {
      clips: [
        { sceneIndex: 0, assetId: own.id, inSec: 0, outSec: 4, overlays: [{ kind: 'lower_third', startSec: 0.5, endSec: 3, text: 'Wolle mit Zwiebelschalen', slot: 'lower' }, { kind: 'arrow', startSec: 3, endSec: 4, slot: 'lower' }] },
        { sceneIndex: 1, assetId: 'gen-asset', inSec: 0, outSec: 2, briefId: 'brief-1' },
      ],
      hook: { source: 'selected', text: 'wird durch den Skript-Text ersetzt', slot: 'upper', endSec: 2 },
      subtitles: 'off', loudness: 'off',
    } });
    expect(plan.body.hook!.text).toBe(hookText);
    await write((db) => { db.editPlans.find((p) => p.id === plan.id)!.styleBibleVersionId = 'sb-pin'; });
    await edit.approveEditPlan(plan.id);

    // hold the worker so the pinned Style Bible can change between queueing (snapshot) and rendering
    const blockerJob = await jobs.startSelftest({});
    await until(() => jobs.getJob(blockerJob.job.id), (j) => j.status === 'running');
    const { job, render } = await edit.startRender(plan.id, {});
    const snap = render!.look!;
    expect(snap).toMatchObject({ source: 'style_bible', styleBibleVersionId: 'sb-pin', font: 'Avenir Next', warnings: [] });
    await write((db) => { (db.styleBibles.find((x) => x.id === 'sb-pin')!.rules as never as { visual: { palette: string[] } }).visual.palette = ['#00FF00', '#0000FF']; });
    const changed = await read((db) => edit.planLook(db, db.editPlans.find((p) => p.id === plan.id)!, { font: 'Avenir Next' }));
    expect(core.lookKey(changed)).not.toBe(core.lookKey(snap)); // the test is only meaningful if the look really changed
    releaseBlocker();

    const done = await until(() => jobs.getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running');
    expect(done.error).toBeNull();
    const ass = captured.ass!;
    expect(ass).toBeTruthy();
    expect(captured.renderArgs!.join(' ')).toContain('subtitles');
    const lines = ass.trim().split('\n');
    const events = lines.filter((l) => l.startsWith('Dialogue:'));

    // no subtitles (off), but the hook: exactly the script string, wrapped by hookLayout
    expect(events.some((l) => l.startsWith('Dialogue: 0,') && l.includes(',Default,'))).toBe(false);
    const layout = core.hookLayout(hookText, 'upper')!;
    const hook = events.filter((l) => l.includes(',Hook,'));
    expect(hook).toHaveLength(1);
    expect(hook[0]!.endsWith(layout.lines.map(core.escapeAss).join('\\N'))).toBe(true);
    expect(hook[0]!.startsWith(`Dialogue: ${core.LAYER.hook},`)).toBe(true);
    // the overlays: lower third text, its two bars and the arrow on the shape layer
    expect(events.filter((l) => l.includes(',LowerThird,') && l.endsWith('Wolle mit Zwiebelschalen'))).toHaveLength(1);
    expect(events.filter((l) => l.startsWith(`Dialogue: ${core.LAYER.shapes},`) && l.includes(',Shape,'))).toHaveLength(3);
    // colours from the SNAPSHOT, not from the Style Bible as it is now
    expect(ass).toContain(core.hexToAssTag(snap.accent));
    expect(ass).not.toContain(core.hexToAssTag(changed.accent));
    expect(lines.find((l) => l.startsWith('Style: LowerThird,'))).toContain(`AvenirNext-Bold,56,${core.hexToAssStyle(snap.text)}`);
    // the AI label: last, on its own top layer, fixed text and fixed font
    const labelIdx = events.map((l, i) => (l.includes(',Label,') ? i : -1)).filter((i) => i >= 0);
    expect(labelIdx.length).toBeGreaterThan(0);
    expect(labelIdx.every((i) => i >= events.length - labelIdx.length)).toBe(true);
    for (const i of labelIdx) expect(events[i]!).toMatch(new RegExp(`^Dialogue: ${core.LABEL_LAYER},.*,Label,,0,0,0,,${core.AI_DISCLOSURE}$`));
    expect(Math.max(...events.filter((l) => !l.includes(',Label,')).map((l) => Number(/^Dialogue: (\d+),/.exec(l)![1])))).toBeLessThan(core.LABEL_LAYER);

    // the render record keeps the snapshot and gets the font warning from the render log
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    expect(r.status).toBe('pending_review');
    expect(r.look).toMatchObject({ accent: snap.accent, styleBibleVersionId: 'sb-pin' });
    expect(r.look!.warnings).toEqual([expect.stringMatching(/„Avenir Next“ nicht gefunden.*Helvetica-Bold/)]);
    // and the changed Style Bible blocks the approval of this render
    await expect(edit.reviewRender(r.id, { decision: 'approve' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Look/) });
  });
});
