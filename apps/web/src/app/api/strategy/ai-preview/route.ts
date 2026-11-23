import { route } from '@/server/http';
import { aiPreview } from '@/server/services/strategy';

/** `?projectId=` | `?conceptId=` | `?scriptId=` → the strategy/profile text the agents for that subject receive. */
export const GET = route((req) => {
  const q = req.nextUrl.searchParams;
  const pick = (k: 'scriptId' | 'conceptId' | 'projectId') => q.get(k);
  const scriptId = pick('scriptId'), conceptId = pick('conceptId'), projectId = pick('projectId');
  return aiPreview(scriptId ? { scriptId } : conceptId ? { conceptId } : { projectId });
});
