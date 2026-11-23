import { HttpError, route } from '@/server/http';
import { slideFile } from '@/server/services/carouselRender';
import { streamFile } from '@/server/streamFile';

/** Etappe 18: one slide as PNG (`?version=` = a version id, default the active one); drawn on demand, content-addressed. */
export const GET = route<{ id: string; cid: string; n: string }>(async (req, { id, cid, n }) => {
  const k = Number(n);
  if (!Number.isInteger(k) || k < 1 || k > 10) throw new HttpError(400, 'Slide-Nummer 1–10');
  const file = await slideFile(id, cid, k, req.nextUrl.searchParams.get('version'));
  return streamFile(req.headers.get('range'), file, 'image/png');
});
