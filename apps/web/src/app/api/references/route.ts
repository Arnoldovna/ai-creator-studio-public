import { HttpError, route } from '@/server/http';
import { MAX_UPLOAD_BYTES } from '@/server/env';
import { createReference, listReferences } from '@/server/services/references';

export const GET = route(() => listReferences());

export const POST = route(async (req) => {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_UPLOAD_BYTES + 1024 * 1024) throw new HttpError(413, 'Upload zu groß (max. 60 MB je Datei)');
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Feld "file" fehlt');
  const palette = form.get('palette');
  return createReference(file, typeof palette === 'string' ? palette : null);
});
