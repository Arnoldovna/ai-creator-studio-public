import { route } from '@/server/http';
import { getBoard } from '@/server/services/board';

/** Etappe 20: the week board (`?week=YYYY-MM-DD`, any day of the week; default this week). Nothing here posts or reminds. */
export const GET = route(async (req) => getBoard(req.nextUrl.searchParams.get('week')));
