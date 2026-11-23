import { jsonBody, route } from '@/server/http';
import { renderCarousel } from '@/server/services/carouselRender';

/** Etappe 18: `{ versionId? }` → every slide as PNG (FFmpeg + libass, same fonts as the video); font fallbacks as warnings. */
export const POST = route<{ id: string; cid: string }>(async (req, { id, cid }) => {
  const body = (await jsonBody(req)) as { versionId?: unknown } | null;
  return renderCarousel(id, cid, typeof body?.versionId === 'string' ? body.versionId : null);
});
