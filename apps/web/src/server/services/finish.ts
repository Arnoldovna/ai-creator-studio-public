import 'server-only';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildAlphaLayer, buildAss, buildFcpxml, buildFrame, buildLoudnessMeasure, buildRender, cutPoints, finishGuide, finishTexts, frameInput, hasGraphics, missingWords,
  OUTPUT, parseLoudness, parseWhisperJson, textsToTxt, toSrt, transcriptWords, type EditPlanBody, type InstagramCopy,
} from '@studio/core';
import { z } from 'zod';
import { HttpError } from '../errors';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { absolutePath, deleteMediaFiles, sha256File } from '../media';
import { must, now, read, type Db, type FinishFile, type FinishFileKind, type Render, type RenderQa } from '../store';
import { runWhisper, whisperStatus } from '../whisper';
import { enqueueJob, isFinished, registerJobHandler } from '../worker';
import { googleSpecimenUrl } from '@studio/core';
import { LABEL_UNAVAILABLE, pathFree, planBody, planLook, renderInputs, subtitleCues, validateFor } from './edit';
import { renderEditDraft } from './editDraft';
import { fontsDir } from './fonts';

/**
 * Etappe 17: the CapCut/finish package of a render, and the QA „fehlende Wörter“.
 * Carola sets text (fonts, animations) in CapCut for now; the studio delivers the cut, the dramaturgy, the hook choice and
 * the subtitles. One click gives everything she needs there:
 * - `finish` job (per render): `video-clean.mp4` = the render's graph WITHOUT hook, overlays and subtitles, but WITH the AI
 *   label whenever the cut shows a generated clip or image (the label is derived from the stored origins, as in the render),
 *   optionally without the image overlays; `overlays-alpha.mov` = only the text/graphics layer with alpha (ProRes 4444);
 *   `cover.png` = the first moment with the hook. Files under renders/<projectId>/finish/<renderId>/, recorded on the render.
 * - `GET /api/renders/[id]/package`: a ZIP built on the fly from those files, the SRTs (`cuesForTimeline`), the text sheet,
 *   the guide (disclosure notes), the caption and an FCPXML.
 * - `render_qa` job: the render transcribed again (whisper.cpp only, never the mock) and compared with the words kept in the
 *   cut; findings with output times, nothing is changed.
 * Gates: client projects export only approved renders of a still-approved plan/script (the existing review gate); personal
 * renders export when finished. The disclosures must still match the render (else: render again).
 */

const finishDir = (projectId: string, renderId: string) => `renders/${projectId}/finish/${renderId}`;
const FILE_NAME: Record<FinishFileKind, string> = { clean: 'video-clean.mp4', clean_noimg: 'video-clean-ohne-bilder.mp4', alpha: 'overlays-alpha.mov', cover: 'cover.png' };

export const FinishOptions = z.object({
  /** Show her image overlays in the clean video (default) or leave them out (they come as files in `bilder/`). */
  images: z.boolean().default(true),
  /** Also make the text/graphics layer with alpha (larger file, slower). */
  alpha: z.boolean().default(false),
});
export type FinishOptions = z.infer<typeof FinishOptions>;
const flag = (def: '0' | '1') => z.enum(['0', '1']).default(def).transform((x) => x === '1');
export const PackageQuery = z.object({ images: flag('1'), alpha: flag('0'), words: flag('1') });

interface Gate { project: Db['projects'][number]; plan: Db['editPlans'][number]; client: boolean }

/**
 * May this render be exported? Client projects: only an approved render of a plan (and script) that is still approved.
 * Personal: a finished render (`allowRendering`: also one that is still rendering – the editor's one click queues the
 * clean render right behind it); a rejected script stops it as everywhere else.
 */
