/**
 * Karussell-Generator (Etappe 18): one idea → slides in the look of „Meine Marke“, in several looks. Pure and deterministic.
 *
 * - `CarouselBody` is what a version stores: 2–10 slides (title, text, list, quote, image + text, before/after, CTA), the
 *   format (1080×1350 standard, 1080×1080), ONE layout template per carousel (production checklist: „ein Template pro
 *   Karussell“), caption and alt text. Colours and fonts are not copied into the body: they come from „Meine Marke“
 *   (colour roles, type roles „Karussell-Titel“/„Karussell-Text“ of Etappe 14) at layout time.
 * - `layoutSlide` is the ONE geometry source: text is wrapped and fitted here (largest size that fits between the role's
 *   maximum and a minimum; does not fit at the minimum = overflow problem). The ASS writer (`slideAss`, rendered by FFmpeg +
 *   libass with the same font pipeline as the video) and the browser preview draw exactly these lines at these positions.
 *   Width is estimated per character class (`textWidth`), a little on the safe side; libass never wraps on its own (`\q2`).
 * - Images only from her library with rights (own, licensed with a source, generated); a generated image carries the label
 *   „KI-generiert“ ON the slide, drawn last (above everything).
 * - Templates are our own and brand-neutral (colour roles of her design system, no copy of another creator's design).
 * - `carouselIssues`: overflow, missing image rights, empty slides (errors block the export), slop hints, figures without
 *   a source, flagged claims, label denials, testimonial wording, the production checklist.
 *
 * Frameworks: ideas from the carousel narratives of coreyhaines31/marketingskills (MIT, `social/references/
 * carousel-frameworks.md`, reviewed in docs/EXTERNAL_SKILLS_REVIEW_2.md) – our own German structures and wording, no text copied.
 */
import { z } from 'zod';
import { claimsInText, normClaim } from './claims';
import { AI_DISCLOSURE, AD_DENIAL, AI_DENIAL, disclosurePrefix, NUMBER_RE, URL_RE } from './agents/scriptAgents';
import { DesignSystem, resolveTypeToken, applyCase, type CustomFontInfo, type ResolvedType, type TextCase } from './designSystem';
import { assEmFactor, contrastRatio, readableOn, AA_TEXT } from './lookBase';
import { BURNED_AD_DENIAL, BURNED_AI_DENIAL, hexToAssStyle, hexToAssTag } from './overlays';
import type { Box } from './overlayLayout';
import { slopHints, type SlopHint } from './slopLint';
import { escapeAss } from './transcript';
import { IMAGE_OVERLAY_MIMES, imageRightsProblem, type ImageUsage } from './imageLayer';
import { collapseWs } from './text';

// ---------- Formats, kinds, templates ----------

export const CAROUSEL_FORMATS = {
  portrait: { width: 1080, height: 1350, label: 'Hochformat 4:5 (1080 × 1350)' },
  square: { width: 1080, height: 1080, label: 'Quadrat 1:1 (1080 × 1080)' },
} as const;
export const CarouselFormat = z.enum(['portrait', 'square']);
export type CarouselFormat = z.infer<typeof CarouselFormat>;

export const SLIDE_KINDS = ['title', 'text', 'list', 'quote', 'image_text', 'before_after', 'cta'] as const;
export const SlideKind = z.enum(SLIDE_KINDS);
export type SlideKind = z.infer<typeof SlideKind>;
export const SLIDE_KIND_LABEL: Record<SlideKind, string> = {
  title: 'Titel', text: 'Text', list: 'Liste', quote: 'Zitat', image_text: 'Bild + Text', before_after: 'Vorher/Nachher', cta: 'Abschluss (CTA)',
};
/** Which fields a slide kind shows (the editor offers exactly these). */
export const SLIDE_FIELDS: Record<SlideKind, readonly ('title' | 'body' | 'items' | 'attribution' | 'image')[]> = {
  title: ['title', 'body'], text: ['title', 'body'], list: ['title', 'items'], quote: ['body', 'attribution'],
  image_text: ['image', 'title', 'body'], before_after: ['title', 'items'], cta: ['title', 'body'],
};

export const CAROUSEL_MIN_SLIDES = 2;
export const CAROUSEL_MAX_SLIDES = 10;
export const SLIDE_TEXT_MAX = { title: 140, body: 600, item: 160, attribution: 80, items: 6 } as const;
/** The label on a slide with a generated image (fixed text, never editable). */
export const CAROUSEL_AI_LABEL = 'KI-generiert';

export const TEMPLATE_IDS = ['klar', 'kontrast', 'rahmen', 'karte', 'editorial'] as const;
export const TemplateId = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof TemplateId>;
/** Our own, brand-neutral layouts: the colours come from „Meine Marke“, nothing imitates another creator. */
export const TEMPLATES: Record<TemplateId, { name: string; description: string }> = {
  klar: { name: 'Klar', description: 'Heller Hintergrund, Titel linksbündig mit Akzent-Balken.' },
  kontrast: { name: 'Kontrast', description: 'Hauptfarbe als Fläche, alles mittig, Akzent-Linie unter dem Titel.' },
  rahmen: { name: 'Rahmen', description: 'Hintergrund mit Akzent-Rahmen, Text mittig.' },
  karte: { name: 'Karte', description: 'Text auf einer Karte in der Flächenfarbe mit versetztem Akzent-Schatten.' },
  editorial: { name: 'Editorial', description: 'Große Slide-Nummer im Akzent, Titel linksbündig, feine Linie.' },
};

/** Slide tone: `accent` = this slide on the accent/primary colour (a per-slide layout switch). */
export const SlideTone = z.enum(['default', 'accent']);
const Txt = (max: number) => z.string().max(max * 2).transform((s) => s.replace(/\r\n?/g, '\n').replace(/[\t\v\f]+/g, ' ').replace(/[ \u00a0]{2,}/g, ' ').trim().slice(0, max));
const Line = (max: number) => z.string().max(max * 2).transform((s) => collapseWs(s, max));
export const SlideId = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const Slide = z.object({
  id: SlideId,
  kind: SlideKind,
  title: Line(SLIDE_TEXT_MAX.title).default(''),
  body: Txt(SLIDE_TEXT_MAX.body).default(''),
  items: z.array(Line(SLIDE_TEXT_MAX.item)).max(SLIDE_TEXT_MAX.items).default([]),
  attribution: Line(SLIDE_TEXT_MAX.attribution).default(''),
  /** A library reference (image); rights are checked against the library, never taken from the client. */
  imageId: z.string().min(1).max(100).nullable().default(null),
  tone: SlideTone.default('default'),
  /** Before/after: the two chip labels (e.g. „Mythos“/„Wahrheit“). */
  pairLabels: z.tuple([Line(24), Line(24)]).default(['Vorher', 'Nachher']),
});
export type Slide = z.infer<typeof Slide>;
export type SlideInput = z.input<typeof Slide>;

