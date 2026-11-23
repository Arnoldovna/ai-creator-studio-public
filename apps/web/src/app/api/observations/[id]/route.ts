import { jsonBody, route } from '@/server/http';
import { reviewObservation } from '@/server/services/references';

/** `{ decision?, feedback?, statement?, dimension?, colors? }`: decide and/or edit; the AI original is kept on the first edit. */
export const PATCH = route<{ id: string }>(async (req, { id }) => reviewObservation(id, await jsonBody(req)));
