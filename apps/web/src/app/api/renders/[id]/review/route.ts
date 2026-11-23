import { jsonBody, route } from '@/server/http';
import { reviewRender } from '@/server/services/edit';

/** Human gate on a finished render: `{ decision: 'approve' | 'reject' | 'revise', note }`. */
export const POST = route<{ id: string }>(async (req, { id }) => reviewRender(id, await jsonBody(req)));
