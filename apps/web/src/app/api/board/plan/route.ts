import { jsonBody, route } from '@/server/http';
import { estimatePlan, planWeek } from '@/server/services/board';

/** Etappe 20: „Woche füllen“ – `{ week, estimate? }` → one Week Planner run with suggestions (nothing lands on the board yet); `estimate` only returns the cost. */
export const POST = route(async (req) => {
  const body = (await jsonBody(req)) as Record<string, unknown> | null;
  return body?.estimate === true ? estimatePlan(body) : planWeek(body);
});
