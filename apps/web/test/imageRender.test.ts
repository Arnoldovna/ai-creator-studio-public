import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Etappe 16: image overlays through the real FFmpeg path – her library image under the ASS layer (keyword, AI label),
 * still frame = render (pixel sampling), a generated image carries the AI label, and the label lies on top even where
 * an image covers it.
 */
const run = promisify(execFile);
let dir: string;
let ff: string;
const BG = '#3C9E47', ACCENT = '#E03A1E', SURFACE = '#1E2A8C', IMG = '#2050F0';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-image-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1', STUDIO_DEFAULTS_DIR: 'off' });
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
async function pixelsOf(file: string, w: number, h: number, seek?: number) {
  const { stdout } = await run(ff, ['-hide_banner', '-loglevel', 'error', ...(seek != null ? ['-ss', String(seek)] : []), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  expect(buf.length).toBe(w * h * 3);
  return (x: number, y: number) => [buf[(y * w + x) * 3]!, buf[(y * w + x) * 3 + 1]!, buf[(y * w + x) * 3 + 2]!] as const;
}
/** Share of pixels close to `hex` inside a box (libass wraps the keyword box tighter than the core box). */
const share = (px: (x: number, y: number) => readonly number[], b: { x0: number; y0: number; x1: number; y1: number }, hex: string) => {
  let n = 0, hit = 0;
  for (let y = Math.ceil(b.y0); y < b.y1; y += 4) for (let x = Math.ceil(b.x0); x < b.x1; x += 4) { n++; if (near(px(x, y), hex)) hit++; }
  return hit / n;
};
const near = (p: readonly number[], hex: string, tol = 45) => [1, 3, 5].every((i, k) => Math.abs(p[k]! - parseInt(hex.slice(i, i + 2), 16)) <= tol);

async function setup() {
  const projects = await import('@/server/services/projects');
  const footage = await import('@/server/services/footage');
  const refs = await import('@/server/services/references');
  const core = await import('@studio/core');
  const { write, now } = await import('@/server/store');
  const project = await projects.createProject({ title: 'Bilder', kind: 'PERSONAL_CONTENT' });
  const take = path.join(dir, `take-${project.id}.mp4`);
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${BG.slice(1)}:s=640x360:r=30:d=4`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', take]);
  const { asset } = await footage.uploadFootage(project.id, new Blob([await readFile(take)]).stream(), { name: 'take.mp4', origin: 'own' }, null);
  const png = path.join(dir, `img-${project.id}.png`);
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${IMG.slice(1)}:s=400x300`, '-frames:v', '1', '-y', png]);
  const { reference } = await refs.createReference(new File([await readFile(png)], 'atelier.png', { type: 'image/png' }), null);
  const rules = { name: 'Marke', visual: { palette: [ACCENT, SURFACE], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [] };
  const derived = core.deriveDesignSystem({ rules, observations: [], references: [], voice: null, current: null }).design;
  const origin = { source: 'manual' as const };
  const design = core.DesignSystem.parse({ ...derived, colors: { ...derived.colors, accent: { hex: ACCENT, origin }, surface: { hex: SURFACE, origin }, onSurface: { hex: '#FFFFFF', origin } } });
  await write((db) => {
    if (!db.styleBibles.some((v) => v.id === 'sb-16i')) db.styleBibles.push({ id: 'sb-16i', profileId: 'profile-personal', version: 1, status: 'approved', createdAt: now(), approvedAt: now(), rules: { ...rules, design } as never });
  });
  return { project, assetId: asset.id, referenceId: reference.id, png };
}

describe('image overlays (real FFmpeg + libass)', () => {
  it('a generated library image: still frame and render agree, the image lies where the core box says, the AI label is burned in', async () => {
    const refs = await import('@/server/services/references');
    const drafts = await import('@/server/services/editDraft');
    const preview = await import('@/server/services/editPreview');
    const core = await import('@studio/core');
    const { project, assetId, referenceId } = await setup();
    const { imageAspects } = await import('@/server/services/editDirection');
    const { read } = await import('@/server/store');
    // without a usage note the image is refused
    const image = { referenceId, startSec: 0.5, endSec: 3.5, aspect: 4 / 3, size: 'M', fade: false };
    const body = { clips: [{ assetId, inSec: 0, outSec: 4, images: [image], overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 0.5, endSec: 3.5, pos: { x: 0.5, y: 0.78 } }] }], loudness: 'off', look: { fontSource: 'design' } };
    const v0 = await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body });
    expect(v0.issues!.errors.join(' ')).toMatch(/nicht angegeben, ob es dein eigenes/);
    await refs.updateReference(referenceId, { usage: { origin: 'generated', source: '' } });
    const ref = await read((db) => db.references.find((r) => r.id === referenceId)!);
    expect((await imageAspects([ref])).get(referenceId)).toBeCloseTo(4 / 3, 3);
    const v = await drafts.putEditDraft(project.id, { scriptId: null, revision: 1, body });
    expect(v.issues!.errors).toEqual([]);

    const still = await preview.renderDraftFrame(project.id, { t: '2', size: 'full' });
    const f = path.join(dir, 'still.png');
    await writeFile(f, still.png);
    const px = await pixelsOf(f, 1080, 1920);
    const box = core.imageBox({ aspect: 4 / 3, size: 'M' });
    expect(near(px((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2), IMG)).toBe(true);
    expect(near(px(box.x0 + 4, box.y0 + 4), IMG)).toBe(true);
    expect(near(px(box.x0 - 6, box.y0 + 20), BG)).toBe(true);
    expect(near(px(box.x1 + 6, box.y0 + 20), BG)).toBe(true);
    // the AI label (black box, white text, top left) because the image is generated
    expect(near(px(52, 180), '#000000', 30)).toBe(true);
    // the keyword (accent box) over the footage
    const kw = core.overlayBox({ kind: 'keyword', text: 'Wolle', slot: 'center', pos: { x: 0.5, y: 0.78 } });
    expect(share(px, kw, ACCENT)).toBeGreaterThan(0.25);
    // before and after the image: the footage
    const early = await preview.renderDraftFrame(project.id, { t: '0.1', size: 'full' });
    await writeFile(f, early.png);
    expect(near((await pixelsOf(f, 1080, 1920))((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2), BG)).toBe(true);

    // the render: same pixels at the same moment, the AI label in the record
    const out = await drafts.renderEditDraft(project.id, { scriptId: null, revision: v.draft!.revision });
    expect(out.render!.disclosures).toEqual([core.AI_DISCLOSURE]);
    const { getJob } = await import('@/server/worker');
    const job = await until(() => getJob(out.job!.id), (j) => j.status === 'succeeded' || j.status === 'failed');
    expect(job.error).toBeNull();
    const render = await read((db) => db.renders.find((r) => r.id === out.render!.id)!);
    const { absolutePath } = await import('@/server/media');
    const rp = await pixelsOf(absolutePath(render.storagePath!), 1080, 1920, 2);
    expect(near(rp((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2), IMG)).toBe(true);
    expect(near(rp(box.x0 - 6, box.y0 + 20), BG)).toBe(true);
    expect(near(rp(52, 180), '#000000', 30)).toBe(true);
    expect(share(rp, kw, ACCENT)).toBeGreaterThan(0.25);
  });

  it('the AI label stays on top even where an image covers the top of the picture (layer order of the graph)', async () => {
    const core = await import('@studio/core');
    const { runFfmpeg } = await import('@/server/ffmpeg');
    const { png } = await setup();
    const take = path.join(dir, 'plain.mp4');
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${BG.slice(1)}:s=540x960:r=30:d=2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', take]);
    const ass = path.join(dir, 'label.ass');
    await writeFile(ass, core.buildAss([], { labels: [{ startSec: 0, endSec: 2, text: core.AI_DISCLOSURE }] }), 'utf8');
    const out = path.join(dir, 'over.mp4');
    const layer = { path: png, x: 0, y: 0, w: 1080, h: 700, startSec: 0, endSec: 2, fade: false };
    await runFfmpeg(core.buildRender([{ path: take, hasAudio: false, inSec: 0, outSec: 2 }], out, { preset: 'off', measured: null }, ass, null, [layer]), { signal: AbortSignal.timeout(60_000) });
    const px = await pixelsOf(out, 1080, 1920, 1);
    expect(near(px(52, 180), '#000000', 30)).toBe(true); // label box on top of the image
    expect(near(px(900, 100), IMG)).toBe(true); // the image under it
    expect(near(px(540, 1200), BG)).toBe(true); // the footage below the image
  });
});
