/**
 * Etappe 16b: the font library – installed macOS fonts and the Google Fonts catalogue. Pure parsers (no I/O): the server
 * runs `fc-list` / `system_profiler` and fetches the Google metadata, this module turns their output into a list she can
 * search. Everything read here is untrusted data (font names from files on disk or from the network): names are length
 * limited and only names libass and the ASS style line carry safely can be chosen.
 */
import { macFontRef } from './lookBase';

// ---------- Installed fonts (macOS) ----------

export interface InstalledFace {
  family: string; style: string; fullName: string; postscriptName: string;
  /** CSS weight 100–900. */
  weight: number; italic: boolean;
  /**
   * Name written into the ASS: the English full name („Georgia Bold“). libass with CoreText does NOT find every TrueType
   * face by its PostScript name (`Georgia-Bold`, `ArialMT` fall back to Lucida/Helvetica; verified 2026-11-19, FFmpeg 9.0.2),
   * the full name selects the exact face for all tested ones. Falls back to the PostScript name when no safe full name exists.
   */
  assName: string;
  /** `mac:<PostScriptName>` when PostScript and ASS name are safe for libass/ASS, else null (listed, not selectable). */
  ref: string | null;
}
export interface InstalledFamily { family: string; faces: InstalledFace[] }

/** `fc-list --format`: one face per line, tab-separated (first family/style/full name of each face). */
export const FC_LIST_FORMAT = '%{family[0]}\\t%{style[0]}\\t%{fullname[0]}\\t%{postscriptname}\\t%{weight}\\t%{slant}\\t%{file}\\t%{fullname}\\t%{fullnamelang}\\n';
const PS_SAFE = /^[A-Za-z0-9_-]{1,63}$/;
const ASS_NAME_SAFE = /^[A-Za-z0-9 _-]{1,63}$/;
const NAME_MAX = 80;
// eslint-disable-next-line no-control-regex -- control characters out of untrusted names
const tidy = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

/** fontconfig weight → CSS weight (fontconfig: thin 0, extralight 40, light 50, book 75, regular 80, medium 100, semibold 180, bold 200, extrabold 205, black 210). */
export function fcWeightToCss(w: number): number {
  if (!Number.isFinite(w)) return 400;
  const steps: [number, number][] = [[0, 100], [40, 200], [50, 300], [75, 400], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900]];
  let best = steps[0]!;
  for (const s of steps) if (Math.abs(s[0] - w) < Math.abs(best[0] - w)) best = s;
  return best[1];
}

/** Weight and slant from a face name when the source gives none (system_profiler). */
export function faceFromName(name: string): { weight: number; italic: boolean } {
  const n = name.toLowerCase().replace(/[\s_-]+/g, '');
  const italic = /italic|oblique|kursiv/.test(n);
  const weight = /hairline|thin/.test(n) ? 100 : /extralight|ultralight/.test(n) ? 200 : /semibold|demibold|demi/.test(n) ? 600
    : /extrabold|ultrabold/.test(n) ? 800 : /black|heavy/.test(n) ? 900 : /bold|fett/.test(n) ? 700 : /medium/.test(n) ? 500 : /light/.test(n) ? 300 : 400;
  return { weight, italic };
}

function group(faces: InstalledFace[]): InstalledFamily[] {
  const byFamily = new Map<string, Map<string, InstalledFace>>();
  for (const f of faces) {
    // hidden system UI fonts („.SF NS“), empty names
    if (!f.family || f.family.startsWith('.') || !f.postscriptName || f.postscriptName.startsWith('.')) continue;
    const m = byFamily.get(f.family) ?? new Map<string, InstalledFace>();
    if (!m.has(f.postscriptName)) m.set(f.postscriptName, f);
    byFamily.set(f.family, m);
  }
  return [...byFamily.entries()]
    .map(([family, m]) => ({ family, faces: [...m.values()].sort((a, b) => Number(a.italic) - Number(b.italic) || a.weight - b.weight || a.style.localeCompare(b.style)) }))
    .sort((a, b) => a.family.localeCompare(b.family, 'de'));
}

const face = (family: string, style: string, fullName: string, ps: string, weight: number, italic: boolean, englishFull = ''): InstalledFace => {
  const en = tidy(englishFull);
  const assName = ASS_NAME_SAFE.test(en) ? en : PS_SAFE.test(ps) ? ps : '';
  return {
    family: tidy(family), style: tidy(style) || (italic ? 'Italic' : 'Regular'), fullName: tidy(fullName) || tidy(`${family} ${style}`), postscriptName: tidy(ps),
    weight, italic, assName, ref: PS_SAFE.test(ps) && assName ? macFontRef(ps) : null,
  };
};

