import { NextResponse } from 'next/server';
import { jsonBody, route } from '@/server/http';
import { approveGeneration } from '@/server/services/generations';

/** Human gate: approves at most `approvedMaxCredits` for this one clip and starts it (202 + polling). */
export const POST = route<{ id: string }>(async (req, { id }) => NextResponse.json(await approveGeneration(id, await jsonBody(req)), { status: 202 }));
