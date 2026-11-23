import { HttpError, route } from '@/server/http';
import { finishPackage } from '@/server/services/finish';
import { prepareZip, zipStream } from '@/server/zip';
import '@/server/services/videoJobs';

/**
 * Etappe 17: the CapCut/finish package of a render as ZIP (`?images=1|0&alpha=0|1&words=1|0`): clean video (AI label
 * burned in when needed), the normal render, SRTs, text sheet, cover, caption, guide, FCPXML. 409 `finish_missing` until
 * the files are made (POST /api/renders/[id]/finish). Client projects: approved renders only.
 */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const { filename, entries } = await finishPackage(id, Object.fromEntries(req.nextUrl.searchParams));
  // every file is opened and every size/limit checked here, before the response starts: a missing file or > 4 GB is a
  // JSON error, not a broken download (a read error later can still abort the stream)
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
