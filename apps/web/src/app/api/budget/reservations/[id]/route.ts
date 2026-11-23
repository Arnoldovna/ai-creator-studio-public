import { jsonBody, route } from '@/server/http';
import { releaseOrphanedReservation } from '@/server/services/agentRuns';

/** Releases a reservation left by a crashed process (only orphaned ones); body `{ chargedUsd }` from the provider's bill. */
export const DELETE = route<{ id: string }>(async (req, { id }) => releaseOrphanedReservation(id, await jsonBody(req)));
