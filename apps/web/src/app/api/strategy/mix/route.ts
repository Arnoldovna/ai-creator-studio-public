import { route } from '@/server/http';
import { parseWeeks, selfAssessmentMix } from '@/server/services/selfAssessment';

/** Pillar mix of finished self-assessed pieces (display only, never changes anything). */
export const GET = route((req) => selfAssessmentMix(parseWeeks(req.nextUrl.searchParams.get('weeks'), 12)));
