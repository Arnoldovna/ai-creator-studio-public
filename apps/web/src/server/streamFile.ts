import 'server-only';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { HttpError } from './errors';

/**
 * Streams a private file with HTTP Range support (video seeking without full downloads). Used for originals, renders
 * and since Etappe 12 for the editing proxy and the thumbnail sprite. The path is server-resolved (`absolutePath`).
 */
export async function streamFile(rangeHeader: string | null, abs: string, mime: string): Promise<Response> {
  const { size } = await stat(abs).catch(() => {
    throw new HttpError(404, 'Mediendatei fehlt');
  });
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? '');
  let start = 0, end = size - 1, status = 200;
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}
