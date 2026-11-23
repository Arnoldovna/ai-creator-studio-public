import { jsonBody, route } from '@/server/http';
import { analyzeVoice } from '@/server/services/style';

export const POST = route(async (req) => analyzeVoice(await jsonBody(req)));
