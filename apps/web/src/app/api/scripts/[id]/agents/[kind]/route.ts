import { route } from '@/server/http';
import { runScriptAgent } from '@/server/services/scriptAgents';

type P = { id: string; kind: string };
/** kind: qa | copy | storyboard */
export const POST = route<P>((_req, { id, kind }) => runScriptAgent(kind, id));
