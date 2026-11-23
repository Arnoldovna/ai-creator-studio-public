import { jsonBody, route } from '@/server/http';
import { chooseVariant } from '@/server/services/carousels';

/** Etappe 18: `{ baseVersionId, templateId, format? }` – the same texts in another layout/look → a new active version. */
export const POST = route<{ id: string; cid: string }>(async (req, { id, cid }) => chooseVariant(id, cid, await jsonBody(req)));
