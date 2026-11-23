import { route } from '@/server/http';
import { suggestDesign } from '@/server/services/designSystem';

/** Design Director (AI, budget) on top of her unsaved edits (`{ design }`, optional): stored as a suggestion only. */
export const POST = route(async (req) => suggestDesign(await req.json().catch(() => ({}))));
