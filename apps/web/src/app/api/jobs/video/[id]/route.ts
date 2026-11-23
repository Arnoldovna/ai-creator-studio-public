import { jobRoute } from '@/server/http';
import { getJobView } from '@/server/services/edit';

/** n8n polling: status of a video job and, for renders, the render's review state. */
export const GET = jobRoute(async (req) => getJobView(req.nextUrl.pathname.split('/').pop() ?? ''));
