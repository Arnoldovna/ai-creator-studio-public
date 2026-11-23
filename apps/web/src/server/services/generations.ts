import 'server-only';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { classifyFailure, FAILURE_LABEL, GenerationParams, HIGGSFIELD_MODELS, type FailureKind, type HiggsfieldJob } from '@studio/core';
import { z } from 'zod';
import { higgsfieldConfig } from '../env';
import { probeMedia } from '../ffmpeg';
import { HttpError } from '../errors';
import { HiggsfieldError, higgsfieldAdapter, higgsfieldStatus } from '../higgsfield';
import { absolutePath, deleteMediaFiles, sha256File } from '../media';
import { must, newId, now, read, write, type Db, type Generation, type MediaAsset, type Project, type ScriptVersion } from '../store';
import { enqueueJob, registerJobHandler } from '../worker';

/**
 * Release 3, Etappe 7 (ADR-010): generated B-roll from approved Cinematic Director asset briefs.
 * Gates: project opt-in → quote (`generate cost`) → per-asset credit approval within the monthly and
 * project budget → one `generate create` without retry → download into own storage → asset review →
 * new EDL version → EDL approval → render (with the AI label burned in) → render review.
 */

const isLive = (g: Generation) => g.status === 'queued' || g.status === 'running';
/** Credits a generation holds against the budget: the approved maximum while it runs, then what was charged. */
export const committedCredits = (g: Generation) => g.creditsCharged ?? (isLive(g) ? (g.approvedMaxCredits ?? 0) : 0);
const month = (iso: string) => iso.slice(0, 7);

export const monthCreditsCommitted = (db: Db) => {
  const m = month(now());
  return db.generations.filter((g) => g.approvedAt && month(g.approvedAt) === m).reduce((s, g) => s + committedCredits(g), 0);
};

function budget(db: Db, projectId: string) {
  const monthCommitted = monthCreditsCommitted(db);
  const projectCommitted = db.generations.filter((g) => g.projectId === projectId).reduce((s, g) => s + committedCredits(g), 0);
  const project = db.projects.find((p) => p.id === projectId);
  return { monthLimit: higgsfieldConfig().monthlyCredits, monthCommitted, projectLimit: project?.aiBroll?.creditBudget ?? 0, projectCommitted };
}

/**
 * The brief a generation comes from must still stand: storyboard and script approved, the scene is no
 * product scene, the project opted in and a client project documented the client's consent (quote, credit approval
 * and submit). The FitCheck re-check is gone since Etappe 11 (personal projects have no gate).
 */
function briefOf(db: Db, projectId: string, storyboardId: string, briefIndex: number) {
  const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
  if (!project.aiBroll) throw new HttpError(409, 'Generierte B-Roll ist für dieses Projekt nicht freigeschaltet (Opt-in fehlt).');
  const sb = db.scriptOutputs.find((o) => o.id === storyboardId && o.projectId === projectId && o.kind === 'storyboard');
  if (!sb || sb.kind !== 'storyboard') throw new HttpError(404, 'Storyboard nicht gefunden');
  if (sb.status !== 'approved') throw new HttpError(409, 'Erst das Storyboard (die KI-Asset-Briefs) freigeben.');
  const brief = sb.output.aiAssetBriefs[briefIndex];
  if (!brief) throw new HttpError(404, 'Asset-Brief nicht gefunden');
  const script = db.scripts.find((s) => s.id === sb.scriptId);
  const blocked = briefBlockReason(project, sb, script, brief.sceneIndex);
  if (blocked) throw new HttpError(409, blocked);
  return { project, sb, script: script!, brief };
}

/** Script/scene/consent rules of a brief, shared by the server gate and the UI badge (null = may be quoted). */
function briefBlockReason(project: Project, sb: { clientConsentNote?: string | null }, script: ScriptVersion | undefined, sceneIndex: number): string | null {
  if (!script || script.status !== 'approved') return 'Das Skript ist nicht freigegeben.';
  const scene = script.body.scenes[sceneIndex];
  if (!scene) return 'Die Szene des Briefs gibt es im Skript nicht mehr.';
  if (scene.shotType === 'product') return 'Produktszenen zeigen immer echtes Footage, nie KI-generierte Clips.';
  if (project.kind === 'UGC_CLIENT' && !sb.clientConsentNote?.trim()) return 'Kundenprojekt: Die Zustimmung der Kundin zu KI-Medien ist am Storyboard nicht dokumentiert.';
  return null;
}
export const briefIdOf = (storyboardId: string, briefIndex: number) => `${storyboardId}:${briefIndex}`;

