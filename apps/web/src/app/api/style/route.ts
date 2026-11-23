import { jsonBody, route } from '@/server/http';
import { getStyleState, saveForms } from '@/server/services/style';

export const GET = route(() => getStyleState());
export const PUT = route(async (req) => saveForms(await jsonBody(req)));
