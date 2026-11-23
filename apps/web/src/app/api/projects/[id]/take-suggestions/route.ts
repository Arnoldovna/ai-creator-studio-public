import { HttpError, route } from '@/server/http';
import { suggestTakes } from '@/server/services/transcripts';

/** `?scriptId=` → per scene up to 3 take windows from the transcripts (text match only, no model call). */
export const GET = route<{ id: string }>((req, { id }) => {
  const scriptId = req.nextUrl.searchParams.get('scriptId');
  if (!scriptId) throw new HttpError(400, 'scriptId fehlt');
  return suggestTakes(id, scriptId);
});