/** The English full name from fontconfig's comma-separated `fullname`/`fullnamelang` lists (prefers one that is not the PostScript name). */
export function englishFullName(names: string, langs: string, ps: string): string {
  const n = names.split(','), l = langs.split(',');
  const en = n.filter((_, i) => l[i] === 'en').map((x) => x.trim());
  return en.find((x) => x !== ps) ?? en[0] ?? (n.length === 1 ? n[0]!.trim() : '');
}

/** Output of `fc-list --format FC_LIST_FORMAT`. Lines that do not have the seven fields are skipped. */
export function parseFcList(out: string): InstalledFamily[] {
  const faces: InstalledFace[] = [];
  for (const line of out.split('\n').slice(0, 20000)) {
    const p = line.split('\t');
    if (p.length < 7) continue;
    const [family, style, fullName, ps, weight, slant, , names = '', langs = ''] = p as string[] as [string, string, string, string, string, string, string, string?, string?];
    const italic = Number(slant) >= 100 || /italic|oblique|kursiv/i.test(style);
    faces.push(face(family, style, fullName, ps.trim(), fcWeightToCss(Number(weight)), italic, names ? englishFullName(names, langs, ps.trim()) : ''));
  }
  return group(faces);
}

/** Output of `system_profiler SPFontsDataType -json` (fallback without fontconfig): no weights, so they come from the names. */
export function parseSystemProfiler(json: string): InstalledFamily[] {
  let root: unknown;
  try { root = JSON.parse(json); } catch { return []; }
  const files = (root as { SPFontsDataType?: unknown }).SPFontsDataType;
  const faces: InstalledFace[] = [];
  for (const file of Array.isArray(files) ? files.slice(0, 5000) : []) {
    const typefaces = (file as { typefaces?: unknown }).typefaces;
    for (const t of Array.isArray(typefaces) ? typefaces.slice(0, 200) : []) {
      const o = t as Record<string, unknown>;
      const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
      if (str('enabled') === 'no') continue;
      const ps = str('_name'), full = str('fullname');
      const { weight, italic } = faceFromName(`${ps} ${full}`);
      // system_profiler reports the full name in English (name ID 4, Windows/en)
      faces.push(face(str('family'), str('style'), full, ps, weight, italic, full));
    }
  }
  return group(faces);
}

/** Search over the families (name contains every word of the query, case- and accent-insensitive). */
export function searchFamilies<T extends { family: string }>(families: readonly T[], query: string, limit = 60): T[] {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const words = norm(query).split(/\s+/).filter(Boolean);
  const hits = words.length ? families.filter((f) => words.every((w) => norm(f.family).includes(w))) : [...families];
  return hits.slice(0, Math.max(1, Math.min(500, limit)));
}

// ---------- Google Fonts ----------

export const GOOGLE_CATEGORIES = ['sans', 'serif', 'display', 'handwriting', 'mono'] as const;
export type GoogleCategory = (typeof GOOGLE_CATEGORIES)[number];
export const GOOGLE_CATEGORY_LABELS: Record<GoogleCategory, string> = { sans: 'Sans', serif: 'Serif', display: 'Display', handwriting: 'Handschrift', mono: 'Mono' };
const CATEGORY_OF: Record<string, GoogleCategory> = { 'sans serif': 'sans', serif: 'serif', display: 'display', handwriting: 'handwriting', monospace: 'mono' };

export interface GoogleFamily {
  family: string; category: GoogleCategory;
  /** Upright weights only (100–900), sorted; italics are not offered (overlays stay upright). */
  weights: number[];
  lastModified: string; popularity: number;
}
const FAMILY_RE = /^[A-Za-z0-9 ]{1,60}$/;
export const isGoogleFamilyName = (s: string) => FAMILY_RE.test(s);

/**
 * The public Google Fonts metadata (`https://fonts.google.com/metadata/fonts`, no API key; the JSON may start with the
 * anti-JSON-hijacking prefix `)]}'`). Only open-source, non-brand families with a plain ASCII name and at least one
 * upright weight are kept. Throws when the document has no family list (format changed).
 */
export function parseGoogleMetadata(text: string): GoogleFamily[] {
  const root = JSON.parse(text.replace(/^\)\]\}'\s*/, '')) as { familyMetadataList?: unknown };
  if (!Array.isArray(root.familyMetadataList)) throw new Error('Google-Fonts-Metadaten ohne Familienliste (Format geändert?).');
  const out: GoogleFamily[] = [];
  for (const raw of root.familyMetadataList.slice(0, 5000)) {
    const f = raw as Record<string, unknown>;
    const family = typeof f.family === 'string' ? f.family.trim() : '';
    if (!FAMILY_RE.test(family) || f.isOpenSource === false || f.isBrandFont === true) continue;
    const category = CATEGORY_OF[String(f.category ?? '').toLowerCase()];
    if (!category) continue;
    const variants = f.fonts && typeof f.fonts === 'object' ? Object.keys(f.fonts as object) : [];
    const weights = [...new Set(variants.filter((v) => /^[1-9]00$/.test(v)).map(Number))].sort((a, b) => a - b);
    if (!weights.length) continue;
    out.push({
      family, category, weights,
      lastModified: typeof f.lastModified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.lastModified) ? f.lastModified : '',
      popularity: typeof f.popularity === 'number' && Number.isFinite(f.popularity) ? f.popularity : 1e9,
    });
  }
  return out.sort((a, b) => a.popularity - b.popularity || a.family.localeCompare(b.family));
}

