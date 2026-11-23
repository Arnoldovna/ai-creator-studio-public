import { z } from 'zod';
import { jobRoute, jsonBody } from '@/server/http';
import { JobEnvelope, runJob } from '@/server/services/jobs';
import { analyzeReference } from '@/server/services/references';

export const maxDuration = 300;
/** n8n WF-01: { idempotencyKey, payload: { referenceId } } */
export const POST = jobRoute(async (req) => {
  const env = JobEnvelope.parse(await jsonBody(req));
  const { referenceId } = z.object({ referenceId: z.string().min(1) }).parse(env.payload);
  const { job, replayed } = await runJob('reference-analysis', env.idempotencyKey, env.payload, async () => {
    const r = await analyzeReference(referenceId);
    return { analysisId: r.analysis.id, observations: r.observations.length, mock: r.mock, reviewRequired: true };
  });
  return { jobId: job.id, status: job.status, replayed, result: job.result };
});
