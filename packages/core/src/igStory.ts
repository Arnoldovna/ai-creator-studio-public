/**
 * Instagram-Stories (Etappe 19): quick 9:16 stories from material she already has – a finished reel (a still or a clip of
 * at most 15 s), a carousel (its first slide as a card), her library photos, footage of a draft, a note – in the look of
 * „Meine Marke“. Pure and deterministic. (Not to be confused with `story.ts`, the dramaturgy of a reel, Etappe 16.)
 *
 * - `IgStoryBody` is what a story stores: kind (teaser, behind the scenes, question, quote, progress), the media (none,
 *   library image, carousel slide, reel still, clip), kicker/title/body, the text position, a sticker NOTE and her notes.
 * - Stickers (poll, question, quiz, slider, link) cannot be made by the studio: the layout keeps a free area for them
 *   (`sticker` box, shown only in the preview, never burned in) and the export writes what to set in Instagram.
 * - Safe zones: Instagram covers the top (progress bar, profile) and the bottom (reply bar). Every text and the AI label
 *   stay inside `STORY_SAFE`; media may run full bleed.
 * - `layoutIgStory` returns the carousel's `SlideLayout` shape, so the same ASS writer (`slideAss`, FFmpeg + libass, the
 *   video's font pipeline) and the same browser preview (`SlideCanvas`) draw it.
 * - A generated image/clip (library image marked generated, generated footage, a reel with AI clips, a carousel slide with
 *   an AI image) puts the label „KI-generiert“ on the story, inside the safe zone, drawn last.
 */
import { z } from 'zod';
import { claimsInText } from './claims';
import { AD_DENIAL, AI_DENIAL, URL_RE } from './agents/scriptAgents';
import { CAROUSEL_AI_LABEL, CAROUSEL_TESTIMONIAL, fitText, mix, textWidth, unsupportedNumbers, type CarouselLook, type FitResult, type HAlign, type SlideElement, type SlideLayout, type SlideProblem, type SlideRole } from './carousel';
import { contrastRatio, readableOn, AA_TEXT } from './lookBase';
import { BURNED_AD_DENIAL, BURNED_AI_DENIAL } from './overlays';
import type { Box } from './overlayLayout';
import { slopHints, type SlopHint } from './slopLint';
import { collapseWs } from './text';

// ---------- Format, safe zones, kinds ----------

export const IG_STORY_SIZE = { width: 1080, height: 1920 } as const;
/**
 * Areas Instagram covers on a story (1080 × 1920): about 250 px at the top (progress bar, profile, close) and about 340 px
 * at the bottom (reply field, reactions). Text and labels stay inside; a little side margin keeps text off the edges.
 */
export const IG_STORY_SAFE = { top: 250, bottom: 340, side: 72 } as const;
export const IG_STORY_SAFE_BOX: Box = { x0: IG_STORY_SAFE.side, y0: IG_STORY_SAFE.top, x1: IG_STORY_SIZE.width - IG_STORY_SAFE.side, y1: IG_STORY_SIZE.height - IG_STORY_SAFE.bottom };
export const IG_STORY_CLIP_MAX_SEC = 15;
export const IG_STORY_CLIP_MIN_SEC = 1;
export const IG_STORY_AI_LABEL = CAROUSEL_AI_LABEL;

export const IG_STORY_KINDS = ['teaser', 'bts', 'question', 'quote', 'progress'] as const;
export const IgStoryKind = z.enum(IG_STORY_KINDS);
export type IgStoryKind = z.infer<typeof IgStoryKind>;
export const IG_STORY_KIND_LABEL: Record<IgStoryKind, string> = {
  teaser: 'Teaser (neuer Beitrag)', bts: 'Hinter den Kulissen', question: 'Frage / Umfrage', quote: 'Zitat', progress: 'Fortschritt',
};

