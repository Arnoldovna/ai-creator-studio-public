import { route } from '@/server/http';
import { applyProposal } from '@/server/services/chat';

/** „Übernehmen“: new active version or draft revision; 409 `stale_base` when the base is no longer current. */
export const POST = route<{ id: string }>(async (_req, { id }) => applyProposal(id));
