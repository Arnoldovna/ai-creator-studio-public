import { route } from '@/server/http';
import { acceptSuggestion } from '@/server/services/board';

/** Etappe 20: „Übernehmen“ – the suggestion becomes a board entry (409 when its day is taken meanwhile). */
export const POST = route<{ sid: string }>(async (_req, { sid }) => acceptSuggestion(sid));
