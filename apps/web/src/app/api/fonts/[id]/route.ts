import { stat, readFile } from 'node:fs/promises';
import { HttpError, route } from '@/server/http';
import { absolutePath } from '@/server/media';
import { deleteFont, getFontRecord } from '@/server/services/fonts';

/** The font file for the browser preview (`@font-face`); only her own uploaded fonts. */
export const GET = route<{ id: string }>(async (_req, { id }) => {
  const rec = await getFontRecord(id);
  if (!rec) throw new HttpError(404, 'Schrift nicht gefunden');
  const abs = absolutePath(rec.storagePath);
  await stat(abs).catch(() => { throw new HttpError(404, 'Schriftdatei fehlt'); });
  return new Response(new Uint8Array(await readFile(abs)), {
    headers: { 'Content-Type': rec.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" },
  });
});

export const DELETE = route<{ id: string }>(async (_req, { id }) => deleteFont(id));
