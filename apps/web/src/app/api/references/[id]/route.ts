import { jsonBody, route } from '@/server/http';
import { deleteReference, updateReference } from '@/server/services/references';

type P = { id: string };
export const PATCH = route<P>(async (req, { id }) => updateReference(id, await jsonBody(req)));
export const DELETE = route<P>((_req, { id }) => deleteReference(id));
