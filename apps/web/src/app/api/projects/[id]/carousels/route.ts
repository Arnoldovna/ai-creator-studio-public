import { jsonBody, route } from '@/server/http';
import { createCarousel, estimateCarousel, listCarousels } from '@/server/services/carousels';

type P = { id: string };
/** Etappe 18: her carousels of the project, the sources she can pick (concepts, scripts, finished reels) and the cost estimate. */
export const GET = route<P>(async (_req, { id }) => listCarousels(id));
/**
 * `{ source: { kind: concept|script|render, id } | { kind: note, text }, framework, slideCount?, format?, templateId?, estimate? }`
 * → one Carousel Writer run (budget, routing, log) and the new carousel. `?estimate=1` (or `estimate: true`) only returns
 * the cost estimate; nothing runs. Client projects: 409.
 */
export const POST = route<P>(async (req, { id }) => {
  const body = (await jsonBody(req)) as Record<string, unknown> | null;
  return req.nextUrl.searchParams.get('estimate') === '1' || body?.estimate === true ? estimateCarousel(id, { ...body, estimate: true }) : createCarousel(id, body);
});