/** Stickers live in Instagram: the studio only leaves room and writes a note. */
export const IG_STICKER_KINDS = ['none', 'poll', 'question', 'quiz', 'slider', 'link'] as const;
export const IgStickerKind = z.enum(IG_STICKER_KINDS);
export type IgStickerKind = z.infer<typeof IgStickerKind>;
export const IG_STICKER_LABEL: Record<IgStickerKind, string> = { none: 'kein Sticker', poll: 'Umfrage', question: 'Fragen-Sticker', quiz: 'Quiz', slider: 'Emoji-Slider', link: 'Link-Sticker' };

const Line = (max: number) => z.string().max(max * 2).transform((s) => collapseWs(s, max));
const Txt = (max: number) => z.string().max(max * 2).transform((s) => s.replace(/\r\n?/g, '\n').replace(/[\t\v\f]+/g, ' ').replace(/[ \u00a0]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max));
const Id = z.string().min(1).max(100);
const Sec = z.number().finite().min(0).max(36_000);

/** What the story shows behind/next to the text. Ids are checked against the store (rights, project) by the studio. */
export const IgStoryMedia = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('image'), imageId: Id }).strict(),
  z.object({ kind: z.literal('carousel_slide'), carouselId: Id, n: z.number().int().min(1).max(10) }).strict(),
  z.object({ kind: z.literal('frame'), renderId: Id, atSec: Sec }).strict(),
  z.object({
    kind: z.literal('clip'), source: z.enum(['render', 'footage']), id: Id, startSec: Sec,
    durationSec: z.number().finite().min(IG_STORY_CLIP_MIN_SEC).max(IG_STORY_CLIP_MAX_SEC),
  }).strict(),
]);
export type IgStoryMedia = z.infer<typeof IgStoryMedia>;
export const IG_MEDIA_LABEL: Record<IgStoryMedia['kind'], string> = { none: 'nur Farbe', image: 'Foto aus der Bibliothek', carousel_slide: 'Karussell-Slide', frame: 'Standbild aus dem Reel', clip: 'Clip (≤ 15 s)' };

export const IgSticker = z.object({
  kind: IgStickerKind.default('none'),
  /** The question / prompt she types into the sticker in Instagram. */
  prompt: Line(120).default(''),
  /** Poll/quiz answers (at most 4). */
  options: z.array(Line(40)).max(4).default([]),
}).strict();
export type IgSticker = z.infer<typeof IgSticker>;

export const IG_STORY_VERSION = 1;
export const IG_STORY_TEXT_MAX = { kicker: 40, title: 140, body: 240, notes: 400 } as const;
export const IgStoryBody = z.object({
  version: z.literal(IG_STORY_VERSION).default(IG_STORY_VERSION),
  kind: IgStoryKind,
  media: IgStoryMedia.default({ kind: 'none' }),
  /** `full` = media full bleed with text on boxes; `card` = media as an inset card on her background colour. */
  fit: z.enum(['full', 'card']).default('full'),
  /** Background when there is no full-bleed media: her background colour or her main colour. */
  tone: z.enum(['default', 'accent']).default('default'),
  textPos: z.enum(['top', 'center', 'bottom']).default('center'),
  kicker: Line(IG_STORY_TEXT_MAX.kicker).default(''),
  title: Txt(IG_STORY_TEXT_MAX.title).default(''),
  body: Txt(IG_STORY_TEXT_MAX.body).default(''),
  sticker: IgSticker.default({ kind: 'none', prompt: '', options: [] }),
  /** Her own posting notes (go into the export). */
  notes: Txt(IG_STORY_TEXT_MAX.notes).default(''),
}).strict();
export type IgStoryBody = z.infer<typeof IgStoryBody>;
export type IgStoryBodyInput = z.input<typeof IgStoryBody>;

export const igStoryMode = (b: Pick<IgStoryBody, 'media'>): 'still' | 'clip' => (b.media.kind === 'clip' ? 'clip' : 'still');

