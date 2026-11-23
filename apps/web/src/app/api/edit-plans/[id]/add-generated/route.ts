import { jsonBody, route } from '@/server/http';
import { addGeneratedClip } from '@/server/services/edit';

/** New draft EDL version with a reviewed generated clip `{ generationId }`; it has to be approved again. */
export const POST = route<{ id: string }>(async (req, { id }) => addGeneratedClip(id, await jsonBody(req)));
