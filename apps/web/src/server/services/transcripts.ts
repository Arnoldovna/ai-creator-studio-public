import 'server-only';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyTranscriptEdit, matchScene, mockTranscript, parseWhisperJson, TranscriptBody, type TakeCandidate } from '@studio/core';
import { z } from 'zod';
import { runFfmpeg } from '../ffmpeg';
import { HttpError } from '../errors';
import { absolutePath } from '../media';
import { scanSilence, type SilenceScanResult } from '../silence';
import { must, newId, now, read, write, type Db, type Transcript } from '../store';
import { runWhisper, whisperStatus } from '../whisper';
import { enqueueJob, isFinished, registerJobHandler } from '../worker';

/**
 * Release 3, Etappe 5: local transcription (whisper.cpp) of uploaded footage, user corrections as
 * versions, and deterministic take suggestions for the EDL. Transcript text is untrusted data.
 */

export const latestTranscript = (db: Db, assetId: string): Transcript | null =>
  db.transcripts.filter((t) => t.assetId === assetId).sort((a, b) => b.version - a.version)[0] ?? null;

/** Clips with a queued or running transcription (one job per clip at a time). */
export const activeTranscriptionAssetIds = (db: Db, exceptJobId?: string) =>
  new Set(db.mediaJobs.filter((j) => j.kind === 'transcribe' && !isFinished(j) && j.id !== exceptJobId).map((j) => (j.input as { assetId?: string } | null)?.assetId));

export async function readTranscriptBody(t: Pick<Transcript, 'storagePath'>): Promise<TranscriptBody> {
  return TranscriptBody.parse(JSON.parse(await readFile(absolutePath(t.storagePath), 'utf8')));
}

async function storeBody(projectId: string, id: string, body: TranscriptBody) {
  const storagePath = `transcripts/${projectId}/${id}.json`;
  await mkdir(path.dirname(absolutePath(storagePath)), { recursive: true });
  await writeFile(absolutePath(storagePath), JSON.stringify(body), 'utf8');
  return storagePath;
}

/** Queues the transcription of one clip (202 + polling). Mock mode is explicit (TRANSCRIPTION=mock) and labelled. */
export async function startTranscription(assetId: string) {
  const st = await whisperStatus();
  if (!st.available) throw new HttpError(503, st.reason ?? 'Transkription ist nicht verfügbar.');
  const asset = await read((db) => must(db.mediaAssets.find((a) => a.id === assetId), 'Footage'));
  if (asset.probe && !asset.probe.hasAudio) throw new HttpError(409, 'Dieses Footage hat keine Tonspur.');
  return enqueueJob('transcribe', { assetId }, {
    projectId: asset.projectId,
    onQueued: (db, job) => {
      if (activeTranscriptionAssetIds(db, job.id).has(assetId))
        throw new HttpError(409, 'Dieses Footage wird bereits transkribiert.');
    },
  });
}

registerJobHandler('transcribe', async ({ job, signal, workDir, progress }) => {
  const { assetId } = z.object({ assetId: z.string() }).parse(job.input);
  const asset = await read((db) => must(db.mediaAssets.find((a) => a.id === assetId), 'Footage'));
  const st = await whisperStatus();
  const id = newId();
  let body: TranscriptBody;
  let model: string | null = null;
  let fillerPrompt = false;
  let scanInput = absolutePath(asset.storagePath);
  if (st.mode === 'mock') {
    body = mockTranscript(asset.probe?.durationSec ?? 6, asset.sha256);
  } else {
    // 16 kHz mono WAV is what whisper.cpp expects; the audio never leaves the machine.
    const wav = path.join(workDir, 'audio.wav');
    progress(0, 'Ton extrahieren');
    await runFfmpeg(['-i', absolutePath(asset.storagePath), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav], { signal });
    const out = await runWhisper(wav, path.join(workDir, 'transcript'), { signal, onProgress: (f) => progress(0.05 + f * 0.95, `Transkription ${Math.round(f * 100)} %`) });
    body = parseWhisperJson(await readFile(out.jsonPath, 'latin1'), { bytes: true }); // raw token bytes, see parser
    model = out.model;
    fillerPrompt = out.fillerPrompt;
    scanInput = wav;
  }
  signal.throwIfAborted();
  // Etappe 8: the silence scan for pause/filler suggestions runs in the same job (seconds on the WAV).
  // A failed scan never fails the transcription: it can be repeated from the Video Studio.
  let scan: SilenceScanResult | null = null;
  let scanError: string | null = null;
  try {
    progress(0.99, 'Pausen messen');
    scan = await scanSilence(scanInput, { signal, durationSec: asset.probe?.durationSec ?? null });
    if (!scan) scanError = 'Keine messbare Tonspur (Stille oder unlesbar).';
  } catch (e) {
    signal.throwIfAborted();
    scanError = (e as Error).message.slice(0, 300);
    console.error('Pausen-Messung fehlgeschlagen', scanError);
  }
  const storagePath = await storeBody(asset.projectId, id, body);
  if (!(await read((db) => db.mediaAssets.some((a) => a.id === assetId)))) {
    await rm(absolutePath(storagePath), { force: true }); // footage deleted while transcribing
    throw new Error('Footage wurde während der Transkription gelöscht.');
  }
  return { id, assetId, projectId: asset.projectId, storagePath, model, source: st.mode, language: body.language, segmentCount: body.segments.length, fillerPrompt, scan, scanError, durationSec: asset.probe?.durationSec ?? null };
}, (db, job) => {
  const r = job.result as { id: string; assetId: string; projectId: string; storagePath: string; model: string | null; source: 'whisper' | 'mock'; language: string; segmentCount: number; fillerPrompt?: boolean; scan?: SilenceScanResult | null; durationSec?: number | null } | null;
  if (job.status !== 'succeeded' || !r) return;
  // footage deleted after the handler's check: no record, the file goes and the job says why
  if (!db.mediaAssets.some((a) => a.id === r.assetId)) {
    void rm(absolutePath(r.storagePath), { force: true }).catch(() => undefined);
    Object.assign(job, { status: 'failed', result: null, error: 'Footage wurde während der Transkription gelöscht.' });
    return;
  }
  const prev = latestTranscript(db, r.assetId);
  db.transcripts.push({
    id: r.id, projectId: r.projectId, assetId: r.assetId, version: (prev?.version ?? 0) + 1, parentId: prev?.id ?? null,
    source: r.source, model: r.model, language: r.language, storagePath: r.storagePath, segmentCount: r.segmentCount, createdAt: now(),
    fillerPrompt: r.fillerPrompt ?? false,
  });
  if (r.scan) storeSilenceScan(db, { projectId: r.projectId, assetId: r.assetId, durationSec: r.durationSec ?? null, ...r.scan });
});

