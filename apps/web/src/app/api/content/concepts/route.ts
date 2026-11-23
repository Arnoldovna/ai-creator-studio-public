import { jsonBody, route } from '@/server/http';
import { generateConcepts } from '@/server/services/content';

export const maxDuration = 300;
export const POST = route(async (req) => generateConcepts(await jsonBody(req)));
