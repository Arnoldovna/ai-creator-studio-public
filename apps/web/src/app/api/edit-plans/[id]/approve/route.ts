import { route } from '@/server/http';
import { approveEditPlan } from '@/server/services/edit';

/** Human gate: approve the EDL (needs an approved script). */
export const POST = route<{ id: string }>((_req, { id }) => approveEditPlan(id));