/** Typical reel fonts for the quick pick. Only names: files are fetched when she clicks „Hinzufügen“. */
export const CURATED_GOOGLE_FONTS = [
  'Montserrat', 'Poppins', 'Inter', 'Bebas Neue', 'Anton', 'Archivo Black', 'Oswald', 'Playfair Display', 'DM Serif Display', 'Syne', 'Space Grotesk', 'Caveat',
  'Permanent Marker', 'Shrikhand',
] as const;

/** Catalogue search: name and category filter, most popular first. */
export function searchGoogleFonts(list: readonly GoogleFamily[], q: { query?: string; category?: GoogleCategory | null; limit?: number }): GoogleFamily[] {
  const byCat = q.category ? list.filter((f) => f.category === q.category) : list;
  return searchFamilies(byCat, q.query ?? '', q.limit ?? 40);
}

/** CSS2 API URL for some upright weights of one family (`text` = only these characters, for the preview). */
export function googleCssUrl(base: string, family: string, weights: readonly number[], text?: string): string {
  if (!FAMILY_RE.test(family)) throw new Error('Ungültiger Familienname.');
  const w = [...new Set(weights)].filter((x) => Number.isInteger(x) && x >= 100 && x <= 900 && x % 100 === 0).sort((a, b) => a - b);
  if (!w.length) throw new Error('Kein Schnitt gewählt.');
  const params = new URLSearchParams({ family: `${family}:wght@${w.join(';')}`, display: 'swap' });
  if (text) params.set('text', text);
  return `${base}?${params.toString().replace(/%3A/g, ':').replace(/%40/g, '@').replace(/%3B/g, ';')}`;
}

/**
 * The `@font-face` blocks of a CSS2 response: family, weight, style and the TTF URL. Only `url(...)` with
 * `format('truetype')` (what the API sends a non-browser client) is used; anything else is ignored.
 */
export function parseGoogleCss(css: string): { family: string; weight: number; italic: boolean; url: string }[] {
  const out: { family: string; weight: number; italic: boolean; url: string }[] = [];
  for (const m of css.slice(0, 200_000).matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const block = m[1]!;
    const family = /font-family:\s*'([^']{1,80})'/.exec(block)?.[1] ?? '';
    const weight = Number(/font-weight:\s*(\d{3})/.exec(block)?.[1] ?? 400);
    const italic = /font-style:\s*italic/.test(block);
    const url = /src:\s*url\(([^)\s]+)\)\s*format\('truetype'\)/.exec(block)?.[1] ?? '';
    if (family && url) out.push({ family, weight, italic, url });
  }
  return out;
}

/** Licences Google Fonts ships under, recognised from the font file's own licence fields (name IDs 13/14). */
export type FontLicense = { id: 'OFL-1.1' | 'Apache-2.0' | 'UFL-1.0'; name: string; url: string };
export function classifyFontLicense(text: string, url: string): FontLicense | null {
  const s = `${text} ${url}`.toLowerCase();
  if (/open font license|scripts\.sil\.org\/ofl|openfontlicense\.org|\bofl\b/.test(s)) return { id: 'OFL-1.1', name: 'SIL Open Font License 1.1', url: 'https://openfontlicense.org' };
  if (/apache license|apache\.org\/licenses/.test(s)) return { id: 'Apache-2.0', name: 'Apache License 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' };
  if (/ubuntu font licen[cs]e/.test(s)) return { id: 'UFL-1.0', name: 'Ubuntu Font Licence 1.0', url: 'https://ubuntu.com/legal/font-licence' };
  return null;
}

/** Specimen page of a Google family (shown as the source next to the licence). */
export const googleSpecimenUrl = (family: string) => `https://fonts.google.com/specimen/${encodeURIComponent(family).replace(/%20/g, '+')}`;

/** The automatic licence note of a Google font (stored like the note she types for her own fonts). */
export const googleLicenseNote = (l: FontLicense, family: string, lastModified: string, fileUrl: string) =>
  `${l.name} (${l.url}) · Google Fonts „${family}“${lastModified ? ` (Stand ${lastModified})` : ''} · ${googleSpecimenUrl(family)} · Datei ${fileUrl}`.slice(0, 500);
