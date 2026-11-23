import { jsonBody, route } from '@/server/http';
import { createItem } from '@/server/services/board';

/** Etappe 20: `{ date|null, ref?: { kind, id }, kind?, title?, note?, pillarId?, projectId? }` → a planned post on the board. */
export const POST = route(async (req) => createItem(await jsonBody(req)));
