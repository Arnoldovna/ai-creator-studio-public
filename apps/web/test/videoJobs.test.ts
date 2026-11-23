import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MediaJob, MediaJobKind } from '@/server/store';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-jobs-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) => access(p).then(() => true, () => false);
const FAKE = 'fake_long' as MediaJobKind;

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Stands in for a 10-minute render: writes a partial file, reports progress and then only ends
 * when it is aborted (or released by the test).
 */
async function registerFakeLongJob() {
  const worker = await import('@/server/worker');
  const release = new Map<string, () => void>();
  worker.registerJobHandler(FAKE, async ({ job, signal, workDir, progress }) => {
    await writeFile(path.join(workDir, 'partial.mp4'), 'x'.repeat(1024));
    progress(0.25, '2:30 von 10:00');
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      release.set(job.id, resolve);
      signal.addEventListener('abort', () => {
        release.delete(job.id);
        reject(signal.reason);
      }, { once: true });
    });
    return { ok: true };
  });
  return { worker, release };
}

describe('Video worker (Release 3, Etappe 3)', () => {
  it('runs the FFmpeg self-test in the background with progress and keeps no file', async () => {
    const jobs = await import('@/server/services/videoJobs');
    const { job } = await jobs.startSelftest({ seconds: 2 });
    expect(job.status).toBe('queued');
    const done = await until(() => jobs.getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running', 60000);
    expect(done).toMatchObject({ status: 'succeeded', progress: 1, error: null, result: { seconds: 2, kept: false } });
    expect((done.result as { bytes: number }).bytes).toBeGreaterThan(1000);
    expect(await exists(path.join(dir, 'jobs', job.id))).toBe(false);
  });

  it('cancels a long running job: the child work stops, the status is cancelled and no partial file is left', async () => {
    const { worker } = await registerFakeLongJob();
    const { job } = await worker.enqueueJob(FAKE, {});
    const running = await until(() => worker.getJob(job.id), (j) => j.status === 'running');
    expect(running.startedAt).not.toBeNull();
    const workDir = path.join(dir, 'jobs', job.id);
    await until(() => exists(path.join(workDir, 'partial.mp4')), Boolean);
    // polling sees the progress
    const polled = await until(() => worker.getJob(job.id), (j) => j.progress === 0.25);
    expect(polled.progressNote).toBe('2:30 von 10:00');

    await worker.cancelJob(job.id);
    const ended = await until(() => worker.getJob(job.id), (j) => j.status !== 'running');
    expect(ended).toMatchObject({ status: 'cancelled', cancelRequested: true, error: 'Abgebrochen' });
    expect(await exists(workDir)).toBe(false);
    await expect(worker.cancelJob(job.id)).rejects.toMatchObject({ status: 409 });
  });

  it('is idempotent per key, re-queues cancelled jobs and refuses key reuse for other work', async () => {
    const { worker, release } = await registerFakeLongJob();
    const a = await worker.enqueueJob(FAKE, {}, { idempotencyKey: 'render-key-1' });
    const b = await worker.enqueueJob(FAKE, {}, { idempotencyKey: 'render-key-1' });
    expect(b).toMatchObject({ replayed: true, job: { id: a.job.id } });
    await expect(worker.enqueueJob('selftest', { seconds: 1 }, { idempotencyKey: 'render-key-1' })).rejects.toMatchObject({ status: 409 });

    await until(() => worker.getJob(a.job.id), (j) => j.status === 'running');
    await worker.cancelJob(a.job.id);
    await until(() => worker.getJob(a.job.id), (j) => j.status === 'cancelled');
    const again = await worker.enqueueJob(FAKE, {}, { idempotencyKey: 'render-key-1' });
    expect(again).toMatchObject({ replayed: false, job: { id: a.job.id, attempts: 2 } });
    await until(async () => release.has(a.job.id), Boolean);
    release.get(a.job.id)!();
    const done = await until(() => worker.getJob(a.job.id), (j) => j.status === 'succeeded');
    expect(done.result).toEqual({ ok: true });
    // a succeeded job is replayed, not run again
    expect(await worker.enqueueJob(FAKE, {}, { idempotencyKey: 'render-key-1' })).toMatchObject({ replayed: true, job: { status: 'succeeded' } });
  });

  it('runs one job at a time and limits the queue', async () => {
    const { worker } = await registerFakeLongJob();
    const first = await worker.enqueueJob(FAKE, {});
    await until(() => worker.getJob(first.job.id), (j) => j.status === 'running');
    const queued: string[] = [];
    for (let i = 0; i < worker.MAX_QUEUED_JOBS; i++) queued.push((await worker.enqueueJob(FAKE, {})).job.id);
    await expect(worker.enqueueJob(FAKE, {})).rejects.toMatchObject({ status: 429 });
    const { worker: w } = await worker.listJobs();
    expect(w).toMatchObject({ running: 1, queued: worker.MAX_QUEUED_JOBS, concurrency: 1 });

    // cancelling queued jobs is immediate and never starts them
    for (const id of queued) expect((await worker.cancelJob(id)).status).toBe('cancelled');
    await worker.cancelJob(first.job.id);
    await until(() => worker.getJob(first.job.id), (j) => j.status === 'cancelled');
    const { jobs } = await worker.listJobs();
    expect(jobs.filter((j) => queued.includes(j.id)).every((j) => j.startedAt === null)).toBe(true);
  });

  it('deleting a project aborts its running job and removes its jobs', async () => {
    const { worker } = await registerFakeLongJob();
    const projects = await import('@/server/services/projects');
    const p = await projects.createProject({ title: 'Reel', kind: 'PERSONAL_CONTENT' });
    const { job } = await worker.enqueueJob(FAKE, {}, { projectId: p.id });
    await until(() => worker.getJob(job.id), (j) => j.status === 'running');
    await projects.deleteProject(p.id);
    await expect(worker.getJob(job.id)).rejects.toMatchObject({ status: 404 });
    await until(() => exists(path.join(dir, 'jobs', job.id)), (x) => !x);
    await expect(worker.enqueueJob(FAKE, {}, { projectId: p.id })).rejects.toMatchObject({ status: 404 });
  });

  it('recovers after a crash: running jobs fail, their half files are removed, queued jobs resume', async () => {
    // Simulate a crashed process: its db.json still says `running`, its work directory is still there.
    const dbFile = path.join(dir, 'db.json');
    const db = JSON.parse(await readFile(dbFile, 'utf8')) as { mediaJobs: MediaJob[]; budgetReservations: unknown[] };
    const base = { kind: FAKE, projectId: null, idempotencyKey: null, attempts: 1, progressNote: '', input: {}, result: null, error: null, cancelRequested: false, finishedAt: null, updatedAt: '2026-11-15T09:00:00.000Z' };
    db.mediaJobs.push(
      { ...base, id: 'crashed-job', status: 'running', progress: 0.4, createdAt: '2026-11-15T09:00:00.000Z', startedAt: '2026-11-15T09:00:01.000Z' },
      { ...base, id: 'waiting-job', status: 'queued', progress: null, createdAt: '2026-11-15T09:00:02.000Z', startedAt: null },
    );
    db.budgetReservations.push({ id: 'res-1', amountUsd: 0.5, purpose: 'x · m', processId: 'old-process', createdAt: '2026-11-15T09:00:00.000Z' });
    await writeFile(dbFile, JSON.stringify(db));
    await mkdir(path.join(dir, 'jobs', 'crashed-job'), { recursive: true });
    await writeFile(path.join(dir, 'jobs', 'crashed-job', 'half.mp4'), 'x');

    (await import('@/server/store')).forgetCacheForTests(); // the store cache is process-wide (globalThis)
    vi.resetModules(); // a fresh process: new store cache, new worker state, new PROCESS_ID
    const { worker, release } = await registerFakeLongJob();
    const crashed = await worker.getJob('crashed-job');
    expect(crashed).toMatchObject({ status: 'failed', error: expect.stringMatching(/neu gestartet/) });
    expect(crashed.finishedAt).not.toBeNull();
    await until(() => exists(path.join(dir, 'jobs', 'crashed-job')), (x) => !x);
    await until(async () => release.has('waiting-job'), Boolean);
    release.get('waiting-job')!();
    await until(() => worker.getJob('waiting-job'), (j) => j.status === 'succeeded');

    // A paid call that was in flight during the crash keeps its worst case reserved until the user releases it.
    const agentRuns = await import('@/server/services/agentRuns');
    const { getStatus } = await import('@/server/services/status');
    const s = await getStatus();
    expect(s.counts.reservedUsd).toBe(0.5);
    expect(s.counts.orphanedReservations).toHaveLength(1);
    await expect(agentRuns.releaseOrphanedReservation('res-1', { chargedUsd: -1 })).rejects.toThrow();
    const spentBefore = s.counts.monthSpendUsd;
    expect(await agentRuns.releaseOrphanedReservation('res-1', { chargedUsd: 0.2 })).toEqual({ released: 'res-1', reservedUsd: 0.5, chargedUsd: 0.2 });
    await expect(agentRuns.releaseOrphanedReservation('res-1', { chargedUsd: 0 })).rejects.toMatchObject({ status: 404 });
    const after = await getStatus();
    expect(after.counts.reservedUsd).toBe(0);
    // what the bill showed is booked as spend, so the hard limit stays correct
    expect(after.counts.monthSpendUsd).toBeCloseTo(spentBefore + 0.2);
    expect(after.counts.orphanedReservations).toHaveLength(0);
  });
});
