import { jsonBody, route } from '@/server/http';
import { createPublication } from '@/server/services/analytics';

export const POST = route(async (req) => createPublication(await jsonBody(req)));