const OptIn = z.object({ enabled: z.boolean(), creditBudget: z.number().int().min(0).max(1_000_000).default(0) });
/** Human gate: generated B-roll per project, with its own credit budget. */
export async function setAiBroll(projectId: string, raw: unknown) {
  const { enabled, creditBudget } = OptIn.parse(raw);
  return write((db) => {
    const p = must(db.projects.find((x) => x.id === projectId), 'Projekt');
    p.aiBroll = enabled ? { optInAt: p.aiBroll?.optInAt ?? now(), creditBudget } : null;
    p.updatedAt = now();
    return { aiBroll: p.aiBroll };
  });
}

const QuoteRequest = z.object({
  storyboardId: z.string().min(1), briefIndex: z.number().int().min(0).max(20),
  model: z.string(), durationSec: z.number().int(), resolution: z.enum(['720p', '1080p']).nullish(),
});

/** Step 1: `generate cost` for one approved brief. Costs nothing; stores the quote for the approval. */
export async function quoteGeneration(projectId: string, raw: unknown): Promise<Generation> {
  const req = QuoteRequest.parse(raw);
  const adapter = await higgsfieldAdapter();
  if (!adapter) throw new HttpError(503, (await higgsfieldStatus()).reason ?? 'Higgsfield ist nicht verfügbar.');
  const { brief } = await read((db) => briefOf(db, projectId, req.storyboardId, req.briefIndex));
  const params = GenerationParams.parse({ model: req.model, prompt: brief.prompt, durationSec: req.durationSec, resolution: req.resolution });
  let credits: number;
  try {
    credits = await adapter.cost(params);
  } catch (e) {
    const kind = e instanceof HiggsfieldError ? e.kind : classifyFailure((e as Error).message);
    throw new HttpError(kind === 'needs_login' || kind === 'needs_workspace' ? 409 : 502, `${FAILURE_LABEL[kind]} ${(e as Error).message}`.trim());
  }
  return write((db) => {
    const { sb, brief } = briefOf(db, projectId, req.storyboardId, req.briefIndex);
    const g: Generation = {
      id: newId(), projectId, scriptId: sb.scriptId, storyboardId: sb.id, briefIndex: req.briefIndex, briefId: briefIdOf(sb.id, req.briefIndex),
      sceneIndex: brief.sceneIndex, params, mock: adapter.mode === 'mock',
      status: 'quoted', quotedCredits: credits, quotedAt: now(), approvedMaxCredits: null, approvedAt: null,
      submittedAt: null, higgsfieldJobId: null, jobId: null, assetId: null, creditsCharged: null, failure: null, error: null,
      reviewNote: '', reviewedAt: null, createdAt: now(),
    };
    db.generations.push(g);
    return g;
  });
}

const QUOTE_TTL_MS = 60 * 60 * 1000;
const MODE_CHANGED = 'Die Schätzung wurde in einem anderen Higgsfield-Modus (Mock/CLI) erstellt – bitte neu schätzen.';
const Approve = z.object({ approvedMaxCredits: z.number().positive().max(1_000_000) });

/**
 * Step 2, human gate: the user approves at most `approvedMaxCredits` for this one clip. Budget check,
 * approval and the queued job happen in one write; a generation is approved once (no retry after a failure).
 */
