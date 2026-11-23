import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { carouselFontTypes, CAROUSEL_AI_LABEL, fontFallbacks, isHex, layoutCarousel, slideAss, type SlideLayout } from '@studio/core';
import { HttpError } from '../errors';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { absolutePath, sha256File } from '../media';
import { must, now, read, write, type CarouselVersion, type Db } from '../store';
import type { ZipEntry } from '../zip';
import { reviewOf } from './carousels';
import { expectedFaces, fontsDir } from './fonts';

/**
 * Etappe 18: slides as PNG through FFmpeg + libass – the same font pipeline as the video (system fonts by name, Mac fonts
 * by their English full name through CoreText, her own/Google font files through `fontsdir`, the same fallback check
 * `fontFallbacks`). Why this and not a browser/canvas renderer: no new heavy dependency (no Chromium, no native canvas
 * build), and the slide's fonts are resolved exactly like the reel's, so a font that works in the video works here
 * (Etappe 14 specimen, Etappe 16 image overlays use the same path).
 *
 * Per slide: colour source → `under` ASS (decoration) → her image (scaled to cover, cropped) → `over` ASS (text, chips,
 * the AI label last). Files are content-addressed (`carousels/<project>/<carousel>/<sha256>.png`: hash of both ASS files,
 * background, image file hashes and boxes, font files, FFmpeg version), so an unchanged slide is never drawn twice.
 */

const folder = (projectId: string, carouselId: string) => `carousels/${projectId}/${carouselId}`;
/** Older renders beyond this many files per carousel are pruned (files of existing versions stay). */
const KEEP_FILES = 60;
const locks = new Map<string, Promise<unknown>>();
/** One render per carousel at a time (a second click waits and then finds the files). */
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const p = prev.catch(() => undefined).then(fn);
  locks.set(key, p);
  try { return await p; } finally { if (locks.get(key) === p) locks.delete(key); }
}

interface SlideJob { n: number; layout: SlideLayout; under: string; over: string; images: { abs: string; sha256: string; box: SlideLayout['elements'][number]['box'] }[]; key: string }

/** Everything one version's render needs (one consistent snapshot). */
function plan(db: Db, projectId: string, carouselId: string, versionId: string | null) {
  const c = must(db.carousels.find((x) => x.id === carouselId && x.projectId === projectId), 'Karussell');
  const v = must(db.carouselVersions.find((x) => x.id === (versionId ?? c.activeVersionId) && x.carouselId === c.id), 'Karussell-Version');
  const { look, lookWarnings, images, review } = reviewOf(db, c, v.body);
  const layouts = layoutCarousel(v.body, look, images);
  const types = carouselFontTypes(look);
  const used = new Set(types.filter((t) => t.custom).map((t) => t.assName));
  const fontsHash = db.fonts.filter((f) => used.has(f.assName)).map((f) => f.sha256).sort().join(',');
  const refs = new Map(db.references.map((r) => [r.id, r]));
  return { c, v, look, lookWarnings, review, layouts, fontsHash, customFonts: types.some((t) => t.custom), expected: expectedFaces(db, types), refs };
}

