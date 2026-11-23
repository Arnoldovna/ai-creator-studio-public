import { jsonBody, route } from '@/server/http';
import { createThread, listThreads } from '@/server/services/chat';

/** Studio-Chat (Etappe 15): the threads of one page (`?scope=brand|strategy|general|editor:<projectId>`) and the model chip. */
export const GET = route(async (req) => listThreads(req.nextUrl.searchParams.get('scope')));
/** `{ scope }`: a new, empty history for that page. */
export const POST = route(async (req) => createThread(await jsonBody(req)));
