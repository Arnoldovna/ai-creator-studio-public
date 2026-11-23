import { route } from '@/server/http';
import { storyFile } from '@/server/services/storyRender';
import { streamFile } from '@/server/streamFile';

/** Etappe 19: the story's current PNG/MP4 (drawn on demand, content-addressed). */
export const GET = route<{ id: string; sid: string }>(async (req, { id, sid }) => {
  const f = await storyFile(id, sid);
  return streamFile(req.headers.get('range'), f.abs, f.mime);
});
