import 'server-only';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { computePeaks, PEAKS, peaksPcmArgs, peaksRate, PREPARE_VERSION, PROXY, proxyArgs, spriteArgs, spritePlan, type PeaksFile } from '@studio/core';
import { z } from 'zod';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { HttpError } from '../errors';
import { absolutePath } from '../media';
import { must, read, write, type AssetDerived, type Db, type MediaAsset, type MediaJob } from '../store';
import { whisperStatus } from '../whisper';
import { enqueueJob, isFinished, registerJobHandler } from '../worker';
import { activeTranscriptionAssetIds, latestSilenceScan, latestTranscript, startTranscription } from './transcripts';
import { startSilenceScan } from './cuts';

/**
 * Etappe 12, „Auto-Vorbereitung“: after an upload the job `prepare` makes the editing proxy (540×960, CFR 30, short GOP),
 * the thumbnail sprite and the waveform peaks, then queues the transcription (which also measures the pauses) or, when
 * whisper is not available, the pause scan alone. Files live under `derived/<projectId>/<assetId>/` in the data folder
 * and go with the footage. Idempotent: a clip prepared with the current PREPARE_VERSION is not prepared again, and there is
 * at most one queued/running job per clip (a failed one can be started again; queued jobs resume after a restart); the
 * files are written in the job's work directory and moved into place at the end, so a half-made set is never used.
 */

export const derivedBase = (projectId: string, assetId: string) => `derived/${projectId}/${assetId}`;
/** STUDIO_AUTO_PREPARE=off switches the automatic start after upload off (unit tests; the button still works). */
export const autoPrepareEnabled = () => process.env.STUDIO_AUTO_PREPARE !== 'off';

/** Footage the editor can use: a video stream and a known duration (ffprobe). */
const preparable = (a: MediaAsset) => !!a.probe && a.probe.durationSec != null && a.probe.durationSec > 0 && (a.probe.videoCodec != null || a.probe.width != null);

export type PrepareStatus = 'ready' | 'queued' | 'running' | 'failed' | 'none' | 'outdated' | 'unsupported';
export interface PrepareView { status: PrepareStatus; progress: number | null; note: string; error: string | null; jobId: string | null }

