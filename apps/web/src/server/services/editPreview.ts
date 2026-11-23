import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildFrame, buildPreview, checkEditPlan, EditPlanBody, frameInput, OUTPUT, PREVIEW, type EditDraftBody, type ImageLayer, type RenderClip } from '@studio/core';
import { z } from 'zod';
import { HttpError } from '../errors';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { absolutePath } from '../media';
import { must, read, type Db } from '../store';
import { enqueueJob, isFinished, registerJobHandler } from '../worker';
import { checkBase, findDraft, ScriptKey } from './editDraft';
import { pinnedStyleFor, planContext, planLook, renderAssText, renderInputs } from './edit';
import { fontFallbacks, lookFontTypes } from '@studio/core';
import { fontsDir } from './fonts';
import { storyVariant } from './editDirection';

/**
 * Etappe 13 (E6): the exact preview of the working draft. Both run through the render's own FFmpeg+ASS path (same
 * segments, zoom, ASS file with hook, overlays, subtitles and the AI label), so what she checks here is what the render
 * draws; only the browser stage is an approximation.
 * - `preview`: a job (202 + polling) rendering the whole cut at 540×960 from the editing proxies with a fast preset.
 * - frame: one PNG at output time t, synchronously, from the original footage.
 * Both are cached under `derived/<projectId>/{previews,frames}/<sha256>` (hash of exactly what FFmpeg gets: ASS text,
 * inputs, loudness, font files, FFmpeg version), the oldest beyond a small limit are deleted, and the folder goes with
 * the project. Nothing here is a version or a render record: approval and publishing are unchanged.
 */
const PREVIEW_VERSION = 1;
export const PREVIEW_CACHE_MAX = 8;
export const FRAME_CACHE_MAX = 40;
const KEY = /^[0-9a-f]{64}$/;
const previewDir = (projectId: string) => `derived/${projectId}/previews`;
const frameDir = (projectId: string) => `derived/${projectId}/frames`;

/** Removes the oldest files of a cache folder beyond `max`. */
async function prune(dirAbs: string, ext: string, max: number) {
  const files = (await readdir(dirAbs).catch(() => [] as string[])).filter((f) => f.endsWith(ext) && KEY.test(f.slice(0, -ext.length)));
  if (files.length <= max) return;
  const aged = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(dirAbs, f)).catch(() => null))?.mtimeMs ?? 0 })));
  // a still frame's font check (`<key>.fonts.json`, Etappe 16b) goes with it
  await Promise.all(aged.sort((a, b) => b.t - a.t).slice(max).flatMap((x) => [rm(path.join(dirAbs, x.f), { force: true }), rm(path.join(dirAbs, `${x.f.slice(0, -ext.length)}.fonts.json`), { force: true })]));
}

/** Hash of the custom font files a look uses (a replaced file gives a new key). */
const fontsHash = (db: Db, assNames: Set<string>) => db.fonts.filter((f) => assNames.has(f.assName)).map((f) => f.sha256).sort().join(',');

/**
 * The draft as the render would see it. Problems that only the render refuses (a layout conflict, a label-zone overlap)
 * do not stop a preview – she sees exactly what is wrong; a draft that cannot be drawn at all (no clip, missing
 * footage, unknown duration) is a 409 with the problems.
 */
