import { jsonBody, route } from '@/server/http';
import { createStories, estimateStories, listStories } from '@/server/services/stories';

type P = { id: string };
/** Etappe 19: her stories of the project, the sources she can pick (reels, carousels, concepts, photos) and the cost estimate. */
export const GET = route<P>(async (_req, { id }) => listStories(id));
/**
 * `{ source: { kind: render|carousel|concept|image, id } | { kind: note, text }, count? (3–5), estimate? }` → one Story Writer
 * run (budget, routing, log) and 3–5 new stories. `?estimate=1` only returns the cost. Client projects: 409.
 */
export const POST = route<P>(async (req, { id }) => {
  const body = (await jsonBody(req)) as Record<string, unknown> | null;
  return req.nextUrl.searchParams.get('estimate') === '1' || body?.estimate === true ? estimateStories(id, { ...body, estimate: true }) : createStories(id, body);
});
