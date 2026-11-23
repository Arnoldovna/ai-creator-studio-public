import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { startDraftFinish } from '@/server/services/finish';
import '@/server/services/videoJobs';

/**
 * Etappe 17, editor „Für CapCut exportieren“ (personal projects): `{ scriptId, revision, images?, alpha? }` renders this
 * revision if needed (same snapshot and idempotent render as „Rendern“) and queues the package files behind it.
 */
export const POST = route<{ id: string }>(async (req, { id }) => NextResponse.json(await startDraftFinish(id, await jsonBody(req)), { status: 202 }));
