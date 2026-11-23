import { jsonBody, route } from '@/server/http';
import { estimateStory, listStories, proposeStory } from '@/server/services/editDirection';

type P = { id: string };
/** Etappe 16: availability, the latest dramaturgy proposals of `?scriptId=` (empty = Freier Schnitt) and the cost estimate. */
export const GET = route<P>(async (req, { id }) => listStories(id, req.nextUrl.searchParams.get('scriptId')));
/**
 * `{ scriptId?, targetSec?, estimate? }` → one Edit Director run (budget, routing, log) and the stored proposal.
 * `?estimate=1` (or `estimate: true`) only returns the cost estimate; nothing runs. Client projects: 409.
 */
export const POST = route<P>(async (req, { id }) => {
  const body = (await jsonBody(req)) as Record<string, unknown> | null;
  return req.nextUrl.searchParams.get('estimate') === '1' || body?.estimate === true ? estimateStory(id, body) : proposeStory(id, body);
});
