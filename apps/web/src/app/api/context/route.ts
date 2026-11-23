import { route } from '@/server/http';
import { getContext } from '@/server/services/strategy';

/** Active strategy, profile and sources, every version (summaries), pillars, phase and the exact AI text. */
export const GET = route(() => getContext());