export async function approveGeneration(id: string, raw: unknown) {
  const { approvedMaxCredits } = Approve.parse(raw);
  const projectId = await read((db) => must(db.generations.find((g) => g.id === id), 'Generierung').projectId);
  const adapter = await higgsfieldAdapter();
  if (!adapter) throw new HttpError(503, 'Higgsfield ist nicht verfügbar.');
  const { job } = await enqueueJob('generate', { generationId: id }, {
    projectId,
    onQueued: (db, job) => {
      const g = must(db.generations.find((x) => x.id === id), 'Generierung');
      if (g.status !== 'quoted') throw new HttpError(409, g.status === 'failed' || g.status === 'cancelled'
        ? 'Fehlgeschlagene Generierungen werden nicht automatisch wiederholt – bei Bedarf neu schätzen und neu freigeben.'
        : 'Diese Generierung ist schon freigegeben.');
      if (g.mock !== (adapter.mode === 'mock')) throw new HttpError(409, MODE_CHANGED);
      if (Date.now() - Date.parse(g.quotedAt) > QUOTE_TTL_MS) throw new HttpError(409, 'Die Kostenschätzung ist älter als 1 Stunde – bitte neu schätzen.');
      if (approvedMaxCredits < g.quotedCredits) throw new HttpError(409, `Die Freigabe (${approvedMaxCredits}) liegt unter der Schätzung (${g.quotedCredits} Credits).`);
      briefOf(db, g.projectId, g.storyboardId, g.briefIndex);
      const b = budget(db, g.projectId);
      if (b.monthLimit <= 0) throw new HttpError(402, 'Kein monatliches Credit-Budget gesetzt (HIGGSFIELD_MONTHLY_CREDITS).');
      if (b.monthCommitted + approvedMaxCredits > b.monthLimit) throw new HttpError(402, `Monatsbudget überschritten: ${b.monthCommitted} von ${b.monthLimit} Credits gebunden.`);
      if (b.projectCommitted + approvedMaxCredits > b.projectLimit) throw new HttpError(402, `Projektbudget überschritten: ${b.projectCommitted} von ${b.projectLimit} Credits gebunden.`);
      Object.assign(g, { status: 'queued', approvedMaxCredits, approvedAt: now(), jobId: job.id });
    },
  });
  return { job, generation: await read((db) => db.generations.find((g) => g.id === id)!) };
}

class GenerationFailure extends Error {}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(t);
    reject(signal.reason);
  }, { once: true });
});

