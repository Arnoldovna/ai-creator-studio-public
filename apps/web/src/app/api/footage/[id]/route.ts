import { route } from '@/server/http';
import { deleteFootage } from '@/server/services/footage';

export const DELETE = route<{ id: string }>((_req, { id }) => deleteFootage(id));
