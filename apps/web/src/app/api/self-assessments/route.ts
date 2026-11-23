import { jsonBody, route } from '@/server/http';
import { createSelfAssessment, listSelfAssessments, parseWeeks, reviewHints } from '@/server/services/selfAssessment';

/** Entries with their local notes (this machine's UI only), weekly series, pickable subjects and review hints. */
export const GET = route(async (req) => {
  const weeks = parseWeeks(req.nextUrl.searchParams.get('weeks'), 12);
  return { ...(await listSelfAssessments(weeks)), reviewHints: await reviewHints() };
});
export const POST = route(async (req) => createSelfAssessment(await jsonBody(req)));
