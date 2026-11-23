import { jsonBody, route } from '@/server/http';
import { createVoiceVersion } from '@/server/services/style';

export const POST = route(async (req) => createVoiceVersion(await jsonBody(req)));
