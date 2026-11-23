import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { previewFile, startEditPreview } from '@/server/services/editPreview';
import { streamFile } from '@/server/streamFile';
// the preview job handler must be registered before the worker picks it up
import '@/server/services/videoJobs';

type P = { id: string };
/**
 * Etappe 13: exact low-res preview (540×960) of the draft `{ scriptId }` through the render's FFmpeg+ASS path.
 * 200 `{ status: 'ready', key }` when cached, else 202 `{ status: 'queued', key, job }` (poll /api/video-jobs/:id).
 */
export const POST = route<P>(async (req, { id }) => {
  const out = await startEditPreview(id, await jsonBody(req));
  return NextResponse.json(out, { status: out.status === 'ready' ? 200 : 202 });
});
/** `?key=` → the finished preview (MP4, Range support). */
export const GET = route<P>(async (req, { id }) => {
  const file = await previewFile(id, req.nextUrl.searchParams.get('key') ?? '');
  return streamFile(req.headers.get('range'), file, 'video/mp4');
});
