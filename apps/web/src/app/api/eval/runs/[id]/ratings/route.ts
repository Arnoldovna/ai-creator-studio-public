import { jsonBody, route } from '@/server/http';
import { rateEval } from '@/server/services/eval';

export const POST = route<{ id: string }>(async (req, { id }) => rateEval(id, await jsonBody(req)));
