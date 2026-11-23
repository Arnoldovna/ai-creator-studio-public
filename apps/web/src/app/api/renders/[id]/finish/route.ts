import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { getFinishState, startFinish } from '@/server/services/finish';
// the finish job handler must be registered before the worker picks it up
import '@/server/services/videoJobs';

type P = { id: string };
/** Etappe 17: state of the CapCut package of a render (options, files, running job, QA „fehlende Wörter“). */
export const GET = route<P>((_req, { id }) => getFinishState(id));
/** `{ images?, alpha? }` → 200 `{ status: 'ready' }` when every file exists, else 202 `{ status: 'queued', job }`. */
export const POST = route<P>(async (req, { id }) => {
  const out = await startFinish(id, await jsonBody(req));
  return NextResponse.json(out, { status: out.status === 'ready' ? 200 : 202 });
});
