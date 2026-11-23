import { route } from '@/server/http';
import { getVersion } from '@/server/services/strategy';

type P = { kind: string; id: string };
/** One version (any status) with its read view. */
export const GET = route<P>(async (_req, { kind, id }) => getVersion(kind, id));
