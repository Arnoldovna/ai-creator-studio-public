import { route } from '@/server/http';
import { deriveVoiceFromContext } from '@/server/services/style';

/** Voice Director over her active profile and sources (switch `always`/`chat_voice_only`). Returns a suggestion only. */
export const POST = route(async () => deriveVoiceFromContext());
