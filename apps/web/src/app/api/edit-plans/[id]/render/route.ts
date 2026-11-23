import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { startRender } from '@/server/services/edit';

/** Queues the render of an approved EDL: 202 + job, the status comes via polling. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const body = req.headers.get('content-length') === '0' ? {} : await jsonBody(req);
  const out = await startRender(id, body);
  return NextResponse.json(out, { status: out.replayed ? 200 : 202 });
});
