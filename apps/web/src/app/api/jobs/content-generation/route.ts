import { z } from 'zod';
import { jobRoute, jsonBody } from '@/server/http';
import { generateConcepts } from '@/server/services/content';
import { JobEnvelope, runJob } from '@/server/services/jobs';

export const maxDuration = 300;
/** n8n WF-03: { idempotencyKey, payload: { brief } } → three concepts (draft, user must choose). */
export const POST = jobRoute(async (req) => {
  const env = JobEnvelope.parse(await jsonBody(req));
  const { brief } = z.object({ brief: z.unknown() }).parse(env.payload);
  const { job, replayed } = await runJob('content-generation', env.idempotencyKey, env.payload, async () => {
    const r = await generateConcepts(brief);
    return { briefId: r.briefId, conceptIds: r.concepts.map((c) => c.id), mock: r.mock, reviewRequired: true };
  });
  return { jobId: job.id, status: job.status, replayed, result: job.result };
});
