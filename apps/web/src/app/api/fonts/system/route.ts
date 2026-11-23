import { route } from '@/server/http';
import { listSystemFonts } from '@/server/services/systemFonts';

/** Etappe 16b: the fonts installed on this Mac (fc-list or system_profiler, cached; `?refresh=1` lists again). */
export const GET = route(async (req) => listSystemFonts({ refresh: req.nextUrl.searchParams.get('refresh') === '1' }));
