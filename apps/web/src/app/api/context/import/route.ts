import { readImportRequest } from '@/server/contextUpload';
import { route } from '@/server/http';
import { previewImport } from '@/server/services/strategy';

/**
 * Preview of a bundle (multipart `files[]` + `text` + `choices`, or JSON): detected kind, problems and what would
 * change per file. Stores nothing.
 */
export const POST = route(async (req) => previewImport(await readImportRequest(req)));