registerJobHandler('generate', async ({ job, signal, workDir, progress }) => {
  const { generationId } = z.object({ generationId: z.string() }).parse(job.input);
  const adapter = await higgsfieldAdapter();
  if (!adapter) throw new Error('Higgsfield ist nicht verfügbar.');
  // Gate check and "submitted" marker in one write BEFORE the create call: after a crash the credits count as spent.
  const g = await write((db) => {
    const g = must(db.generations.find((x) => x.id === generationId), 'Generierung');
    if (g.status !== 'queued' || g.approvedMaxCredits == null || g.jobId !== job.id) throw new HttpError(409, 'Generierung ist nicht freigegeben.');
    if (g.mock !== (adapter.mode === 'mock')) throw new HttpError(409, MODE_CHANGED);
    briefOf(db, g.projectId, g.storyboardId, g.briefIndex);
    // cancelled before anything was sent: nothing is charged
    if (signal.aborted || db.mediaJobs.find((j) => j.id === job.id)?.cancelRequested) {
      Object.assign(g, { failure: 'cancelled', error: FAILURE_LABEL.cancelled, creditsCharged: 0 });
      return null;
    }
    Object.assign(g, { status: 'running', submittedAt: now() });
    return { ...g };
  });
  if (!g) {
    signal.throwIfAborted();
    throw new GenerationFailure(FAILURE_LABEL.cancelled);
  }
  const fail = async (kind: FailureKind, detail: string | null, charged: number): Promise<never> => {
    const error = [FAILURE_LABEL[kind], detail].filter(Boolean).join(' ').slice(0, 400);
    await write((db) => {
      const x = db.generations.find((y) => y.id === g.id);
      if (x) Object.assign(x, { failure: kind, error, creditsCharged: charged });
    });
    throw new GenerationFailure(error);
  };

  progress(0.02, 'Auftrag an Higgsfield');
  if (signal.aborted) return fail('cancelled', null, 0); // the CLI was never started
  let hj: HiggsfieldJob;
  try {
    hj = await adapter.create(g.params, signal); // exactly once: no retry, whatever the error
  } catch (e) {
    const kind = signal.aborted ? 'cancelled' : e instanceof HiggsfieldError ? e.kind : 'failed';
    // refused before a job existed → nothing charged; otherwise unclear → counts as charged
    return fail(kind, (e as Error).message, kind === 'needs_login' || kind === 'needs_workspace' || kind === 'invalid' || kind === 'rate_limited' ? 0 : g.quotedCredits);
  }
  await write((db) => {
    const x = db.generations.find((y) => y.id === g.id);
    if (x) x.higgsfieldJobId = hj.id;
  });
  const deadline = Date.now() + adapter.timeoutMs;
  let limited = 0, errors = 0;
  while (hj.status === 'queued' || hj.status === 'in_progress') {
    if (Date.now() > deadline) return fail('timeout', null, g.quotedCredits);
    progress(hj.status === 'queued' ? 0.05 : 0.3, hj.status === 'queued' ? 'Wartet bei Higgsfield' : 'Higgsfield erzeugt den Clip');
    try {
      await sleep(limited ? adapter.backoffMs(limited) : adapter.pollMs, signal);
      hj = await adapter.get(hj.id, signal);
      limited = 0;
      errors = 0;
    } catch (e) {
      if (signal.aborted) return fail('cancelled', 'Der Job kann bei Higgsfield weiterlaufen und Credits verbrauchen.', g.quotedCredits);
      if (e instanceof HiggsfieldError && e.kind === 'rate_limited') limited++;
      else if (++errors >= 5) return fail(e instanceof HiggsfieldError ? e.kind : 'failed', (e as Error).message, g.quotedCredits);
    }
  }
  if (hj.status !== 'completed') return fail(classifyFailure(hj.error ?? '', hj.status), hj.error, g.quotedCredits);

  progress(0.8, 'Clip herunterladen');
  const tmp = path.join(workDir, 'generated.mp4');
  try {
    await adapter.fetchResult(hj, tmp, signal);
  } catch (e) {
    return fail(signal.aborted ? 'cancelled' : 'failed', `Download: ${(e as Error).message}`, g.quotedCredits);
  }
  const probe = await probeMedia(tmp);
  if (!probe || (probe.videoCodec == null && probe.width == null)) return fail('failed', 'Das Ergebnis ist kein lesbares Video.', g.quotedCredits);
  const [{ size }, sha256] = await Promise.all([stat(tmp), sha256File(tmp)]);
  signal.throwIfAborted();
  const assetId = newId();
  const storagePath = `footage/${g.projectId}/${assetId}.mp4`;
  await mkdir(path.dirname(absolutePath(storagePath)), { recursive: true });
  await rename(tmp, absolutePath(storagePath));
  // cancelled during the move: the job ends as cancelled without an asset, so no file may stay behind
  if (signal.aborted) {
    await rm(absolutePath(storagePath), { force: true });
    signal.throwIfAborted();
  }
  return { assetId, storagePath, size, sha256, probe, higgsfieldJobId: hj.id };
}, (db, job) => {
  const g = db.generations.find((x) => x.jobId === job.id);
  const r = job.result as { assetId: string; storagePath: string; size: number; sha256: string; probe: MediaAsset['probe']; higgsfieldJobId: string } | null;
  if (!g) {
    if (r) void deleteMediaFiles([r.storagePath]);
    return;
  }
  if (job.status === 'succeeded' && r) {
    if (!db.projects.some((p) => p.id === g.projectId)) {
      void deleteMediaFiles([r.storagePath]);
      Object.assign(g, { status: 'failed', creditsCharged: g.quotedCredits, error: 'Projekt wurde während der Generierung gelöscht.' });
      return;
    }
    const m = HIGGSFIELD_MODELS[g.params.model];
    db.mediaAssets.push({
      id: r.assetId, projectId: g.projectId, name: `KI-B-Roll Szene ${g.sceneIndex + 1} (${m.label}${g.mock ? ', MOCK' : ''}).mp4`,
      mime: 'video/mp4', size: r.size, sha256: r.sha256, storagePath: r.storagePath,
      origin: 'generated', rightsNote: `Generiert mit Higgsfield ${m.label}${g.mock ? ' (Mock, keine echten Credits)' : ''}`, rightsConfirmedAt: now(),
      probe: r.probe, status: 'probed', createdAt: now(),
      generation: { generationId: g.id, briefId: g.briefId, model: g.params.model, prompt: g.params.prompt, higgsfieldJobId: r.higgsfieldJobId, credits: g.quotedCredits, mock: g.mock, review: 'pending' },
    });
    Object.assign(g, { status: 'review', assetId: r.assetId, creditsCharged: g.quotedCredits, higgsfieldJobId: r.higgsfieldJobId });
  } else if (job.status === 'failed' || job.status === 'cancelled') {
    Object.assign(g, {
      status: job.status, error: g.error ?? job.error,
      creditsCharged: g.creditsCharged ?? (g.submittedAt ? g.quotedCredits : 0),
    });
  }
});

