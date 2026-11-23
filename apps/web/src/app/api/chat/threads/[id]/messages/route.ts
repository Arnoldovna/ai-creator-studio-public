import { jsonBody, route } from '@/server/http';
import { getThread, sendMessage } from '@/server/services/chat';

type P = { id: string };
/** The thread with its messages and proposals (`stale` = its base is no longer current). */
export const GET = route<P>(async (_req, { id }) => getThread(id));
/** `{ text, imageIds?, scriptId? }`: one agent run (budget, routing, log); 402 on the budget stop, nothing is applied. */
export const POST = route<P>(async (req, { id }) => sendMessage(id, await jsonBody(req)));
