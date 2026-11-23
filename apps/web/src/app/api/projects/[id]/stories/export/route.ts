import { HttpError, route } from '@/server/http';
import { storiesPackage } from '@/server/services/storyRender';
import { prepareZip, zipStream } from '@/server/zip';

/**
 * Etappe 19: stories as ZIP (`?ids=a,b,c` in this order): `01.png`/`02.mp4` …, `notizen.txt` (stickers to set in Instagram,
 * her notes) and `KENNZEICHNUNG.txt` when a story shows generated material. 409 `story_problems` while a story has errors.
 */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const ids = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const { filename, entries } = await storiesPackage(id, ids);
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
