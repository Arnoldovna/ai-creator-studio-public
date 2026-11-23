import { NextResponse } from 'next/server';
import { route } from '@/server/http';
import { startTranscription } from '@/server/services/transcripts';

/** Queues the local transcription (whisper.cpp) of one clip: 202 + job, status via polling. */
export const POST = route<{ id: string }>(async (_req, { id }) => NextResponse.json(await startTranscription(id), { status: 202 }));
