import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { startSelftest } from '@/server/services/videoJobs';

/** Queues the worker self-test; answers 202 with the job, the status comes via polling. */
export const POST = route(async (req) => {
  const out = await startSelftest(await jsonBody(req));
  return NextResponse.json(out, { status: out.replayed ? 200 : 202 });
});
