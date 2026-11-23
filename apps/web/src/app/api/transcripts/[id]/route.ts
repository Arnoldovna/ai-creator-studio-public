import { jsonBody, route } from '@/server/http';
import { saveTranscriptEdit } from '@/server/services/transcripts';

/** The user's correction `{ texts: string[] }` (one per segment) → new transcript version. */
export const POST = route<{ id: string }>(async (req, { id }) => saveTranscriptEdit(id, await jsonBody(req)));
