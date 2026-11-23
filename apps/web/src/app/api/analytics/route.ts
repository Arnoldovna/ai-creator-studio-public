import { route } from '@/server/http';
import { getAnalytics } from '@/server/services/analytics';

export const GET = route(() => getAnalytics());
