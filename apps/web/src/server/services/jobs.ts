import 'server-only';
import { z } from 'zod';
import { HttpError } from '../http';
import { newId, now, write, type WorkflowJob } from '../store';

export const JobEnvelope = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  payload: z.unknown(),
});

/**
 * Idempotent job execution for n8n: the same idempotencyKey returns the stored result
 * instead of re-running (and re-billing) an agent. Failed jobs may be retried.
 *
 * The payload is stored only for a job that succeeded (so it passed the privacy guard): while it runs, nothing of
 * it is on disk, and a failed job never stores it, whatever stopped it. Some failures happen before the guard
 * (strategy gate, budget, confidential routing, phase), and their payload may still hold local-only text.
 * The failed record keeps only the error and the idempotencyKey; n8n retries with its own payload.
 */
export async function runJob(workflow: string, idempotencyKey: string, payload: unknown, fn: () => Promise<unknown>) {
  // Check and claim in ONE serialized write, so two concurrent requests cannot both start the agent.
  const claim = await write((db): { replay: WorkflowJob } | { job: WorkflowJob } => {
    const existing = db.workflowJobs.find((j) => j.idempotencyKey === idempotencyKey) ?? null;
    if (existing) {
      if (existing.workflow !== workflow) throw new HttpError(409, 'idempotencyKey wird bereits von einem anderen Workflow verwendet');
      if (existing.status === 'succeeded') return { replay: existing };
      // `running` jobs from a crashed process are marked failed when the store loads.
      if (existing.status === 'running') throw new HttpError(409, 'Job läuft bereits');
    }
    const job: WorkflowJob = existing
      ? { ...existing, status: 'running', attempts: existing.attempts + 1, payload: null, updatedAt: now(), error: null }
      : { id: newId(), workflow, idempotencyKey, status: 'running', attempts: 1, payload: null, result: null, error: null, createdAt: now(), updatedAt: now() };
    db.workflowJobs = db.workflowJobs.filter((j) => j.id !== job.id).concat(job);
    return { job };
  });
  if ('replay' in claim) return { job: claim.replay, replayed: true };
  const { job } = claim;
  try {
    const result = await fn();
    const done = { ...job, status: 'succeeded' as const, payload, result, updatedAt: now() };
    await write((db) => {
      db.workflowJobs = db.workflowJobs.map((j) => (j.id === job.id ? done : j));
    });
    return { job: done, replayed: false };
  } catch (e) {
    await write((db) => {
      db.workflowJobs = db.workflowJobs.map((j) => (j.id === job.id ? { ...job, status: 'failed' as const, payload: null, error: (e as Error).message, updatedAt: now() } : j));
    });
    throw e;
  }
}
