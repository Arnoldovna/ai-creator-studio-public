import { route } from '@/server/http';
import { deleteSnapshot } from '@/server/services/analytics';

export const DELETE = route<{ id: string }>((_req, { id }) => deleteSnapshot(id));