/** Stable key of a media item (the render service and the preview resolve it to a file / URL). */
export function igMediaKey(m: IgStoryMedia): string | null {
  switch (m.kind) {
    case 'none': return null;
    case 'image': return `ref:${m.imageId}`;
    case 'carousel_slide': return `slide:${m.carouselId}:${m.n}`;
    case 'frame': return `frame:${m.renderId}:${Math.round(m.atSec * 100) / 100}`;
    case 'clip': return `clip:${m.source}:${m.id}:${Math.round(m.startSec * 100) / 100}:${Math.round(m.durationSec * 100) / 100}`;
  }
}

// ---------- Layout ----------

/** What the studio knows about the story's media (from the store, never from the client). */
export interface IgMediaInfo {
  /** null = usable; otherwise why not (missing, rights, wrong project …). */
  problem: string | null;
  /** Generated (AI) material → the label on the story. */
  ai: boolean;
  /** width / height of the media (card size); default 9:16 for video/frames, 4:5 for slides. */
  aspect?: number;
  label?: string;
}

export type IgStoryField = 'kicker' | 'title' | 'body';
/** The preview edits fields through the carousel's field names: kicker ↔ `attribution`. */
export const IG_FIELD_OF_SLIDE: Record<'title' | 'body' | 'attribution', IgStoryField> = { title: 'title', body: 'body', attribution: 'kicker' };
const SLIDE_FIELD_OF: Record<IgStoryField, 'title' | 'body' | 'attribution'> = { title: 'title', body: 'body', kicker: 'attribution' };
export const IG_FIELD_LABEL: Record<IgStoryField, string> = { kicker: 'Kicker (kleine Zeile)', title: 'Haupttext', body: 'Zusatztext' };

export interface IgStoryLayout extends SlideLayout {
  mode: 'still' | 'clip';
  safe: Box;
  /** The free area for an Instagram sticker (preview only, never burned in). */
  sticker: Box | null;
  /** Where the media sits (full canvas or the card). */
  mediaBox: Box | null;
}

const textOn = (bg: string, ...candidates: string[]) => candidates.find((c) => contrastRatio(c, bg) >= AA_TEXT) ?? readableOn(bg);
const rx = (b: Box): Box => ({ x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) });
const STICKER = { w: 760, h: 280, gap: 56 } as const;
const LABEL = { size: 34, pad: 12 } as const;
const GAP = 28;
const PILL = 22;
/** ASS sizes [max, min] per role; the role's size step (S/M/L) scales the maximum. */
const SIZES = {
  kicker: [40, 30],
  title: { teaser: [104, 52], bts: [88, 46], question: [92, 48], quote: [84, 44], progress: [92, 48] },
  body: [50, 32],
} as const;
const DEFAULT_POS: Record<IgStoryKind, IgStoryBody['textPos']> = { teaser: 'bottom', bts: 'bottom', question: 'top', quote: 'center', progress: 'center' };
/** The text position a new story of this kind starts with. */
export const defaultTextPos = (kind: IgStoryKind) => DEFAULT_POS[kind];

const shiftFit = (f: FitResult, dy: number): FitResult => ({ ...f, top: f.top + dy, bottom: f.bottom + dy, lines: f.lines.map((l) => ({ ...l, cy: Math.round(l.cy + dy) })) });

/** The box around the drawn lines (+ padding): the colour box behind text on a full-bleed picture. */
function linesBox(f: FitResult, align: HAlign, type: CarouselLook['title'], pad: number): Box {
  let x0 = Infinity, x1 = -Infinity;
  for (const l of f.lines) {
    if (!l.text.trim()) continue;
    const w = textWidth(l.text, type, f.size);
    const a = align === 'left' ? l.x : align === 'right' ? l.x - w : l.x - w / 2;
    x0 = Math.min(x0, a);
    x1 = Math.max(x1, a + w);
  }
  return { x0: x0 - pad, y0: f.top - pad * 0.6, x1: x1 + pad, y1: f.bottom + pad * 0.6 };
}