export function exportGate(db: Db, render: Render, opts: { allowRendering?: boolean } = {}): Gate {
  const project = must(db.projects.find((p) => p.id === render.projectId), 'Projekt');
  const plan = must(db.editPlans.find((p) => p.id === render.editPlanId), 'Schnittplan');
  const script = plan.scriptId ? db.scripts.find((s) => s.id === plan.scriptId) ?? null : null;
  const client = project.kind === 'UGC_CLIENT';
  if (client) {
    if (render.status !== 'approved') throw new HttpError(409, 'Kundenprojekt: Export erst, wenn der Render freigegeben ist (Klassische Ansicht).', 'render_not_approved');
    if (plan.status !== 'approved' || (plan.scriptId && script?.status !== 'approved')) throw new HttpError(409, 'Kundenprojekt: Schnittplan oder Skript sind nicht mehr freigegeben.', 'render_not_approved');
  } else {
    const ok = render.status === 'pending_review' || render.status === 'approved' || (opts.allowRendering && render.status === 'rendering');
    if (!ok) throw new HttpError(409, render.status === 'rendering' ? 'Der Render läuft noch.' : 'Nur fertige Renders lassen sich exportieren – bitte neu rendern.', 'render_not_ready');
    if (script?.status === 'rejected') throw new HttpError(409, 'Das Skript wurde verworfen.');
  }
  return { project, plan, client };
}

const hasImagesIn = (body: EditPlanBody) => body.clips.some((c) => (c.images?.length ?? 0) > 0);

/** The files a package with these options needs. */
export function neededFiles(body: EditPlanBody, o: FinishOptions): FinishFileKind[] {
  return [hasImagesIn(body) && !o.images ? 'clean_noimg' : 'clean', 'cover', ...(o.alpha && hasGraphics(body) ? ['alpha' as const] : [])];
}

const activeJob = (db: Db, kind: 'finish' | 'render_qa', renderId: string) =>
  db.mediaJobs.find((j) => j.kind === kind && !isFinished(j) && (j.input as { renderId?: string } | null)?.renderId === renderId) ?? null;
