import { route } from '@/server/http';
import { deletePublication } from '@/server/services/analytics';

export const DELETE = route<{ id: string }>((_req, { id }) => deletePublication(id));
