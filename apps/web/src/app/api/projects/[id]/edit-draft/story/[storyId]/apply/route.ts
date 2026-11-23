import { jsonBody, route } from '@/server/http';
import { applyStory } from '@/server/services/editDirection';

/**
 * Etappe 16: `{ scriptId?, revision, selection? }` applies the dramaturgy proposal (all of it, or the chosen beats in her
 * order, one hook, single overlays/images/zooms) as a new draft revision. 409 when the draft or the transcripts changed.
 */
export const POST = route<{ id: string; storyId: string }>(async (req, { id, storyId }) => applyStory(id, storyId, await jsonBody(req)));
