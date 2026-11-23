import 'server-only';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './env';
import { HttpError } from './errors';
import { must, newId, now, read, write, type Db, type MediaJob, type MediaJobKind } from './store';

/**
 * Video worker (Release 3, Etappe 3): a queue for long media jobs, run outside the request.
 *
 * It runs inside the app's server process, because the local JSON store is single-process
 * (serialized writes in memory). The heavy work runs in child processes (FFmpeg, later whisper.cpp),
 * so requests stay responsive. A separate worker process follows with the Supabase store.
 *
 * Each running job gets its own work directory under `.data/jobs/<id>`; it is removed when the job
 * ends, whatever the outcome. Handlers move finished files to their final place before they return.
 */

export interface JobContext {
  job: MediaJob;
  signal: AbortSignal;
  workDir: string;
  /** Throttled progress update (0..1 or null when unknown). */
  progress: (fraction: number | null, note?: string) => void;
}
export type JobHandler = (ctx: JobContext) => Promise<unknown>;
/** Runs inside the write that stores the job's final status, so dependent records change atomically with it. */
export type JobFinalizer = (db: Db, job: MediaJob) => void;

/** Queued jobs per app; beyond that, new jobs are rejected (429). */
export const MAX_QUEUED_JOBS = 20;
/** Finished jobs kept in the store (newest first). */
const KEEP_FINISHED = 200;
const PROGRESS_INTERVAL_MS = 1000;

const handlers = new Map<MediaJobKind, JobHandler>();
const finalizers = new Map<MediaJobKind, JobFinalizer>();
const running = new Map<string, AbortController>();
let recovered: Promise<void> | null = null;
let pumping = false;
let pumpAgain = false;

export const jobsDir = () => path.join(dataDir(), 'jobs');
export const isFinished = (j: Pick<MediaJob, 'status'>) => j.status === 'succeeded' || j.status === 'failed' || j.status === 'cancelled';

export function workerConcurrency(): number {
  const n = Math.floor(Number(process.env.VIDEO_WORKER_CONCURRENCY));
  return Number.isFinite(n) ? Math.min(2, Math.max(1, n)) : 1;
}

export function registerJobHandler(kind: MediaJobKind, handler: JobHandler, finalize?: JobFinalizer) {
  handlers.set(kind, handler);
  if (finalize) finalizers.set(kind, finalize);
  else finalizers.delete(kind);
}

/**
 * Removes work directories left by an earlier process (its running jobs were marked failed
 * when the store loaded). Runs once per process, before the first job starts.
 */
function recover(): Promise<void> {
  return (recovered ??= (async () => {
    const dirs = await readdir(jobsDir()).catch(() => [] as string[]);
    await Promise.all(dirs.filter((d) => !running.has(d)).map((d) =>
      rm(path.join(jobsDir(), d), { recursive: true, force: true }).catch((e) => console.error('Video-Worker: Arbeitsordner konnte nicht entfernt werden', d, e))));
  })());
}

/** Starts as many queued jobs as the concurrency allows. Safe to call any time. */
export async function pump(): Promise<void> {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    // Never rejects: callers fire and forget (`void pump()`).
    await recover();
    do {
      pumpAgain = false;
      while (running.size < workerConcurrency()) {
        const job = await write((db) => {
          const next = db.mediaJobs.filter((j) => j.status === 'queued' && handlers.has(j.kind)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
          if (!next) return null;
          Object.assign(next, { status: 'running', progress: 0, progressNote: '', startedAt: now(), updatedAt: now() });
          return { ...next };
        });
        if (!job) break;
        const controller = new AbortController();
        running.set(job.id, controller);
        void execute(job, controller);
      }
    } while (pumpAgain);
  } catch (e) {
    console.error('Video-Worker: Warteschlange konnte nicht gelesen werden', e);
  } finally {
    pumping = false;
  }
}

