import { jsonBody, route } from '@/server/http';
import { deleteProject, getProject, updateProject } from '@/server/services/projects';

type P = { id: string };
export const GET = route<P>((_req, { id }) => getProject(id));
export const PATCH = route<P>(async (req, { id }) => updateProject(id, await jsonBody(req)));
export const DELETE = route<P>((_req, { id }) => deleteProject(id));
