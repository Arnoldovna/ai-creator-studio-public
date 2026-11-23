import { jsonBody, route } from '@/server/http';
import { getScript, saveScriptEdit } from '@/server/services/content';

type P = { id: string };
export const GET = route<P>((_req, { id }) => getScript(id));
/** Saves an edit as a NEW version. */
export const PUT = route<P>(async (req, { id }) => saveScriptEdit(id, await jsonBody(req)));
