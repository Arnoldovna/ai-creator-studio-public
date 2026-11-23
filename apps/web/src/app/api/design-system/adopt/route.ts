import { jsonBody, route } from '@/server/http';
import { adoptIntoDesign } from '@/server/services/designSystem';

/** „Ins Design System übernehmen“ from the Style Lab (colour → role, observation → guideline/image look, reference → image look). */
export const POST = route(async (req) => adoptIntoDesign(await jsonBody(req)));