const Review = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(1000).default(''),
});

/** Human gate on the generated clip, before it can enter an EDL. Rejected clips are deleted (the credits stay spent). */
export async function reviewGeneration(id: string, raw: unknown) {
  const { decision, note } = Review.parse(raw);
  const out = await write((db) => {
    const g = must(db.generations.find((x) => x.id === id), 'Generierung');
    if (g.status !== 'review') throw new HttpError(409, 'Nur fertige Clips, die auf Prüfung warten, können freigegeben oder abgelehnt werden.');
    if (decision === 'reject' && note.length < 3) throw new HttpError(400, 'Bitte kurz begründen, was nicht passt.');
    const asset = db.mediaAssets.find((a) => a.id === g.assetId);
    if (!asset?.generation) throw new HttpError(409, 'Der generierte Clip wurde inzwischen gelöscht.');
    Object.assign(g, { status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: note, reviewedAt: now() });
    if (decision === 'approve') {
      asset.generation.review = 'approved';
      return { generation: g, file: null };
    }
    db.mediaAssets = db.mediaAssets.filter((a) => a.id !== asset.id);
    return { generation: g, file: asset.storagePath };
  });
  if (out.file) await deleteMediaFiles([out.file]);
  return out.generation;
}

/** Everything the B-roll panel needs: availability, budgets, approved briefs and the generations. */
export async function getAiBrollState(projectId: string) {
  const status = await higgsfieldStatus();
  return read((db) => {
    const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
    const briefs = db.scriptOutputs.filter((o) => o.projectId === projectId && o.kind === 'storyboard' && o.status === 'approved').flatMap((o) => {
      if (o.kind !== 'storyboard') return [];
      const script = db.scripts.find((s) => s.id === o.scriptId);
      return o.output.aiAssetBriefs.map((b, briefIndex) => {
        const blocked = briefBlockReason(project, o, script, b.sceneIndex);
        return { storyboardId: o.id, scriptId: o.scriptId, scriptVersion: script?.version ?? null, briefIndex, briefId: briefIdOf(o.id, briefIndex), sceneIndex: b.sceneIndex, purpose: b.purpose, prompt: b.prompt, blocked };
      });
    });
    return {
      status,
      optIn: project.aiBroll ?? null,
      budget: budget(db, projectId),
      models: Object.entries(HIGGSFIELD_MODELS).map(([id, m]) => ({ id, label: m.label, durations: [...m.durations], resolutions: [...m.resolutions] })),
      briefs,
      generations: db.generations.filter((g) => g.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((g) => ({
        ...g, job: db.mediaJobs.find((j) => j.id === g.jobId) ?? null,
        asset: db.mediaAssets.find((a) => a.id === g.assetId) ?? null,
      })),
    };
  });
}

/** Project deletion: the records stay for the monthly credit accounting, without the prompt. */
export function scrubProjectGenerations(db: Db, projectId: string) {
  for (const g of db.generations.filter((x) => x.projectId === projectId)) {
    // the job rows go with the project, so no finalizer will close a live generation: close it here
    const live = isLive(g);
    Object.assign(g, {
      params: { ...g.params, prompt: '[Projekt gelöscht]' }, assetId: null,
      ...(live ? { status: 'cancelled', error: g.error ?? 'Projekt gelöscht', creditsCharged: g.creditsCharged ?? (g.submittedAt ? g.quotedCredits : 0) } : {}),
    });
  }
}
