import { route } from '@/server/http';
import { getPeaks } from '@/server/services/prepare';

/** Waveform peaks of a prepared clip: `{ perSec, durationSec, peaks: 0..255[], hasAudio }` (404 while not prepared). */
export const GET = route<{ id: string }>((_req, { id }) => getPeaks(id));
