import { route } from '@/server/http';
import { listJobs } from '@/server/services/videoJobs';

/** `?projectId=` filters; without it all jobs are listed. */
export const GET = route((req) => listJobs(req.nextUrl.searchParams.get('projectId') ?? undefined));
