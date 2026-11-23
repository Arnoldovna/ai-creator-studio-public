/**
 * Boundary lint (Etappe 9, ADR-012): a deterministic keyword check of content text against her no-go categories.
 * No AI. It finds typical words only, never paraphrases; that is why the FitCheck asks her directly as well.
 *
 * Findings are computed on demand and never stored. The text of a `custom` finding (her own sensitive terms) never
 * contains the term: excerpt and message replace it with a placeholder.
 */
import type { ProjectKind } from './schemas';
import { NO_GO_CATEGORY_LABEL, termRegex, type LintFinding, type NoGoCategory, type SensitiveTerm } from './strategy';

export interface LintPart { field: string; text: string }

/** fnv1a32 hex (8 characters). */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable id of a finding: the category and its sentence (other sentences may change without affecting it). */
export const sentenceFingerprint = (category: NoGoCategory, sentence: string) =>
  fnv1a32(`${category}|${sentence.toLowerCase().replace(/\s+/g, ' ').trim()}`);

const words = (...xs: string[]) => xs.map((x) => termRegex(x, 'giu'));

const WORDS: Partial<Record<NoGoCategory, RegExp[]>> = {
  children: words('Kind', 'Kinder', 'Kindern', 'Sohn', 'Söhne', 'Tochter', 'Töchter', 'Kita', 'Baby', 'Enkel', 'Enkelin'),
  employer: words('Arbeitgeber', 'Arbeitgeberin', 'Chef', 'Chefin', 'Vorgesetzter', 'Vorgesetzte', 'Kollege', 'Kollegin', 'Kollegen', 'Betriebsrat', 'Kündigung', 'Abmahnung'),
  medical: words('Diagnose', 'krankgeschrieben', 'Krankschreibung', 'Therapie', 'Therapeutin', 'Therapeut', 'Medikament', 'Medikamente', 'Klinik', 'Befund', 'Reha', 'Arzt', 'Ärztin'),
  faked_expertise: words('als Expertin', 'als Experte', 'Profi-Tipp', 'zertifiziert', 'Studien zeigen', 'wissenschaftlich bewiesen', 'garantiert'),
  home_location: [
    /(?<![\p{L}\p{N}])\d{5}\s+\p{Lu}\p{L}+/gu,
    /(?<![\p{L}\p{N}])\p{Lu}[\p{L}-]*(?:straße|strasse|str\.|weg|gasse|allee|platz)\s+\d+[a-z]?(?![\p{L}\p{N}])/gu,
    /(?<![\p{L}\p{N}])[Ww]ohne in \p{Lu}\p{L}+/gu,
  ],
};
const FAMILY = words('Ehemann', 'Ehefrau', 'Partner', 'Partnerin', 'Mutter', 'Vater', 'Schwester', 'Bruder', 'Schwiegermutter', 'Schwiegervater', 'Familie');
const CONFLICT = words('Streit', 'streiten', 'gestritten', 'Trennung', 'Scheidung', 'Krise', 'Vorwurf', 'Vorwürfe');

const PLACEHOLDER = '[Begriff aus deiner Liste]';
const UGC_CATEGORIES: ReadonlySet<NoGoCategory> = new Set(['custom', 'home_location']);

interface Range { start: number; end: number }
function matches(re: RegExp, text: string, offset = 0): Range[] {
  const out: Range[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = r.exec(text); m; m = r.exec(text)) {
    if (m[0].length === 0) { r.lastIndex++; continue; }
    out.push({ start: offset + m.index, end: offset + m.index + m[0].length });
  }
  return out;
}

