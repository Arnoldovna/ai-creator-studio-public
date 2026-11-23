import { jsonBody, route } from '@/server/http';
import { synthesizeStyle } from '@/server/services/style';

export const POST = route(async (req) => synthesizeStyle(await jsonBody(req)));
