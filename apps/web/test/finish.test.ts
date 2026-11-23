import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Etappe 17: the CapCut/finish package through the real FFmpeg + libass path. The clean video has no hook, keyword or
 * subtitles (pixel sampling where the render draws them) but keeps the AI label for a generated image or clip; the alpha
 * layer is transparent around the text; the ZIP holds the expected files with correct SRT and text sheet. Client renders
 * export only after approval.
 */
const run = promisify(execFile);
let dir: string;
let ff: string, fp: string;
const BG = '#3C9E47', ACCENT = '#E03A1E', SURFACE = '#1E2A8C', IMG = '#2050F0';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-finish-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1', STUDIO_DEFAULTS_DIR: 'off', TRANSCRIPTION: 'mock' });
  const f = await import('@/server/ffmpeg');
  ff = (await f.ffmpegPath())!;
  fp = (await f.ffprobePath())!;
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  delete process.env.TRANSCRIPTION;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 180000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function frame(file: string, seek: number, fmt: 'rgb24' | 'rgba' = 'rgb24') {
  const n = fmt === 'rgba' ? 4 : 3;
  const { stdout } = await run(ff, ['-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  expect(buf.length).toBe(1080 * 1920 * n);
  return (x: number, y: number) => Array.from(buf.subarray((Math.round(y) * 1080 + Math.round(x)) * n, (Math.round(y) * 1080 + Math.round(x)) * n + n));
}
const near = (p: readonly number[], hex: string, tol = 45) => [1, 3, 5].every((i, k) => Math.abs(p[k]! - parseInt(hex.slice(i, i + 2), 16)) <= tol);
type Box = { x0: number; y0: number; x1: number; y1: number };
const share = (px: (x: number, y: number) => readonly number[], b: Box, test: (p: readonly number[]) => boolean) => {
  let n = 0, hit = 0;
  for (let y = Math.ceil(b.y0) + 2; y < b.y1 - 2; y += 4) for (let x = Math.ceil(b.x0) + 2; x < b.x1 - 2; x += 4) { n++; if (test(px(x, y))) hit++; }
  return hit / n;
};
const LABEL_PX = [52, 180] as const;

async function setup(title: string, kind: 'PERSONAL_CONTENT' | 'UGC_CLIENT' = 'PERSONAL_CONTENT') {
  const projects = await import('@/server/services/projects');
  const footage = await import('@/server/services/footage');
  const core = await import('@studio/core');
  const { write, now } = await import('@/server/store');
  const project = await projects.createProject({ title, kind, ...(kind === 'UGC_CLIENT' ? { client: { name: 'Kunde', brief: 'x' } } : {}) } as never);
  const take = path.join(dir, `take-${project.id}.mp4`);
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${BG.slice(1)}:s=640x360:r=30:d=4`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', take]);
  const { asset } = await footage.uploadFootage(project.id, new Blob([await readFile(take)]).stream(), { name: 'take.mp4', origin: 'own', rightsConfirmed: true }, null);
  // a transcript of the take (as the transcription would store it): words over the 4 s
  const words = ['Heute', 'färbe', 'ich', 'Wolle', 'mit', 'Zwiebelschalen', 'und', 'Essig.'].map((text, i) => ({ startSec: 0.2 + i * 0.45, endSec: 0.2 + i * 0.45 + 0.4, text }));
  const body = { language: 'de', segments: [{ startSec: 0, endSec: 4, text: words.map((w) => w.text).join(' '), words }] };
  const storagePath = `transcripts/${project.id}/t-${asset.id}.json`;
  await mkdir(path.join(dir, 'transcripts', project.id), { recursive: true });
  await writeFile(path.join(dir, storagePath), JSON.stringify(body), 'utf8');
  const rules = { name: 'Marke', visual: { palette: [ACCENT, SURFACE], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [] };
  const derived = core.deriveDesignSystem({ rules, observations: [], references: [], voice: null, current: null }).design;
  const origin = { source: 'manual' as const };
  const design = core.DesignSystem.parse({ ...derived, colors: { ...derived.colors, accent: { hex: ACCENT, origin }, surface: { hex: SURFACE, origin }, onSurface: { hex: '#FFFFFF', origin } } });
  await write((db) => {
    db.transcripts.push({ id: `t-${asset.id}`, projectId: project.id, assetId: asset.id, version: 1, parentId: null, source: 'whisper', model: 'test', language: 'de', storagePath, segmentCount: 1, createdAt: now() });
    if (!db.styleBibles.some((v) => v.id === 'sb-17')) db.styleBibles.push({ id: 'sb-17', profileId: 'profile-personal', version: 1, status: 'approved', createdAt: now(), approvedAt: now(), rules: { ...rules, design } as never });
  });
  return { project, assetId: asset.id };
}

async function renderDraft(projectId: string, body: unknown) {
  const drafts = await import('@/server/services/editDraft');
  const { getJob } = await import('@/server/worker');
  const v = await drafts.putEditDraft(projectId, { scriptId: null, revision: 0, body });
  expect(v.issues!.errors).toEqual([]);
  const out = await drafts.renderEditDraft(projectId, { scriptId: null, revision: v.draft!.revision });
  const job = await until(() => getJob(out.job!.id), (j) => j.status === 'succeeded' || j.status === 'failed');
  expect(job.error).toBeNull();
  return out.render!;
}
async function finish(renderId: string, opts: { images?: boolean; alpha?: boolean }) {
  const fin = await import('@/server/services/finish');
  const { getJob } = await import('@/server/worker');
  const s = await fin.startFinish(renderId, opts);
  if (s.job) {
    const j = await until(() => getJob(s.job!.id), (x) => x.status === 'succeeded' || x.status === 'failed');
    expect(j.error).toBeNull();
  }
  return fin.getFinishState(renderId);
}
async function zipOf(renderId: string, q: Record<string, string>) {
  const fin = await import('@/server/services/finish');
  const { zipStream } = await import('@/server/zip');
  const { filename, entries } = await fin.finishPackage(renderId, q);
  const out = path.join(dir, `${renderId}-${Object.values(q).join('')}.zip`);
  await pipeline(Readable.from(zipStream(entries)), createWriteStream(out));
  return { filename, out };
}
const unzipList = async (zip: string) => (await run('unzip', ['-Z1', zip])).stdout.trim().split('\n').sort();
const unzipText = async (zip: string, name: string) => (await run('unzip', ['-p', zip, name])).stdout;

describe('Etappe 17: CapCut package (real FFmpeg + libass)', () => {
  it('clean video: no hook/keyword/subtitles but the AI label of a generated image; without images no label; alpha layer; ZIP contents', async () => {
    const refs = await import('@/server/services/references');
    const core = await import('@studio/core');
    const { absolutePath } = await import('@/server/media');
    const { read } = await import('@/server/store');
    const { project, assetId } = await setup('Wolle färben');
    const png = path.join(dir, 'img.png');
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${IMG.slice(1)}:s=400x300`, '-frames:v', '1', '-y', png]);
    const { reference } = await refs.createReference(new File([await readFile(png)], 'atelier.png', { type: 'image/png' }), null);
    await refs.updateReference(reference.id, { usage: { origin: 'generated', source: '' } });
    const body = {
      clips: [{
        assetId, inSec: 0, outSec: 4, cuts: [{ startSec: 1.55, endSec: 2.05 }],
        images: [{ referenceId: reference.id, startSec: 0.5, endSec: 3.5, aspect: 4 / 3, size: 'M', fade: false }],
        overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 0.5, endSec: 3.5, pos: { x: 0.5, y: 0.6 } }],
      }],
      hook: { source: 'free', text: 'So färbst du Wolle', endSec: 2, slot: 'upper' },
      subtitles: 'burn', loudness: 'off', look: { fontSource: 'design' },
    };
    const render = await renderDraft(project.id, body);
    expect(render.disclosures).toEqual([core.AI_DISCLOSURE]);
    const state = await finish(render.id, { images: true, alpha: true });
    expect(state.files).toMatchObject({ clean: true, alpha: true, cover: true, clean_noimg: false });
    expect(state.options).toEqual({ images: true, alpha: true });
    const r = await read((db) => db.renders.find((x) => x.id === render.id)!);
    const clean = absolutePath(r.finish!.files.clean!.storagePath), withText = absolutePath(r.storagePath!);

    const kw = core.overlayBox({ kind: 'keyword', text: 'Wolle', slot: 'center', pos: { x: 0.5, y: 0.6 } });
    const hookBox = core.hookLayout('So färbst du Wolle', 'upper')!.box;
    const subBand = { x0: 200, y0: 1400, x1: 880, y1: 1560 };
    const notBg = (p: readonly number[]) => !near(p, BG, 30);
    // t = 0.3: hook, no image yet; t = 1.0: keyword, subtitles, image
    const [r03, c03, r10, c10] = await Promise.all([frame(withText, 0.3), frame(clean, 0.3), frame(withText, 1.0), frame(clean, 1.0)]);
    // the normal render draws them (otherwise the test proves nothing) …
    expect(share(r03, hookBox, notBg)).toBeGreaterThan(0.3);
    expect(share(r10, kw, (p) => near(p, ACCENT))).toBeGreaterThan(0.25);
    expect(share(r10, subBand, (p) => p[0]! > 200 && p[1]! > 200 && p[2]! > 200)).toBeGreaterThan(0.01);
    // … the clean video does not: footage there, at the same moment
    expect(share(c03, hookBox, notBg)).toBeLessThan(0.02);
    expect(share(c10, kw, (p) => near(p, BG, 30))).toBeGreaterThan(0.98);
    expect(share(c10, subBand, (p) => p[0]! > 200 && p[1]! > 200 && p[2]! > 200)).toBe(0);
    // the generated image stays, and with it the AI label (black box top left)
    const ib = core.imageBox({ aspect: 4 / 3, size: 'M' });
    expect(near(c10((ib.x0 + ib.x1) / 2, (ib.y0 + ib.y1) / 2), IMG)).toBe(true);
    expect(near(c10(...LABEL_PX), '#000000', 30)).toBe(true);
    expect(near(r10(...LABEL_PX), '#000000', 30)).toBe(true);

    // alpha layer: ProRes 4444 with alpha, opaque only where the keyword is
    const alpha = absolutePath(r.finish!.files.alpha!.storagePath);
    const probe = JSON.parse((await run(fp, ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height', '-of', 'json', alpha])).stdout).streams[0];
    expect(probe).toMatchObject({ codec_name: 'prores', width: 1080, height: 1920 });
    expect(probe.pix_fmt).toMatch(/^yuva444p1[02]le$/); // the decoder reports 12 bit; the "a" is the alpha plane
    const a10 = await frame(alpha, 1.0, 'rgba');
    expect(a10((kw.x0 + kw.x1) / 2, (kw.y0 + kw.y1) / 2)[3]).toBeGreaterThan(240);
    expect(a10(20, 1900)[3]).toBe(0);
    expect(a10(...LABEL_PX)[3]).toBe(0); // the label is in the clean video, not in the text layer
    expect(a10(540, 1480)[3]).toBe(0); // subtitles come as SRT, not in the layer

    // the ZIP: expected files, correct SRT on the output timeline, schema of texte.json, the label note
    const { filename, out } = await zipOf(render.id, { images: '1', alpha: '1', words: '1' });
    expect(filename).toMatch(/^capcut-paket-wolle-farben-v1\.zip$/);
    await run('unzip', ['-tq', out]);
    expect(await unzipList(out)).toEqual(['ANLEITUNG.md', 'cover.png', 'overlays-alpha.mov', 'projekt.fcpxml', 'texte.json', 'texte.txt', 'untertitel-woerter.srt', 'untertitel.srt', 'video-clean.mp4', 'video-mit-text.mp4'].sort());
    const srt = await unzipText(out, 'untertitel.srt');
    const transcript = JSON.parse(await readFile(path.join(dir, `transcripts/${project.id}/t-${assetId}.json`), 'utf8'));
    const tl = core.buildTimeline(body.clips);
    expect(srt).toBe(core.toSrt(core.cuesForTimeline(tl, [{ subtitle: '', inSec: 0, outSec: 4, transcript }])));
    // the cut [1.55, 2.05): the piece before it is frame-quantised to 47/30 s, so the last word (source end 3.75 s) ends at
    // 47/30 + (3.75 − 2.05) = 3.267 s in the cut, exactly where the render shows it
    expect(srt.startsWith('1\r\n00:00:00,200 --> ')).toBe(true);
    expect(srt.trimEnd().split('\r\n').at(-2)).toMatch(/ --> 00:00:03,267$/);
    const wordsSrt = await unzipText(out, 'untertitel-woerter.srt');
    expect(wordsSrt.split('\r\n\r\n').length).toBeGreaterThanOrEqual(7);
    const sheet = core.FinishTexts.parse(JSON.parse(await unzipText(out, 'texte.json')));
    expect(sheet.items.map((i) => i.kind)).toEqual(['hook', 'keyword']);
    expect(sheet.items[1]).toMatchObject({ text: 'Wolle', start: '0:00.500', style: { fill: ACCENT } });
    expect(sheet.images[0]).toMatchObject({ inCleanVideo: true, generated: true });
    const guide = await unzipText(out, 'ANLEITUNG.md');
    expect(guide).toContain(`Das Label „${core.AI_DISCLOSURE}“ ist oben links eingebrannt`);
    expect(guide).toContain('nicht geprüft');
    expect(await unzipText(out, 'projekt.fcpxml')).toContain('<fcpxml version="1.10">');
    const fx = path.join(dir, 'p.fcpxml');
    await writeFile(fx, await unzipText(out, 'projekt.fcpxml'));
    await run('xmllint', ['--noout', fx]); // well-formed (exit 0)

    // without the image overlays: no image, and no AI label (the image was the only generated element), image as a file
    const s2 = await finish(render.id, { images: false });
    expect(s2.files.clean_noimg).toBe(true);
    const r2 = await read((db) => db.renders.find((x) => x.id === render.id)!);
    const noimg = await frame(absolutePath(r2.finish!.files.clean_noimg!.storagePath), 1.0);
    expect(near(noimg((ib.x0 + ib.x1) / 2, (ib.y0 + ib.y1) / 2), BG, 30)).toBe(true);
    expect(near(noimg(...LABEL_PX), BG, 30)).toBe(true);
    const z2 = await zipOf(render.id, { images: '0', alpha: '0', words: '0' });
    const names = await unzipList(z2.out);
    expect(names.some((n) => /^bilder\/atelier-[a-z0-9]{6}\.png$/i.test(n))).toBe(true);
    expect(names).not.toContain('overlays-alpha.mov');
    expect(names).not.toContain('untertitel-woerter.srt');
    const g2 = await unzipText(z2.out, 'ANLEITUNG.md');
    expect(g2).toContain('kein KI-Label eingebrannt');
    expect(g2).toContain('als KI-generiert markiert');
    // the package needs its files: a deleted one is refused (and made again by the next „Für CapCut exportieren“)
    await rm(absolutePath(r2.finish!.files.cover!.storagePath));
    const fin = await import('@/server/services/finish');
    await expect(fin.finishPackage(render.id, { images: '1' })).rejects.toMatchObject({ status: 409, code: 'finish_missing' });
  });

  it('review fix: an image marked as generated AFTER the export – the package is refused and the old clean video counts as stale', async () => {
    const refs = await import('@/server/services/references');
    const fin = await import('@/server/services/finish');
    const edit = await import('@/server/services/edit');
    const { absolutePath } = await import('@/server/media');
    const { read } = await import('@/server/store');
    const { existsSync } = await import('node:fs');
    const { project, assetId } = await setup('Später KI');
    const png = path.join(dir, 'own.png');
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${IMG.slice(1)}:s=400x300`, '-frames:v', '1', '-y', png]);
    const { reference } = await refs.createReference(new File([await readFile(png)], 'eigenes.png', { type: 'image/png' }), null);
    await refs.updateReference(reference.id, { usage: { origin: 'own', source: '' } });
    const render = await renderDraft(project.id, { clips: [{ assetId, inSec: 0, outSec: 3, images: [{ referenceId: reference.id, startSec: 0.5, endSec: 2.5, aspect: 4 / 3, size: 'M', fade: false }] }], loudness: 'off' });
    expect(render.disclosures).toEqual([]);
    expect((await finish(render.id, {})).files.clean).toBe(true);
    await zipOf(render.id, {}); // fine while nothing changed
    const clean = await read((db) => db.renders.find((r) => r.id === render.id)!.finish!.files.clean!);
    expect(clean.labels).toBe('[]');
    // now she marks the image as generated: the video without label must not go out as „fine“
    await refs.updateReference(reference.id, { usage: { origin: 'generated', source: '' } });
    await expect(fin.finishPackage(render.id, {})).rejects.toMatchObject({ status: 409, code: 'render_stale' });
    expect((await fin.getFinishState(render.id)).files.clean).toBe(false); // its label spans no longer match
    // deleting the render removes the whole finish folder
    const folder = path.dirname(absolutePath(clean.storagePath));
    expect(existsSync(folder)).toBe(true);
    await edit.deleteRender(render.id);
    expect(existsSync(folder)).toBe(false);
  });

  it('review fix: the ZIP is checked before the first byte (a missing file is an error, not a broken download)', async () => {
    const { prepareZip, zipStream } = await import('@/server/zip');
    await expect(prepareZip([{ name: 'a.txt', data: 'x' }, { name: 'b.mp4', file: path.join(dir, 'gibt-es-nicht.mp4') }])).rejects.toThrow(/fehlt: b\.mp4/);
    await expect(prepareZip([{ name: '../x', data: 'x' }])).rejects.toThrow(/Ungültiger Dateiname/);
    const f = path.join(dir, 'z.zip');
    await writeFile(path.join(dir, 'payload.bin'), Buffer.alloc(3 * 1024 * 1024 + 7, 7));
    await pipeline(Readable.from(zipStream([{ name: 'ä.txt', data: 'Grüße' }, { name: 'payload.bin', file: path.join(dir, 'payload.bin') }])), createWriteStream(f));
    await run('unzip', ['-tq', f]);
    expect(await unzipText(f, 'ä.txt')).toBe('Grüße');
  });

  it('a generated CLIP (scripted plan): the clean video keeps the AI label over that clip, none over her own clip', async () => {
    const core = await import('@studio/core');
    const { absolutePath } = await import('@/server/media');
    const { read, write } = await import('@/server/store');
    const content = await import('@/server/services/content');
    const edit = await import('@/server/services/edit');
    const { getJob } = await import('@/server/worker');
    const { seedApprovedStrategy, passFit } = await import('./helpers/strategy');
    await seedApprovedStrategy();
    const { project, assetId } = await setup('KI-Clip');
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Wolle färben', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    await write((db) => { db.scripts.find((x) => x.id === script.id)!.body.scenes[1]!.shotType = 'b_roll'; });
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    // a reviewed generated clip for scene 2 (records as Etappe 7 leaves them)
    await write((db) => {
      const a = db.mediaAssets.find((x) => x.id === assetId)!;
      db.mediaAssets.push({ ...a, id: 'gen-17', origin: 'generated', generation: { generationId: 'g-17', briefId: 'brief-17', model: 'seedance_2_5', prompt: 'Wolle', higgsfieldJobId: 'h', credits: 1, mock: true, review: 'approved' } });
      db.generations.push({ id: 'g-17', projectId: project.id, scriptId: script.id, briefId: 'brief-17', sceneIndex: 1, status: 'approved', assetId: 'gen-17' } as never);
    });
    const plan = await edit.saveEditPlan(project.id, { scriptId: script.id, body: {
      clips: [
        { sceneIndex: 0, assetId, inSec: 0, outSec: 2, overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 0.5, endSec: 1.8, slot: 'center' }] },
        { sceneIndex: 1, assetId: 'gen-17', inSec: 0, outSec: 2, briefId: 'brief-17' },
      ],
      subtitles: 'off', loudness: 'streaming_-14',
    } });
    await edit.approveEditPlan(plan.id);
    const { job, render } = await edit.startRender(plan.id, {});
    expect((await until(() => getJob(job.id), (j) => j.status === 'succeeded' || j.status === 'failed')).error).toBeNull();
    expect(render!.disclosures).toEqual([core.AI_DISCLOSURE]);
    await finish(render!.id, {});
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    const clean = absolutePath(r.finish!.files.clean!.storagePath);
    const [own, gen] = await Promise.all([frame(clean, 1.0), frame(clean, 3.0)]);
    expect(near(gen(...LABEL_PX), '#000000', 30)).toBe(true); // over the generated clip
    expect(near(own(...LABEL_PX), BG, 30)).toBe(true); // not over her own clip
    const kw = core.overlayBox({ kind: 'keyword', text: 'Wolle', slot: 'center' });
    expect(share(own, kw, (p) => near(p, BG, 30))).toBeGreaterThan(0.98); // no keyword
    // the clean video has the render's audio (loudnorm with the render's measurement)
    const streams = JSON.parse((await run(fp, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', clean])).stdout).streams.map((x: { codec_type: string }) => x.codec_type);
    expect(streams).toEqual(['video', 'audio']);
  });

  it('client projects: export only for an approved render of a still-approved plan; QA needs whisper', async () => {
    const fin = await import('@/server/services/finish');
    const { write, now, newId } = await import('@/server/store');
    const { project } = await setup('Kunde', 'UGC_CLIENT');
    const ids = { plan: newId(), render: newId(), script: newId() };
    await write((db) => {
      db.scripts.push({ id: ids.script, projectId: project.id, status: 'approved' } as never);
      db.editPlans.push({ id: ids.plan, projectId: project.id, scriptId: ids.script, version: 1, parentId: null, status: 'approved', body: { clips: [{ assetId: 'x', inSec: 0, outSec: 1 }] }, durationSec: 1, disclosures: ['Anzeige'], warnings: [], clientConsentNote: null, styleBibleVersionId: null, voiceGuideVersionId: null, createdAt: now(), approvedAt: now() } as never);
      db.renders.push({ id: ids.render, projectId: project.id, editPlanId: ids.plan, jobId: 'j', status: 'pending_review', storagePath: null, size: null, sha256: null, durationSec: 1, loudness: null, disclosures: ['Anzeige'], error: null, reviewNote: '', createdAt: now(), finishedAt: now(), reviewedAt: null });
    });
    await expect(fin.startFinish(ids.render, {})).rejects.toMatchObject({ status: 409, code: 'render_not_approved' });
    await expect(fin.finishPackage(ids.render, {})).rejects.toMatchObject({ status: 409, code: 'render_not_approved' });
    expect((await fin.getFinishState(ids.render)).blocker).toMatch(/freigegeben/);
    await expect(fin.startDraftFinish(project.id, { scriptId: ids.script, revision: 1 })).rejects.toMatchObject({ status: 409 });
    await write((db) => { Object.assign(db.renders.find((r) => r.id === ids.render)!, { status: 'approved', reviewedAt: now() }); });
    expect((await fin.getFinishState(ids.render)).blocker).toBeNull();
    // the script demoted after the approval: blocked again
    await write((db) => { (db.scripts.find((s) => s.id === ids.script) as { status: string }).status = 'draft'; });
    expect((await fin.getFinishState(ids.render)).blocker).toMatch(/nicht mehr freigegeben/);
    // QA in mock mode: refused with a reason, also in the state
    const st = await fin.getFinishState(ids.render);
    expect(st.qa).toMatchObject({ available: false, reason: expect.stringContaining('whisper.cpp') });
    await expect(fin.startRenderQa(ids.render)).rejects.toMatchObject({ status: 409, code: 'qa_unavailable' });
  });
});
