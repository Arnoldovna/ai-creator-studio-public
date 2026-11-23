import { route } from '@/server/http';
import { cancelJob } from '@/server/services/videoJobs';

export const POST = route<{ id: string }>((_req, { id }) => cancelJob(id));