const latestPrepareJob = (db: Db, assetId: string): MediaJob | null =>
  db.mediaJobs.filter((j) => j.kind === 'prepare' && (j.input as { assetId?: string } | null)?.assetId === assetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

/** What the library and the editor show about a clip's preparation. */
export function prepareView(db: Db, a: MediaAsset): PrepareView {
  const job = latestPrepareJob(db, a.id);
  const base = { progress: job?.progress ?? null, note: job?.progressNote ?? '', error: null, jobId: job?.id ?? null };
  if (job && !isFinished(job)) return { ...base, status: job.status === 'queued' ? 'queued' : 'running' };
  if (a.derived) return { ...base, status: a.derived.version === PREPARE_VERSION ? 'ready' : 'outdated' };
  if (!preparable(a)) return { ...base, status: 'unsupported' };
  if (job?.status === 'failed' || job?.status === 'cancelled') return { ...base, status: 'failed', error: job.error ?? 'Abgebrochen' };
  return { ...base, status: 'none' };
}

/** Queues the preparation of one clip (202 + polling). A finished preparation of the current version is returned as it is. */
export async function startPrepare(assetId: string) {
  const ff = await ffmpegStatus();
  if (!ff.available) throw new HttpError(503, 'FFmpeg ist nicht verfügbar – Proxy, Vorschaubilder und Wellenform brauchen FFmpeg.');
  const asset = await read((db) => must(db.mediaAssets.find((a) => a.id === assetId), 'Footage'));
  if (!preparable(asset)) throw new HttpError(409, 'Dieses Footage hat keine lesbare Videospur mit bekannter Dauer (ffprobe) – es kann nicht vorbereitet werden.');
  if (asset.derived?.version === PREPARE_VERSION) return { job: null, replayed: true, ready: true };
  // one job per clip at a time: a queued or running one is returned (resumed after a restart by the worker)
  const active = await read((db) => db.mediaJobs.find((j) => j.kind === 'prepare' && !isFinished(j) && (j.input as { assetId?: string } | null)?.assetId === assetId) ?? null);
  if (active) return { job: active, replayed: true, ready: false };
  const out = await enqueueJob('prepare', { assetId }, {
    projectId: asset.projectId,
    onQueued: (db, job) => {
      if (db.mediaJobs.some((j) => j.id !== job.id && j.kind === 'prepare' && !isFinished(j) && (j.input as { assetId?: string } | null)?.assetId === assetId))
        throw new HttpError(409, 'Dieses Footage wird bereits vorbereitet.');
    },
  });
  return { ...out, ready: false };
}

/** Starts the preparation after an upload (never fails the upload: a problem is logged and shown in the library). */
export async function autoPrepare(asset: MediaAsset): Promise<void> {
  if (!autoPrepareEnabled() || !preparable(asset)) return;
  try {
    await startPrepare(asset.id);
  } catch (e) {
    console.error('Vorbereitung konnte nicht gestartet werden', (e as Error).message);
  }
}

/**
 * After the proxy: the transcription (with the pause scan) when whisper is available and the clip has no transcript yet,
 * else the pause scan alone. Errors are logged; the editor shows „Transkription nicht verfügbar“ with the reason.
 */
async function queueAnalysis(assetId: string): Promise<{ transcription: 'queued' | 'exists' | 'unavailable' | 'no_audio' | 'failed'; scan: 'queued' | 'exists' | 'with_transcription' | 'no_audio' | 'failed' }> {
  const snap = await read((db) => {
    const a = db.mediaAssets.find((x) => x.id === assetId);
    if (!a) return null;
    return {
      hasAudio: a.probe?.hasAudio ?? false, transcript: !!latestTranscript(db, assetId), scan: !!latestSilenceScan(db, assetId),
      transcribing: activeTranscriptionAssetIds(db).has(assetId),
      scanning: db.mediaJobs.some((j) => j.kind === 'silence_scan' && !isFinished(j) && (j.input as { assetId?: string } | null)?.assetId === assetId),
    };
  });
  if (!snap || !snap.hasAudio) return { transcription: 'no_audio', scan: 'no_audio' };
  let transcription: 'queued' | 'exists' | 'unavailable' | 'failed' = snap.transcript || snap.transcribing ? 'exists' : 'unavailable';
  if (!snap.transcript && !snap.transcribing && (await whisperStatus()).available) {
    try {
      await startTranscription(assetId);
      transcription = 'queued';
    } catch (e) {
      transcription = 'failed';
      console.error('Transkription konnte nicht gestartet werden', (e as Error).message);
    }
  }
  if (transcription === 'queued' || snap.transcribing) return { transcription, scan: 'with_transcription' };
  if (snap.scan || snap.scanning) return { transcription, scan: 'exists' };
  try {
    await startSilenceScan(assetId);
    return { transcription, scan: 'queued' };
  } catch (e) {
    console.error('Pausen-Messung konnte nicht gestartet werden', (e as Error).message);
    return { transcription, scan: 'failed' };
  }
}

interface PrepareResult { assetId: string; projectId: string; derived: AssetDerived; analysis: Awaited<ReturnType<typeof queueAnalysis>> }

registerJobHandler('prepare', async ({ job, signal, workDir, progress }): Promise<PrepareResult> => {
  const { assetId } = z.object({ assetId: z.string() }).parse(job.input);
  const asset = await read((db) => must(db.mediaAssets.find((a) => a.id === assetId), 'Footage'));
  if (!preparable(asset)) throw new Error('Footage ohne lesbare Videospur oder Dauer.');
  const durationSec = asset.probe!.durationSec!;
  const hasAudio = asset.probe!.hasAudio;
  const src = absolutePath(asset.storagePath);

  const proxy = path.join(workDir, 'proxy.mp4');
  progress(0, 'Proxy für flüssiges Scrubbing');
  await runFfmpeg(proxyArgs(src, proxy, hasAudio), { signal, durationSec, onProgress: (f) => progress(f == null ? null : f * 0.75, 'Proxy für flüssiges Scrubbing') });

  const plan = spritePlan(durationSec);
  const thumbs = path.join(workDir, 'thumbs.jpg');
  progress(0.76, 'Vorschaubilder');
  await runFfmpeg(spriteArgs(proxy, thumbs, plan), { signal });

  let peaks: AssetDerived['peaks'] = null;
  if (hasAudio) {
    progress(0.88, 'Wellenform');
    const pcm = path.join(workDir, 'audio.pcm');
    await runFfmpeg(peaksPcmArgs(src, pcm), { signal });
    const buf = await readFile(pcm);
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    const perSec = peaksRate(durationSec);
    const file: PeaksFile = { version: 1, perSec, durationSec, peaks: computePeaks(samples, PEAKS.sampleRate, perSec) };
    await writeFile(path.join(workDir, 'peaks.json'), JSON.stringify(file), 'utf8');
    peaks = { storagePath: '', perSec, count: file.peaks.length };
  }
  signal.throwIfAborted();

  // move the finished set into place (a fresh folder: an older set of this clip is replaced as a whole)
  const base = derivedBase(asset.projectId, asset.id);
  const finalDir = absolutePath(base);
  // review fix: the new set is assembled next to the old one and swapped in only when complete, so a failed or
  // cancelled re-preparation never leaves `derived` pointing at deleted files
  const staging = `${finalDir}.new`, old = `${finalDir}.old`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await rename(proxy, path.join(staging, 'proxy.mp4'));
  await rename(thumbs, path.join(staging, 'thumbs.jpg'));
  if (peaks) await rename(path.join(workDir, 'peaks.json'), path.join(staging, 'peaks.json'));
  if (signal.aborted) {
    await rm(staging, { recursive: true, force: true });
    signal.throwIfAborted();
  }
  await rm(old, { recursive: true, force: true });
  await rename(finalDir, old).catch(() => undefined); // no older set: nothing to move aside
  await rename(staging, finalDir);
  await rm(old, { recursive: true, force: true });
  if (signal.aborted || !(await read((db) => db.mediaAssets.some((a) => a.id === assetId)))) {
    await rm(finalDir, { recursive: true, force: true });
    signal.throwIfAborted();
    throw new Error('Footage wurde während der Vorbereitung gelöscht.');
  }
  const derived: AssetDerived = {
    version: PREPARE_VERSION,
    proxy: { storagePath: `${base}/proxy.mp4`, width: PROXY.width, height: PROXY.height, fps: PROXY.fps, size: (await stat(path.join(finalDir, 'proxy.mp4'))).size },
    thumbs: { ...plan, storagePath: `${base}/thumbs.jpg` },
    peaks: peaks ? { ...peaks, storagePath: `${base}/peaks.json` } : null,
    preparedAt: new Date().toISOString(),
  };
  progress(0.99, 'Transkription und Pausen anstoßen');
  // stored before the follow-up jobs are queued, so the editor can show proxy and waveform at once
  await write((db) => {
    const a = db.mediaAssets.find((x) => x.id === assetId);
    if (a) a.derived = derived;
  });
  const analysis = await queueAnalysis(assetId);
  return { assetId, projectId: asset.projectId, derived, analysis };
}, (db, job) => {
  const r = job.result as PrepareResult | null;
  if (job.status !== 'succeeded' || !r) return;
  const a = db.mediaAssets.find((x) => x.id === r.assetId);
  if (!a) {
    void rm(absolutePath(derivedBase(r.projectId, r.assetId)), { recursive: true, force: true }).catch(() => undefined);
    Object.assign(job, { status: 'failed', result: null, error: 'Footage wurde während der Vorbereitung gelöscht.' });
    return;
  }
  a.derived = r.derived;
});

/** A derived file of a footage clip for `/api/media/[id]?variant=`; 404 while it is not prepared. */
export async function derivedFile(assetId: string, variant: 'proxy' | 'thumbs'): Promise<{ storagePath: string; mime: string }> {
  const a = await read((db) => db.mediaAssets.find((x) => x.id === assetId) ?? null);
  if (!a) throw new HttpError(404, 'Medium nicht gefunden');
  if (!a.derived) throw new HttpError(404, 'Noch nicht vorbereitet (Proxy und Vorschaubilder fehlen).');
  return variant === 'proxy' ? { storagePath: a.derived.proxy.storagePath, mime: 'video/mp4' } : { storagePath: a.derived.thumbs.storagePath, mime: 'image/jpeg' };
}

/** Waveform peaks of a clip (`GET /api/footage/[id]/peaks`). A clip without sound gives an empty list. */
export async function getPeaks(assetId: string): Promise<PeaksFile & { hasAudio: boolean }> {
  const a = await read((db) => must(db.mediaAssets.find((x) => x.id === assetId), 'Footage'));
  if (!a.derived) throw new HttpError(404, 'Noch nicht vorbereitet (Wellenform fehlt).');
  if (!a.derived.peaks) return { version: 1, perSec: 0, durationSec: a.probe?.durationSec ?? 0, peaks: [], hasAudio: false };
  const raw = JSON.parse(await readFile(absolutePath(a.derived.peaks.storagePath), 'utf8').catch(() => {
    throw new HttpError(404, 'Wellenform-Datei fehlt – Vorbereitung erneut starten.');
  })) as PeaksFile;
  const file = z.object({ version: z.literal(1), perSec: z.number().positive(), durationSec: z.number().min(0), peaks: z.array(z.number().int().min(0).max(255)).max(PEAKS.maxBins + 10) }).parse(raw);
  return { ...file, hasAudio: true };
}
