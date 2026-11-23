import { jsonBody, route } from '@/server/http';
import { createStyleVersion } from '@/server/services/style';

export const POST = route(async (req) => createStyleVersion(await jsonBody(req)));
