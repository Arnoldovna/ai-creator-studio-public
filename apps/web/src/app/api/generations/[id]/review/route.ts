import { jsonBody, route } from '@/server/http';
import { reviewGeneration } from '@/server/services/generations';

/** Asset review `{ decision: 'approve' | 'reject', note }` before a generated clip may enter an EDL. */
export const POST = route<{ id: string }>(async (req, { id }) => reviewGeneration(id, await jsonBody(req)));
