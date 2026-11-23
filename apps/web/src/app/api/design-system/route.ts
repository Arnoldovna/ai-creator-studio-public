import { jsonBody, route } from '@/server/http';
import { getDesignState, saveDesign } from '@/server/services/designSystem';

/** „Meine Marke“ (Etappe 14): the active design system; PUT saves it as a new active Style Bible version. */
export const GET = route(() => getDesignState());
export const PUT = route(async (req) => saveDesign(await jsonBody(req)));