export const FRAMEWORK_IDS = ['problem_weg_ergebnis', 'liste', 'geschichte', 'mythos_wahrheit', 'prozess'] as const;
export const FrameworkId = z.enum(FRAMEWORK_IDS);
export type FrameworkId = z.infer<typeof FrameworkId>;

export const CAROUSEL_VERSION = 1;
export const CarouselBody = z.object({
  version: z.literal(CAROUSEL_VERSION).default(CAROUSEL_VERSION),
  format: CarouselFormat.default('portrait'),
  templateId: TemplateId.default('klar'),
  framework: FrameworkId.default('problem_weg_ergebnis'),
  slides: z.array(Slide).min(CAROUSEL_MIN_SLIDES, `Mindestens ${CAROUSEL_MIN_SLIDES} Slides.`).max(CAROUSEL_MAX_SLIDES, `Höchstens ${CAROUSEL_MAX_SLIDES} Slides.`),
  /** „1/7“ at the bottom of each slide. */
  numbering: z.boolean().default(true),
  caption: Txt(2200).default(''),
  altText: Line(500).default(''),
}).refine((b) => new Set(b.slides.map((s) => s.id)).size === b.slides.length, { message: 'Slide-IDs doppelt.', path: ['slides'] });
export type CarouselBody = z.infer<typeof CarouselBody>;
export type CarouselBodyInput = z.input<typeof CarouselBody>;

/** A fresh slide id that is not used yet (`s1`, `s2` …). */
export function newSlideId(slides: readonly Pick<Slide, 'id'>[]): string {
  const used = new Set(slides.map((s) => s.id));
  for (let i = 1; ; i++) if (!used.has(`s${i}`)) return `s${i}`;
}

// ---------- Frameworks (own German structures, see header) ----------

export interface Framework {
  name: string;
  description: string;
  /** Slide plan the writer follows (kinds in order; the middle repeats to the wished length). */
  plan: { kind: SlideKind; role: string }[];
  /** The part that repeats when there are more slides. */
  repeat: { kind: SlideKind; role: string };
}
export const FRAMEWORKS: Record<FrameworkId, Framework> = {
  problem_weg_ergebnis: {
    name: 'Problem → Weg → Ergebnis', description: 'Was hakt, wie du es angehst, was dabei herauskam (nur Echtes).',
    plan: [{ kind: 'title', role: 'Titel: das Problem als Frage oder Aussage' }, { kind: 'text', role: 'Das Problem konkret' }, { kind: 'text', role: 'Der Weg (ein Schritt pro Slide)' }, { kind: 'text', role: 'Das Ergebnis – nur, was wirklich passiert ist' }, { kind: 'cta', role: 'Eine Bitte' }],
    repeat: { kind: 'text', role: 'Weiterer Schritt des Wegs' },
  },
  liste: {
    name: 'Liste', description: 'Mehrere kurze Punkte zu einem Thema (Tipps, Dinge, Fehler).',
    plan: [{ kind: 'title', role: 'Titel: was die Liste verspricht' }, { kind: 'list', role: 'Punkte' }, { kind: 'cta', role: 'Eine Bitte' }],
    repeat: { kind: 'text', role: 'Ein Punkt ausführlich' },
  },
  geschichte: {
    name: 'Geschichte', description: 'Ausgangslage → Wendepunkt → was du mitnimmst.',
    plan: [{ kind: 'title', role: 'Titel: der Moment' }, { kind: 'text', role: 'Ausgangslage' }, { kind: 'text', role: 'Wendepunkt' }, { kind: 'quote', role: 'Ein Satz von dir (ohne fremde Namen)' }, { kind: 'cta', role: 'Eine Bitte' }],
    repeat: { kind: 'text', role: 'Weiterer Moment' },
  },
  mythos_wahrheit: {
    name: 'Mythos / Wahrheit', description: 'Eine verbreitete Annahme und wie du es erlebst.',
    plan: [{ kind: 'title', role: 'Titel: die Annahme' }, { kind: 'before_after', role: 'Mythos (links/oben) und Wahrheit' }, { kind: 'text', role: 'Warum' }, { kind: 'cta', role: 'Eine Bitte' }],
    repeat: { kind: 'before_after', role: 'Weiteres Paar Mythos/Wahrheit' },
  },
  prozess: {
    name: 'Prozess-Schritte', description: 'Schritt für Schritt, je ein Schritt pro Slide.',
    plan: [{ kind: 'title', role: 'Titel: was am Ende steht' }, { kind: 'text', role: 'Schritt 1' }, { kind: 'text', role: 'Schritt 2' }, { kind: 'text', role: 'Schritt 3' }, { kind: 'cta', role: 'Eine Bitte' }],
    repeat: { kind: 'text', role: 'Weiterer Schritt' },
  },
};
/** The plan for `n` slides: the framework's plan, its repeating part inserted before the CTA (or the end cut away). */
export function frameworkPlan(id: FrameworkId, n?: number | null): { kind: SlideKind; role: string }[] {
  const f = FRAMEWORKS[id];
  const want = Math.max(CAROUSEL_MIN_SLIDES, Math.min(CAROUSEL_MAX_SLIDES, n ?? f.plan.length));
  const plan = [...f.plan];
  while (plan.length < want) plan.splice(plan.length - 1, 0, f.repeat);
  while (plan.length > want) plan.splice(plan.length - 2, 1);
  return plan;
}

/** Production checklist (own wording; idea: marketingskills carousel checklist, MIT). Shown with ok/not ok in the editor. */
export const CHECKLIST = [
  { id: 'cover', text: 'Slide 1 ist das Vorschaubild: kurzer Titel, auch klein lesbar (höchstens ca. 8 Wörter).' },
  { id: 'one_idea', text: 'Eine Aussage pro Slide, höchstens ca. 40 Wörter.' },
  { id: 'one_template', text: 'Ein Layout für das ganze Karussell (Wechsel nur über die Fläche einzelner Slides).' },
  { id: 'ask', text: 'Die letzte Slide hat eine einzige Bitte (speichern, eine Frage, eine DM) – kein Köder.' },
  { id: 'facts', text: 'Keine Zahlen, Ergebnisse oder Zitate ohne Beleg.' },
  { id: 'labels', text: 'KI-Bilder sind auf der Slide gekennzeichnet („KI-generiert“).' },
  { id: 'fits', text: 'Jeder Text passt auf seine Slide (kein Überlauf).' },
] as const;
export type ChecklistId = (typeof CHECKLIST)[number]['id'];

// ---------- Look: colours and fonts from „Meine Marke“ ----------

export interface CarouselColors { background: string; primary: string; accent: string; surface: string; onSurface: string; onAccent: string }
export interface CarouselLook { colors: CarouselColors; title: ResolvedType; body: ResolvedType }

