import 'server-only';
import { FootageUploadMeta } from '@studio/core';
import { footageLimits } from '../env';
import { ffprobePath, probeMedia } from '../ffmpeg';
import { HttpError } from '../http';
import { absolutePath, deleteMediaFiles, safeFileName, storeUploadStream } from '../media';
import { must, newId, now, read, write, type Db, type MediaAsset } from '../store';
import { cancelJob, isFinished } from '../worker';
import { activeTranscriptionAssetIds, dropTranscripts, latestTranscript } from './transcripts';
import { autoPrepare, derivedBase, prepareView } from './prepare';
import { rm } from 'node:fs/promises';

export const projectFootageBytes = (db: Db, projectId: string) => db.mediaAssets.filter((a) => a.projectId === projectId).reduce((n, a) => n + a.size, 0);

export const listFootage = (projectId: string) =>
  read((db) => {
    must(db.projects.find((p) => p.id === projectId), 'Projekt');
    const active = activeTranscriptionAssetIds(db);
    const items = db.mediaAssets.filter((a) => a.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => ({ ...a, transcript: latestTranscript(db, a.id), transcribing: active.has(a.id), prepare: prepareView(db, a) }));
    return { items, usedBytes: projectFootageBytes(db, projectId), limits: footageLimits() };
  });

/**
 * Footage upload: the body is the raw file (streamed to disk, never buffered); metadata comes as query parameters.
 * Rights are confirmed by the user; quota and type are checked while streaming; ffprobe runs afterwards.
 */
export async function uploadFootage(projectId: string, body: ReadableStream<Uint8Array> | null, rawMeta: unknown, declaredLength: number | null) {
  const meta = FootageUploadMeta.parse(rawMeta);
  const limits = footageLimits();
  const used = await read((db) => {
    must(db.projects.find((p) => p.id === projectId), 'Projekt');
    return projectFootageBytes(db, projectId);
  });
  const room = Math.min(limits.perFile, limits.perProject - used);
  if (room <= 0 || (declaredLength != null && declaredLength > room))
    throw new HttpError(413, room <= 0 ? 'Speicherlimit des Projekts erreicht (FOOTAGE_MAX_PROJECT_BYTES).' : 'Datei zu groß für das Datei- oder Projektlimit.');

  const id = newId();
  const stored = await storeUploadStream(`footage/${projectId}/${id}`, body, {
    maxBytes: room, kinds: ['video'],
    tooLargeMessage: room < limits.perFile ? 'Speicherlimit des Projekts erreicht (FOOTAGE_MAX_PROJECT_BYTES).' : `Datei über dem Limit pro Datei (FOOTAGE_MAX_BYTES).`,
  });
  const probe = await probeMedia(absolutePath(stored.storagePath));
  const status: MediaAsset['status'] = probe ? 'probed' : (await ffprobePath()) ? 'probe_failed' : 'probe_unavailable';

  const result = await write((db) => {
    // The project may have been deleted, or the quota used up by a parallel upload, while the file streamed.
    if (!db.projects.some((p) => p.id === projectId)) throw new HttpError(409, 'Projekt wurde inzwischen gelöscht.');
    const dup = db.mediaAssets.find((a) => a.projectId === projectId && a.sha256 === stored.sha256);
    if (dup) {
      // Same clip again: never silently drop the rights the user just entered.
      if (dup.origin !== meta.origin || dup.rightsNote !== meta.rightsNote)
        throw new HttpError(409, `Dieser Clip ist schon als „${dup.name}“ mit anderen Rechte-Angaben gespeichert – dort löschen und neu hochladen.`);
      return { asset: dup, duplicate: true };
    }
    if (projectFootageBytes(db, projectId) + stored.size > limits.perProject) throw new HttpError(413, 'Speicherlimit des Projekts erreicht (FOOTAGE_MAX_PROJECT_BYTES).');
    const asset: MediaAsset = {
      id, projectId, name: safeFileName(meta.name), mime: stored.mime, size: stored.size, sha256: stored.sha256, storagePath: stored.storagePath,
      origin: meta.origin, rightsNote: meta.rightsNote, rightsConfirmedAt: now(), probe, status, createdAt: now(),
    };
    db.mediaAssets.push(asset);
    return { asset, duplicate: false };
  }).catch(async (e) => {
    await deleteMediaFiles([stored.storagePath]);
    throw e;
  });
  if (result.duplicate) await deleteMediaFiles([stored.storagePath]);
  // Etappe 12: proxy, thumbnails, waveform, then transcription and pauses – without another click (a duplicate is
  // prepared too if it never was; a finished or running preparation is not started again)
  await autoPrepare(result.asset);
  return result;
}

export async function deleteFootage(id: string) {
  const asset = await write((db) => {
    const a = must(db.mediaAssets.find((x) => x.id === id), 'Footage');
    // Reviewed work keeps its source: no deletion under an approved EDL or a live/approved render.
    const plans = db.editPlans.filter((p) => p.body.clips.some((c) => c.assetId === id));
    const live = new Set(db.renders.filter((r) => r.status === 'rendering' || r.status === 'pending_review' || r.status === 'approved').map((r) => r.editPlanId));
    if (plans.some((p) => p.status === 'approved' || live.has(p.id)))
      throw new HttpError(409, 'Dieses Footage wird in einem freigegebenen Schnittplan oder Render verwendet und kann nicht gelöscht werden.');
    db.mediaAssets = db.mediaAssets.filter((x) => x.id !== id);
    // a generated clip deleted before its review: the generation ends as rejected (credits stay booked)
    const gen = a.generation && db.generations.find((g) => g.id === a.generation!.generationId && g.status === 'review');
    if (gen) Object.assign(gen, { status: 'rejected', reviewNote: 'Clip vor der Prüfung gelöscht.', reviewedAt: now() });
    const jobs = db.mediaJobs.filter((j) => (j.kind === 'transcribe' || j.kind === 'silence_scan' || j.kind === 'prepare') && !isFinished(j) && (j.input as { assetId?: string } | null)?.assetId === id).map((j) => j.id);
    // Etappe 12: working drafts lose the clips of this footage (the draft is mutable; saved plan versions keep theirs)
    for (const d of db.editDrafts.filter((x) => x.body.clips.some((c) => c.assetId === id))) {
      d.body = { ...d.body, clips: d.body.clips.filter((c) => c.assetId !== id) };
      d.revision += 1;
      d.updatedAt = now();
    }
    return { storagePath: a.storagePath, projectId: a.projectId, transcripts: dropTranscripts(db, new Set([id])), jobs };
  });
  // whisper, the silence scan and the preparation stop working on deleted footage
  await Promise.all(asset.jobs.map((j) => cancelJob(j).catch(() => undefined)));
  await deleteMediaFiles([asset.storagePath, ...asset.transcripts]);
  await rm(absolutePath(derivedBase(asset.projectId, id)), { recursive: true, force: true }).catch(() => undefined);
  return { deleted: id };
}
