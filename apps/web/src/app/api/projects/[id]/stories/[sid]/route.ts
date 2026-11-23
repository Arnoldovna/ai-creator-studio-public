import { jsonBody, route } from '@/server/http';
import { deleteStoryFiles } from '@/server/services/storyRender';
import { deleteStoryRecord, getStory, saveStory } from '@/server/services/stories';

type P = { id: string; sid: string };
/** Etappe 19: the story with its review (problems, hints, sticker note), look, media info and the media she can choose. */
export const GET = route<P>(async (_req, { id, sid }) => getStory(id, sid));
/** `{ baseRevision, body, title? }` → the next revision (409 `stale_revision` when another save came first). */
export const PUT = route<P>(async (req, { id, sid }) => saveStory(id, sid, await jsonBody(req)));
/** Deletes the story and its files; a board entry keeps its title without the link. */
export const DELETE = route<P>(async (_req, { id, sid }) => {
  const r = await deleteStoryRecord(id, sid);
  await deleteStoryFiles(id, sid);
  return r;
});
