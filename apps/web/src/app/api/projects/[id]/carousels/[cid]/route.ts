import { jsonBody, route } from '@/server/http';
import { deleteCarouselFiles } from '@/server/services/carouselRender';
import { deleteCarouselRecord, getCarousel, saveCarousel } from '@/server/services/carousels';

type P = { id: string; cid: string };
/** Etappe 18: the carousel with its active version, versions, review (problems, hints, checklist), look and library images. */
export const GET = route<P>(async (_req, { id, cid }) => getCarousel(id, cid));
/** `{ baseVersionId, body, title? }` → a new active version (409 `stale_version` when another version became active). */
export const PUT = route<P>(async (req, { id, cid }) => saveCarousel(id, cid, await jsonBody(req)));
/** Deletes the carousel, its versions, its chat history and its PNG files. */
export const DELETE = route<P>(async (_req, { id, cid }) => {
  const r = await deleteCarouselRecord(id, cid);
  await deleteCarouselFiles(id, cid);
  return r;
});
