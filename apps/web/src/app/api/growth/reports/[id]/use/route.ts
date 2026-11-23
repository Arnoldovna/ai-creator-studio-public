import { jsonBody, route } from '@/server/http';
import { setGrowthReportUse } from '@/server/services/insights';

type P = { id: string };
export const POST = route<P>(async (req, { id }) => setGrowthReportUse(id, await jsonBody(req)));
