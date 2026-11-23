import { jsonBody, route } from '@/server/http';
import { getDefaultsStatus, postDefaults } from '@/server/defaults';

/** Standard folder (Etappe 10): status, „jetzt sichern“ ({action:'snapshot'}), „aus Datei übernehmen“ ({action:'apply'}). */
export const GET = route(() => getDefaultsStatus());
export const POST = route(async (req) => postDefaults(await jsonBody(req)));
