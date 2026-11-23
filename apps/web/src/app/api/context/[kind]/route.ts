import { jsonBody, route } from '@/server/http';
import { archiveSource, parseKind, putDocument } from '@/server/services/strategy';
import { HttpError } from '@/server/errors';

type P = { kind: string };
/**
 * Saves a whole document as the new active version: strategy `{ json }`, profile `{ markdown }`, source
 * `{ key?, title?, markdown?, sendMode? }`. A changed send switch alone updates the active version in place.
 */
export const PUT = route<P>(async (req, { kind }) => putDocument(kind, await jsonBody(req)));

/** `DELETE /api/context/source?key=…`: takes a source out of the AI context (archived, can be reactivated). */
export const DELETE = route<P>(async (req, { kind }) => {
  if (parseKind(kind) !== 'source') throw new HttpError(405, 'Nur Quellen lassen sich entfernen.');
  return archiveSource(req.nextUrl.searchParams.get('key'));
});
