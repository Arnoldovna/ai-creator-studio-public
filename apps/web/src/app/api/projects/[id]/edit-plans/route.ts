import { jsonBody, route } from '@/server/http';
import { getEditState, saveEditPlan } from '@/server/services/edit';

type P = { id: string };
/** Scripts, EDL versions and renders of the project. */
export const GET = route<P>((_req, { id }) => getEditState(id));
/** Saves a new draft EDL version `{ scriptId (null = Freier Schnitt, personal content only), body: { clips, loudness, subtitles }, parentId?, clientConsentNote? }`. */
export const POST = route<P>(async (req, { id }) => saveEditPlan(id, await jsonBody(req)));
