import { readImportRequest } from '@/server/contextUpload';
import { route } from '@/server/http';
import { applyImport } from '@/server/services/strategy';

/** Same input as the preview: the recognised documents become new active versions (unchanged ones are skipped). */
export const POST = route(async (req) => applyImport(await readImportRequest(req)));
