import { jsonBody, route } from '@/server/http';
import { addItemMetrics } from '@/server/services/board';

/** Etappe 20: her figures of a posted entry, typed in by hand (→ Rückblick). No Instagram API. */
export const POST = route<{ itemId: string }>(async (req, { itemId }) => addItemMetrics(itemId, await jsonBody(req)));
