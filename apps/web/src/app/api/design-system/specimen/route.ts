import { jsonBody, route } from '@/server/http';
import { renderSpecimen } from '@/server/services/designSystem';

/** Exact specimen (1080×1920 PNG) through FFmpeg + ASS, cached by content hash. Warnings in `X-Specimen-Warnings` (URI-encoded JSON). */
export const POST = route(async (req) => {
  const { png, cached, warnings } = await renderSpecimen(await jsonBody(req));
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Specimen-Cached': cached ? '1' : '0', 'X-Specimen-Warnings': encodeURIComponent(JSON.stringify(warnings)),
    },
  });
});
