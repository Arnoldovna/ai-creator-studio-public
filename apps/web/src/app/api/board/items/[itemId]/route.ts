import { jsonBody, route } from '@/server/http';
import { deleteItem, updateItem } from '@/server/services/board';

type P = { itemId: string };
/** Etappe 20: move (date, index), status, title, note, pillar, „gepostet“ (`posted: { at?, permalink? }` – only her click). */
export const PATCH = route<P>(async (req, { itemId }) => updateItem(itemId, await jsonBody(req)));
/** Takes the entry off the board (the material stays). */
export const DELETE = route<P>(async (_req, { itemId }) => deleteItem(itemId));
