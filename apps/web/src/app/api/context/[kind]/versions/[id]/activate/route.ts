import { route } from '@/server/http';
import { activateVersion } from '@/server/services/strategy';

type P = { kind: string; id: string };
/** Makes this version active again; the previously active one of the same kind (or source key) is archived. */
export const POST = route<P>(async (_req, { kind, id }) => activateVersion(kind, id));
