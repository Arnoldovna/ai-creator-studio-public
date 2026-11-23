/** Small, dependency-free text helpers shared by UI and server (ported from prototype). */
const LIST_DELIMITERS = /[,;\n]/;
export const splitList = (str: string | null | undefined, max = 25): string[] =>
  String(str ?? '')
    .split(LIST_DELIMITERS)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);

export const unique = <T>(xs: readonly (T | null | undefined | '')[]): T[] =>
  [...new Set(xs.filter((x): x is T => Boolean(x)))];

/** One entry per line (lists whose items may contain commas, e.g. facts and claims). */
export const splitLines = (value: string, max = 40): string[] =>
  value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, max);

/** Stable non-cryptographic hash (FNV-1a) used for deterministic mock output. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Inverse of splitList for editor forms: one item per line, delimiter characters inside an item
 * become " / " so the item survives a split, and items stop before `maxChars` is exceeded.
 */
export function joinList(items: readonly string[], maxChars = Infinity): string {
  const out: string[] = [];
  let len = 0;
  for (const item of items) {
    const clean = item.replace(/[,;\n\r]+/g, ' / ').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const add = clean.length + (out.length ? 1 : 0);
    if (len + add > maxChars) break;
    out.push(clean);
    len += add;
  }
  return out.join('\n');
}

/** Collapse whitespace, trim and cap (model output → stored text). */
export const collapseWs = (s: string, max = Infinity) => s.replace(/\s+/g, ' ').trim().slice(0, max);
/** Whitespace- and case-insensitive form for verbatim checks (keeps punctuation, unlike claim matching). */
export const squash = (s: string) => collapseWs(s).toLowerCase();
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
