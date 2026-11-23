import { route } from '@/server/http';
import { dismissProposal } from '@/server/services/chat';

/** „Verwerfen“: nothing changes. */
export const POST = route<{ id: string }>(async (_req, { id }) => dismissProposal(id));
