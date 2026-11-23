import 'server-only';
import { claimRanges, EditPlanBody, suggestCuts, type CutSuggestion } from '@studio/core';
import { z } from 'zod';
import { HttpError } from '../errors';
import { absolutePath } from '../media';
import { scanSilence, type SilenceScanResult } from '../silence';
import { must, read, type Db } from '../store';
import { enqueueJob, isFinished, registerJobHandler } from '../worker';
import { latestSilenceScan, latestTranscript, readTranscriptBody, storeSilenceScan } from './transcripts';

/**
 * Release 3, Etappe 8: filler and pause suggestions. The silence scan runs with the transcription, or on
 * request (POST, a job) for clips transcribed before. Suggestions are computed on GET without any side
 * effect and are never stored: accepted ones become cuts of a new EDL draft (save → approve → render review).
 */

const activeScanAssetIds = (db: Db, exceptJobId?: string) =>
  new Set(db.mediaJobs.filter((j) => j.kind === 'silence_scan' && !isFinished(j) && j.id !== exceptJobId).map((j) => (j.input as { assetId?: string } | null)?.assetId));

/** Queues the silence scan of one clip (202 + polling). */
export async function startSilenceScan(assetId: string) {
  const asset = await read((db) => must(db.mediaAssets.find((a) => a.id === assetId), 'Footage'));
  if (asset.probe && !asset.probe.hasAudio) throw new HttpError(409, 'Dieses Footage hat keine Tonspur.');
  return enqueueJob('silence_scan', { assetId }, {
    projectId: asset.projectId,
    onQueued: (db, job) => {
      if (activeScanAssetIds(db, job.id).has(assetId)) throw new HttpError(409, 'Die Pausen dieses Footage werden bereits gemessen.');
    },
  });
}

registerJobHandler('silence_scan', async ({ job, signal, progress }) => {
  const { assetId } = z.object({ assetId: z.string() }).parse(job.input);
  const asset = await read((db) => must(db.mediaAssets.find((a) => a.id === assetId), 'Footage'));
  progress(null, 'Pausen messen');
  const scan = await scanSilence(absolutePath(asset.storagePath), { signal, durationSec: asset.probe?.durationSec ?? null });
  if (!scan) throw new Error('Keine messbare Tonspur (Stille oder unlesbar).');
  return { assetId, projectId: asset.projectId, durationSec: asset.probe?.durationSec ?? null, scan, silenceCount: scan.ranges.length };
}, (db, job) => {
  const r = job.result as { assetId: string; projectId: string; durationSec: number | null; scan: SilenceScanResult } | null;
  if (job.status !== 'succeeded' || !r) return;
  if (!db.mediaAssets.some((a) => a.id === r.assetId)) return; // footage deleted meanwhile: nothing to keep
  storeSilenceScan(db, { projectId: r.projectId, assetId: r.assetId, durationSec: r.durationSec, ...r.scan });
});

/**
 * The last failed pause measurement of a clip that is newer than its latest scan (a failed scan job, or a
 * transcription whose scan failed), so the panel can show the reason instead of a generic hint.
 */
