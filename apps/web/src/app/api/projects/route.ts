import { jsonBody, route } from '@/server/http';
import { createProject, listProjects } from '@/server/services/projects';

export const GET = route(() => listProjects());
export const POST = route(async (req) => createProject(await jsonBody(req)));
