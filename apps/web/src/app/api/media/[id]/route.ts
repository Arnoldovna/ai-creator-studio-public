import { HttpError, route } from '@/server/http';
import { absolutePath } from '@/server/media';
import { getMediaRecord } from '@/server/services/references';
import { derivedFile } from '@/server/services/prepare';
import { streamFile } from '@/server/streamFile';

/**
 * Streams private media with HTTP Range support (video seeking/metadata without full downloads).
 * Etappe 12: `?variant=proxy` (540×960 editing proxy) or `?variant=thumbs` (thumbnail sprite) of a footage clip.
 */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const variant = req.nextUrl.searchParams.get('variant');
  if (variant != null) {
    if (variant !== 'proxy' && variant !== 'thumbs') throw new HttpError(400, 'variant: proxy oder thumbs');
    const f = await derivedFile(id, variant);
    return streamFile(req.headers.get('range'), absolutePath(f.storagePath), f.mime);
  }
  const rec = await getMediaRecord(id);
  if (!rec) throw new HttpError(404, 'Medium nicht gefunden');
  return streamFile(req.headers.get('range'), absolutePath(rec.storagePath), rec.mime);
});
