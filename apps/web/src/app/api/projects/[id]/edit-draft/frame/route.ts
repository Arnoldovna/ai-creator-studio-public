import { route } from '@/server/http';
import { renderDraftFrame } from '@/server/services/editPreview';

/**
 * Etappe 13: `?t=&scriptId=&size=half|full` → one frame of the draft at output time t as PNG, through the render's
 * picture chain and the same ASS file (hook, overlays, subtitles, AI label). Cached by content hash.
 */
export const GET = route<{ id: string }>(async (req, { id }) => {
  const { png, cached, t, fontWarnings } = await renderDraftFrame(id, Object.fromEntries(req.nextUrl.searchParams));
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Cached': cached ? '1' : '0', 'X-Frame-Time': String(t), 'X-Font-Warnings': encodeURIComponent(JSON.stringify(fontWarnings)) },
  });
});
