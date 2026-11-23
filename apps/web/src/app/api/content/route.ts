import { HttpError, route } from '@/server/http';
import { getContent } from '@/server/services/content';

export const GET = route(async (req) => {
  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) throw new HttpError(400, 'projectId fehlt');
  return getContent(projectId);
});
