import { jsonBody, route } from '@/server/http';
import { setPreference } from '@/server/services/eval';

export const PUT = route(async (req) => setPreference(await jsonBody(req)));
