import { NextResponse } from 'next/server';
import { route } from '@/server/http';
import { startRenderQa } from '@/server/services/finish';
import '@/server/services/videoJobs';

/** Etappe 17: QA „fehlende Wörter“ – transcribes the render again (whisper.cpp) and compares; 202 + job. 409 without whisper. */
export const POST = route<{ id: string }>(async (_req, { id }) => NextResponse.json(await startRenderQa(id), { status: 202 }));