/**
 * The story as boxes, lines and colours (PlayRes 1080 × 1920). `media` = what the studio knows about its media (null =
 * none). Text is fitted (largest size that fits), stacked kicker → title → body, and placed at the chosen position
 * inside the safe zone; a sticker area is kept free when a sticker is planned.
 */
export function layoutIgStory(body: IgStoryBody, look: CarouselLook, media: IgMediaInfo | null): IgStoryLayout {
  const { width: W, height: H } = IG_STORY_SIZE;
  const safe = { ...IG_STORY_SAFE_BOX };
  const c = look.colors;
  const els: SlideElement[] = [];
  const problems: SlideProblem[] = [];
  const hasMedia = body.media.kind !== 'none';
  const usable = hasMedia && !!media && !media.problem;
  const card = hasMedia && body.fit === 'card';
  const bg = body.tone === 'accent' ? (c.primary === c.background ? c.accent : c.primary) : c.background;
  const onBg = { title: textOn(bg, body.tone === 'accent' ? c.onAccent : c.primary, c.onSurface, c.background), body: textOn(bg, body.tone === 'accent' ? c.onAccent : c.onSurface, c.primary, c.background) };
  const accentOnBg = contrastRatio(c.accent, bg) >= 1.6 ? c.accent : onBg.title;
  // full-bleed media: text sits on boxes in her surface colour
  const pill = hasMedia && !card;
  const pillFg = textOn(c.surface, c.onSurface, c.background);
  const kickerOnPill = textOn(c.surface, c.accent, c.onSurface);
  const align: HAlign = body.kind === 'quote' || body.textPos === 'center' ? 'center' : 'left';
  const ai = !!(usable && media?.ai);

  // the AI label first in the safe zone (drawn last)
  let region: Box = { ...safe };
  let label: Extract<SlideElement, { type: 'label' }> | null = null;
  if (ai) {
    const w = Math.round(textWidth(IG_STORY_AI_LABEL, { family: 'Arial', bold: true, custom: false }, LABEL.size));
    const x = safe.x0 + LABEL.pad, y = safe.y0 + LABEL.pad;
    label = { type: 'label', text: IG_STORY_AI_LABEL, x, y, size: LABEL.size, box: { x0: x - LABEL.pad, y0: y - LABEL.pad, x1: x + w + LABEL.pad, y1: y + LABEL.size + LABEL.pad } };
    region = { ...region, y0: label.box.y1 + 24 };
  }

  const wantSticker = body.sticker.kind !== 'none';
  // card: text on top, the card below; otherwise the whole region for text (minus the sticker area)
  const textMaxH = card ? Math.min(560, (region.y1 - region.y0) * 0.36) : (region.y1 - region.y0) - (wantSticker ? STICKER.h + STICKER.gap : 0);
  const inner: Box = pill ? { x0: region.x0 + PILL, y0: region.y0, x1: region.x1 - PILL, y1: region.y1 } : region;

  // fit each text at y = 0 (placed afterwards)
  type Part = { role: SlideRole; field: IgStoryField | null; font: 'title' | 'body'; fit: FitResult; color: string; align: HAlign; type: CarouselLook['title'] };
  const parts: Part[] = [];
  const fitPart = (role: SlideRole, field: IgStoryField | null, text: string, font: 'title' | 'body', range: readonly [number, number], maxH: number, color: string, textCase?: 'upper' | 'none') => {
    if (!text.trim()) return;
    const type = font === 'title' ? look.title : look.body;
    const fit = fitText(text, { x0: inner.x0, y0: 0, x1: inner.x1, y1: maxH }, type, { max: range[0], min: range[1], align, valign: 'top', ...(textCase ? { textCase } : {}) });
    parts.push({ role, field, font, fit, color, align, type });
  };
  if (body.kind === 'quote' && body.title.trim()) fitPart('mark', null, '„', 'title', [160, 160], 150, pill ? kickerOnPill : accentOnBg, 'none');
  fitPart('meta', 'kicker', body.kicker, 'body', SIZES.kicker, 130, pill ? kickerOnPill : accentOnBg, 'upper');
  const fixed = parts.reduce((n, p) => n + p.fit.height + GAP, 0);
  const avail = Math.max(120, textMaxH - fixed);
  fitPart('title', 'title', body.title, 'title', SIZES.title[body.kind], body.body.trim() ? avail * 0.68 : avail, pill ? pillFg : onBg.title);
  const used = parts.reduce((n, p) => n + p.fit.height + GAP, 0);
  fitPart('body', 'body', body.body, 'body', SIZES.body, Math.max(80, textMaxH - used), pill ? pillFg : onBg.body);

  const blockGap = pill ? GAP + PILL : GAP;
  const blockH = parts.reduce((n, p, i) => n + p.fit.height + (i ? blockGap : 0), 0);
  // vertical placement of the block (and the sticker area next to it)
  const stickerH = wantSticker ? STICKER.h + STICKER.gap : 0;
  let y0: number;
  if (card) y0 = region.y0;
  else if (body.textPos === 'top') y0 = region.y0;
  else if (body.textPos === 'bottom') y0 = region.y1 - blockH;
  else y0 = region.y0 + (region.y1 - region.y0 - blockH - stickerH) / 2;
  if (!card && body.textPos === 'bottom' && wantSticker) y0 = Math.max(region.y0 + stickerH, y0);

  // media below everything
  let mediaBox: Box | null = null;
  if (hasMedia) {
    if (card) {
      const top = parts.length ? y0 + blockH + 48 : region.y0;
      const bottom = region.y1 - (wantSticker ? stickerH : 0);
      const a = media?.aspect ?? (body.media.kind === 'carousel_slide' ? 0.8 : 9 / 16);
      const maxW = region.x1 - region.x0, maxH = Math.max(200, bottom - top);
      const w = Math.min(maxW, maxH * a), h = w / a;
      const x = (W - w) / 2;
      mediaBox = rx({ x0: x, y0: top, x1: x + w, y1: top + h });
      // a thin accent frame around the card
      els.push({ type: 'rect', box: rx({ x0: mediaBox.x0 - 8, y0: mediaBox.y0 - 8, x1: mediaBox.x1 + 8, y1: mediaBox.y1 + 8 }), color: accentOnBg, layer: 'under' });
    } else mediaBox = { x0: 0, y0: 0, x1: W, y1: H };
    if (usable) els.push({ type: 'image', box: mediaBox, imageId: igMediaKey(body.media)! });
    else {
      els.push({ type: 'placeholder', box: mediaBox, color: mix(bg, onBg.body, 0.12), text: media?.problem ? 'Medium nicht nutzbar' : 'Medium wählen' });
      problems.push({ level: 'error', code: media ? 'image_rights' : 'image_missing', message: `Medium: ${media?.problem ?? 'nicht gefunden.'}` });
    }
  }

  // texts (with their colour box on full-bleed media)
  let y = y0;
  parts.forEach((p, i) => {
    if (i) y += blockGap;
    const f = shiftFit(p.fit, y - p.fit.top);
    if (pill && p.role !== 'mark') els.push({ type: 'rect', box: rx(linesBox(f, p.align, p.type, PILL)), color: c.surface, layer: 'over' });
    const box: Box = rx({ x0: inner.x0, y0: f.top, x1: inner.x1, y1: f.bottom });
    els.push({ type: 'text', role: p.role, field: p.field ? SLIDE_FIELD_OF[p.field] : null, font: p.font, size: f.size, color: p.color, align: p.align, lines: f.lines, box, overflow: f.overflow });
    if (f.overflow && p.field) problems.push({ level: 'error', code: 'overflow', field: SLIDE_FIELD_OF[p.field], message: `${IG_FIELD_LABEL[p.field]} passt nicht in den sicheren Bereich – bitte kürzen.` });
    y = f.bottom;
  });
  const textBottom = parts.length ? y : y0;
  // something placed below the safe zone (too much text) is an overflow, too
  if (parts.length && (textBottom > safe.y1 + 0.5 || y0 < safe.y0 - 0.5) && !problems.some((p) => p.code === 'overflow'))
    problems.push({ level: 'error', code: 'overflow', field: 'title', message: 'Der Text reicht in den Bereich, den Instagram verdeckt – bitte kürzen.' });

  let sticker: Box | null = null;
  if (wantSticker) {
    const top = card
      ? region.y1 - STICKER.h
      : body.textPos === 'bottom' ? Math.max(region.y0, y0 - STICKER.gap - STICKER.h) : Math.min(region.y1 - STICKER.h, textBottom + STICKER.gap);
    sticker = rx({ x0: (W - STICKER.w) / 2, y0: top, x1: (W + STICKER.w) / 2, y1: top + STICKER.h });
  }

  const hasText = parts.some((p) => p.field && p.fit.lines.some((l) => l.text.trim()));
  if (!hasText && !hasMedia) problems.push({ level: 'error', code: 'empty', message: 'Die Story ist leer – Text oder Medium ergänzen.' });
  if (label) els.push(label);
  return { index: 0, width: W, height: H, bg, elements: els, problems, aiImage: ai, mode: igStoryMode(body), safe, sticker, mediaBox };
}

