import { jsonBody, route } from '@/server/http';
import { getAiBrollState, quoteGeneration, setAiBroll } from '@/server/services/generations';

type P = { id: string };
/** Generated B-roll of the project: availability, budgets, approved briefs, generations. */
export const GET = route<P>((_req, { id }) => getAiBrollState(id));
/** `{ action: 'opt-in', enabled, creditBudget }` or `{ action: 'quote', storyboardId, briefIndex, model, durationSec, resolution }` (costs nothing). */
export const POST = route<P>(async (req, { id }) => {
  const body = (await jsonBody(req)) as { action?: string } | null;
  if (body?.action === 'opt-in') return setAiBroll(id, body);
  if (body?.action === 'quote') return quoteGeneration(id, body);
  return Response.json({ error: 'action muss opt-in oder quote sein' }, { status: 400 });
});