/** Resolves the carousel roles of a design system (type roles „Karussell-Titel“/„Karussell-Text“, colour roles). */
export function carouselLook(design: DesignSystem, fonts: readonly CustomFontInfo[] = []): { look: CarouselLook; warnings: string[] } {
  const warnings: string[] = [];
  const c = design.colors;
  return {
    look: {
      colors: { background: c.background.hex, primary: c.primary.hex, accent: c.accent.hex, surface: c.surface.hex, onSurface: c.onSurface.hex, onAccent: c.onAccent.hex },
      title: resolveTypeToken(design.typography.carouselTitle, fonts, warnings, 'Karussell-Titel'),
      body: resolveTypeToken(design.typography.carouselBody, fonts, warnings, 'Karussell-Text'),
    },
    warnings,
  };
}

/** First candidate with AA contrast on `bg`, else white or near-black. */
const textOn = (bg: string, ...candidates: string[]) => candidates.find((c) => contrastRatio(c, bg) >= AA_TEXT) ?? readableOn(bg);

interface Scheme { bg: string; title: string; body: string; accent: string; onAccentChip: string; card: string | null; shadow: string | null; line: string }
function schemeOf(t: TemplateId, c: CarouselColors, tone: 'default' | 'accent'): Scheme {
  if (tone === 'accent') {
    const bg = t === 'kontrast' ? c.accent : c.primary === c.background ? c.accent : c.primary;
    const fg = textOn(bg, c.onAccent, c.background, c.onSurface);
    // the accent-coloured parts need a colour that still shows on the accent slide
    const deco = contrastRatio(c.accent, bg) >= 1.6 ? c.accent : fg;
    return { bg, title: fg, body: fg, accent: deco, onAccentChip: textOn(deco, c.onAccent, bg), card: null, shadow: null, line: fg };
  }
  const chip = textOn(c.accent, c.onAccent, c.background, c.onSurface);
  switch (t) {
    case 'klar': return { bg: c.background, title: textOn(c.background, c.primary, c.onSurface), body: textOn(c.background, c.onSurface, c.primary), accent: c.accent, onAccentChip: chip, card: null, shadow: null, line: c.accent };
    case 'kontrast': {
      const fg = textOn(c.primary, c.onAccent, c.background, c.onSurface);
      return { bg: c.primary, title: fg, body: fg, accent: contrastRatio(c.accent, c.primary) >= 1.6 ? c.accent : fg, onAccentChip: chip, card: null, shadow: null, line: fg };
    }
    case 'rahmen': return { bg: c.background, title: textOn(c.background, c.onSurface, c.primary), body: textOn(c.background, c.onSurface, c.primary), accent: c.accent, onAccentChip: chip, card: null, shadow: null, line: c.accent };
    case 'karte': {
      const fg = textOn(c.surface, c.onSurface, c.background);
      return { bg: c.background, title: fg, body: fg, accent: c.accent, onAccentChip: chip, card: c.surface, shadow: c.accent, line: c.accent };
    }
    case 'editorial': {
      const fg = textOn(c.surface, c.onSurface, c.background);
      return { bg: c.surface, title: fg, body: fg, accent: contrastRatio(c.accent, c.surface) >= 1.6 ? c.accent : fg, onAccentChip: chip, card: null, shadow: null, line: fg };
    }
  }
}

// ---------- Text measuring and fitting ----------