function lastScanFailure(db: Db, assetId: string, after: string | null): { at: string; error: string } | null {
  const fails = db.mediaJobs.flatMap((j) => {
    if ((j.input as { assetId?: string } | null)?.assetId !== assetId || !j.finishedAt || (after && j.finishedAt <= after)) return [];
    if (j.kind === 'silence_scan' && j.status === 'failed') return [{ at: j.finishedAt, error: j.error || 'unbekannter Fehler' }];
    const err = j.kind === 'transcribe' && j.status === 'succeeded' ? (j.result as { scanError?: string | null } | null)?.scanError : null;
    return err ? [{ at: j.finishedAt, error: err }] : [];
  });
  return fails.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

export const CutSuggestionQuery = z.object({
  assetId: z.string().min(1).max(100),
  inSec: z.coerce.number().finite().min(0),
  outSec: z.coerce.number().finite().positive(),
  /** Also suggest unexplained short sounds (low confidence). */
  sounds: z.enum(['0', '1']).default('0'),
  /** The plan's script (scripted plan): its verifiedClaims are protected as in the save gate. Empty = free cut. */
  scriptId: z.string().max(100).optional().transform((s) => s || null),
}).refine((q) => q.outSec > q.inSec, { message: 'Out muss nach In liegen.' });

export type CutSuggestionsView = Awaited<ReturnType<typeof getCutSuggestions>>;

/**
 * The claims a client cut must not shorten: the studio's claim allowlist (every brief's verifiedFacts and the
 * client's productClaims, as in agents/context `allowedClaims`) plus, with a script, its verifiedClaims.
 */
export function protectedClaims(db: Db, projectId: string, scriptId: string | null = null): string[] {
  const project = db.projects.find((p) => p.id === projectId);
  const facts = db.briefs.filter((b) => b.projectId === projectId).flatMap((b) => b.input.verifiedFacts ?? []);
  const script = scriptId ? db.scripts.find((s) => s.id === scriptId && s.projectId === projectId) : null;
  return [...new Set([...(script?.body.verifiedClaims ?? []), ...facts, ...(project?.client?.productClaims ?? [])].map((c) => c.trim()).filter(Boolean))];
}

/**
 * Suggestions for one clip of a take (side-effect free: reads the latest transcript and silence scan, writes
 * nothing, starts nothing). The words come from the same transcript version the subtitles use.
 */
export async function getCutSuggestions(projectId: string, raw: unknown) {
  const q = CutSuggestionQuery.parse(raw);
  const snap = await read((db) => {
    const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
    const asset = must(db.mediaAssets.find((a) => a.id === q.assetId && a.projectId === projectId), 'Footage');
    if (q.scriptId) must(db.scripts.find((s) => s.id === q.scriptId && s.projectId === projectId), 'Skript');
    return {
      project, asset,
      // the same claim list as the save gate (`assertNoClaimCuts` with the plan's script)
      claims: project.kind === 'UGC_CLIENT' ? protectedClaims(db, projectId, q.scriptId) : [],
      transcript: latestTranscript(db, asset.id),
      scan: latestSilenceScan(db, asset.id),
      scanFailure: lastScanFailure(db, asset.id, latestSilenceScan(db, asset.id)?.createdAt ?? null),
      scanRunning: activeScanAssetIds(db).has(asset.id),
      transcribing: db.mediaJobs.some((j) => j.kind === 'transcribe' && !isFinished(j) && (j.input as { assetId?: string } | null)?.assetId === asset.id),
    };
  });
  const client = snap.project.kind === 'UGC_CLIENT';
  const base = {
    assetId: snap.asset.id,
    clientProject: client,
    scanRunning: snap.scanRunning || snap.transcribing,
    /** Why the last pause measurement failed (newer than the latest scan), else null. */
    scanError: snap.scanFailure?.error ?? null,
    scan: snap.scan ? { id: snap.scan.id, createdAt: snap.scan.createdAt, noiseDb: snap.scan.params.noiseDb, meanDb: snap.scan.params.meanDb, silenceCount: snap.scan.ranges.length } : null,
    transcript: snap.transcript ? { id: snap.transcript.id, version: snap.transcript.version, source: snap.transcript.source, fillerPrompt: snap.transcript.fillerPrompt ?? false } : null,
  };
  const empty = { suggestions: [] as CutSuggestion[], skippedFillers: 0, dtw: false, untimedSegments: 0, silences: [] as { startSec: number; endSec: number }[] };
  if (snap.asset.probe && !snap.asset.probe.hasAudio) return { ...base, status: 'no_audio' as const, ...empty };
  if (!snap.transcript) return { ...base, status: 'no_transcript' as const, ...empty };
  if (!snap.scan) return { ...base, status: 'no_scan' as const, ...empty };
  const body = await readTranscriptBody(snap.transcript);
  // client work: sentences that state a client claim are never shortened by a suggestion (ADR-007)
  const protectedRanges = client ? claimRanges(body, snap.claims) : [];
  const res = suggestCuts({ transcript: body, silences: snap.scan.ranges, clip: { inSec: q.inSec, outSec: q.outSec }, protectedRanges }, { sounds: q.sounds === '1' });
  // the measured silences of the clip: accepting joins two close cuts only over silence (core `addCuts`)
  const silences = snap.scan.ranges.filter((r) => r.endSec > q.inSec && r.startSec < q.outSec);
  return { ...base, status: 'ready' as const, ...res, silences };
}

/**
 * Client projects (critique 39): a filler or pause cut inside a sentence that states a client claim is
 * refused; only a manual cut (the user's own decision) may shorten it. Reads the latest transcripts. The
 * claims are the project's allowlist plus the plan script's verifiedClaims (`protectedClaims`).
 */
export async function assertNoClaimCuts(projectId: string, rawBody: unknown, scriptId: string | null = null) {
  const parsed = EditPlanBody.safeParse(rawBody);
  if (!parsed.success) return; // the validator reports shape errors
  const ctx = await read((db) => {
    const project = db.projects.find((p) => p.id === projectId);
    if (project?.kind !== 'UGC_CLIENT') return null;
    const claims = protectedClaims(db, projectId, scriptId);
    if (!claims.length) return null;
    return { claims, clips: parsed.data.clips.map((c) => ({ c, t: c.cuts.some((x) => x.reason !== 'manual') ? latestTranscript(db, c.assetId) : null })) };
  });
  if (!ctx) return;
  const errors: string[] = [];
  for (const [i, { c, t }] of ctx.clips.entries()) {
    if (!t) continue;
    const ranges = claimRanges(await readTranscriptBody(t), ctx.claims);
    const hit = c.cuts.find((x) => x.reason !== 'manual' && ranges.some((r) => Math.min(r.endSec, x.endSec) > Math.max(r.startSec, x.startSec)));
    if (hit) errors.push(`Clip ${i + 1}: Der ${hit.reason === 'pause' ? 'Pausen' : 'Füllwort'}-Schnitt ${hit.startSec}–${hit.endSec} s liegt in einem Satz mit Kunden-Claim – dort nur bewusst manuell schneiden.`);
  }
  if (errors.length) throw new HttpError(400, errors.join(' '));
}
