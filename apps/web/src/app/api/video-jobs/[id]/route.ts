import { route } from '@/server/http';
import { getJob } from '@/server/services/videoJobs';

export const GET = route<{ id: string }>((_req, { id }) => getJob(id));
