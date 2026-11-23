import { jsonBody, route } from '@/server/http';
import { runResearch } from '@/server/services/insights';

export const POST = route(async (req) => runResearch(await jsonBody(req)));
