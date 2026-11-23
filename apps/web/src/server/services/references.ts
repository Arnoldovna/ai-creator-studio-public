import 'server-only';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { HEX, HexColor, IMAGE_OVERLAY_MIMES, ImageUsage, ObservationDecision, ObservationDimension, ReferenceUpdate, runReferenceAnalyst, type ImageInput, type ImageMediaType, type ReferenceAnalysis } from '@studio/core';
import { extractKeyframes, ffmpegPath } from '../ffmpeg';
import { HttpError } from '../http';
import { absolutePath, deleteMediaFiles, readMedia, safeFileName, storeUpload, writeBytes } from '../media';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type AnalysisRecord, type Observation, type Reference } from '../store';
import { runAgent, type AgentTask } from './agentRuns';

const MAX_IMAGE_BYTES_FOR_LLM = 4.5 * 1024 * 1024;

export const listReferences = () =>
  read((db) =>
    db.references
      .map((r) => ({
        ...r,
        analysis: db.analyses.filter((a) => a.referenceId === r.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
        observations: db.observations.filter((o) => o.referenceId === r.id),
        keyframes: db.keyframes.filter((k) => k.referenceId === r.id),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

export async function createReference(file: File, paletteRaw: string | null): Promise<{ reference: Reference; duplicate: boolean }> {
  const id = newId();
  const stored = await storeUpload(id, file);
  let palette: string[] = [];
  try {
    const parsed = JSON.parse(paletteRaw ?? '[]');
    if (Array.isArray(parsed)) palette = parsed.filter((c): c is string => typeof c === 'string' && HEX.test(c)).map((c) => c.toUpperCase()).slice(0, 8);
  } catch {
    /* palette is optional */
  }
  if (stored.kind === 'video') palette = [];
  const result = await write((db) => {
    const dup = db.references.find((r) => r.sha256 === stored.sha256);
    if (dup) return { reference: dup, duplicate: true };
    const ref: Reference = {
      id, profileId: PERSONAL_PROFILE_ID, name: safeFileName(file.name), kind: stored.kind, mime: stored.mime, size: stored.size,
      sha256: stored.sha256, storagePath: stored.storagePath, palette, notes: '', source: '', likes: [], dislikes: [], tags: [],
      ratings: {}, status: 'uploaded', createdAt: now(), updatedAt: now(),
    };
    db.references.push(ref);
    return { reference: ref, duplicate: false };
  });
  if (result.duplicate) await deleteMediaFiles([stored.storagePath]);
  return result;
}

/** Etappe 16: may this image appear in her videos (own / licensed with source / generated = labelled)? null = only inspiration. */
const UsagePatch = z.object({ usage: ImageUsage.nullable().optional() });

export async function updateReference(id: string, raw: unknown) {
  const patch = ReferenceUpdate.parse(raw);
  const { usage } = UsagePatch.parse(raw ?? {});
  return write((db) => {
    const r = must(db.references.find((x) => x.id === id), 'Referenz');
    if (usage !== undefined && usage !== null && r.kind !== 'image') throw new HttpError(400, 'Im Video einblenden lassen sich nur Bilder.');
    if (usage && !IMAGE_OVERLAY_MIMES.includes(r.mime)) throw new HttpError(400, 'GIFs lassen sich nicht einblenden – bitte als PNG, JPEG oder WebP hochladen.');
    Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { updatedAt: now() });
    if (usage !== undefined) r.usage = usage ? { ...usage, setAt: now() } : null;
    return r;
  });
}

export async function deleteReference(id: string) {
  const { ref, keyframes } = await write((db) => {
    const ref = must(db.references.find((x) => x.id === id), 'Referenz');
    const keyframes = db.keyframes.filter((k) => k.referenceId === id);
    db.references = db.references.filter((x) => x.id !== id);
    db.keyframes = db.keyframes.filter((k) => k.referenceId !== id);
    db.analyses = db.analyses.filter((a) => a.referenceId !== id);
    db.observations = db.observations.filter((o) => o.referenceId !== id);
    return { ref, keyframes };
  });
  await deleteMediaFiles([ref.storagePath, ...keyframes.map((k) => k.storagePath)]);
  return { deleted: id };
}

/** Downscale an image to a ≤1568px JPEG via FFmpeg (keeps LLM requests small). */
export async function imageForLlm(ref: Reference): Promise<ImageInput> {
  const bin = await ffmpegPath();
  if (bin && ref.mime !== 'image/gif') {
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-img-'));
    try {
      const out = path.join(dir, 'img.jpg');
      await promisify(execFile)(bin, ['-hide_banner', '-loglevel', 'error', '-i', absolutePath(ref.storagePath), '-frames:v', '1', '-vf', "scale='min(1568,iw)':-2", '-q:v', '3', '-y', out], { timeout: 30000 });
      return { mediaType: 'image/jpeg', base64: (await readFile(out)).toString('base64') };
    } catch {
      /* fall through to original bytes */
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const bytes = await readMedia(ref.storagePath);
  if (bytes.byteLength > MAX_IMAGE_BYTES_FOR_LLM) throw new HttpError(422, 'Bild zu groß für die Analyse und FFmpeg zum Verkleinern nicht verfügbar.');
  return { mediaType: ref.mime as ImageMediaType, base64: bytes.toString('base64') };
}

/**
 * Reference Analyst task (images/keyframes prepared). With `persistKeyframes` the frames are written
 * to storage for the review UI; the Evaluation Lab keeps them in memory only.
 */
export async function prepareReferenceTask(id: string, { persistKeyframes }: { persistKeyframes: boolean }) {
  const ref = await read((db) => must(db.references.find((x) => x.id === id), 'Referenz'));
  let images: ImageInput[] = [];
  let keyframeRecords: { id: string; storagePath: string; timestampSec: number }[] = [];
  const warnings: string[] = [];

  if (ref.kind === 'video') {
    try {
      const frames = await extractKeyframes(absolutePath(ref.storagePath), 6);
      keyframeRecords = [];
      for (const f of frames) {
        const kid = newId();
        const storagePath = `keyframes/${ref.id}/${kid}.jpg`;
        if (persistKeyframes) await writeBytes(storagePath, f.jpeg);
        keyframeRecords.push({ id: kid, storagePath, timestampSec: f.timestampSec });
      }
      images = frames.map((f) => ({ mediaType: 'image/jpeg' as const, base64: f.jpeg.toString('base64'), label: `Keyframe bei ${f.timestampSec}s:` }));
    } catch (e) {
      warnings.push(`Keyframe-Extraktion fehlgeschlagen: ${(e as Error).message}`);
    }
  } else {
    images = [await imageForLlm(ref)];
  }

  const task: AgentTask<ReferenceAnalysis> = {
    meta: {
      agent: 'reference_analyst', useCase: ref.kind === 'video' ? 'reference_video_analysis' : 'reference_image_analysis', projectId: null,
      input: { id: ref.id, sha: ref.sha256, notes: ref.notes, likes: ref.likes }, images: images.length,
    },
    run: async (provider) => {
      if (!images.length && provider.name !== 'mock') throw new HttpError(422, 'Keine Bilddaten für die Analyse verfügbar (Video ohne Keyframes).');
      return runReferenceAnalyst(provider, {
        reference: { id: ref.id, name: ref.name, kind: ref.kind, palette: ref.palette, notes: ref.notes, likes: ref.likes, dislikes: ref.dislikes, tags: ref.tags },
        images,
        keyframeTimestamps: keyframeRecords.map((k) => k.timestampSec),
      });
    },
  };
  return { ref, task, keyframeRecords, warnings };
}

/**
 * Reference Analyst: image → vision analysis; video → FFmpeg keyframes → vision analysis.
 * All resulting observations start as `pending` and never reach the Style Bible until approved.
 */
export async function analyzeReference(id: string) {
  const { task, keyframeRecords, warnings } = await prepareReferenceTask(id, { persistKeyframes: true });
  try {
    const { result, run, mock } = await runAgent(task.meta, task.run);

    let replacedFiles: string[] = [];
    const out = await write((db) => {
      const r = must(db.references.find((x) => x.id === id), 'Referenz');
      // replace older keyframes for this reference (their files are deleted after the write)
      replacedFiles = db.keyframes.filter((k) => k.referenceId === id).map((k) => k.storagePath);
      db.keyframes = db.keyframes.filter((k) => k.referenceId !== id).concat(keyframeRecords.map((k) => ({ ...k, referenceId: id })));
      const analysis: AnalysisRecord = {
        id: newId(), referenceId: id, agentRunId: run.id, provider: result.provider, model: result.model, promptVersion: result.promptVersion,
        analysis: { ...result.output, uncertainties: [...result.output.uncertainties, ...warnings] }, keyframeIds: keyframeRecords.map((k) => k.id), createdAt: now(),
      };
      db.analyses.push(analysis);
      // Pending (undecided) observations of earlier runs are superseded; decided or hand-edited ones are kept.
      db.observations = db.observations.filter((o) => !(o.referenceId === id && o.decision === 'pending' && !o.original));
      const obs: Observation[] = result.output.observations.map((o) => ({
        id: newId(), referenceId: id, analysisId: analysis.id, dimension: o.dimension, kind: o.kind, statement: o.statement, evidence: o.evidence,
        confidence: o.confidence, colors: o.dimension === 'color' ? result.output.colorCharacter.dominantColors : [],
        decision: 'pending', feedback: '', decidedAt: null, mock, createdAt: now(),
      }));
      db.observations.push(...obs);
      r.status = obs.length ? 'review_required' : 'analyzed';
      r.updatedAt = now();
      return { analysis, observations: obs, mock };
    });
    await deleteMediaFiles(replacedFiles);
    return out;
  } catch (e) {
    // budget/provider/validation failure or reference deleted meanwhile: don't leave orphaned frames
    await deleteMediaFiles(keyframeRecords.map((k) => k.storagePath));
    throw e;
  }
}

/**
 * `PATCH /api/observations/[id]`: decide (`decision`, `feedback`) and/or edit (`statement`, `dimension`, `colors`).
 * Every field is optional, at least one is required. The first edit keeps the AI's wording in `original`;
 * the decision stays as it is, so a confirmed observation stays confirmed (and editable).
 */
export const ObservationPatch = z.object({
  decision: ObservationDecision.optional(),
  feedback: z.string().max(1000).optional(),
  statement: z.string().trim().min(1, 'Beobachtung darf nicht leer sein').max(1000).optional(),
  dimension: ObservationDimension.optional(),
  colors: z.array(HexColor).max(8).optional(),
}).strict().refine((p) => Object.values(p).some((v) => v !== undefined), 'Keine Änderung angegeben.');

export async function reviewObservation(id: string, raw: unknown) {
  const { decision, feedback, statement, dimension, colors } = ObservationPatch.parse(raw);
  return write((db) => {
    const o = must(db.observations.find((x) => x.id === id), 'Beobachtung');
    const next = { statement: statement ?? o.statement, dimension: dimension ?? o.dimension, colors: colors?.map((c) => c.toUpperCase()) ?? o.colors };
    const edited = next.statement !== o.statement || next.dimension !== o.dimension || next.colors.join() !== o.colors.join();
    if (edited) {
      o.original ??= { statement: o.statement, dimension: o.dimension, colors: [...o.colors] };
      Object.assign(o, next, { editedAt: now() });
    }
    if (feedback !== undefined) o.feedback = feedback;
    if (decision !== undefined) {
      o.decision = decision;
      o.decidedAt = decision === 'pending' ? null : now();
    }
    const ref = db.references.find((r) => r.id === o.referenceId);
    if (ref) {
      const pending = db.observations.some((x) => x.referenceId === ref.id && x.decision === 'pending');
      ref.status = pending ? 'review_required' : 'reviewed';
    }
    return o;
  });
}

export const getMediaRecord = (mediaId: string) =>
  read((db) => {
    const ref = db.references.find((r) => r.id === mediaId);
    if (ref) return { storagePath: ref.storagePath, mime: ref.mime };
    const kf = db.keyframes.find((k) => k.id === mediaId);
    if (kf) return { storagePath: kf.storagePath, mime: 'image/jpeg' };
    const asset = db.mediaAssets.find((a) => a.id === mediaId);
    if (asset) return { storagePath: asset.storagePath, mime: asset.mime };
    const render = db.renders.find((r) => r.id === mediaId && r.storagePath);
    if (render?.storagePath) return { storagePath: render.storagePath, mime: 'video/mp4' };
    return null;
  });