async function draftForPreview(projectId: string, scriptId: string | null, opts: { proxy: boolean; variant?: (db: Db, body: EditDraftBody) => EditDraftBody }) {
  const snap = await read((db) => {
    checkBase(db, projectId, scriptId);
    const draft = findDraft(db, projectId, scriptId);
    if (!draft || !draft.body.clips.length) throw new HttpError(409, 'Noch kein Clip im Schnitt – nichts zu zeigen.');
    // Etappe 16: a variant of the draft (a dramaturgy proposal with one hook option) – never stored
    const source = opts.variant ? opts.variant(db, draft.body) : draft.body;
    const pinned = pinnedStyleFor(db, projectId, scriptId);
    const { ctx } = planContext(db, { projectId, scriptId, styleBibleVersionId: pinned }, source, draft.clientConsentNote || null);
    const { result, errors } = checkEditPlan(source, ctx);
    const blocking = errors.filter((e) => !CONTENT_ISSUE.test(e));
    if (blocking.length) throw new HttpError(409, `Vorschau nicht möglich: ${blocking.slice(0, 3).join(' ')}`);
    const body: EditPlanBody = EditPlanBody.parse(result.body);
    const look = planLook(db, { styleBibleVersionId: pinned }, body.look, body);
    let inputs;
    try {
      inputs = renderInputs(db, projectId, body, look, { proxy: opts.proxy });
    } catch (e) {
      throw new HttpError(409, `Vorschau nicht möglich: ${(e as Error).message}`);
    }
    // fonts of the plan's style and of every element style (`presetLooks`): a replaced font file gives a new key
    // Etappe 16b: and every element font (`lookFontTypes`)
    const custom = new Set(lookFontTypes(look).filter((x) => x.custom).map((x) => x.assName));
    return { body, inputs, revision: draft.revision, fonts: fontsHash(db, custom), issues: errors.length };
  });
  const ff = await ffmpegStatus();
  if (!ff.available) throw new HttpError(409, 'Die Vorschau braucht FFmpeg (nicht gefunden).');
  let ass: string | null;
  try {
    ass = await renderAssText(snap.body, snap.inputs);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  return { ...snap, ass, ffVersion: ff.version };
}

/** Problems of what is burned in (text, place, claims): shown in the preview instead of stopping it. Everything else (footage, ranges, length) stops it. */
const CONTENT_ISSUE = /Overlay|Hook|KI-Label|gleichzeitig an derselben Stelle|Claim|Zahlen|Kennzeichnung|Link/;

const clipKey = (c: RenderClip) => ({ ...c, path: path.basename(c.path) });
const imageKey = (im: ImageLayer) => ({ ...im, path: path.basename(im.path) });

export const PreviewRequest = z.object({ scriptId: ScriptKey });

const PreviewJobInput = z.object({
  projectId: z.string(), key: z.string().regex(KEY), ass: z.string().nullable(), customFonts: z.boolean(), total: z.number(),
  loudness: z.enum(['streaming_-14', 'quiet_-16', 'off']),
  clips: z.array(z.object({ path: z.string(), hasAudio: z.boolean(), inSec: z.number(), outSec: z.number(), fadeIn: z.boolean().optional(), fadeOut: z.boolean().optional(), zoom: z.any().optional() })),
  images: z.array(z.object({ path: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), startSec: z.number(), endSec: z.number(), fade: z.boolean() })).default([]),
});

/**
 * Starts (or reuses) the exact low-res preview of the current draft. `ready` with the file key when it is cached, else a
 * queued job (one per key at a time).
 */
export async function startEditPreview(projectId: string, raw: unknown) {
  const req = PreviewRequest.parse(raw ?? {});
  const d = await draftForPreview(projectId, req.scriptId, { proxy: true });
  const key = createHash('sha256').update(JSON.stringify({
    v: PREVIEW_VERSION, projectId, ass: d.ass, clips: d.inputs.clips.map(clipKey), sources: d.inputs.assets.map((a) => [a.id, a.sha256, a.derived?.preparedAt ?? null]),
    loudness: d.body.loudness, fonts: d.fonts, ff: d.ffVersion, size: PREVIEW,
    ...(d.inputs.images.length ? { images: d.inputs.images.map(imageKey), imageFiles: d.inputs.imageRefs } : {}),
  })).digest('hex');
  const file = absolutePath(`${previewDir(projectId)}/${key}.mp4`);
  if (await stat(file).then(() => true, () => false)) return { status: 'ready' as const, key, job: null, revision: d.revision, issues: d.issues };
  const active = await read((db) => db.mediaJobs.find((j) => j.kind === 'preview' && !isFinished(j) && (j.input as { key?: string } | null)?.key === key) ?? null);
  if (active) return { status: 'queued' as const, key, job: active, revision: d.revision, issues: d.issues };
  const input = { projectId, key, ass: d.ass, customFonts: d.inputs.customFonts, total: d.inputs.total, loudness: d.body.loudness, clips: d.inputs.clips, images: d.inputs.images };
  const { job } = await enqueueJob('preview', input, { projectId });
  return { status: 'queued' as const, key, job, revision: d.revision, issues: d.issues };
}

registerJobHandler('preview', async ({ job, signal, workDir, progress }) => {
  const input = PreviewJobInput.parse(job.input);
  const assFile = input.ass != null ? path.join(workDir, 'preview.ass') : null;
  if (assFile) await writeFile(assFile, input.ass!, 'utf8');
  const out = path.join(workDir, 'preview.mp4');
  progress(0, 'Exakte Vorschau');
  await runFfmpeg(buildPreview(input.clips as RenderClip[], out, { preset: input.loudness }, assFile, assFile && input.customFonts ? fontsDir() : null, input.images), {
    signal, durationSec: input.total, onProgress: (f, sec) => progress(f, `${sec.toFixed(1)} von ${input.total} s`),
  });
  signal.throwIfAborted();
  const dir = absolutePath(previewDir(input.projectId));
  await mkdir(dir, { recursive: true });
  await rename(out, path.join(dir, `${input.key}.mp4`));
  await prune(dir, '.mp4', PREVIEW_CACHE_MAX);
  return { key: input.key };
});

