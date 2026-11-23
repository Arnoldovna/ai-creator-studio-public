import { HttpError, route } from '@/server/http';
import { carouselPackage } from '@/server/services/carouselRender';
import { prepareZip, zipStream } from '@/server/zip';

/**
 * Etappe 18: the carousel as ZIP (`?version=`): `01.png … NN.png`, `caption.txt`, `alt-text.txt` and `KENNZEICHNUNG.txt` when
 * a slide shows a generated image. 409 `carousel_problems` while overflow, image rights, flagged claims or label denials remain.
 */
export const GET = route<{ id: string; cid: string }>(async (req, { id, cid }) => {
  const { filename, entries } = await carouselPackage(id, cid, req.nextUrl.searchParams.get('version'));
  let prepared;
  try {
    prepared = await prepareZip(entries);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  const it = zipStream(prepared);
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const n = await it.next();
        if (n.done) c.close();
        else c.enqueue(n.value);
      } catch (e) {
        c.error(e);
      }
    },
    async cancel() { await it.return(undefined); },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]+/g, '-')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
