import { jsonBody, route } from '@/server/http';
import { createManualStory } from '@/server/services/stories';

/** Etappe 19: `{ kind?, media?, title? }` → an empty story of that kind (no agent, no cost). */
export const POST = route<{ id: string }>(async (req, { id }) => createManualStory(id, await jsonBody(req)));
