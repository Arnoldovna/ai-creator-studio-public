import { route } from '@/server/http';
import { analyzeReference } from '@/server/services/references';

export const maxDuration = 300;
export const POST = route<{ id: string }>((_req, { id }) => analyzeReference(id));
