import { HttpError, route } from '@/server/http';
import { mediaPreview } from '@/server/services/storyRender';
import { streamFile } from '@/server/streamFile';

/** Etappe 19: a still of a story medium for the preview (`?key=ref:…|slide:…|frame:…|clip:…`). */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const key = req.nextUrl.searchParams.get('key') ?? '';
  if (!key || key.length > 300) throw new HttpError(400, 'Medium fehlt.');
  const f = await mediaPreview(id, key);
  return streamFile(req.headers.get('range'), f.abs, f.mime);
});
