import { route } from '@/server/http';
import { getStatus } from '@/server/services/status';

export const GET = route(() => getStatus());
