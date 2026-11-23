import { jsonBody, route } from '@/server/http';
import { deleteSelfAssessment, updateSelfAssessment } from '@/server/services/selfAssessment';

type P = { id: string };
export const PATCH = route<P>(async (req, { id }) => updateSelfAssessment(id, await jsonBody(req)));
/** Removes the entry and its local note. */
export const DELETE = route<P>((_req, { id }) => deleteSelfAssessment(id));
