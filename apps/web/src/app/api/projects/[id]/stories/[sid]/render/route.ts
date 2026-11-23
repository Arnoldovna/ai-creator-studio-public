import { route } from '@/server/http';
import { renderStory } from '@/server/services/storyRender';

/** Etappe 19: the story as PNG (still) or MP4 (clip ≤ 15 s) through FFmpeg + libass. */
export const POST = route<{ id: string; sid: string }>(async (_req, { id, sid }) => renderStory(id, sid));