/** The finished preview file of a key (404 when it is not there, e.g. pruned: start the preview again). */
export async function previewFile(projectId: string, key: string): Promise<string> {
  if (!KEY.test(key)) throw new HttpError(400, 'Ungültiger Vorschau-Schlüssel.');
  await read((db) => must(db.projects.find((p) => p.id === projectId), 'Projekt'));
  const file = absolutePath(`${previewDir(projectId)}/${key}.mp4`);
  if (!(await stat(file).then(() => true, () => false))) throw new HttpError(404, 'Vorschau nicht (mehr) vorhanden – bitte neu erzeugen.');
  return file;
}

export const FrameQuery = z.object({
  scriptId: z.string().max(100).optional().transform((s) => s || null),
  t: z.coerce.number().finite().min(0).max(600),
  size: z.enum(['half', 'full']).default('half'),
  /** Etappe 16: the still of a hook option – the draft with the story's beats applied and this hook (nothing is stored). */
  storyId: z.string().max(100).optional(),
  hook: z.string().regex(/^h\d$/).optional(),
}).refine((q) => !q.hook || q.storyId, { message: 'Hook-Standbild braucht storyId.' });

/**
 * One frame of the draft at output time t as PNG („Standbild prüfen“): the original footage through the render's picture
 * chain and the same ASS file (hook, overlays, subtitles, AI label at that moment). Cached by content hash.
 */
export async function renderDraftFrame(projectId: string, raw: unknown): Promise<{ png: Buffer; cached: boolean; t: number; fontWarnings: string[] }> {
  const q = FrameQuery.parse(raw);
  const variant = q.storyId ? (db: Db, body: EditDraftBody) => storyVariant(db, projectId, q.storyId!, q.hook ?? null, body) : undefined;
  const d = await draftForPreview(projectId, q.scriptId, { proxy: false, variant });
  const f = frameInput(d.inputs.tl, d.body.clips, d.inputs.sources, q.t);
  if (!f) throw new HttpError(409, 'Noch kein Clip im Schnitt.');
  const size = q.size === 'full' ? OUTPUT : PREVIEW;
  const key = createHash('sha256').update(JSON.stringify({
    v: PREVIEW_VERSION, projectId, ass: d.ass, clip: clipKey(f.clip), source: d.inputs.assets.map((a) => [a.id, a.sha256]), outT: f.outT, size: [size.width, size.height], fonts: d.fonts, ff: d.ffVersion,
    ...(d.inputs.images.length ? { images: d.inputs.images.map(imageKey), imageFiles: d.inputs.imageRefs } : {}),
  })).digest('hex');
  const dir = absolutePath(frameDir(projectId));
  const file = path.join(dir, `${key}.png`);
  // Etappe 16b: the font check of the frame (libass log) is kept next to the cached PNG
  const warnFile = file.replace(/\.png$/, '.fonts.json');
  try {
    const png = await readFile(file);
    const fontWarnings = await readFile(warnFile, 'utf8').then((t) => JSON.parse(t) as string[], () => []);
    // a frame with a font warning is drawn again: she may have installed the font since (Mac fonts are not in the key)
    if (!fontWarnings.length) return { png, cached: true, t: f.outT, fontWarnings };
  } catch { /* not cached yet */ }
  await mkdir(dir, { recursive: true });
  const work = path.join(/*turbopackIgnore: true*/ dir, `${key}.${process.pid}.${Date.now()}`);
  const assFile = d.ass != null ? `${work}.ass` : null, out = `${work}.png`;
  try {
    if (assFile) await writeFile(assFile, d.ass!, 'utf8');
    const { stderr } = await runFfmpeg(buildFrame(f.clip, f.outT, out, assFile, assFile && d.inputs.customFonts ? fontsDir() : null, size, d.inputs.images), { signal: AbortSignal.timeout(60_000), ...(assFile ? { loglevel: 'info' as const, keepStderr: 256 * 1024 } : {}) });
    if (!(await stat(out).then((x) => x.size > 0, () => false))) throw new HttpError(500, `FFmpeg hat bei ${f.outT.toFixed(2)} s kein Bild geliefert.`);
    const fontWarnings = assFile ? fontFallbacks(stderr, d.inputs.expectedFonts) : [];
    if (fontWarnings.length) await writeFile(warnFile, JSON.stringify(fontWarnings), 'utf8');
    else await rm(warnFile, { force: true });
    await rename(out, file);
    await prune(dir, '.png', FRAME_CACHE_MAX);
    return { png: await readFile(file), cached: false, t: f.outT, fontWarnings };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `Standbild fehlgeschlagen: ${(e as Error).message.slice(0, 300)}`);
  } finally {
    await Promise.all([assFile ? rm(assFile, { force: true }) : null, rm(out, { force: true })]);
  }
}
