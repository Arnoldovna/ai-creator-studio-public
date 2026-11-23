import { route } from '@/server/http';
import { deleteRender } from '@/server/services/edit';

export const DELETE = route<{ id: string }>((_req, { id }) => deleteRender(id));
