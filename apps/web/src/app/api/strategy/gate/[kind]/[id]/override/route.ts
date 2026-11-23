import { jsonBody, route } from '@/server/http';
import { addOverride } from '@/server/services/strategyGate';

type P = { kind: string; id: string };
/** `{ type: 'fit', key, reason }` | `{ type: 'lint', fingerprint, reason }`; the reason (≥ 10 characters) stays local. */
export const POST = route<P>(async (req, { kind, id }) => addOverride(kind, id, await jsonBody(req)));
