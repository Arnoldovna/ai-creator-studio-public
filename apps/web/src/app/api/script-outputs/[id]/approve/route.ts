import { jsonBody, route } from '@/server/http';
import { approveScriptOutput } from '@/server/services/scriptAgents';

type P = { id: string };
export const POST = route<P>(async (req, { id }) => approveScriptOutput(id, await jsonBody(req)));
