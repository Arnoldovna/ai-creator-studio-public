import { jsonBody, route } from '@/server/http';
import { quoteEval } from '@/server/services/eval';

/** Cost quote for one comparison (nothing is called). */
export const POST = route(async (req) => quoteEval(await jsonBody(req)));