/** Advance of one character in em of the glyphs (classes of a typical sans; bold +7 %, the family's width below). */
function charEm(ch: string): number {
  if (ch === ' ') return 0.28;
  if (/[il.,:;'!|`´‚‘’]/.test(ch)) return 0.27;
  if (/[jfrtI()[\]\-/]/.test(ch)) return 0.36;
  if (/[mwMW@%]/.test(ch)) return 0.88;
  if (/[A-ZÄÖÜ]/.test(ch)) return 0.7;
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[„“"»«?…–—]/.test(ch)) return 0.5;
  return 0.56;
}
/** Width of a family relative to a typical sans (wide geometric/serif faces wider, condensed narrower). */
const FAMILY_WIDTH: Readonly<Record<string, number>> = { 'Avenir Next': 1, 'Helvetica Neue': 1.02, Arial: 1, Futura: 1.06, Georgia: 1.08, 'DIN Condensed': 0.64 };
/** Safety margin: libass must never draw a line wider than its box. Measured 2026-11-19 (FFmpeg 9 + libass, the six system
 * fonts bold/regular, four German test lines): the estimate lies 4–23 % above the drawn width. */
const WIDTH_SAFETY = 1.06;

/** Estimated width (PlayRes px) of a text at ASS size `size` in the resolved type. */
export function textWidth(text: string, type: Pick<ResolvedType, 'family' | 'bold' | 'custom' | 'mac'>, size: number): number {
  const em = size * assEmFactor(type.family);
  // unknown families (her own / Google / Mac fonts): a bit wider than a typical sans
  const fam = FAMILY_WIDTH[type.family] ?? 1.08;
  let w = 0;
  for (const ch of text) w += charEm(ch);
  return w * em * fam * (type.bold ? 1.07 : 1) * WIDTH_SAFETY;
}

export interface TextLine { text: string; x: number; cy: number }
export interface FitResult { size: number; lines: TextLine[]; height: number; overflow: boolean; top: number; bottom: number }
export type HAlign = 'left' | 'center' | 'right';

/** Greedy word wrap at `width`; a word longer than the width stays alone on its line (`tooLong`). */
export function wrapText(text: string, type: Pick<ResolvedType, 'family' | 'bold' | 'custom' | 'mac'>, size: number, width: number): { lines: string[]; tooLong: boolean } {
  const out: string[] = [];
  let tooLong = false;
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { if (out.length) out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (!line || textWidth(next, type, size) <= width) line = next;
      else { out.push(line); line = w; }
      if (textWidth(w, type, size) > width) tooLong = true;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return { lines: out, tooLong };
}

export interface FitOptions { max: number; min: number; align: HAlign; valign: 'top' | 'center' | 'bottom'; step?: number; textCase?: TextCase }
/** Line advance as a share of the ASS size (libass size = line height). */
const LINE_STEP = 1.12;

/**
 * The largest size (in steps of 2, from `max` down to `min`) at which the text fits the box; at `min` it is laid out anyway
 * and `overflow` is set. Lines carry their anchor x (by alignment) and their vertical centre (ASS `\an4/5/6`, CSS centred).
 */
export function fitText(text: string, box: Box, type: ResolvedType, o: FitOptions): FitResult {
  const t = applyCase(text, o.textCase ?? type.textCase);
  const width = box.x1 - box.x0, height = box.y1 - box.y0;
  const stepK = o.step ?? LINE_STEP;
  const max = Math.round(o.max * type.scale), min = Math.min(Math.round(o.min), max);
  let size = max, wrapped = wrapText(t, type, size, width);
  const h = (n: number, s: number) => (n <= 0 ? 0 : s + (n - 1) * s * stepK);
  while (size > min && (wrapped.tooLong || h(wrapped.lines.length, size) > height)) {
    size = Math.max(min, size - 2);
    wrapped = wrapText(t, type, size, width);
  }
  const lines = wrapped.lines;
  const total = h(lines.length, size);
  const overflow = wrapped.tooLong || total > height + 0.5;
  const top = o.valign === 'top' ? box.y0 : o.valign === 'bottom' ? box.y1 - total : box.y0 + (height - total) / 2;
  const x = o.align === 'left' ? box.x0 : o.align === 'right' ? box.x1 : (box.x0 + box.x1) / 2;
  return {
    size, overflow, height: total, top, bottom: top + total,
    lines: lines.map((text, i) => ({ text, x: Math.round(x), cy: Math.round(top + size / 2 + i * size * stepK) })),
  };
}

// ---------- Layout ----------

export type SlideRole = 'title' | 'body' | 'item' | 'quote' | 'attribution' | 'meta' | 'chip' | 'mark' | 'number';
/** Where a text comes from in the slide (the editor edits exactly that field). */
export type SlideField = 'title' | 'body' | 'attribution' | `item:${number}`;
export type SlideElement =
  | { type: 'rect'; box: Box; color: string; layer: 'under' | 'over' }
  | { type: 'image'; box: Box; imageId: string }
  | { type: 'placeholder'; box: Box; color: string; text: string }
  | { type: 'text'; role: SlideRole; field: SlideField | null; font: 'title' | 'body'; size: number; color: string; align: HAlign; lines: TextLine[]; box: Box; overflow: boolean }
  | { type: 'label'; text: string; x: number; y: number; size: number; box: Box };

export interface SlideProblem { level: 'error' | 'warning'; code: 'overflow' | 'image_missing' | 'image_rights' | 'empty'; message: string; field?: SlideField }
export interface SlideLayout { index: number; width: number; height: number; bg: string; elements: SlideElement[]; problems: SlideProblem[]; aiImage: boolean }

/** What the layout knows about library images (from the store, never from the client). */
export interface CarouselImageInfo { kind: 'image' | 'video'; usage: ImageUsage | null; mime?: string; name?: string }

const MARGIN = 96;
const FOOTER = 64;
const LABEL = { x: 44, y: 40, size: 34, pad: 12 } as const;

/** Text sizes per kind and role (ASS sizes at M; the role's size step S/M/L scales the maximum). */
const SIZES = {
  title: { title: [112, 56], body: [46, 30] },
  text: { title: [76, 44], body: [50, 30] },
  list: { title: [68, 40], item: [46, 28] },
  quote: { quote: [68, 36], attribution: [34, 28] },
  image_text: { title: [62, 40], body: [42, 28] },
  before_after: { title: [60, 40], item: [50, 28], chip: [30, 30] },
  cta: { title: [92, 48], body: [46, 30] },
} as const;

const rx = (b: Box): Box => ({ x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) });

/**
 * The slide `index` of a carousel as boxes, lines and colours (PlayRes = the format's pixels). `images` = her library
 * images (rights, type); a missing or not usable image becomes a placeholder and a problem.
 */
export function layoutSlide(body: Pick<CarouselBody, 'format' | 'templateId' | 'slides' | 'numbering'>, index: number, look: CarouselLook, images: ReadonlyMap<string, CarouselImageInfo> = new Map()): SlideLayout {
  const slide = body.slides[index]!;
  const { width: W, height: H } = CAROUSEL_FORMATS[body.format];
  const tpl = body.templateId;
  const sc = schemeOf(tpl, look.colors, slide.tone);
  const els: SlideElement[] = [];
  const problems: SlideProblem[] = [];
  const m = tpl === 'rahmen' ? MARGIN + 24 : MARGIN;
  const content: Box = { x0: m, y0: m, x1: W - m, y1: H - m - (body.numbering ? FOOTER - 24 : 0) };
  const align: HAlign = tpl === 'kontrast' || tpl === 'rahmen' || slide.kind === 'cta' || slide.kind === 'quote' ? 'center' : 'left';
  const rect = (box: Box, color: string, layer: 'under' | 'over' = 'under') => els.push({ type: 'rect', box: rx(box), color, layer });
  const text = (role: SlideRole, field: SlideField | null, value: string, box: Box, font: 'title' | 'body', range: readonly [number, number], o: Partial<FitOptions> & { color?: string } = {}) => {
    const type = font === 'title' ? look.title : look.body;
    const fit = fitText(value, box, type, { max: range[0], min: range[1], align: o.align ?? align, valign: o.valign ?? 'top', ...(o.textCase ? { textCase: o.textCase } : {}), ...(o.step ? { step: o.step } : {}) });
    const el: SlideElement = { type: 'text', role, field, font, size: fit.size, color: o.color ?? (font === 'title' ? sc.title : sc.body), align: o.align ?? align, lines: fit.lines, box: rx(box), overflow: fit.overflow };
    els.push(el);
    if (fit.overflow && field) problems.push({ level: 'error', code: 'overflow', field, message: `Slide ${index + 1}: ${fieldLabel(field)} passt nicht auf die Slide – bitte kürzen.` });
    return fit;
  };

  // template decoration below everything
  if (tpl === 'rahmen') {
    const i = 40, t = 6;
    for (const b of [{ x0: i, y0: i, x1: W - i, y1: i + t }, { x0: i, y0: H - i - t, x1: W - i, y1: H - i }, { x0: i, y0: i, x1: i + t, y1: H - i }, { x0: W - i - t, y0: i, x1: W - i, y1: H - i }]) rect(b, sc.accent);
  }
  if (tpl === 'karte' && sc.card && sc.shadow) {
    const card: Box = { x0: m - 44, y0: m - 44, x1: W - m + 44, y1: content.y1 + 36 };
    rect({ x0: card.x0 + 16, y0: card.y0 + 16, x1: card.x1 + 16, y1: card.y1 + 16 }, sc.shadow);
    rect(card, sc.card);
  }
  if (tpl === 'editorial') rect({ x0: m, y0: m - 30, x1: W - m, y1: m - 26 }, sc.line);
  let c = { ...content };
  if (tpl === 'editorial') {
    const num = String(index + 1).padStart(2, '0');
    const f = text('number', null, num, { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y0 + 150 }, 'title', [150, 150], { align: 'left', color: sc.accent });
    c = { ...c, y0: f.bottom + 30 };
  }
  const ch = c.y1 - c.y0;
  const bar = (fit: FitResult) => {
    if (tpl === 'klar' && fit.lines.length && align === 'left') rect({ x0: m - 40, y0: fit.top, x1: m - 26, y1: fit.bottom }, sc.accent);
    if (tpl === 'kontrast' && fit.lines.length) rect({ x0: W / 2 - 60, y0: fit.bottom + 22, x1: W / 2 + 60, y1: fit.bottom + 32 }, sc.accent);
  };
  const gap = (fit: FitResult) => (fit.lines.length ? fit.bottom + (tpl === 'kontrast' ? 64 : 40) : c.y0);

  switch (slide.kind) {
    case 'title': {
      const t = text('title', 'title', slide.title, { x0: c.x0, y0: c.y0 + ch * 0.12, x1: c.x1, y1: c.y0 + ch * 0.66 }, 'title', SIZES.title.title, { valign: 'bottom' });
      bar(t);
      if (slide.body) text('body', 'body', slide.body, { x0: c.x0, y0: gap(t), x1: c.x1, y1: c.y1 }, 'body', SIZES.title.body);
      break;
    }
    case 'text':
    case 'cta': {
      const big = slide.kind === 'cta';
      const sz = big ? SIZES.cta : SIZES.text;
      const t = slide.title
        ? text('title', 'title', slide.title, big ? { x0: c.x0, y0: c.y0 + ch * 0.12, x1: c.x1, y1: c.y0 + ch * 0.58 } : { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y0 + ch * 0.36 }, 'title', sz.title, { valign: big ? 'bottom' : 'top' })
        : null;
      if (t) bar(t);
      if (slide.body) {
        const b = text('body', 'body', slide.body, { x0: c.x0, y0: t ? gap(t) : c.y0, x1: c.x1, y1: c.y1 }, 'body', sz.body);
        if (big && b.lines.length && tpl !== 'kontrast') rect({ x0: align === 'center' ? W / 2 - 50 : c.x0, y0: b.bottom + 26, x1: align === 'center' ? W / 2 + 50 : c.x0 + 100, y1: b.bottom + 34 }, sc.accent);
      }
      break;
    }
    case 'list': {
      const t = slide.title ? text('title', 'title', slide.title, { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y0 + ch * 0.28 }, 'title', SIZES.list.title, { align: 'left' }) : null;
      if (t) bar(t);
      listItems(slide.items, { x0: c.x0, y0: t ? gap(t) : c.y0, x1: c.x1, y1: c.y1 }, look, sc, els, problems, index);
      break;
    }
    case 'quote': {
      text('mark', null, '„', { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y0 + 150 }, 'title', [180, 180], { align: 'center', color: sc.accent });
      const q = text('quote', 'body', slide.body, { x0: c.x0, y0: c.y0 + 170, x1: c.x1, y1: c.y1 - (slide.attribution ? 90 : 0) }, 'title', SIZES.quote.quote, { valign: 'center', align: 'center' });
      if (slide.attribution) text('attribution', 'attribution', `– ${slide.attribution}`, { x0: c.x0, y0: q.bottom + 30, x1: c.x1, y1: q.bottom + 30 + 60 }, 'body', SIZES.quote.attribution, { align: 'center' });
      break;
    }
    case 'image_text': {
      const imgBox: Box = rx({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y0 + ch * 0.56 });
      placeImage(slide.imageId, imgBox, images, sc, els, problems, index);
      const t = slide.title ? text('title', 'title', slide.title, { x0: c.x0, y0: imgBox.y1 + 40, x1: c.x1, y1: imgBox.y1 + 40 + ch * 0.18 }, 'title', SIZES.image_text.title) : null;
      if (slide.body) text('body', 'body', slide.body, { x0: c.x0, y0: t ? t.bottom + 28 : imgBox.y1 + 40, x1: c.x1, y1: c.y1 }, 'body', SIZES.image_text.body);
      break;
    }
    case 'before_after': {
      const t = slide.title ? text('title', 'title', slide.title, { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y0 + ch * 0.2 }, 'title', SIZES.before_after.title) : null;
      if (t) bar(t);
      const top = t ? gap(t) : c.y0;
      const half = (c.y1 - top - 32) / 2;
      slide.pairLabels.forEach((raw, i) => {
        const label = raw || (i === 0 ? 'Vorher' : 'Nachher');
        const y0 = top + i * (half + 32);
        const panel: Box = { x0: c.x0, y0, x1: c.x1, y1: y0 + half };
        rect(panel, i === 0 ? mix(sc.bg, sc.body, 0.08) : mix(sc.bg, sc.accent, 0.22));
        const chipW = Math.round(textWidth(label, look.body, 30) + 40);
        rect({ x0: panel.x0 + 28, y0: panel.y0 + 28, x1: panel.x0 + 28 + chipW, y1: panel.y0 + 28 + 52 }, sc.accent, 'over');
        text('chip', null, label, { x0: panel.x0 + 28, y0: panel.y0 + 28, x1: panel.x0 + 28 + chipW, y1: panel.y0 + 80 }, 'body', [30, 30], { align: 'center', valign: 'center', color: sc.onAccentChip, textCase: 'none' });
        const fg = textOn(i === 0 ? mix(sc.bg, sc.body, 0.08) : mix(sc.bg, sc.accent, 0.22), sc.body, sc.title);
        text('item', `item:${i}`, slide.items[i] ?? '', { x0: panel.x0 + 28, y0: panel.y0 + 104, x1: panel.x1 - 28, y1: panel.y1 - 24 }, 'body', SIZES.before_after.item, { align: 'left', valign: 'center', color: fg });
      });
      break;
    }
  }

  // empty slides are a problem (an empty picture would be posted)
  const hasText = els.some((e) => e.type === 'text' && e.field && e.lines.some((l) => l.text.trim()));
  if (!hasText && slide.kind !== 'image_text') problems.push({ level: 'error', code: 'empty', message: `Slide ${index + 1} ist leer.` });
  if (slide.kind === 'image_text' && !hasText && !slide.imageId) problems.push({ level: 'error', code: 'empty', message: `Slide ${index + 1} ist leer.` });

  if (body.numbering) text('meta', null, `${index + 1}/${body.slides.length}`, { x0: W - m - 200, y0: H - m + 4, x1: W - m + (tpl === 'rahmen' ? 0 : 20), y1: H - m + 44 }, 'body', [28, 28], { align: 'right', valign: 'center', color: sc.body, textCase: 'none' });

  // a generated image: the label on the slide, last element = drawn above everything
  const info = slide.imageId ? images.get(slide.imageId) : undefined;
  const aiImage = !!(slide.kind === 'image_text' && slide.imageId && info?.usage?.origin === 'generated' && !imageRightsProblem(info));
  if (aiImage) {
    const w = Math.round(textWidth(CAROUSEL_AI_LABEL, { family: 'Arial', bold: true, custom: false }, LABEL.size));
    els.push({ type: 'label', text: CAROUSEL_AI_LABEL, x: LABEL.x, y: LABEL.y, size: LABEL.size, box: { x0: LABEL.x - LABEL.pad, y0: LABEL.y - LABEL.pad, x1: LABEL.x + w + LABEL.pad, y1: LABEL.y + LABEL.size + LABEL.pad } });
  }
  return { index, width: W, height: H, bg: sc.bg, elements: els, problems, aiImage };
}

/** Numbered items with a chip (accent square + number) and a common size. */
function listItems(items: readonly string[], box: Box, look: CarouselLook, sc: Scheme, els: SlideElement[], problems: SlideProblem[], index: number) {
  // review fix: keep each item's own index (identical texts must not map to the first one)
  const entries = items.map((t, i) => ({ t: t.trim(), i })).filter((x) => x.t);
  const list = entries.map((x) => x.t);
  if (!list.length) return;
  const chip = 56, indent = chip + 28, gapY = 26;
  const inner: Box = { x0: box.x0 + indent, y0: box.y0, x1: box.x1, y1: box.y1 };
  const [max, min] = SIZES.list.item;
  let size = Math.round(max * look.body.scale);
  const layoutAt = (s: number) => {
    let y = box.y0;
    const out = list.map((t) => {
      const f = fitText(t, { x0: inner.x0, y0: y, x1: inner.x1, y1: 1e6 }, look.body, { max: s, min: s, align: 'left', valign: 'top' });
      const r = { f, y0: y };
      y = f.bottom + gapY;
      return r;
    });
    return { out, bottom: y - gapY, tooLong: out.some((r) => r.f.overflow) };
  };
  let res = layoutAt(size);
  while (size > min && (res.bottom > box.y1 || res.tooLong)) { size = Math.max(min, size - 2); res = layoutAt(size); }
  const overflow = res.bottom > box.y1 + 0.5 || res.tooLong;
  res.out.forEach(({ f, y0 }, i) => {
    const firstCy = f.lines[0]?.cy ?? y0 + size / 2;
    const cb: Box = { x0: box.x0, y0: firstCy - chip / 2, x1: box.x0 + chip, y1: firstCy + chip / 2 };
    els.push({ type: 'rect', box: rx(cb), color: sc.accent, layer: 'over' });
    els.push({ type: 'text', role: 'chip', field: null, font: 'title', size: 32, color: sc.onAccentChip, align: 'center', lines: [{ text: String(i + 1), x: Math.round((cb.x0 + cb.x1) / 2), cy: Math.round(firstCy) }], box: rx(cb), overflow: false });
    els.push({ type: 'text', role: 'item', field: `item:${entries[i]!.i}`, font: 'body', size, color: sc.body, align: 'left', lines: f.lines, box: rx({ x0: inner.x0, y0, x1: inner.x1, y1: f.bottom }), overflow });
  });
  if (overflow) problems.push({ level: 'error', code: 'overflow', field: 'item:0', message: `Slide ${index + 1}: die Liste passt nicht auf die Slide – Punkte kürzen oder auf zwei Slides verteilen.` });
}

function placeImage(id: string | null, box: Box, images: ReadonlyMap<string, CarouselImageInfo>, sc: Scheme, els: SlideElement[], problems: SlideProblem[], index: number) {
  if (!id) {
    els.push({ type: 'placeholder', box, color: mix(sc.bg, sc.body, 0.1), text: 'Bild aus der Bibliothek wählen' });
    problems.push({ level: 'warning', code: 'image_missing', message: `Slide ${index + 1}: noch kein Bild gewählt.` });
    return;
  }
  const info = images.get(id);
  const why = !info ? 'Das Bild gibt es in der Bibliothek nicht (mehr).' : info.mime && !IMAGE_OVERLAY_MIMES.includes(info.mime) ? 'Nur PNG, JPEG oder WebP.' : imageRightsProblem(info);
  if (why) {
    els.push({ type: 'placeholder', box, color: mix(sc.bg, sc.body, 0.1), text: 'Bild nicht nutzbar' });
    problems.push({ level: 'error', code: info ? 'image_rights' : 'image_missing', message: `Slide ${index + 1}: ${why}` });
    return;
  }
  els.push({ type: 'image', box, imageId: id });
}

/** Mixes two colours (t = share of b). */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(p(a, i) * (1 - t) + p(b, i) * t).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export const fieldLabel = (f: SlideField) => (f === 'title' ? 'Titel' : f === 'body' ? 'Text' : f === 'attribution' ? 'Quelle' : `Punkt ${Number(f.slice(5)) + 1}`);

/** All slides of a carousel. */
export const layoutCarousel = (body: Pick<CarouselBody, 'format' | 'templateId' | 'slides' | 'numbering'>, look: CarouselLook, images?: ReadonlyMap<string, CarouselImageInfo>) =>
  body.slides.map((_, i) => layoutSlide(body, i, look, images));

// ---------- ASS (FFmpeg + libass, the video's font pipeline) ----------

/** Layer of the AI label: above every other line of the slide. */
export const SLIDE_LABEL_LAYER = 9;
const n0 = (x: number) => String(Math.round(x));
const rectPath = (w: number, h: number) => `m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h}`;
const AN: Record<HAlign, number> = { left: 4, center: 5, right: 6 };
/** ASS clock `h:mm:ss.cc`. */
const assClock = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/**
 * Two ASS files of one slide: `under` (decoration below her image) and `over` (text, chips, the AI label). FFmpeg draws
 * colour → under → image → over. Every text line is its own event at the core's position, `\q2` (libass never wraps), so
 * the picture has exactly the core's lines. Text is escaped (`escapeAss`): slide texts cannot inject ASS tags.
 */
export function slideAss(layout: SlideLayout, look: CarouselLook, opts: { endSec?: number } = {}): { under: string; over: string } {
  // Etappe 19: a clip story runs up to 15 s – its events must last that long (stills keep the old 10 s)
  const end = opts.endSec ? assClock(opts.endSec) : '0:00:10.00';
  const head = (styles: string[]) => [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${layout.width}`, `PlayResY: ${layout.height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Shape,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    ...styles,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const style = (name: string, t: ResolvedType) => `Style: ${name},${t.assName},40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,${t.bold ? -1 : 0},${t.italic ? -1 : 0},0,0,100,100,0,0,1,0,0,5,0,0,0,1`;
  const ev = (layer: number, st: string, body: string) => `Dialogue: ${layer},0:00:00.00,${end},${st},,0,0,0,,${body}`;
  const shape = (layer: number, b: Box, color: string) => ev(layer, 'Shape', `{\\an7\\pos(${n0(b.x0)},${n0(b.y0)})\\1c${hexToAssTag(color)}\\1a&H00&\\bord0\\shad0\\p1}${rectPath(Math.max(1, Math.round(b.x1 - b.x0)), Math.max(1, Math.round(b.y1 - b.y0)))}{\\p0}`);
  const under: string[] = [], over: string[] = [];
  for (const e of layout.elements) {
    if (e.type === 'rect') (e.layer === 'under' ? under : over).push(shape(e.layer === 'under' ? 0 : 1, e.box, e.color));
    else if (e.type === 'placeholder') under.push(shape(0, e.box, e.color));
    else if (e.type === 'text') {
      const st = e.font === 'title' ? 'Title' : 'Body';
      for (const l of e.lines) if (l.text.trim()) over.push(ev(2, st, `{\\an${AN[e.align]}\\pos(${n0(l.x)},${n0(l.cy)})\\fs${e.size}\\q2\\1c${hexToAssTag(e.color)}}${escapeAss(l.text)}`));
    } else if (e.type === 'label') {
      // fixed font and colours (like the video's AI label): boxed, white on black, top left, last line of the file
      over.push(`Dialogue: ${SLIDE_LABEL_LAYER},0:00:00.00,${end},Label,,0,0,0,,{\\an7\\pos(${e.x},${e.y})}${escapeAss(e.text)}`);
    }
  }
  const labelStyle = `Style: Label,Arial,${LABEL.size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,${LABEL.pad},0,7,0,0,0,1`;
  return {
    under: `${[...head([]), ...under].join('\n')}\n`,
    over: `${[...head([style('Title', look.title), style('Body', look.body), labelStyle]), ...over].join('\n')}\n`,
  };
}
/** The fonts a carousel draws with (for `fontsdir`, the cache key and the render's font check). */
export const carouselFontTypes = (look: CarouselLook): ResolvedType[] => [look.title, look.body];
export { hexToAssStyle };

// ---------- Issues: rights, overflow, claims, slop, checklist ----------

export interface CarouselRules {
  /** Verified facts and her own source text: figures there are hers (concept facts, transcript, her note). */
  sources: readonly string[];
  /** Claims flagged in the source's lineage (script `claimsToVerify`). */
  flagged: readonly string[];
}
export interface CarouselIssue { slide: number | null; level: 'error' | 'warning'; code: string; message: string; field?: SlideField }
export interface CarouselReview {
  issues: CarouselIssue[];
  slop: { slide: number | null; field: SlideField | 'caption'; hints: SlopHint[] }[];
  checklist: { id: ChecklistId; text: string; ok: boolean }[];
  /** Slides with a generated image (1-based): the label is on them, the caption gets the AI label. */
  aiSlides: number[];
  /** Labels the caption must start with. */
  requiredLabels: string[];
  errors: number;
}

/** Testimonial, praise by others, guarantees – never invented (also in her edits: a hint). */
export const CAROUSEL_TESTIMONIAL = /\b(?:kund(?:in|innen|en)|follower(?:innen)?|zuschauer(?:innen)?|alle|jede[rs]?|viele|tausende)\s+(?:sagen|sagt|lieben|liebt|schwören|schwört|feiern|bestätigen)\b|\btestimonial|\b\d+\s*(?:sterne|bewertungen)\b|\b(?:bewiesen|garantiert|wissenschaftlich belegt)\b/i;
const numberKey = (n: string) => n.toLowerCase().replace(/\s+/g, '').replace(',', '.');
/** Figures in a text that do not appear in any source (whole tokens: „5“ is not in „50“). */
export function unsupportedNumbers(text: string, sources: readonly string[]): string[] {
  const known = new Set(sources.flatMap((s) => (s.match(NUMBER_RE) ?? []).map(numberKey)));
  return [...new Set((text.match(NUMBER_RE) ?? []).map((n) => n.trim()).filter((n) => !known.has(numberKey(n))))];
}
const deniesLabel = (t: string) => AD_DENIAL.test(t) || AI_DENIAL.test(t) || BURNED_AD_DENIAL.test(t) || BURNED_AI_DENIAL.test(t);

/** Texts of a slide with their field (for lint and the chat). */
export function slideTexts(s: Slide): { field: SlideField; text: string }[] {
  const out: { field: SlideField; text: string }[] = [];
  if (s.title) out.push({ field: 'title', text: s.title });
  if (s.body) out.push({ field: 'body', text: s.body });
  s.items.forEach((t, i) => { if (t) out.push({ field: `item:${i}`, text: t }); });
  if (s.attribution) out.push({ field: 'attribution', text: s.attribution });
  return out;
}
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const isBait = (t: string) => slopHints(t, 'caption').some((h) => h.kind === 'engagement_bait');

/**
 * Everything the editor and the export check. Errors (overflow, image rights, empty slide, flagged claims, a text that
 * denies a label) block the export; the rest are hints.
 */
export function reviewCarousel(body: CarouselBody, look: CarouselLook, images: ReadonlyMap<string, CarouselImageInfo>, rules: CarouselRules): CarouselReview {
  const layouts = layoutCarousel(body, look, images);
  const issues: CarouselIssue[] = [];
  const slop: CarouselReview['slop'] = [];
  for (const l of layouts) for (const p of l.problems) issues.push({ slide: l.index + 1, level: p.level, code: p.code, message: p.message, ...(p.field ? { field: p.field } : {}) });
  body.slides.forEach((s, i) => {
    const n = i + 1;
    for (const { field, text } of slideTexts(s)) {
      const where = `Slide ${n} (${fieldLabel(field)})`;
      const flagged = claimsInText(rules.flagged, text);
      if (flagged.length) issues.push({ slide: n, level: 'error', code: 'flagged_claim', field, message: `${where}: ungeprüfter Claim „${flagged.join(' · ')}“ – erst belegen oder streichen.` });
      if (deniesLabel(text)) issues.push({ slide: n, level: 'error', code: 'label_denial', field, message: `${where} bestreitet eine Kennzeichnung (z. B. „ohne KI“, „keine Werbung“).` });
      const nums = unsupportedNumbers(text, rules.sources);
      if (nums.length) issues.push({ slide: n, level: 'warning', code: 'number', field, message: `${where}: Zahl ohne Beleg (${nums.join(', ')}) – nur echte, belegte Werte.` });
      if (CAROUSEL_TESTIMONIAL.test(text)) issues.push({ slide: n, level: 'warning', code: 'testimonial', field, message: `${where} klingt nach Testimonial, Garantie oder fremdem Lob – nur Echtes.` });
      if (URL_RE.test(text)) issues.push({ slide: n, level: 'warning', code: 'link', field, message: `${where}: Links sind auf Bildern nicht klickbar.` });
      const hints = slopHints(text, 'overlay');
      if (hints.length) slop.push({ slide: n, field, hints });
    }
    if (s.kind === 'quote' && s.attribution && !rules.sources.some((src) => normClaim(src).includes(normClaim(s.body)) && normClaim(src).includes(normClaim(s.attribution))))
      issues.push({ slide: n, level: 'warning', code: 'quote_source', field: 'attribution', message: `Slide ${n}: Zitat mit Namen – nur echte, belegte Zitate (keine erfundenen Testimonials).` });
  });
  const aiSlides = layouts.filter((l) => l.aiImage).map((l) => l.index + 1);
  const requiredLabels = aiSlides.length ? [AI_DISCLOSURE] : [];
  // review fix: the label is required also when the caption is empty (an image re-tagged as generated after saving)
  if (requiredLabels.length && !body.caption.startsWith(disclosurePrefix(requiredLabels))) issues.push({ slide: null, level: 'error', code: 'caption_label', message: `Caption: Kennzeichnung „${AI_DISCLOSURE}“ fehlt am Anfang (KI-Bild auf Slide ${aiSlides.join(', ')}).` });
  if (body.caption) {
    const hints = slopHints(body.caption, 'caption');
    if (hints.length) slop.push({ slide: null, field: 'caption', hints });
    if (deniesLabel(body.caption)) issues.push({ slide: null, level: 'error', code: 'label_denial', message: 'Caption bestreitet eine Kennzeichnung.' });
    const flagged = claimsInText(rules.flagged, body.caption);
    if (flagged.length) issues.push({ slide: null, level: 'error', code: 'flagged_claim', message: `Caption: ungeprüfter Claim „${flagged.join(' · ')}“.` });
    const nums = unsupportedNumbers(body.caption, rules.sources);
    if (nums.length) issues.push({ slide: null, level: 'warning', code: 'number', message: `Caption: Zahl ohne Beleg (${nums.join(', ')}).` });
  }
  const first = body.slides[0]!;
  const last = body.slides[body.slides.length - 1]!;
  const lastText = slideTexts(last).map((t) => t.text).join(' ');
  const checklist: CarouselReview['checklist'] = CHECKLIST.map((c) => ({
    id: c.id, text: c.text,
    ok: c.id === 'cover' ? !!(first.title || first.body) && wordCount(first.title || first.body) <= 8
      : c.id === 'one_idea' ? body.slides.every((s) => wordCount(slideTexts(s).map((t) => t.text).join(' ')) <= 40)
        : c.id === 'one_template' ? true
          : c.id === 'ask' ? last.kind === 'cta' && !!lastText && !isBait(lastText)
            : c.id === 'facts' ? !issues.some((x) => x.code === 'number' || x.code === 'flagged_claim' || x.code === 'quote_source' || x.code === 'testimonial')
              : c.id === 'labels' ? layouts.every((l) => !l.elements.some((e) => e.type === 'image') || !l.aiImage || l.elements.some((e) => e.type === 'label'))
                : !issues.some((x) => x.code === 'overflow'),
  }));
  return { issues, slop, checklist, aiSlides, requiredLabels, errors: issues.filter((x) => x.level === 'error').length };
}

export const CAPTION_LIMIT = 2200;
/**
 * The caption with the labels it needs at the very start (never removed; an existing prefix is kept). Review fix: the
 * result stays within Instagram's 2200 characters – the tail is cut, never the label.
 */
export function ensureCaptionLabels(caption: string, labels: readonly string[]): string {
  if (!labels.length) return caption;
  const prefix = disclosurePrefix([...labels]);
  const out = caption.startsWith(prefix) ? caption : `${prefix}${caption}`;
  return out.slice(0, CAPTION_LIMIT);
}

// ---------- Editing operations (editor, chat) ----------

/** A new slide of a kind (empty texts; list/before-after get their item slots). */
export function emptySlide(kind: SlideKind, slides: readonly Pick<Slide, 'id'>[]): Slide {
  return Slide.parse({ id: newSlideId(slides), kind, items: kind === 'before_after' ? ['', ''] : kind === 'list' ? [''] : [] });
}
/** Changes the kind of a slide; texts move along where the new kind has a place for them (nothing is lost silently). */
export function changeKind(s: Slide, kind: SlideKind): Slide {
  if (s.kind === kind) return s;
  const fields = SLIDE_FIELDS[kind];
  let { title, body, items, attribution } = s;
  if (!fields.includes('items') && items.length) { body = [body, ...items.filter(Boolean).map((x) => `• ${x}`)].filter(Boolean).join('\n'); items = []; }
  if (fields.includes('items') && !items.length) { items = body ? body.split(/\n+|(?<=[.!?])\s+/).map((x) => x.replace(/^•\s*/, '').trim()).filter(Boolean).slice(0, kind === 'before_after' ? 2 : SLIDE_TEXT_MAX.items) : []; body = ''; }
  if (kind === 'before_after') items = [items[0] ?? '', items[1] ?? ''];
  if (!fields.includes('title') && title) { body = [title, body].filter(Boolean).join('\n'); title = ''; }
  if (!fields.includes('body') && body) { title = title || body.split('\n')[0]!.slice(0, SLIDE_TEXT_MAX.title); body = ''; }
  if (!fields.includes('attribution')) attribution = '';
  return Slide.parse({ ...s, kind, title, body, items, attribution, imageId: fields.includes('image') ? s.imageId : null });
}
/** Moves slide `from` to `to` (0-based). */
export function moveSlide(slides: readonly Slide[], from: number, to: number): Slide[] {
  const out = [...slides];
  if (from < 0 || from >= out.length) return out;
  const [s] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, s!);
  return out;
}

const sentences = (t: string) => t.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
/** A shorter version of a text (deterministic): its first sentence, else the first ~60 % of the words at a word boundary. */
export function shortenText(t: string): string {
  const s = sentences(t);
  if (s.length > 1) return s[0]!;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return t;
  return `${words.slice(0, Math.max(3, Math.ceil(words.length * 0.6))).join(' ').replace(/[,;:–-]$/, '')} …`;
}

/**
 * Deterministic resize to `n` slides: fewer = middle slides from the end of the middle go (first and last stay); more =
 * the longest text slide with at least two sentences is split. Returns what happened (chat card, warnings).
 */
export function resizeCarousel(body: CarouselBody, n: number): { body: CarouselBody; notes: string[] } {
  const want = Math.max(CAROUSEL_MIN_SLIDES, Math.min(CAROUSEL_MAX_SLIDES, Math.round(n)));
  let slides = [...body.slides];
  const notes: string[] = [];
  while (slides.length > want) {
    const i = slides.length - 2 >= 1 ? slides.length - 2 : slides.length - 1;
    notes.push(`Slide „${(slides[i]!.title || slides[i]!.body || SLIDE_KIND_LABEL[slides[i]!.kind]).slice(0, 40)}“ entfällt.`);
    slides.splice(i, 1);
  }
  while (slides.length < want) {
    const cand = slides.map((s, i) => ({ s, i, parts: sentences(s.body) })).filter((x) => (x.s.kind === 'text' || x.s.kind === 'title') && x.parts.length >= 2 && x.i > 0)
      .sort((a, b) => b.s.body.length - a.s.body.length || a.i - b.i)[0];
    if (!cand) break;
    const half = Math.ceil(cand.parts.length / 2);
    const a = { ...cand.s, body: cand.parts.slice(0, half).join(' ') };
    const b = Slide.parse({ id: newSlideId(slides), kind: 'text', title: '', body: cand.parts.slice(half).join(' ') });
    slides = [...slides.slice(0, cand.i), a, b, ...slides.slice(cand.i + 1)];
    notes.push(`Slide ${cand.i + 1} in zwei Slides geteilt.`);
  }
  if (slides.length < want) notes.push(`Nur ${slides.length} Slides möglich – es gibt keinen Text mehr zum Teilen.`);
  return { body: CarouselBody.parse({ ...body, slides }), notes };
}
