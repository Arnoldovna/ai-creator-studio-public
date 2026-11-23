import { route } from '@/server/http';
import { selectConceptAndWrite } from '@/server/services/content';

export const maxDuration = 300;
export const POST = route<{ id: string }>((_req, { id }) => selectConceptAndWrite(id));
