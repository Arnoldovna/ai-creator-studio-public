import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { getEditDraft, putEditDraft } from '@/server/services/editDraft';
// the render and the preparation are queued from here: every job handler must be registered
import '@/server/services/videoJobs';

type P = { id: string };
/** The working draft of `?scriptId=` (empty = Freier Schnitt) with its problems, the look and the project's media. ETag = revision. */
export const GET = route<P>(async (req, { id }) => {
  const v = await getEditDraft(id, req.nextUrl.searchParams.get('scriptId'));
  return NextResponse.json(v, { headers: { ETag: v.etag } });
});
/** Autosave `{ scriptId, revision, body, clientConsentNote?, basePlanId? }` (`If-Match: "r<n>"` optional). 409 on a conflict. */
export const PUT = route<P>(async (req, { id }) => {
  const v = await putEditDraft(id, await jsonBody(req), req.headers.get('if-match'));
  return NextResponse.json(v, { headers: { ETag: v.etag } });
});
