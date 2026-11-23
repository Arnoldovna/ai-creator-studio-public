import { NextResponse } from 'next/server';
import { route } from '@/server/http';
import { startPrepare } from '@/server/services/prepare';
// registers every job handler (the preparation queues the transcription and the pause scan)
import '@/server/services/videoJobs';

/** Starts (or resumes) the preparation of a clip: proxy, thumbnails, waveform, then transcription and pauses. 202 + job. */
export const POST = route<{ id: string }>(async (_req, { id }) => {
  const out = await startPrepare(id);
  return NextResponse.json(out, { status: out.ready || out.replayed ? 200 : 202 });
});
