import { NextResponse } from 'next/server';
import { route } from '@/server/http';
import { startSilenceScan } from '@/server/services/cuts';

/** Queues the silence scan of one clip (for clips transcribed before Etappe 8): 202 + job, status via polling. */
export const POST = route<{ id: string }>(async (_req, { id }) => NextResponse.json(await startSilenceScan(id), { status: 202 }));