/** Whether every text, colour box above the media and the label lie inside the safe zone (checked by tests and the review). */
export function insideSafeZone(l: IgStoryLayout): boolean {
  const s = l.safe;
  return l.elements.every((e) => {
    if (e.type === 'text' || e.type === 'label' || (e.type === 'rect' && e.layer === 'over')) return e.box.x0 >= 0 && e.box.x1 <= l.width && e.box.y0 >= s.y0 - PILL && e.box.y1 <= s.y1 + PILL;
    return true;
  }) && (!l.sticker || (l.sticker.y0 >= s.y0 && l.sticker.y1 <= s.y1));
}

// ---------- Review ----------

export interface IgStoryRules { sources: readonly string[]; flagged: readonly string[] }
export interface IgStoryIssue { level: 'error' | 'warning'; code: string; message: string; field?: IgStoryField }
export interface IgStoryReview { issues: IgStoryIssue[]; slop: { field: IgStoryField; hints: SlopHint[] }[]; errors: number; ai: boolean; stickerNote: string | null }

const deniesLabel = (t: string) => AD_DENIAL.test(t) || AI_DENIAL.test(t) || BURNED_AD_DENIAL.test(t) || BURNED_AI_DENIAL.test(t);
export const igStoryTexts = (b: Pick<IgStoryBody, 'kicker' | 'title' | 'body'>): { field: IgStoryField; text: string }[] =>
  (['kicker', 'title', 'body'] as const).filter((f) => b[f].trim()).map((field) => ({ field, text: b[field] }));

