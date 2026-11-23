import { route } from '@/server/http';
import { googlePreview } from '@/server/services/googleFonts';

/** Etappe 16b: a small subset font file of a family for the browser preview (fetched by the server, cached). */
export const GET = route(async (req) => {
  const p = req.nextUrl.searchParams;
  const bytes = await googlePreview(p.get('family'), p.get('weight'));
  return new Response(new Uint8Array(bytes), {
    headers: { 'Content-Type': 'font/ttf', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" },
  });
});
