import { route } from '@/server/http';
import { dismissSuggestion } from '@/server/services/board';

/** Etappe 20: „Verwerfen“ – nothing changes on the board. */
export const POST = route<{ sid: string }>(async (_req, { sid }) => dismissSuggestion(sid));