/** What to set in Instagram for the sticker (null = none). */
export function stickerNote(s: IgSticker): string | null {
  if (s.kind === 'none') return null;
  const opts = s.options.filter(Boolean);
  return `${IG_STICKER_LABEL[s.kind]} in Instagram setzen${s.prompt ? ` – Text: „${s.prompt}“` : ''}${opts.length ? ` – Antworten: ${opts.join(' / ')}` : ''} (freie Fläche ist in der Story vorgesehen).`;
}

/**
 * Errors (overflow, media rights, empty, flagged claims, label denials) block the export; figures without a source,
 * testimonial wording, links on the picture and slop are hints.
 */
export function reviewIgStory(body: IgStoryBody, layout: IgStoryLayout, rules: IgStoryRules): IgStoryReview {
  const issues: IgStoryIssue[] = layout.problems.map((p) => ({ level: p.level, code: p.code, message: p.message, ...(p.field ? { field: IG_FIELD_OF_SLIDE[p.field as 'title' | 'body' | 'attribution'] } : {}) }));
  const slop: IgStoryReview['slop'] = [];
  for (const { field, text } of igStoryTexts(body)) {
    const where = IG_FIELD_LABEL[field];
    const flagged = claimsInText(rules.flagged, text);
    if (flagged.length) issues.push({ level: 'error', code: 'flagged_claim', field, message: `${where}: ungeprüfter Claim „${flagged.join(' · ')}“ – erst belegen oder streichen.` });
    if (deniesLabel(text)) issues.push({ level: 'error', code: 'label_denial', field, message: `${where} bestreitet eine Kennzeichnung (z. B. „ohne KI“, „keine Werbung“).` });
    const nums = unsupportedNumbers(text, rules.sources);
    if (nums.length) issues.push({ level: 'warning', code: 'number', field, message: `${where}: Zahl ohne Beleg (${nums.join(', ')}) – nur echte, belegte Werte.` });
    if (CAROUSEL_TESTIMONIAL.test(text)) issues.push({ level: 'warning', code: 'testimonial', field, message: `${where} klingt nach Testimonial, Garantie oder fremdem Lob – nur Echtes.` });
    if (URL_RE.test(text)) issues.push({ level: 'warning', code: 'link', field, message: `${where}: Links sind in Stories nur über den Link-Sticker klickbar.` });
    const hints = slopHints(text, 'overlay');
    if (hints.length) slop.push({ field, hints });
  }
  if (body.sticker.kind === 'poll' && body.sticker.options.filter(Boolean).length < 2) issues.push({ level: 'warning', code: 'sticker', message: 'Umfrage: mindestens zwei Antworten notieren (du setzt den Sticker in Instagram).' });
  if (body.sticker.prompt && (deniesLabel(body.sticker.prompt) || claimsInText(rules.flagged, body.sticker.prompt).length))
    issues.push({ level: 'error', code: 'sticker_text', message: 'Der Sticker-Text enthält einen ungeprüften Claim oder bestreitet eine Kennzeichnung.' });
  if (!insideSafeZone(layout) && !issues.some((i) => i.code === 'overflow')) issues.push({ level: 'error', code: 'safe_zone', message: 'Ein Element liegt im Bereich, den Instagram verdeckt.' });
  return { issues, slop, errors: issues.filter((i) => i.level === 'error').length, ai: layout.aiImage, stickerNote: stickerNote(body.sticker) };
}

