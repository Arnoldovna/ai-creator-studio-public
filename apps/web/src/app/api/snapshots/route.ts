import { jsonBody, route } from '@/server/http';
import { addSnapshot } from '@/server/services/analytics';

export const POST = route(async (req) => addSnapshot(await jsonBody(req)));
