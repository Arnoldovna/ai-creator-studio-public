import { FONT_MAX_BYTES } from '@studio/core';
import { HttpError, route } from '@/server/http';
import { listFonts, uploadFont } from '@/server/services/fonts';

export const GET = route(() => listFonts());

/** Her own font file: multipart `file` (TTF/OTF, ≤ 10 MB) + `license` (required). */
export const POST = route(async (req) => {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > FONT_MAX_BYTES + 64 * 1024) throw new HttpError(413, 'Schriftdatei zu groß (max. 10 MB).');
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Feld "file" fehlt');
  return uploadFont(file, form.get('license'));
});