/** Sentences of a text with their offsets (split on . ! ? and line breaks). */
function sentences(text: string): (Range & { text: string })[] {
  const out: (Range & { text: string })[] = [];
  const re = /[^.!?\n]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

/** German label of a lint field such as `scenes[2].dialogue`. */
export function lintFieldLabel(field: string): string {
  const n = (s: string) => Number(s) + 1;
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^title$/, () => 'Titel'],
    [/^(hook|selectedHook)$/, () => 'Hook'],
    [/^hook\.text$/, () => 'Hook'],
    [/^hookVariants\[(\d+)\]$/, (m) => `Hook-Variante ${n(m[1]!)}`],
    [/^angle$/, () => 'Blickwinkel'],
    [/^structure\[(\d+)\]$/, (m) => `Aufbau ${n(m[1]!)}`],
    [/^cta$/, () => 'CTA'],
    [/^scenes\[(\d+)\]\.dialogue$/, (m) => `Szene ${n(m[1]!)} (Dialog)`],
    [/^scenes\[(\d+)\]\.onScreenText$/, (m) => `Szene ${n(m[1]!)} (Text im Bild)`],
    [/^caption$/, () => 'Caption'],
    [/^coverText$/, () => 'Cover-Text'],
    [/^altText$/, () => 'Alt-Text'],
    [/^hashtags\[(\d+)\]$/, (m) => `Hashtag ${n(m[1]!)}`],
    [/^aiAssetBriefs\[(\d+)\]\.prompt$/, (m) => `KI-Asset-Brief ${n(m[1]!)}`],
    [/^clips\[(\d+)\]\.overlays\[(\d+)\]\.text$/, (m) => `Clip ${n(m[1]!)}, Overlay ${n(m[2]!)}`],
    [/^clips\[(\d+)\]\.subtitle$/, (m) => `Clip ${n(m[1]!)} (Untertitel)`],
  ];
  for (const [re, f] of rules) {
    const m = re.exec(field);
    if (m) return f(m);
  }
  return field;
}

