import { jsonBody, route } from '@/server/http';
import { analyzeGrowth, growthReports } from '@/server/services/insights';

export const GET = route(() => growthReports());
export const POST = route(async (req) => analyzeGrowth(await jsonBody(req)));
