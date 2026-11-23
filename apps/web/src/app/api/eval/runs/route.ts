import { jsonBody, route } from '@/server/http';
import { runEval } from '@/server/services/eval';

/** Runs one comparison (paid runs need `approvedMaxUsd`). */
export const POST = route(async (req) => runEval(await jsonBody(req)));