/** Sorted, with overlapping or adjacent ranges merged (nested and partly overlapping terms mask as one). */
function mergeRanges(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** ±30 characters around the match; sensitive terms in it are masked (a term is never cut in half). */
function excerptOf(text: string, at: Range, termRanges: readonly Range[], maskMatch: boolean): string {
  const masks = mergeRanges([...termRanges, ...(maskMatch ? [at] : [])]);
  let s = Math.max(0, at.start - 30);
  let e = Math.min(text.length, at.end + 30);
  // masks are merged, so one widening pass never leaves part of a term at either edge
  for (const r of masks) {
    if (r.start < s && r.end > s) s = r.start;
    if (r.start < e && r.end > e) e = r.end;
  }
  let out = '';
  let pos = s;
  for (const r of masks) {
    if (r.end <= s || r.start >= e) continue;
    out += text.slice(pos, r.start) + PLACEHOLDER;
    pos = r.end;
  }
  out += text.slice(pos, e);
  return `${s > 0 ? '…' : ''}${out.replace(/\s+/g, ' ').trim()}${e < text.length ? '…' : ''}`;
}

/**
 * Deterministic keyword lint. NFC, case-insensitive, on Unicode word boundaries; sentences split on . ! ? and line
 * breaks. Client projects run only `custom` (her sensitive terms) and `home_location`.
 * Offsets refer to the NFC form of the field text.
 */
export function lintBoundaries(parts: readonly LintPart[], opts: { projectKind: ProjectKind; terms: readonly SensitiveTerm[] }): LintFinding[] {
  const runs = (c: NoGoCategory) => opts.projectKind !== 'UGC_CLIENT' || UGC_CATEGORIES.has(c);
  const termRes = opts.terms.filter((t) => t.term.trim().length >= 2).map((t) => termRegex(t.term, 'giu'));
  const out: LintFinding[] = [];
  for (const part of parts) {
    const text = (part.text ?? '').normalize('NFC');
    if (!text.trim()) continue;
    const sents = sentences(text);
    const sentenceAt = (pos: number) => sents.find((x) => pos >= x.start && pos < x.end) ?? { start: pos, end: pos, text: '' };
    const termRanges = mergeRanges(termRes.flatMap((re) => matches(re, text)));
    const seen = new Set<string>();
    const push = (category: NoGoCategory, ruleId: string, at: Range, sentence: string) => {
      const fingerprint = sentenceFingerprint(category, sentence);
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      const excerpt = excerptOf(text, at, termRanges, category === 'custom');
      out.push({
        ruleId, category, field: part.field, fingerprint, excerpt, start: at.start, end: at.end,
        message: `Grenze berührt (Kategorie „${NO_GO_CATEGORY_LABEL[category]}“) in ${lintFieldLabel(part.field)}: „${excerpt}“. Ändern oder mit Begründung bewusst freigeben.`,
      });
    };
    for (const [cat, res] of Object.entries(WORDS) as [NoGoCategory, RegExp[]][]) {
      if (!runs(cat)) continue;
      const hits = res.flatMap((re) => matches(re, text)).sort((a, b) => a.start - b.start);
      for (const h of hits) push(cat, `${cat}:word`, h, sentenceAt(h.start).text);
    }
    if (runs('family_conflict'))
      for (const s of sents) {
        const fam = FAMILY.flatMap((re) => matches(re, s.text, s.start)).sort((a, b) => a.start - b.start);
        if (fam.length && CONFLICT.some((re) => matches(re, s.text).length)) push('family_conflict', 'family_conflict:cooccurrence', fam[0]!, s.text);
      }
    if (runs('custom'))
      for (const r of termRanges) push('custom', 'custom:term', r, sentenceAt(r.start).text);
  }
  return out;
}

// ---------- Field extractors ----------
type ConceptParts = { title: string; hook: string; hookVariants: readonly string[]; angle: string; structure: readonly string[]; cta: string };
export const conceptLintParts = (c: ConceptParts): LintPart[] => [
  { field: 'title', text: c.title }, { field: 'hook', text: c.hook },
  ...c.hookVariants.map((text, i) => ({ field: `hookVariants[${i}]`, text })),
  { field: 'angle', text: c.angle },
  ...c.structure.map((text, i) => ({ field: `structure[${i}]`, text })),
  { field: 'cta', text: c.cta },
];

type ScriptParts = { hookVariants: readonly string[]; selectedHook: string; cta: string; scenes: readonly { dialogue: string; onScreenText: string }[] };
/** Everything `scriptText` (claims) covers, with field names. */
export const scriptLintParts = (s: ScriptParts): LintPart[] => [
  ...s.hookVariants.map((text, i) => ({ field: `hookVariants[${i}]`, text })),
  { field: 'selectedHook', text: s.selectedHook }, { field: 'cta', text: s.cta },
  ...s.scenes.flatMap((sc, i) => [{ field: `scenes[${i}].dialogue`, text: sc.dialogue }, { field: `scenes[${i}].onScreenText`, text: sc.onScreenText }]),
];

type CopyParts = { caption: string; coverText: string; altText: string; hashtags: readonly string[] };
export const copyLintParts = (o: CopyParts): LintPart[] => [
  { field: 'caption', text: o.caption }, { field: 'coverText', text: o.coverText }, { field: 'altText', text: o.altText },
  ...o.hashtags.map((text, i) => ({ field: `hashtags[${i}]`, text })),
];

export const storyboardLintParts = (o: { aiAssetBriefs: readonly { prompt: string }[] }): LintPart[] =>
  o.aiAssetBriefs.map((b, i) => ({ field: `aiAssetBriefs[${i}].prompt`, text: b.prompt }));

type PlanParts = { hook: { text: string } | null; clips: readonly { subtitle: string; overlays: readonly { text: string }[] }[] };
export const editPlanLintParts = (b: PlanParts): LintPart[] => [
  ...(b.hook ? [{ field: 'hook.text', text: b.hook.text }] : []),
  ...b.clips.flatMap((c, i) => [
    ...c.overlays.map((o, j) => ({ field: `clips[${i}].overlays[${j}].text`, text: o.text })),
    { field: `clips[${i}].subtitle`, text: c.subtitle },
  ]),
];
