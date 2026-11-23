import { z } from 'zod';
import { jobRoute, jsonBody } from '@/server/http';
import { startRender } from '@/server/services/edit';
import { JobEnvelope } from '@/server/services/jobs';

/**
 * n8n WF-06: { idempotencyKey, payload: { editPlanId } } → queues the render of an APPROVED EDL
 * (409 otherwise – n8n never approves anything). Returns at once; poll GET /api/jobs/video/<jobId>.
 * The finished render waits for the user's review in the Video Studio.
 */
export const POST = jobRoute(async (req) => {
  const env = JobEnvelope.parse(await jsonBody(req));
  const { editPlanId } = z.object({ editPlanId: z.string().min(1).max(100) }).parse(env.payload);
  const { job, render, replayed } = await startRender(editPlanId, { idempotencyKey: env.idempotencyKey });
  return { jobId: job.id, status: job.status, replayed, renderId: render?.id ?? null, reviewRequired: true };
});
