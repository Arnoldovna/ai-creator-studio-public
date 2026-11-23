import { jsonBody, route } from '@/server/http';
import { addGoogleFont, searchGoogleCatalog } from '@/server/services/googleFonts';

/** Etappe 16b: search the Google Fonts catalogue (`q`, `category`, `limit`). 503 when offline without a stored copy. */
export const GET = route(async (req) => {
  const p = req.nextUrl.searchParams;
  return searchGoogleCatalog({ q: p.get('q') ?? undefined, category: p.get('category') || undefined, limit: p.get('limit') ?? undefined });
});

/** Adds the chosen upright weights of a family to her fonts (download, checks, licence note). */
export const POST = route(async (req) => addGoogleFont(await jsonBody(req)));
