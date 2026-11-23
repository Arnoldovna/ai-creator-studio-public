import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  classifyFontLicense, CURATED_GOOGLE_FONTS, FONT_MAX_BYTES, fontFormat, GOOGLE_CATEGORIES, googleCssUrl, googleLicenseNote, isGoogleFamilyName, parseGoogleCss,
  parseGoogleMetadata, searchGoogleFonts, type GoogleFamily,
} from '@studio/core';
import { z } from 'zod';
import { dataDir } from '../env';
import { HttpError } from '../errors';
import { read, type FontRecord } from '../store';
import { storeFont } from './fonts';

/**
 * Etappe 16b: Google Fonts without an API key.
 *
 * Sources (decision): the catalogue is the public metadata the Google Fonts website itself loads
 * (`fonts.google.com/metadata/fonts`: family, category, weights, last change); it is not versioned, so the studio keeps a
 * dated copy on disk and uses it offline. The files come from the public CSS2 API (`fonts.googleapis.com/css2`), which
 * hands a non-browser client STATIC TrueType files of exactly the chosen weights on `fonts.gstatic.com` under a versioned
 * path (`/s/<family>/v<N>/…`). The google/fonts GitHub repository was not used: most popular families there are only
 * variable fonts (`Family[wght].ttf`), and libass/FreeType would draw their default instance, not the chosen weight.
 * The fixed version of an added font is that versioned URL plus the SHA-256 of the downloaded file (stored on the record).
 *
 * Every response is untrusted: TTF URLs must be HTTPS on the allowed host, files go through the same checks as her own
 * uploads (magic bytes, ≤ 10 MB, tables, upright), the family in the file must be the one she chose, and the licence must be
 * recognisable from the file itself (OFL, Apache 2.0, UFL) – it becomes the licence note automatically. Requests carry a
 * generic user agent and nothing about her (no cookies, no referrer, no ids).
 */
const UA = 'Mozilla/5.0 (compatible; font-client/1.0)';
const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;
const PREVIEW_MAX_FILES = 300;
/** Characters of the preview font files (`text=`): enough for German sample lines. */
export const PREVIEW_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÄÖÜäöüß0123456789 .,:;!?-–„“"\'&()';

export const googleConfig = () => ({
  enabled: process.env.GOOGLE_FONTS !== 'off',
  metadataUrl: process.env.GOOGLE_FONTS_METADATA_URL || 'https://fonts.google.com/metadata/fonts',
  cssUrl: process.env.GOOGLE_FONTS_CSS_URL || 'https://fonts.googleapis.com/css2',
  fileHosts: (process.env.GOOGLE_FONTS_FILE_HOSTS || 'fonts.gstatic.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
});

export const OFFLINE = 'Keine Verbindung zu Google Fonts (offline?). Bereits hinzugefügte Schriften funktionieren weiter; Mac-Schriften und eigene Dateien gehen ohne Internet.';
const offline = (detail?: string) => new HttpError(503, detail ? `${OFFLINE} (${detail.slice(0, 120)})` : OFFLINE);

/** HTTPS only; plain http only to a local test server (127.0.0.1/localhost) that is configured explicitly. */
function checkUrl(raw: string, hosts?: readonly string[]): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(502, 'Google Fonts lieferte eine ungültige Adresse.'); }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new HttpError(502, 'Google Fonts lieferte keine HTTPS-Adresse.');
  if (hosts && !hosts.includes(u.hostname.toLowerCase()) && !hosts.includes(u.host.toLowerCase())) throw new HttpError(502, `Schriftdatei von unerwartetem Server (${u.hostname.slice(0, 60)}).`);
  if (u.username || u.password) throw new HttpError(502, 'Adresse mit Zugangsdaten abgelehnt.');
  return u;
}