/** Draws one slide (or reuses the content-addressed file); the font check of its render log stays with the file. */
async function drawSlide(job: SlideJob, bg: string, customFonts: boolean, rel: string, expected: { name: string; postscriptName: string }[]): Promise<{ file: string; warnings: string[] }> {
  // every path through absolutePath (inside the data folder)
  const file = absolutePath(`${rel}/${job.key}.png`);
  try {
    await stat(file);
    const warnings = await readFile(`${file}.warnings.json`, 'utf8').then((t) => JSON.parse(t) as string[], () => []);
    // a cached picture with a font warning is drawn again (an installed Mac font is not part of the key)
    if (!warnings.length) return { file, warnings };
  } catch { /* not drawn yet */ }
  const work = absolutePath(`${rel}/${job.key}.${process.pid}.${Date.now()}`);
  const underFile = `${work}.under.ass`, overFile = `${work}.over.ass`, out = `${work}.png`;
  const chars = /['\\:[\],;]/;
  if (chars.test(work) || (customFonts && chars.test(fontsDir()))) throw new HttpError(409, 'Der Datenordner-Pfad enthält Zeichen, die der FFmpeg-Filter nicht verarbeitet.');
  if (!isHex(bg)) throw new HttpError(400, 'Hintergrundfarbe ungültig.');
  await Promise.all([writeFile(underFile, job.under, 'utf8'), writeFile(overFile, job.over, 'utf8')]);
  try {
    const { width: W, height: H } = job.layout;
    const args = ['-f', 'lavfi', '-i', `color=c=0x${bg.slice(1)}:s=${W}x${H}:d=1:r=1`];
    // image paths are input arguments; the filtergraph carries only our numbers and our own file names
    for (const img of job.images) args.push('-i', img.abs);
    const graph = [`[0:v]subtitles=filename='${underFile}'[u0]`];
    job.images.forEach((img, i) => {
      const w = img.box.x1 - img.box.x0, h = img.box.y1 - img.box.y0;
      graph.push(`[${i + 1}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[i${i}]`);
      graph.push(`[u${i}][i${i}]overlay=${img.box.x0}:${img.box.y0}:eof_action=repeat[u${i + 1}]`);
    });
    graph.push(`[u${job.images.length}]subtitles=filename='${overFile}'${customFonts ? `:fontsdir='${fontsDir()}'` : ''}[out]`);
    const { stderr } = await runFfmpeg([...args, '-filter_complex', graph.join(';'), '-map', '[out]', '-frames:v', '1', '-y', out], { loglevel: 'info', keepStderr: 256 * 1024 });
    await rename(out, file);
    const warnings = fontFallbacks(stderr, expected);
    await writeFile(`${file}.warnings.json`, JSON.stringify(warnings), 'utf8').catch(() => undefined);
    return { file, warnings };
  } finally {
    await Promise.all([rm(underFile, { force: true }), rm(overFile, { force: true }), rm(out, { force: true })]);
  }
}

/** The slides of a plan with their ASS files, images and content keys (no drawing, no side effects). */
function jobsOf(p: ReturnType<typeof plan>, ffVersion: string | null): SlideJob[] {
  return p.layouts.map((layout) => {
    const { under, over } = slideAss(layout, p.look);
    const images = layout.elements.flatMap((e) => {
      if (e.type !== 'image') return [];
      const r = p.refs.get(e.imageId);
      return r ? [{ abs: absolutePath(r.storagePath), sha256: r.sha256, box: e.box }] : [];
    });
    const key = createHash('sha256').update(JSON.stringify({ under, over, bg: layout.bg, images: images.map((i) => [i.sha256, i.box]), fonts: p.fontsHash, ff: ffVersion })).digest('hex');
    return { n: layout.index + 1, layout, under, over, images, key };
  });
}

/**
 * `POST …/carousels/[cid]/render`: every slide of the version (default: the active one) as PNG. Font fallbacks come back
 * as warnings (like the video render). Problems of the content (overflow, rights) do not stop the render – the picture
 * shows them; the export refuses them.
 */
export async function renderCarousel(projectId: string, carouselId: string, versionId: string | null = null) {
  const ff = await ffmpegStatus();
  if (!ff.available || !ff.subtitles) throw new HttpError(409, 'Die Slides brauchen FFmpeg mit libass (Filter „subtitles“). FFmpeg mit libass installieren (brew install ffmpeg-full).');
  return locked(carouselId, async () => {
    const p = await read((db) => plan(db, projectId, carouselId, versionId));
    await mkdir(absolutePath(folder(projectId, carouselId)), { recursive: true });
    const files: NonNullable<CarouselVersion['render']>['files'] = [];
    const warnings = new Set<string>(p.lookWarnings);
    for (const job of jobsOf(p, ff.version)) {
      const { key, layout } = job;
      const drawn = await drawSlide(job, layout.bg, p.customFonts, folder(projectId, carouselId), p.expected);
      for (const x of drawn.warnings) warnings.add(`Slide ${job.n}: ${x}`);
      files.push({ n: job.n, key, storagePath: `${folder(projectId, carouselId)}/${key}.png`, sha256: await sha256File(drawn.file) });
    }
    const render = { at: now(), files, warnings: [...warnings] };
    await write((db) => {
      const v = db.carouselVersions.find((x) => x.id === p.v.id);
      if (v) v.render = render;
    });
    await prune(projectId, carouselId);
    return { versionId: p.v.id, version: p.v.version, render, review: p.review };
  });
}

/** Keeps the files of every stored version plus the newest KEEP_FILES. */
async function prune(projectId: string, carouselId: string) {
  const dir = absolutePath(folder(projectId, carouselId));
  const keep = await read((db) => new Set(db.carouselVersions.filter((v) => v.carouselId === carouselId).flatMap((v) => v.render?.files.map((f) => `${f.key}.png`) ?? [])));
  const pngs = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^[0-9a-f]{64}\.png$/.test(f) && !keep.has(f));
  if (pngs.length <= KEEP_FILES) return;
  const aged = await Promise.all(pngs.map(async (f) => ({ f, t: (await stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })));
  await Promise.all(aged.sort((a, b) => b.t - a.t).slice(KEEP_FILES).flatMap((x) => [rm(path.join(dir, x.f), { force: true }), rm(path.join(dir, `${x.f}.warnings.json`), { force: true })]));
}

/** The current files of a version: content-addressed, so only missing or changed slides (design, fonts, images) are drawn. */
const currentFiles = (projectId: string, carouselId: string, versionId: string | null) => renderCarousel(projectId, carouselId, versionId);

/**
 * `GET …/carousels/[cid]/slides/[n]?version=`: one slide PNG. Review fix: served straight from the version's last render
 * when that file still matches the current design/fonts/images (same content key) and exists – no lock, no store write;
 * otherwise the version is rendered (content-addressed, only changed slides are drawn).
 */
export async function slideFile(projectId: string, carouselId: string, n: number, versionId: string | null) {
  const ff = await ffmpegStatus();
  const p = await read((db) => plan(db, projectId, carouselId, versionId));
  const job = jobsOf(p, ff.version).find((j) => j.n === n);
  if (!job) throw new HttpError(404, `Slide ${n} gibt es nicht.`);
  const stored = p.v.render?.files.find((f) => f.n === n && f.key === job.key);
  if (stored) {
    const abs = absolutePath(stored.storagePath);
    if (await stat(abs).then(() => true, () => false)) return abs;
  }
  const r = await currentFiles(projectId, carouselId, versionId);
  const f = r.render.files.find((x) => x.n === n);
  if (!f) throw new HttpError(404, `Slide ${n} gibt es nicht.`);
  return absolutePath(f.storagePath);
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'karussell';

/**
 * `GET …/carousels/[cid]/export`: ZIP with `01.png … NN.png`, `caption.txt`, `alt-text.txt` and – when a slide shows a
 * generated image – `KENNZEICHNUNG.txt`. Refused (409 `carousel_problems`) while the review has errors (overflow, image
 * rights, flagged claims, label denials, empty slides).
 */
export async function carouselPackage(projectId: string, carouselId: string, versionId: string | null): Promise<{ filename: string; entries: ZipEntry[] }> {
  const pre = await read((db) => plan(db, projectId, carouselId, versionId));
  const errors = pre.review.issues.filter((i) => i.level === 'error');
  if (errors.length) throw new HttpError(409, `Export nicht möglich: ${errors.map((e) => e.message).join(' · ')}`, 'carousel_problems');
  const r = await currentFiles(projectId, carouselId, versionId);
  const body = pre.v.body;
  const pad = (n: number) => String(n).padStart(2, '0');
  const entries: ZipEntry[] = r.render.files.sort((a, b) => a.n - b.n).map((f) => ({ name: `${pad(f.n)}.png`, file: absolutePath(f.storagePath) }));
  entries.push({ name: 'caption.txt', data: `${body.caption}\n` });
  if (body.altText) entries.push({ name: 'alt-text.txt', data: `${body.altText}\n` });
  if (pre.review.aiSlides.length) {
    entries.push({
      name: 'KENNZEICHNUNG.txt',
      data: [
        `Dieses Karussell enthält KI-generierte Bilder (Slide ${pre.review.aiSlides.join(', ')}).`,
        `Auf diesen Slides ist „${CAROUSEL_AI_LABEL}“ eingebrannt – bitte nicht wegschneiden oder überdecken.`,
        `Die Caption beginnt mit „${pre.review.requiredLabels.join(' · ')}“. Beim Posten zusätzlich das KI-Label von Instagram setzen („Mit KI erstellt“, je nach App-Version).`,
        '',
      ].join('\n'),
    });
  }
  return { filename: `karussell-${slug(pre.c.title)}-v${pre.v.version}.zip`, entries };
}

/** Removes the PNG folder of a carousel (after its records are gone). */
export const deleteCarouselFiles = (projectId: string, carouselId: string) => rm(absolutePath(folder(projectId, carouselId)), { recursive: true, force: true }).catch(() => undefined);
