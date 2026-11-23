import { route } from '@/server/http';
import { getTranscript } from '@/server/services/transcripts';

/** Latest transcript version of the clip (null if none). */
export const GET = route<{ id: string }>(async (_req, { id }) => (await getTranscript(id)) ?? Response.json(null));
