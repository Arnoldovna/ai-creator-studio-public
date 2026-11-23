import { route } from '@/server/http';
import { deriveDesign } from '@/server/services/designSystem';

/** Deterministic proposal from her favourites, on top of her unsaved edits (`{ design }`, optional). Nothing is stored. */
export const POST = route(async (req) => deriveDesign(await req.json().catch(() => ({}))));
