import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { renderEditDraft } from '@/server/services/editDraft';
import '@/server/services/videoJobs';

/** Snapshot of the draft as an EditPlan version, then the render (personal projects). `{ scriptId, revision, mode?: 'render' | 'save' }`. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const out = await renderEditDraft(id, await jsonBody(req));
  return NextResponse.json(out, { status: out.job && !out.replayed ? 202 : 200 });
});