async function fetchLimited(url: URL, maxBytes: number, accept: string): Promise<Uint8Array> {
  if (!googleConfig().enabled) throw offline('GOOGLE_FONTS=off');
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, redirect: 'error', referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw offline((e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message);
  }
  if (!res.ok) throw new HttpError(res.status === 400 || res.status === 404 ? 404 : 502, `Google Fonts antwortete mit ${res.status}.`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new HttpError(413, `Datei zu groß (max. ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new HttpError(413, `Datei zu groß (max. ${Math.round(maxBytes / 1024 / 1024)} MB).`); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

// ---------- Catalogue ----------

const cacheDir = () => path.join(dataDir(), 'cache', 'google-fonts');
type Catalog = { at: number; list: GoogleFamily[]; fetchedAt: string; stale: boolean };
const g = globalThis as unknown as { __studioGoogleCatalog?: Catalog | null; __studioGoogleCatalogRun?: Promise<Catalog> | null };

/** The catalogue: memory → fresh disk copy → network → stale disk copy (offline) → 503. */
export async function googleCatalog(): Promise<{ list: GoogleFamily[]; fetchedAt: string; stale: boolean }> {
  const mem = g.__studioGoogleCatalog;
  // fresh: 1 h in memory; a stale (offline) copy is kept 2 min before the network is tried again
  if (mem && Date.now() - mem.at < (mem.stale ? 120_000 : 3600_000)) return mem;
  // one load at a time (parallel searches share it)
  g.__studioGoogleCatalogRun ??= loadCatalog().finally(() => { g.__studioGoogleCatalogRun = null; });
  return g.__studioGoogleCatalogRun;
}

async function loadCatalog(): Promise<Catalog> {
  const file = path.join(cacheDir(), 'metadata.json');
  const disk = await readFile(file, 'utf8').then((t) => JSON.parse(t) as { fetchedAt: string; text: string }, () => null);
  const fromDisk = (stale: boolean) => {
    let list: GoogleFamily[];
    try { list = parseGoogleMetadata(disk!.text); } catch { return null; } // a damaged copy counts as none
    g.__studioGoogleCatalog = { at: Date.now(), list, fetchedAt: disk!.fetchedAt, stale };
    return g.__studioGoogleCatalog;
  };
  if (disk && Date.now() - Date.parse(disk.fetchedAt) < CATALOG_TTL_MS) {
    const fresh = fromDisk(false);
    if (fresh) return fresh;
  }
  try {
    const text = new TextDecoder().decode(await fetchLimited(checkUrl(googleConfig().metadataUrl), 30 * 1024 * 1024, 'application/json'));
    const list = parseGoogleMetadata(text);
    const fetchedAt = new Date().toISOString();
    await mkdir(cacheDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify({ fetchedAt, text }), 'utf8');
    await rename(tmp, file);
    g.__studioGoogleCatalog = { at: Date.now(), list, fetchedAt, stale: false };
    return g.__studioGoogleCatalog;
  } catch (e) {
    const stale = disk ? fromDisk(true) : null;
    if (stale) return stale;
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Google-Fonts-Katalog nicht lesbar: ${(e as Error).message.slice(0, 120)}`);
  }
}

