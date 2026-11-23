import { route } from '@/server/http';
import { getCutSuggestions } from '@/server/services/cuts';

/**
 * `?assetId=&inSec=&outSec=[&sounds=1]` → filler and pause suggestions for one clip. Side-effect free:
 * nothing is stored or started (the silence scan is queued with POST /api/footage/:id/silence-scan).
 */
export const GET = route<{ id: string }>((req, { id }) => getCutSuggestions(id, Object.fromEntries(req.nextUrl.searchParams)));