const lastJob = (db: Db, kind: 'finish' | 'render_qa', renderId: string) =>
  db.mediaJobs.filter((j) => j.kind === kind && (j.input as { renderId?: string } | null)?.renderId === renderId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
const jobView = (j: Db['mediaJobs'][number] | null) => (j ? { id: j.id, status: j.status, progress: j.progress, progressNote: j.progressNote, error: pathFree(j.error), done: isFinished(j) } : null);

/** The AI-label spans each file must carry for the cut as it is NOW (origins can change after a render). */
type LabelKeys = Record<FinishFileKind, string>;
const labelKeysOf = (inputs: { labels: unknown[]; clipLabels: unknown[] }): LabelKeys => ({
  clean: JSON.stringify(inputs.labels), clean_noimg: JSON.stringify(inputs.clipLabels), cover: JSON.stringify(inputs.labels), alpha: '[]',
});
/** Current label keys of a render's plan (null when the plan cannot be read: then nothing counts as present). */
function currentLabelKeys(db: Db, render: Render): LabelKeys | null {
  try {
    const plan = must(db.editPlans.find((p) => p.id === render.editPlanId), 'Schnittplan');
    const body = planBody(plan);
    return labelKeysOf(renderInputs(db, plan.projectId, body, render.look ?? planLook(db, plan, body.look, body)));
  } catch {
    return null;
  }
}

/**
 * Files on record that are still on disk AND carry the AI-label spans the cut needs now; anything else is made again
 * (e.g. an image marked as generated after the export: the clean video then needs the label).
 */
async function presentFiles(render: Render, keys: LabelKeys | null): Promise<Set<FinishFileKind>> {
  const out = new Set<FinishFileKind>();
  if (!keys) return out;
  await Promise.all(Object.entries(render.finish?.files ?? {}).map(async ([k, f]) => {
    const kind = k as FinishFileKind;
    if (!f || f.labels !== keys[kind]) return;
    if (await stat(absolutePath(f.storagePath)).then((s) => s.size === f.size, () => false)) out.add(kind);
  }));
  return out;
}

/**
 * Starts (or reuses) the finish job of a render for these options: `ready` when every needed file exists, else the queued
 * job (one per render at a time; a second click while it runs returns the running job).
 */
export async function startFinish(renderId: string, raw: unknown, opts: { allowRendering?: boolean } = {}) {
  const o = FinishOptions.parse(raw ?? {});
  const snap = await read((db) => {
    const render = must(db.renders.find((r) => r.id === renderId), 'Render');
    const { plan } = exportGate(db, render, opts);
    return { render, need: neededFiles(planBody(plan), o), active: activeJob(db, 'finish', renderId), keys: currentLabelKeys(db, render) };
  });
  const have = await presentFiles(snap.render, snap.keys);
  const missing = snap.need.filter((k) => !have.has(k));
  if (!missing.length) return { status: 'ready' as const, job: null, need: snap.need };
  if (snap.active) return { status: 'queued' as const, job: jobView(snap.active), need: snap.need };
  const ff = await ffmpegStatus();
  if (!ff.available) throw new HttpError(409, 'Das Paket braucht FFmpeg (nicht gefunden).');
  const { job } = await enqueueJob('finish', { renderId, need: missing }, {
    projectId: snap.render.projectId,
    onQueued: (db, job) => {
      const render = must(db.renders.find((r) => r.id === renderId), 'Render');
      exportGate(db, render, opts);
      const other = activeJob(db, 'finish', renderId);
      if (other && other.id !== job.id) throw new HttpError(409, 'Für diesen Render läuft das Paket schon.');
    },
  });
  return { status: 'queued' as const, job: jobView(job), need: snap.need };
}

/**
 * Editor („Für CapCut exportieren“, personal projects): renders the draft revision she sees if that has not happened yet
 * (same snapshot + idempotent render as „Rendern“) and queues the finish job right behind it.
 */
export async function startDraftFinish(projectId: string, raw: unknown) {
  const req = z.object({ scriptId: z.string().trim().min(1).max(100).nullable(), revision: z.number().int().min(1), images: z.boolean().default(true), alpha: z.boolean().default(false) }).parse(raw);
  const kind = await read((db) => must(db.projects.find((p) => p.id === projectId), 'Projekt').kind);
  if (kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Kundenprojekte: Export nur für freigegebene Renders (Render-Liste).', 'render_not_approved');
  const out = await renderEditDraft(projectId, { scriptId: req.scriptId, revision: req.revision, mode: 'render' });
  if (!out.render) throw new HttpError(500, 'Render wurde nicht angelegt.');
  const finish = await startFinish(out.render.id, { images: req.images, alpha: req.alpha }, { allowRendering: true });
  return { render: out.render, renderJob: out.job, finish };
}

const FinishJobInput = z.object({ renderId: z.string(), need: z.array(z.enum(['clean', 'clean_noimg', 'alpha', 'cover'])).min(1) });

/** What the finish job reads from the store (one snapshot; the render's look snapshot keeps hook/overlays as rendered). */
function finishSnapshot(db: Db, renderId: string) {
  const render = must(db.renders.find((r) => r.id === renderId), 'Render');
  const { plan } = exportGate(db, render, { allowRendering: true });
  const body = planBody(plan);
  const { v } = validateFor(db, plan, body, plan.clientConsentNote);
  // the disclosures may not change between the render and its package (e.g. footage origin corrected)
  if (v.disclosures.join('|') !== render.disclosures.join('|')) throw new Error('Die Kennzeichnungspflicht hat sich seit dem Render geändert – bitte neu rendern.');
  const look = render.look ?? planLook(db, plan, body.look, body);
  return { render, plan, body, inputs: renderInputs(db, plan.projectId, body, look) };
}

registerJobHandler('finish', async ({ job, signal, workDir, progress }) => {
  const { renderId, need } = FinishJobInput.parse(job.input);
  const { render, plan, body, inputs } = await read((db) => finishSnapshot(db, renderId));
  const ff = await ffmpegStatus();
  const fonts = inputs.customFonts ? fontsDir() : null;
  const total = inputs.total;
  const steps = need.length;
  const done: Partial<Record<FinishFileKind, FinishFile>> = {};
  const dir = finishDir(plan.projectId, renderId);
  await mkdir(absolutePath(dir), { recursive: true });
  const keys = labelKeysOf(inputs);
  // new files are written next to the recorded ones and only swapped in by the finalizer's record: a failed or cancelled
  // job removes what it made (a recorded older file of the same kind is replaced only on success)
  const stamp = job.id.slice(0, 8);
  const keep = async (kind: FinishFileKind, file: string) => {
    signal.throwIfAborted();
    const storagePath = `${dir}/${stamp}-${FILE_NAME[kind]}`;
    const [{ size }, sha256] = await Promise.all([stat(file), sha256File(file)]);
    await rename(file, absolutePath(storagePath));
    done[kind] = { storagePath, size, sha256, createdAt: now(), labels: keys[kind] };
  };
  try {
  // loudness: the render's measurement (same audio graph), else measured here (the render may still run)
  let measured = render.loudness?.measured ?? null;
  const loud = body.loudness;
  for (const [i, kind] of need.entries()) {
    const share = (f: number | null) => (f == null ? null : (i + f) / steps);
    if (kind === 'clean' || kind === 'clean_noimg') {
      const withImages = kind === 'clean';
      // the AI label from the stored origins: clips always, generated images only when they are shown
      const labels = withImages ? inputs.labels : inputs.clipLabels;
      let assFile: string | null = null;
      if (labels.length) {
        if (!ff.subtitles) throw new Error(LABEL_UNAVAILABLE);
        assFile = path.join(workDir, `${kind}.ass`);
        await writeFile(assFile, buildAss([], { labels }), 'utf8');
      }
      if (loud !== 'off' && !measured) {
        progress(share(0), 'Lautheit messen');
        measured = parseLoudness((await runFfmpeg(buildLoudnessMeasure(inputs.clips, loud), { signal, durationSec: total, loglevel: 'info' })).stderr);
      }
      const out = path.join(workDir, `${kind}.mp4`);
      await runFfmpeg(buildRender(inputs.clips, out, { preset: loud, measured }, assFile, null, withImages ? inputs.images : []), {
        signal, durationSec: total, onProgress: (f, sec) => progress(share(f), `Video ohne Text: ${sec.toFixed(1)} von ${total} s`),
      });
      await keep(kind, out);
    } else if (kind === 'alpha') {
      if (!inputs.graphics) throw new Error('Im Schnitt gibt es weder Hook noch Overlay – keine Text-Ebene zu erzeugen.');
      if (!ff.subtitles) throw new Error('Die Text-Ebene braucht FFmpeg mit libass (brew install ffmpeg-full).');
      const assFile = path.join(workDir, 'overlays.ass');
      // only hook, overlays and shapes: no subtitles (they come as SRT) and no label (it is in the clean video)
      await writeFile(assFile, buildAss([], { overlays: inputs.graphics }), 'utf8');
      const out = path.join(workDir, 'overlays-alpha.mov');
      await runFfmpeg(buildAlphaLayer(assFile, total, out, fonts), { signal, durationSec: total, onProgress: (f, sec) => progress(share(f), `Text-Ebene: ${sec.toFixed(1)} von ${total} s`) });
      await keep(kind, out);
    } else {
      progress(share(0), 'Cover');
      const hook = body.hook;
      const t = hook ? Math.min(0.6, hook.endSec / 2) : 0;
      const f = frameInput(inputs.tl, body.clips, inputs.sources, t);
      if (!f) throw new Error('Kein Clip im Schnitt.');
      let assFile: string | null = null;
      if (inputs.graphics || inputs.labels.length) {
        if (!ff.subtitles) throw new Error(LABEL_UNAVAILABLE);
        assFile = path.join(workDir, 'cover.ass');
        await writeFile(assFile, buildAss([], { labels: inputs.labels, overlays: inputs.graphics ?? undefined }), 'utf8');
      }
      const out = path.join(workDir, 'cover.png');
      await runFfmpeg(buildFrame(f.clip, f.outT, out, assFile, assFile && fonts ? fonts : null, OUTPUT, inputs.images), { signal });
      await keep(kind, out);
    }
  }
  } catch (e) {
    await deleteMediaFiles(Object.values(done).map((f) => f!.storagePath));
    throw e;
  }
  return { renderId, files: done };
}, (db, job) => {
  const res = job.result as { renderId: string; files: Partial<Record<FinishFileKind, FinishFile>> } | null;
  if (job.status !== 'succeeded' || !res) return;
  const r = db.renders.find((x) => x.id === res.renderId);
  if (!r) {
    // render deleted while the package was made: never leave unreferenced files behind
    void deleteMediaFiles(Object.values(res.files).map((f) => f!.storagePath));
    return;
  }
  // replaced files of the same kind go
  const old = Object.entries(res.files).flatMap(([k, f]) => { const prev = r.finish?.files[k as FinishFileKind]; return prev && prev.storagePath !== f!.storagePath ? [prev.storagePath] : []; });
  r.finish = { ...(r.finish ?? {}), files: { ...(r.finish?.files ?? {}), ...res.files } };
  if (old.length) void deleteMediaFiles(old);
});

/** State of the export for the UI: options, which files exist, the running job, the QA. */
export async function getFinishState(renderId: string) {
  const [ff, wh] = await Promise.all([ffmpegStatus(), whisperStatus()]);
  const snap = await read((db) => {
    const render = must(db.renders.find((r) => r.id === renderId), 'Render');
    let blocker: string | null = null;
    try { exportGate(db, render, { allowRendering: true }); } catch (e) { blocker = (e as Error).message; }
    const plan = db.editPlans.find((p) => p.id === render.editPlanId);
    const parsed = plan ? planBody(plan) : null;
    const project = db.projects.find((p) => p.id === render.projectId);
    return {
      render, blocker, projectKind: project?.kind ?? null,
      hasImages: parsed ? hasImagesIn(parsed) : false, hasGraphics: parsed ? hasGraphics(parsed) : false,
      job: jobView(activeJob(db, 'finish', renderId) ?? lastJob(db, 'finish', renderId)),
      keys: currentLabelKeys(db, render),
      qaJob: jobView(activeJob(db, 'render_qa', renderId) ?? lastJob(db, 'render_qa', renderId)),
    };
  });
  const have = await presentFiles(snap.render, snap.keys);
  const qaReason = wh.mode !== 'whisper' ? 'Fehlende Wörter prüfen braucht whisper.cpp – im Mock-Modus (TRANSCRIPTION=mock) wäre der Vergleich bedeutungslos.'
    : !wh.available ? wh.reason : !snap.render.storagePath ? 'Erst wenn der Render fertig ist.' : null;
  return {
    renderId, status: snap.render.status, projectKind: snap.projectKind, blocker: snap.blocker,
    options: { images: snap.hasImages, alpha: snap.hasGraphics && ff.subtitles },
    files: { clean: have.has('clean'), clean_noimg: have.has('clean_noimg'), alpha: have.has('alpha'), cover: have.has('cover') },
    job: snap.job,
    qa: { available: qaReason == null, reason: qaReason, job: snap.qaJob, result: snap.render.finish?.qa ?? null },
  };
}
export type FinishState = Awaited<ReturnType<typeof getFinishState>>;

const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'schnitt';
const ext = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');

/** The caption of the plan's script: the approved copy, else (personal only) the newest one. Free cuts have none. */
function captionOf(db: Db, scriptId: string | null, client: boolean): string | null {
  if (!scriptId) return null;
  const copies = db.scriptOutputs.filter((o) => o.scriptId === scriptId && o.kind === 'copy').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pick = copies.find((o) => o.status === 'approved') ?? (client ? null : copies[0] ?? null);
  return pick ? (pick.output as InstagramCopy).caption : null;
}

/**
 * The package as ZIP entries (built per request, nothing extra is stored): needs the finish files for these options (409
 * `finish_missing` otherwise). Subtitles from the render's own cue builder on the output timeline.
 */
export async function finishPackage(renderId: string, raw: unknown) {
  const q = PackageQuery.parse(raw ?? {});
  const snap = await read((db) => {
    const render = must(db.renders.find((r) => r.id === renderId), 'Render');
    const { project, plan, client } = exportGate(db, render);
    const body = planBody(plan);
    // the labels must still be the ones the render burned in (origins can change after it): else render again
    const { v } = validateFor(db, plan, body, plan.clientConsentNote);
    const stale = new HttpError(409, 'Die Kennzeichnung (KI-Label/Anzeige) hat sich seit dem Render geändert – bitte neu rendern, dann exportieren.', 'render_stale');
    if (v.disclosures.join('|') !== render.disclosures.join('|')) throw stale;
    const look = render.look ?? planLook(db, plan, body.look, body);
    const inputs = renderInputs(db, plan.projectId, body, look);
    if (render.labelKey != null && render.labelKey !== JSON.stringify(inputs.labels)) throw stale;
    const refs = new Map(db.references.map((r) => [r.id, r]));
    const images = [...new Set(body.clips.flatMap((c) => (c.images ?? []).map((im) => im.referenceId)))].flatMap((id) => {
      const r = refs.get(id);
      return r ? [{ id, name: r.name, file: `bilder/${slug(r.name.replace(/\.[a-z0-9]+$/i, ''))}-${id.slice(0, 6)}.${ext(r.mime)}`, storagePath: r.storagePath, generated: r.usage?.origin === 'generated' }] : [];
    });
    // Etappe 16b: where each font comes from (Google Fonts with licence link, her own file), for rebuilding it in CapCut
    const fontRecords = (db.fonts ?? []).map((f) => ({ assName: f.assName, postscriptName: f.postscriptName, license: f.license, origin: f.origin ?? null }));
    return { render, project, plan, client, body, look, inputs, images, caption: captionOf(db, plan.scriptId, client), keys: labelKeysOf(inputs), fontRecords };
  });
  const { render, project, plan, body, inputs, client } = snap;
  const hasImages = hasImagesIn(body);
  const imagesInVideo = hasImages ? q.images : true;
  const need = neededFiles(body, { images: q.images, alpha: q.alpha });
  const have = await presentFiles(render, snap.keys);
  const missing = need.filter((k) => !have.has(k));
  if (missing.length) throw new HttpError(409, 'Das Paket ist noch nicht (oder nicht mehr passend) vorbereitet – erst „Für CapCut exportieren“ starten.', 'finish_missing');
  const file = (k: FinishFileKind) => absolutePath(render.finish!.files[k]!.storagePath);
  const title = `${project.title} · Schnitt v${plan.version}`;
  const cues = await subtitleCues(inputs.subtitleItems);
  const words = q.words ? await subtitleCues(inputs.subtitleItems, { maxWords: 1 }) : [];
  const imageById = new Map(snap.images.map((i) => [i.id, i]));
  const sheet = finishTexts(body, inputs.tl, snap.look, {
    disclosures: render.disclosures, imagesInVideo,
    image: (id) => ({ name: imageById.get(id)?.name ?? 'Bild', generated: imageById.get(id)?.generated ?? false, file: imageById.get(id)?.file ?? null }),
    fontOrigin: (t) => {
      if (!t.custom) return null;
      const f = snap.fontRecords.find((x) => x.assName === t.assName);
      if (!f) return null;
      return f.origin?.kind === 'google'
        ? { source: 'google', postscriptName: f.postscriptName, license: f.license, licenseUrl: f.origin.licenseUrl, sourceUrl: googleSpecimenUrl(f.origin.family) }
        : { source: 'eigene', postscriptName: f.postscriptName, license: f.license, licenseUrl: null, sourceUrl: null };
    },
    subtitles: inputs.subtitleAnimation ? { mode: inputs.subtitleAnimation.mode, wordsPerLine: inputs.subtitleAnimation.wordsPerLine, highlight: inputs.subtitleAnimation.highlight } : null,
  });
  const withText = render.storagePath && (await stat(absolutePath(render.storagePath)).then(() => true, () => false));
  const imageFiles = !imagesInVideo ? snap.images : [];
  // what the clean video file really carries (its recorded label spans, which match the cut now – checked above)
  const cleanKind: FinishFileKind = hasImages && !q.images ? 'clean_noimg' : 'clean';
  const labelBurned = (render.finish!.files[cleanKind]!.labels ?? '[]') !== '[]';
  const alpha = q.alpha && have.has('alpha') && need.includes('alpha');
  const fcpxml = buildFcpxml({
    title, durationSec: inputs.total, hasAudio: true, videoFile: 'video-clean.mp4',
    markers: sheet.items.map((it) => ({ startSec: it.startSec, text: `${it.label}: ${it.text || it.direction || ''}`.trim() })),
  });
  const guide = finishGuide({
    title, durationSec: inputs.total, client, disclosures: render.disclosures, labelBurned,
    generatedImagesOutside: imageFiles.some((i) => i.generated), imagesInVideo: hasImages ? imagesInVideo : null,
    files: { videoWithText: !!withText, wordSrt: q.words && words.length > 0, alpha, fcpxml: true, caption: snap.caption != null, images: imageFiles.length > 0, subtitles: cues.length > 0 },
  });
  const captionText = snap.caption != null
    ? `${snap.caption.trim()}\n${client && !/\banzeige\b/i.test(snap.caption) ? '\nHinweis: In Kundenprojekten gehört „Anzeige“ in die Caption.\n' : ''}`
    : null;
  const entries = [
    { name: 'ANLEITUNG.md', data: guide },
    { name: 'video-clean.mp4', file: file(cleanKind) },
    ...(withText ? [{ name: 'video-mit-text.mp4', file: absolutePath(render.storagePath!) }] : []),
    ...(cues.length ? [{ name: 'untertitel.srt', data: toSrt(cues) }] : []),
    ...(q.words && words.length ? [{ name: 'untertitel-woerter.srt', data: toSrt(words) }] : []),
    { name: 'texte.txt', data: textsToTxt(sheet, title) },
    { name: 'texte.json', data: `${JSON.stringify(sheet, null, 2)}\n` },
    { name: 'cover.png', file: file('cover') },
    ...(alpha ? [{ name: 'overlays-alpha.mov', file: file('alpha') }] : []),
    ...(captionText ? [{ name: 'caption.txt', data: captionText }] : []),
    { name: 'projekt.fcpxml', data: fcpxml },
    ...imageFiles.map((i) => ({ name: i.file, file: absolutePath(i.storagePath) })),
  ];
  return { filename: `capcut-paket-${slug(project.title)}-v${plan.version}.zip`, entries };
}

// ---------- QA „fehlende Wörter“ ----------

/** Starts the QA of a finished render (whisper.cpp only; the mock would compare nothing). */
export async function startRenderQa(renderId: string) {
  const wh = await whisperStatus();
  if (wh.mode !== 'whisper') throw new HttpError(409, 'Fehlende Wörter prüfen braucht whisper.cpp – im Mock-Modus wäre der Vergleich bedeutungslos.', 'qa_unavailable');
  if (!wh.available) throw new HttpError(409, wh.reason ?? 'whisper.cpp ist nicht verfügbar.', 'qa_unavailable');
  const render = await read((db) => {
    const r = must(db.renders.find((x) => x.id === renderId), 'Render');
    if (!r.storagePath || (r.status !== 'pending_review' && r.status !== 'approved')) throw new HttpError(409, 'Erst wenn der Render fertig ist.');
    return r;
  });
  const active = await read((db) => activeJob(db, 'render_qa', renderId));
  if (active) return { job: jobView(active) };
  const { job } = await enqueueJob('render_qa', { renderId }, {
    projectId: render.projectId,
    onQueued: (db, j) => {
      const other = activeJob(db, 'render_qa', renderId);
      if (other && other.id !== j.id) throw new HttpError(409, 'Die Prüfung läuft schon.');
    },
  });
  return { job: jobView(job) };
}

registerJobHandler('render_qa', async ({ job, signal, workDir, progress }) => {
  const { renderId } = z.object({ renderId: z.string() }).parse(job.input);
  const snap = await read((db) => {
    const render = must(db.renders.find((r) => r.id === renderId), 'Render');
    if (!render.storagePath) throw new Error('Der Render hat keine Datei.');
    const plan = must(db.editPlans.find((p) => p.id === render.editPlanId), 'Schnittplan');
    const body = planBody(plan);
    const look = render.look ?? planLook(db, plan, body.look, body);
    const inputs = renderInputs(db, plan.projectId, body, look);
    return { file: absolutePath(render.storagePath), inputs };
  });
  const wav = path.join(workDir, 'render.wav');
  progress(0, 'Ton aus dem Render');
  await runFfmpeg(['-i', snap.file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav], { signal });
  const out = await runWhisper(wav, path.join(workDir, 'qa'), { signal, onProgress: (f) => progress(0.05 + f * 0.9, `Render neu transkribieren ${Math.round(f * 100)} %`) });
  const heard = transcriptWords(parseWhisperJson(await readFile(out.jsonPath, 'latin1'), { bytes: true }));
  // the spoken words she kept: the transcript words of every clip on the output timeline (a clip's own subtitle text is
  // not what was spoken, so it is ignored here)
  const items = snap.inputs.subtitleItems.map((c) => ({ ...c, subtitle: '' }));
  const expected = await subtitleCues(items, { maxWords: 1 });
  const report = missingWords(expected, heard, { cuts: cutPoints(snap.inputs.tl) });
  await rm(wav, { force: true });
  const qa: RenderQa = {
    createdAt: now(), model: out.model, expected: report.expected, recognized: report.recognized, matched: report.matched,
    findings: report.findings.slice(0, 200), skippedClips: items.flatMap((c, i) => (c.transcript ? [] : [i + 1])),
  };
  return { renderId, qa };
}, (db, job) => {
  const res = job.result as { renderId: string; qa: RenderQa } | null;
  if (job.status !== 'succeeded' || !res) return;
  const r = db.renders.find((x) => x.id === res.renderId);
  if (r) r.finish = { files: r.finish?.files ?? {}, qa: res.qa };
});