export const CatalogQuery = z.object({
  q: z.string().trim().max(60).default(''),
  category: z.enum(GOOGLE_CATEGORIES).nullish(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

/** GET /api/fonts/google: search with category filter, the quick pick, and which families are already added. */
export async function searchGoogleCatalog(raw: unknown) {
  const q = CatalogQuery.parse(raw ?? {});
  const added = await read((db) => (db.fonts ?? []).filter((f) => f.origin?.kind === 'google').map((f) => ({ id: f.id, family: f.origin!.family, weight: f.origin!.weight })));
  const cat = await googleCatalog();
  const results = searchGoogleFonts(cat.list, { query: q.q, category: q.category ?? null, limit: q.limit });
  const byName = new Map(cat.list.map((f) => [f.family, f]));
  return {
    fetchedAt: cat.fetchedAt, stale: cat.stale, total: cat.list.length,
    results, curated: CURATED_GOOGLE_FONTS.map((n) => byName.get(n)).filter((f): f is GoogleFamily => !!f),
    added,
  };
}

// ---------- Preview (small subset file, cached) ----------

/** A subset font file (only `PREVIEW_CHARS`) for the browser preview of a family she has not added yet. */
export async function googlePreview(familyRaw: unknown, weightRaw: unknown): Promise<Uint8Array> {
  const family = z.string().trim().refine(isGoogleFamilyName, 'Ungültiger Familienname.').parse(familyRaw);
  const weight = z.coerce.number().int().min(100).max(900).default(400).parse(weightRaw ?? undefined);
  const key = createHash('sha256').update(`${family}|${weight}|${PREVIEW_CHARS}`).digest('hex').slice(0, 32);
  const dir = path.join(cacheDir(), 'preview');
  const file = path.join(dir, `${key}.ttf`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return new Uint8Array(cached);
  const cat = await googleCatalog();
  const fam = cat.list.find((f) => f.family === family);
  if (!fam) throw new HttpError(404, `„${family}“ gibt es im Google-Fonts-Katalog nicht.`);
  const w = fam.weights.includes(weight) ? weight : fam.weights.includes(400) ? 400 : fam.weights[0]!;
  const css = new TextDecoder().decode(await fetchLimited(checkUrl(googleCssUrl(googleConfig().cssUrl, family, [w], PREVIEW_CHARS)), 256 * 1024, 'text/css'));
  const src = parseGoogleCss(css).find((x) => !x.italic);
  if (!src) throw new HttpError(502, 'Google Fonts lieferte keine TrueType-Datei für die Vorschau.');
  const bytes = await fetchLimited(checkUrl(src.url, googleConfig().fileHosts), 2 * 1024 * 1024, 'font/ttf');
  if (!fontFormat(bytes)) throw new HttpError(502, 'Vorschau-Datei ist keine TTF/OTF-Schrift.');
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  void prunePreviews(dir);
  return bytes;
}

async function prunePreviews(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.length <= PREVIEW_MAX_FILES) return;
  const aged = await Promise.all(names.map(async (n) => ({ n, t: (await stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
  await Promise.all(aged.sort((a, b) => b.t - a.t).slice(PREVIEW_MAX_FILES).map((x) => rm(path.join(dir, x.n), { force: true })));
}

// ---------- Add (download the chosen weights into her font folder) ----------

export const AddGoogleFont = z.object({
  family: z.string().trim().refine(isGoogleFamilyName, 'Ungültiger Familienname.'),
  /** Upright weights to add (default: regular and bold where the family has them). */
  weights: z.array(z.number().int().min(100).max(900)).min(1).max(4).optional(),
}).strict();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const WEIGHT_WORDS = ['Thin', 'ExtraLight', 'Light', 'Medium', 'SemiBold', 'ExtraBold', 'Black'];

/**
 * POST /api/fonts/google: downloads the TTF of each chosen weight (HTTPS, allowed host, size limit), checks it like her
 * own uploads, writes the licence note from the file's licence fields and stores it in the font folder (Etappe 14) – from
 * there Meine Marke, the editor and the render use it (libass `fontsdir`, full name). Already added files are reused.
 */
export async function addGoogleFont(raw: unknown): Promise<{ fonts: { font: FontRecord; duplicate: boolean }[] }> {
  const req = AddGoogleFont.parse(raw);
  const cat = await googleCatalog();
  const fam = cat.list.find((f) => f.family === req.family);
  if (!fam) throw new HttpError(404, `„${req.family}“ gibt es im Google-Fonts-Katalog nicht.`);
  const wanted = req.weights ?? fam.weights.filter((w) => w === 400 || w === 700);
  const weights = (wanted.length ? wanted : [fam.weights.includes(400) ? 400 : fam.weights[0]!]).filter((w) => fam.weights.includes(w));
  if (!weights.length) throw new HttpError(400, `„${fam.family}“ hat keinen dieser Schnitte (vorhanden: ${fam.weights.join(', ')}).`);
  const css = new TextDecoder().decode(await fetchLimited(checkUrl(googleCssUrl(googleConfig().cssUrl, fam.family, weights)), 256 * 1024, 'text/css'));
  const files = parseGoogleCss(css).filter((x) => !x.italic && weights.includes(x.weight) && norm(x.family) === norm(fam.family));
  if (!files.length) throw new HttpError(502, 'Google Fonts lieferte keine TrueType-Dateien für diese Schnitte.');
  const out: { font: FontRecord; duplicate: boolean }[] = [];
  for (const f of files) {
    const url = checkUrl(f.url, googleConfig().fileHosts);
    const bytes = await fetchLimited(url, FONT_MAX_BYTES, 'font/ttf');
    out.push(await storeFont(bytes, `${fam.family.replace(/ /g, '')}-${f.weight}.ttf`, (info) => {
      // exact typographic family (name ID 16, else 1): „Montserrat Alternates“ is not „Montserrat“
      // (a static non-RIBBI instance may name the weight in ID 1 without an ID 16: „Montserrat SemiBold“)
      if (norm(info.family) !== norm(fam.family) && !WEIGHT_WORDS.some((w) => norm(info.family) === norm(`${fam.family}${w}`))) throw new HttpError(502, `Die Datei enthält „${info.family}“, nicht „${fam.family}“.`);
      const lic = classifyFontLicense(info.licenseText, info.licenseUrl);
      if (!lic) throw new HttpError(415, `Die Lizenz von „${fam.family}“ ist in der Datei nicht als OFL, Apache 2.0 oder UFL erkennbar – nicht hinzugefügt.`);
      return {
        note: googleLicenseNote(lic, fam.family, fam.lastModified, url.toString()),
        origin: { kind: 'google', family: fam.family, weight: f.weight, url: url.toString(), licenseId: lic.id, licenseUrl: lic.url, lastModified: fam.lastModified },
      };
    }));
  }
  return { fonts: out };
}