async function execute(job: MediaJob, controller: AbortController) {
  const workDir = path.join(jobsDir(), job.id);
  let lastWrite = 0;
  let progressWrite: Promise<unknown> = Promise.resolve();
  const progress = (fraction: number | null, note?: string) => {
    if (Date.now() - lastWrite < PROGRESS_INTERVAL_MS) return;
    lastWrite = Date.now();
    const p = { fraction: fraction == null ? null : Math.max(0, Math.min(1, fraction)), note };
    progressWrite = write((db) => {
      const j = db.mediaJobs.find((x) => x.id === job.id);
      if (j?.status !== 'running') return;
      j.progress = p.fraction;
      if (p.note !== undefined) j.progressNote = p.note.slice(0, 200);
      j.updatedAt = now();
    }).catch(() => undefined);
  };

  let outcome: Pick<MediaJob, 'status' | 'result' | 'error'> & { progress?: number };
  try {
    await mkdir(workDir, { recursive: true });
    const handler = handlers.get(job.kind);
    if (!handler) throw new Error(`Kein Handler für Job-Art ${job.kind}`);
    controller.signal.throwIfAborted(); // cancelled between claim and start
    const result = await handler({ job, signal: controller.signal, workDir, progress });
    controller.signal.throwIfAborted();
    outcome = { status: 'succeeded', result: result ?? null, error: null, progress: 1 };
  } catch (e) {
    outcome = controller.signal.aborted
      ? { status: 'cancelled', result: null, error: 'Abgebrochen' }
      : { status: 'failed', result: null, error: e instanceof Error ? e.message.slice(0, 1000) : 'Unbekannter Fehler' };
  }
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  await progressWrite;
  // A lost final write would leave the job `running` until restart: retry, then give up loudly
  // (cancelJob can still close such a row, see there).
  for (let i = 0; i < 3; i++) {
    try {
      await write((db) => {
        const j = db.mediaJobs.find((x) => x.id === job.id);
        if (!j) return;
        Object.assign(j, outcome, { finishedAt: now(), updatedAt: now() });
        finalizers.get(j.kind)?.(db, j);
      });
      break;
    } catch (e) {
      if (i === 2) console.error('Video-Worker: Status konnte nicht gespeichert werden', e);
      else await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  running.delete(job.id);
  void pump();
}

export interface EnqueueOptions {
  projectId?: string | null; idempotencyKey?: string | null;
  /** Runs in the same write that queues the job (checks may throw; dependent records are created atomically). Not called on replay. */
  onQueued?: (db: Db, job: MediaJob) => void;
}

/**
 * Queues a job and returns at once (the route answers 202). With an idempotency key, a repeated
 * request returns the existing job instead of starting a second one; failed or cancelled jobs are re-queued.
 */
export async function enqueueJob(kind: MediaJobKind, input: unknown, opts: EnqueueOptions = {}): Promise<{ job: MediaJob; replayed: boolean }> {
  if (!handlers.has(kind)) throw new HttpError(501, `Job-Art ${kind} ist nicht verfügbar`);
  const key = opts.idempotencyKey ?? null;
  const out = await write((db) => {
    if (opts.projectId) must(db.projects.find((p) => p.id === opts.projectId), 'Projekt');
    const existing = key ? db.mediaJobs.find((j) => j.idempotencyKey === key) : undefined;
    if (existing) {
      if (existing.kind !== kind || existing.projectId !== (opts.projectId ?? null)) throw new HttpError(409, 'idempotencyKey wird bereits für einen anderen Job verwendet');
      if (existing.status !== 'failed' && existing.status !== 'cancelled') return { job: { ...existing }, replayed: true };
    }
    if (db.mediaJobs.filter((j) => j.status === 'queued').length >= MAX_QUEUED_JOBS)
      throw new HttpError(429, `Die Warteschlange ist voll (${MAX_QUEUED_JOBS} Jobs). Bitte warten oder Jobs abbrechen.`);
    const fresh = {
      status: 'queued' as const, progress: null, progressNote: '', input, result: null, error: null, cancelRequested: false,
      startedAt: null, finishedAt: null, updatedAt: now(),
    };
    const job: MediaJob = existing
      ? { ...existing, ...fresh, attempts: existing.attempts + 1 }
      : { id: newId(), kind, projectId: opts.projectId ?? null, idempotencyKey: key, attempts: 1, createdAt: now(), ...fresh };
    // Keep the newest finished jobs; queued and running ones are never pruned.
    const finished = db.mediaJobs.filter((j) => isFinished(j) && j.id !== job.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const drop = new Set(finished.slice(KEEP_FINISHED - 1).map((j) => j.id));
    db.mediaJobs = db.mediaJobs.filter((j) => j.id !== job.id && !drop.has(j.id)).concat(job);
    opts.onQueued?.(db, job);
    return { job: { ...job }, replayed: false };
  });
  void pump();
  return out;
}

/** Cancels a queued job at once; a running job is aborted (its child process is killed) and ends as `cancelled`. */
export async function cancelJob(id: string): Promise<MediaJob> {
  const job = await write((db) => {
    const j = must(db.mediaJobs.find((x) => x.id === id), 'Job');
    if (isFinished(j)) throw new HttpError(409, 'Der Job ist bereits beendet.');
    // Queued, or `running` without a live run in this process (its final status write was lost): close at once.
    j.cancelRequested = true;
    j.updatedAt = now();
    if (j.status === 'queued' || !running.has(id)) {
      Object.assign(j, { status: 'cancelled', error: 'Abgebrochen', finishedAt: now() });
      finalizers.get(j.kind)?.(db, j);
    }
    return { ...j };
  });
  running.get(id)?.abort();
  return job;
}

/** Aborts and forgets all jobs of a project (used when the project is deleted). */
export async function cancelProjectJobs(projectId: string) {
  const ids = await read((db) => db.mediaJobs.filter((j) => j.projectId === projectId && !isFinished(j)).map((j) => j.id));
  for (const id of ids) running.get(id)?.abort();
}

export function getJob(id: string) {
  void pump(); // also resumes queued jobs after a restart
  return read((db) => ({ ...must(db.mediaJobs.find((j) => j.id === id), 'Job') }));
}

export function listJobs(projectId?: string | null) {
  void pump();
  return read((db) => ({
    jobs: db.mediaJobs
      .filter((j) => projectId === undefined || j.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50),
    worker: { concurrency: workerConcurrency(), running: running.size, queued: db.mediaJobs.filter((j) => j.status === 'queued').length, maxQueued: MAX_QUEUED_JOBS },
  }));
}