/** Latest silence scan of a clip (null if none yet). */
export const latestSilenceScan = (db: Db, assetId: string) =>
  db.silenceScans.filter((x) => x.assetId === assetId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

/** Stores a scan as the clip's only one (older scans of the clip are replaced). */
export function storeSilenceScan(db: Db, x: SilenceScanResult & { projectId: string; assetId: string; durationSec: number | null }) {
  db.silenceScans = db.silenceScans.filter((s) => s.assetId !== x.assetId);
  db.silenceScans.push({ id: newId(), projectId: x.projectId, assetId: x.assetId, params: x.params, ranges: x.ranges, durationSec: x.durationSec, createdAt: now() });
}

/** Latest transcript of a clip with its text (null if none yet). */
export async function getTranscript(assetId: string) {
  const t = await read((db) => {
    must(db.mediaAssets.find((a) => a.id === assetId), 'Footage');
    return latestTranscript(db, assetId);
  });
  return t ? { ...t, body: await readTranscriptBody(t) } : null;
}

/** Human gate: the user corrects the text; this becomes a new version (word timings of changed segments are dropped). */
export async function saveTranscriptEdit(transcriptId: string, raw: unknown) {
  const { texts } = z.object({ texts: z.array(z.string().max(2000)).max(5000) }).parse(raw);
  const base = await read((db) => ({ ...must(db.transcripts.find((t) => t.id === transcriptId), 'Transkript') }));
  const body = applyTranscriptEdit(await readTranscriptBody(base), texts);
  const id = newId();
  const storagePath = await storeBody(base.projectId, id, body);
  try {
    return await write((db) => {
      const latest = latestTranscript(db, base.assetId);
      if (!latest || latest.id !== base.id) throw new HttpError(409, 'Das Transkript wurde inzwischen geändert – bitte neu laden.');
      // a corrected mock stays a mock: its timings and other segments are still stand-ins
      const t: Transcript = { ...base, id, version: base.version + 1, parentId: base.id, source: base.source === 'mock' ? 'mock' : 'user_edit', storagePath, segmentCount: body.segments.length, createdAt: now() };
      db.transcripts.push(t);
      return { ...t, body };
    });
  } catch (e) {
    await rm(absolutePath(storagePath), { force: true });
    throw e;
  }
}

/**
 * Take suggestions for every scene of a script: the best window of each transcribed clip for the scene's
 * dialogue. Only a suggestion – the user saves and approves the EDL as in Etappe 4.
 */
export async function suggestTakes(projectId: string, scriptId: string) {
  const { scenes, transcripts } = await read((db) => {
    const script = must(db.scripts.find((s) => s.id === scriptId && s.projectId === projectId), 'Skript');
    const assets = db.mediaAssets.filter((a) => a.projectId === projectId && a.probe?.durationSec != null && (a.probe.videoCodec != null || a.probe.width != null));
    return {
      scenes: script.body.scenes.map((s) => ({ dialogue: s.dialogue, shotType: s.shotType })),
      transcripts: assets.flatMap((a) => {
        const t = latestTranscript(db, a.id);
        return t ? [{ asset: a, t }] : [];
      }),
    };
  });
  const takes = await Promise.all(transcripts.map(async ({ asset, t }) => ({
    assetId: asset.id, durationSec: asset.probe!.durationSec, transcript: await readTranscriptBody(t), mock: t.source === 'mock',
  })));
  const mock = takes.some((t) => t.mock);
  return {
    transcribedClips: takes.length,
    mock,
    scenes: scenes.map((s, sceneIndex): { sceneIndex: number; candidates: TakeCandidate[] } => ({ sceneIndex, candidates: matchScene(s.dialogue, takes).slice(0, 3) })),
  };
}

/** Removes transcripts (records + files) and silence scans of the given clips; used when footage or a project is deleted. */
export function dropTranscripts(db: Db, assetIds: Set<string>): string[] {
  db.silenceScans = db.silenceScans.filter((x) => !assetIds.has(x.assetId));
  const gone = db.transcripts.filter((t) => assetIds.has(t.assetId));
  db.transcripts = db.transcripts.filter((t) => !assetIds.has(t.assetId));
  return gone.map((t) => t.storagePath);
}
