import { route } from '@/server/http';
import { getEvalOverview } from '@/server/services/eval';

export const GET = route(() => getEvalOverview());