/** The export's `notes.txt`: per story the file, the sticker to set, her notes and the label reminder. */
export function igStoryNotes(stories: readonly { file: string; title: string; body: IgStoryBody; ai: boolean }[]): string {
  const out = ['Stories – Notizen zum Posten (das Studio postet nichts; Sticker setzt du in Instagram).', ''];
  stories.forEach((s, i) => {
    out.push(`${i + 1}. ${s.file} – ${IG_STORY_KIND_LABEL[s.body.kind]}${s.title ? ` („${s.title}“)` : ''}`);
    const sn = stickerNote(s.body.sticker);
    if (sn) out.push(`   Sticker: ${sn}`);
    if (s.body.notes) out.push(`   Notiz: ${s.body.notes.replace(/\n/g, ' ')}`);
    if (s.ai) out.push(`   Kennzeichnung: „${IG_STORY_AI_LABEL}“ ist eingebrannt – zusätzlich das KI-Label von Instagram setzen.`);
  });
  out.push('');
  return out.join('\n');
}

/** A fresh story body of a kind (empty texts, default text position). */
export const emptyIgStory = (kind: IgStoryKind, media: IgStoryMedia = { kind: 'none' }): IgStoryBody =>
  IgStoryBody.parse({ kind, media, fit: media.kind === 'carousel_slide' ? 'card' : 'full', textPos: defaultTextPos(kind) });
