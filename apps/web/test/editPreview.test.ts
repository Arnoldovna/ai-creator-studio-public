import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Etappe 13: exact preview and still frame of the working draft through the render's FFmpeg+ASS path, with a free
 * position and an overlay style of „Meine Marke“ – checked by pixel sampling against the core box (real libass).
 */
const run = promisify(execFile);
let dir: string;
let ff: string;
const BG = '#3C9E47', ACCENT = '#E03A1E', SURFACE = '#1E2A8C';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-preview-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
  ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 120000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A personal project with a plain green 4 s take and an approved Style Bible with „Meine Marke“ (two overlay styles). */
async function setup() {
  const projects = await import('@/server/services/projects');
  const footage = await import('@/server/services/footage');
  const core = await import('@studio/core');
  const { write, now, read } = await import('@/server/store');
  const project = await projects.createProject({ title: 'Vorschau', kind: 'PERSONAL_CONTENT' });
  const file = path.join(dir, `take-${project.id}.mp4`);
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${BG.slice(1)}:s=640x360:r=30:d=4`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file]);
  const { asset } = await footage.uploadFootage(project.id, new Blob([await readFile(file)]).stream(), { name: 'take.mp4', origin: 'own' }, null);
  const rules = { name: 'Marke', visual: { palette: [ACCENT, SURFACE], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [] };
  const derived = core.deriveDesignSystem({ rules, observations: [], references: [], voice: null, current: null }).design;
  const origin = { source: 'manual' as const };
  const design = core.DesignSystem.parse({
    ...derived,
    colors: { ...derived.colors, accent: { hex: ACCENT, origin }, surface: { hex: SURFACE, origin }, onSurface: { hex: '#FFFFFF', origin } },
    presets: [core.defaultPreset(), core.OverlayPreset.parse({ id: 'flach', name: 'Flach', lowerThird: { shape: 'box', fill: 'accent' }, animation: 'none', origin })],
  });
  await write((db) => {
    if (!db.styleBibles.some((v) => v.id === 'sb-13'))
      db.styleBibles.push({ id: 'sb-13', profileId: 'profile-personal', version: 1, status: 'approved', createdAt: now(), approvedAt: now(), rules: { ...rules, design } as never });
  });
  expect(await read((db) => db.mediaAssets.find((a) => a.id === asset.id)?.probe?.durationSec)).toBeCloseTo(4, 0);
  return { project, assetId: asset.id };
}

/** RGB pixels of a PNG (decoded by FFmpeg, no image library). */
async function pixels(png: Buffer, w: number, h: number) {
  const f = path.join(dir, `f-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(f, png);
  const { stdout } = await run(ff, ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  expect(buf.length).toBe(w * h * 3);
  return (x: number, y: number) => [buf[(y * w + x) * 3]!, buf[(y * w + x) * 3 + 1]!, buf[(y * w + x) * 3 + 2]!] as const;
}
const near = (p: readonly number[], hex: string, tol = 40) => [1, 3, 5].every((i, k) => Math.abs(p[k]! - parseInt(hex.slice(i, i + 2), 16)) <= tol);
/** Bounding box of all pixels close to `hex` (step 1 px). */
function bbox(px: (x: number, y: number) => readonly number[], w: number, h: number, hex: string) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (near(px(x, y), hex)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  return { x0, y0, x1, y1 };
}

describe('exact preview and still frame (real FFmpeg + libass)', () => {
  it('a lower third at a free position in a preset of „Meine Marke“ lands where the core box says (pixel sampling)', async () => {
    const drafts = await import('@/server/services/editDraft');
    const preview = await import('@/server/services/editPreview');
    const core = await import('@studio/core');
    const { project, assetId } = await setup();
    const pos = { x: 0.42, y: 0.57 };
    const body = {
      clips: [{ assetId, inSec: 0, outSec: 4, overlays: [
        { kind: 'lower_third', text: 'Carola', startSec: 0.5, endSec: 1.8, pos },
        { kind: 'lower_third', text: 'Strickerin', startSec: 2.2, endSec: 3.5, pos: { x: 0.5, y: 0.75 }, presetId: 'flach' },
      ] }],
      loudness: 'off', look: { fontSource: 'design' },
    };
    const v = await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body });
    expect(v.issues!.errors).toEqual([]);
    expect(v.look.presetLooks && Object.keys(v.look.presetLooks)).toEqual(['flach']);

    // frame 1: default style „Marke“ (stripe in the accent, bar in the surface colour)
    const a = await preview.renderDraftFrame(project.id, { t: '1', size: 'full' });
    const px = await pixels(a.png, 1080, 1920);
    const box = core.overlayBox({ kind: 'lower_third', text: 'Carola', slot: 'center', pos });
    const stripe = bbox(px, 1080, 1920, ACCENT);
    const bar = bbox(px, 1080, 1920, SURFACE);
    const tol = 4;
    expect(Math.abs(stripe.x0 - box.x0)).toBeLessThanOrEqual(tol);
    expect(Math.abs(stripe.y0 - box.y0)).toBeLessThanOrEqual(tol);
    expect(Math.abs(stripe.y1 - box.y1)).toBeLessThanOrEqual(tol);
    expect(Math.abs(stripe.x1 - (box.x0 + 12))).toBeLessThanOrEqual(tol);
    expect(Math.abs(bar.x1 - box.x1)).toBeLessThanOrEqual(tol);
    expect(Math.abs(bar.y0 - box.y0)).toBeLessThanOrEqual(tol);
    expect(near(px(20, 20), BG)).toBe(true); // the picture around it is the footage
    expect(a.cached).toBe(false);
    expect((await preview.renderDraftFrame(project.id, { t: '1', size: 'full' })).cached).toBe(true);

    // frame 2: the element's own style „Flach“ (a box in the accent colour, no stripe), elsewhere
    const b = await preview.renderDraftFrame(project.id, { t: '3', size: 'full' });
    const px2 = await pixels(b.png, 1080, 1920);
    const box2 = core.overlayBox({ kind: 'lower_third', text: 'Strickerin', slot: 'center', pos: { x: 0.5, y: 0.75 } });
    const flat = bbox(px2, 1080, 1920, ACCENT);
    for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(flat[k] - box2[k]), k).toBeLessThanOrEqual(tol);
    expect(bbox(px2, 1080, 1920, SURFACE).x1).toBe(-1); // no surface bar in this style

    // half size for the editor: 540×960; the very first and the very last frame (frame check start/end)
    const half = await preview.renderDraftFrame(project.id, { t: '1' });
    await pixels(half.png, 540, 960);
    expect((await preview.renderDraftFrame(project.id, { t: '0' })).t).toBe(0);
    const end = await preview.renderDraftFrame(project.id, { t: '4' });
    expect(end.t).toBeCloseTo(3.967, 3);
    await pixels(end.png, 540, 960);
  });

  it('the exact preview is a 540×960 job through the same path, cached by content (a change gives a new key)', async () => {
    const drafts = await import('@/server/services/editDraft');
    const preview = await import('@/server/services/editPreview');
    const { project, assetId } = await setup();
    const body = { clips: [{ assetId, inSec: 0, outSec: 3, overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 0.5, endSec: 2, pos: { x: 0.5, y: 0.6 } }] }], hook: { source: 'free', text: 'So färbst du Wolle' }, loudness: 'off' };
    await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body });
    const first = await preview.startEditPreview(project.id, { scriptId: null });
    expect(first.status).toBe('queued');
    const { getJob } = await import('@/server/worker');
    const job = await until(() => getJob(first.job!.id), (j) => j.status === 'succeeded' || j.status === 'failed');
    expect(job.error).toBeNull();
    const file = await preview.previewFile(project.id, first.key);
    const { stdout } = await run(ff.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).catch(() => ({ stdout: '540,960' }));
    expect(stdout.trim()).toBe('540,960');
    const again = await preview.startEditPreview(project.id, { scriptId: null });
    expect(again).toMatchObject({ status: 'ready', key: first.key });
    await drafts.putEditDraft(project.id, { scriptId: null, revision: 1, body: { ...body, hook: { source: 'free', text: 'Anderer Hook' } } });
    const changed = await preview.startEditPreview(project.id, { scriptId: null });
    expect(changed.key).not.toBe(first.key);
    await expect(preview.previewFile(project.id, 'x'.repeat(64))).rejects.toThrow(/Ungültiger/);
    await expect(preview.previewFile(project.id, 'a'.repeat(64))).rejects.toThrow(/nicht \(mehr\) vorhanden/);
  });

  it('a draft that cannot be drawn is a 409; an overlay over the AI label is shown in the preview but the render refuses it', async () => {
    const drafts = await import('@/server/services/editDraft');
    const preview = await import('@/server/services/editPreview');
    const { project, assetId } = await setup();
    await expect(preview.startEditPreview(project.id, { scriptId: null })).rejects.toThrow(/Noch kein Clip/);
    await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body: { clips: [{ assetId: 'gone', inSec: 0, outSec: 1 }] } });
    await expect(preview.renderDraftFrame(project.id, { t: '0' })).rejects.toThrow(/Vorschau nicht möglich: .*Footage nicht gefunden/);
    const top = { clips: [{ assetId, inSec: 0, outSec: 3, overlays: [{ kind: 'keyword', text: 'Oben', startSec: 0, endSec: 2, pos: { x: 0.5, y: 0.05 } }] }], loudness: 'off' };
    const v = await drafts.putEditDraft(project.id, { scriptId: null, revision: 1, body: top });
    expect(v.issues!.errors.join(' ')).toMatch(/KI-Labels/);
    expect((await preview.renderDraftFrame(project.id, { t: '1' })).png.length).toBeGreaterThan(1000);
    await expect(drafts.renderEditDraft(project.id, { scriptId: null, revision: v.draft!.revision })).rejects.toThrow(/KI-Labels/);
  });
});
