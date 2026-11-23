/**
 * Text hook, graphic overlays and the look of a cut (Release 3, Etappe 8, part 3). Pure and deterministic.
 *
 * - Everything is burned in through ONE ASS file with libass (like subtitles and the AI label). No user
 *   text ever enters the FFmpeg filtergraph; all text goes through `escapeAss`, our own override tags are
 *   written outside it.
 * - Layer order is fixed: subtitles 0, shapes 1, overlay text 2, hook 3, AI label `LABEL_LAYER` (9),
 *   and the label lines are always written last, so nothing can cover the disclosure.
 * - Positions are fixed slots (all below the label zone, y < 330, and above the subtitle band) or, since Etappe 13, a free
 *   centre (`pos`); every box comes from overlayLayout.ts (shared with the editor stage) and is checked by the validator
 *   (a free box in the label zone is an error).
 * - Burned-in text has a source: a script hook (exact reference to the approved script), a free hook of a
 *   scriptless personal plan (≤ 60 characters, claim lint), or for lower thirds/keywords a literal part of
 *   the script's dialogue/on-screen text or of the clip's own transcript. Nothing else is burned in.
 * - Colours come from the plan's pinned, approved Style Bible version, else from a labelled neutral
 *   placeholder (the placeholder label is shown in the UI and the render record, never burned in).
 *   Fonts come from an allow-list of macOS system fonts, never from the Style Bible's free-text typography.
 */
import { z } from 'zod';
import { AD_DENIAL, AI_DENIAL, NUMBER_RE, URL_RE } from './agents/scriptAgents';
import { claimsInText } from './claims';
import { assTime, escapeAss, LABEL_LAYER, stripFillers, type SubtitleStyle } from './transcript';
import { mapSpan, type Timeline } from './timeline';
import { ASS_FONT_NAME, isHex, OverlayFont, readableOn, type SystemFont } from './lookBase';
import {
  ArrowDirection, freeBoxFindings, hookLayout, HOOK_PAD, KEYWORD_PAD, LOWER_THIRD, LOWER_THIRD_TEXT_INSET, NormPos, OverlayKind, overlayBox, overlayFontSize,
  paintedBoxes, scaled, Slot, FRAME_BARS, intersects, type Box, type HookLayout,
} from './overlayLayout';
import { applyCase, designOf, ElementFont, elementFontKey, fitOf, resolveDesignLook, resolveElementFont, SIZE_SCALE, SizeStep, type CustomFontInfo, type DesignLook, type OverlayFit, type ResolvedType } from './designSystem';
import { animAssTags, animSpec, DEFAULT_WORDS_PER_LINE, TextAnim, type AnimSpec } from './textAnim';

// ---------- Schemas (stored inside the EDL body) ----------

export { ASS_FONT_NAME, contrastRatio, isHex, OVERLAY_FONTS, OverlayFont, readableOn } from './lookBase';

export { ArrowDirection, NormPos, OverlayKind, Slot } from './overlayLayout';

/** Etappe 13: an overlay style („Meine Marke“ preset) per element; absent = the plan's style (`look.preset`). */
export const PresetRef = z.string().regex(/^[a-z0-9-]{1,40}$/);
/** Etappe 13: size step per element (S 0.85, M 1, L 1.15); absent = the size of the design system's type role. */
export const ElementSize = SizeStep;
export type ElementSize = SizeStep;

/** Longest free text (hook of a scriptless plan, lower third, keyword) before the per-kind limits. */
export const OVERLAY_TEXT_MAX = 60;
export const TEXT_LIMIT: Record<'lower_third' | 'keyword' | 'free_hook', number> = { lower_third: 42, keyword: 30, free_hook: 60 };
const TEXT_KINDS: readonly OverlayKind[] = ['lower_third', 'keyword'];
export const overlayHasText = (k: OverlayKind) => TEXT_KINDS.includes(k);

/** An overlay on one clip, in SOURCE time of the take (it stays on the same moment when cuts change). */
export const ClipOverlay = z.object({
  kind: OverlayKind,
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().positive(),
  text: z.string().trim().max(OVERLAY_TEXT_MAX).default(''),
  slot: Slot.default('center'),
  /** Arrows only. */
  direction: ArrowDirection.default('down'),
  /** Etappe 13 (all optional, absent = as before): free centre position, overlay style and size step. Frames ignore `pos`. */
  pos: NormPos.optional(),
  presetId: PresetRef.optional(),
  size: ElementSize.optional(),
  /** Etappe 16b (optional, absent = as before): the element's own font and animation (absent = its role's / its style's). */
  font: ElementFont.optional(),
  anim: TextAnim.optional(),
})
  .refine((o) => o.endSec > o.startSec, { message: 'Overlay: Ende muss nach dem Anfang liegen.' })
  .refine((o) => !overlayHasText(o.kind) || o.text.length > 0, { message: 'Bauchbinde und Keyword brauchen einen Text.' });
export type ClipOverlay = z.infer<typeof ClipOverlay>;

/**
 * Text hook from output time 0. With a script it is an exact reference (the selected hook or variant i of
 * the plan's approved script); the validator fills `text` with that exact script string. Without a script
 * (personal content only) it is the user's own text, ≤ 60 characters, checked by the claim lint (since
 * Etappe 10 only as warnings, except a denied label). `claimsReviewed` is no longer required (kept for old plans).
 */
export const PlanHook = z.object({
  source: z.enum(['selected', 'variant', 'free']),
  variantIndex: z.number().int().min(0).max(5).nullable().default(null),
  text: z.string().trim().max(300).default(''),
  endSec: z.number().finite().min(0.5).max(5).default(2.5),
  /** Etappe 10: default `upper`, so a hook never collides with a keyword (default `center`) or a lower third. */
  slot: Slot.default('upper'),
  claimsReviewed: z.boolean().default(false),
  /** Etappe 13 (optional, absent = as before): free centre position, overlay style and size step of the hook. */
  pos: NormPos.optional(),
  presetId: PresetRef.optional(),
  size: ElementSize.optional(),
  /** Etappe 16b (optional): the hook's own font and animation. */
  font: ElementFont.optional(),
  anim: TextAnim.optional(),
}).refine((h) => (h.source === 'variant') === (h.variantIndex != null), { message: 'Hook: Variante nur mit Index, sonst ohne.' });
export type PlanHook = z.infer<typeof PlanHook>;

/**
 * Look settings stored in the EDL. The colours are NOT stored here: they come from the plan's pinned Style Bible.
 * Etappe 14: `preset` picks an overlay style of the pinned version's design system (null = its default style);
 * `fontSource` `design` takes the fonts of the design system's type roles, `plan` keeps `font` for hook, lower
 * third and keyword (the default, so plans saved before Etappe 14 render as before).
 */
export const PlanLook = z.object({
  font: OverlayFont.default('Avenir Next'),
  fontSource: z.enum(['plan', 'design']).default('plan'),
  preset: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable().default(null),
});
export type PlanLook = z.infer<typeof PlanLook>;

// ---------- Look tokens ----------

export interface LookTokens {
  source: 'style_bible' | 'placeholder';
  styleBibleVersionId: string | null;
  version: number | null;
  /** Shown in the UI and stored on the render; never burned into the video. */
  label: string;
  /** Font family shown in the UI (the hook's font for a design-system look). */
  font: string;
  /** #RRGGBB */
  accent: string;
  box: string;
  text: string;
  /**
   * Etappe 14: the resolved design-system look (fonts, sizes, cases, preset colours). Absent for versions without
   * `rules.design` and for every look stored before Etappe 14: those render exactly as before.
   */
  design?: DesignLook;
  /** Notes from resolving the design (missing preset or font, low contrast). Not part of `lookKey`. */
  designNotes?: string[];
  /**
   * Etappe 13: the resolved looks of the other overlay styles single elements use (`presetId`), by preset id. Absent when
   * no element names another style (every plan before Etappe 13), so their `lookKey` and ASS stay the same.
   */
  presetLooks?: Record<string, DesignLook>;
  /**
   * Etappe 16b: fonts single elements chose in the inspector, resolved (key `elementFontKey`). Absent when no element has
   * its own font (every plan before), so `lookKey` and the ASS stay the same.
   */
  elementFonts?: Record<string, ResolvedType>;
}
export const PLACEHOLDER_LABEL = 'Neutraler Platzhalter-Stil (keine aktive Style Bible)';
const PLACEHOLDER = { accent: '#9AA0A6', box: '#111111', text: '#FFFFFF' } as const;
/** Label of a design-system look in the editor and the render record. */
export const designLookLabel = (version: number, presetName: string) => `Look aus Meine Marke (Style Bible v${version}) · Stil „${presetName}“`;

/**
 * Tokens from the plan's PINNED Style Bible version: only a version that is or was approved
 * (`approvedAt != null`) gives colours; a draft, a missing version or one without colours gives the
 * labelled placeholder. Never resolved from "the latest approved" version, so an approved cut keeps its look.
 * Etappe 14 (v2): a version with `rules.design` gives the design-system look (colour and type roles, the plan's
 * preset); a version without it goes through `legacyDesignFromRules` (palette[0]/[1]) and gives exactly the
 * tokens of Etappe 8 (no `design` field, same `lookKey`).
 */
export function styleTokens(
  version: { id: string; version: number; approvedAt: string | null; rules: { visual?: { palette?: readonly string[] }; design?: unknown } } | null,
  font: OverlayFont,
  opts: { preset?: string | null; fontSource?: 'plan' | 'design'; fonts?: readonly CustomFontInfo[]; elementPresets?: readonly string[]; elementFonts?: readonly ElementFont[] } = {},
): LookTokens {
  // Etappe 16b: fonts of single elements (only when some element has one: older plans keep their tokens)
  const fontNotes: string[] = [];
  const elementFonts: Record<string, ResolvedType> = {};
  for (const f of opts.elementFonts ?? []) {
    const key = elementFontKey(f);
    if (key in elementFonts) continue;
    const r = resolveElementFont(f, opts.fonts ?? [], fontNotes);
    if (r) elementFonts[key] = r;
  }
  const ef = Object.keys(elementFonts).length ? { elementFonts } : {};
  const resolved = version && version.approvedAt != null ? designOf(version.rules) : null;
  if (!version || version.approvedAt == null || !resolved) {
    const label = version && version.approvedAt != null ? `Style Bible v${version.version} hat keine Farbpalette – ${PLACEHOLDER_LABEL}` : PLACEHOLDER_LABEL;
    return { source: 'placeholder', styleBibleVersionId: null, version: null, label, font, ...PLACEHOLDER, ...ef };
  }
  const { design, legacy } = resolved;
  const base = { source: 'style_bible' as const, styleBibleVersionId: version.id, version: version.version, accent: design.colors.accent.hex, box: design.colors.surface.hex, text: design.colors.onSurface.hex };
  // legacy: palette[0] accent, palette[1] (or a darker accent) surface, readable text – the Etappe-8 tokens
  if (legacy) return { ...base, label: `Style Bible v${version.version}`, font, ...ef };
  const fontOverride: SystemFont | null = (opts.fontSource ?? 'plan') === 'plan' ? font : null;
  const { look, warnings } = resolveDesignLook(design, { presetId: opts.preset ?? null, fontOverride, fonts: opts.fonts });
  warnings.push(...fontNotes);
  // Etappe 13: styles single elements name (only existing ones; an unknown id falls back to the plan's style)
  const presetLooks: Record<string, DesignLook> = {};
  for (const id of [...new Set(opts.elementPresets ?? [])].sort()) {
    if (id === look.presetId) continue;
    if (!design.presets.some((p) => p.id === id)) { warnings.push(`Overlay-Stil „${id}“ gibt es in dieser Version nicht – der Stil des Schnitts wird verwendet.`); continue; }
    presetLooks[id] = resolveDesignLook(design, { presetId: id, fontOverride, fonts: opts.fonts }).look;
  }
  const extra = Object.keys(presetLooks).length ? { presetLooks } : {};
  return { ...base, label: designLookLabel(version.version, look.presetName), font: look.hook.type.family, design: look, designNotes: warnings, ...extra, ...ef };
}

/** The parts of the tokens a reviewed render must still match (a design-system look adds its resolved design). */
export const lookKey = (t: Pick<LookTokens, 'source' | 'styleBibleVersionId' | 'font' | 'accent' | 'box' | 'text' | 'design' | 'presetLooks' | 'elementFonts'>) =>
  [t.source, t.styleBibleVersionId ?? '', t.font, t.accent, t.box, t.text, ...(t.design ? [JSON.stringify(t.design)] : []),
    ...(t.presetLooks && Object.keys(t.presetLooks).length ? [JSON.stringify(Object.keys(t.presetLooks).sort().map((k) => [k, t.presetLooks![k]]))] : []),
    ...(t.elementFonts && Object.keys(t.elementFonts).length ? [JSON.stringify(Object.keys(t.elementFonts).sort().map((k) => [k, t.elementFonts![k]]))] : [])].join('|');

/** Every font a look draws with (roles of its style and of the element styles, element fonts): for libass `fontsdir`, cache keys and the font check. */
export function lookFontTypes(t: Pick<LookTokens, 'design' | 'presetLooks' | 'elementFonts'>): ResolvedType[] {
  const roles = [t.design, ...Object.values(t.presetLooks ?? {})].flatMap((d) => (d ? [d.hook.type, d.lowerThird.type, d.keyword.type, d.subtitle.type] : []));
  return [...roles, ...Object.values(t.elementFonts ?? {})];
}

/** Layout fit of a look (null for legacy looks: Etappe-8 sizes, text as written). */
export const lookFit = (t: Pick<LookTokens, 'design'> | null | undefined): OverlayFit | undefined => (t?.design ? fitOf(t.design) : undefined);

// ---------- ASS colours ----------

const bgr = (hex: string) => {
  if (!isHex(hex)) throw new Error(`Keine Farbe: ${hex}`);
  return `${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
};
const aa = (alpha: number) => Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, '0').toUpperCase();
/** Colour for a Style line: '#RRGGBB' → '&HAABBGGRR' (alpha 0 = opaque). */
export const hexToAssStyle = (hex: string, alpha = 0) => `&H${aa(alpha)}${bgr(hex)}`;
/** Colour for an override tag (`\1c`): '#RRGGBB' → '&HBBGGRR&'; the alpha goes into `\1a&HAA&`. */
export const hexToAssTag = (hex: string) => `&H${bgr(hex)}&`;

// ---------- Geometry (PlayRes 1080x1920): overlayLayout.ts (Etappe 13), re-exported here ----------

export {
  CONTENT_AREA, FRAME_BARS, hookLayout, intersects, LABEL_ZONE, overlayBox, overlayFontSize, SLOT_BAND, SUBTITLE_BAND, type Box, type HookLayout,
} from './overlayLayout';

// ---------- Text sources and claim lint ----------

/** Compare form for „is this literally part of the source“: lowercase, ß → ss, quotes/sentence punctuation and fillers ignored. */
const sourceForm = (s: string) => ` ${stripFillers(s).toLowerCase().normalize('NFC').replace(/ß/g, 'ss').replace(/[.,!?;:„“"'‚‘’«»…()[\]–—-]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
/** Sentence ends (a decimal point like „1.5“ is not one: it has no space after it). */
const SENTENCE_END = /(?<=[.!?…;]["“”»«'’)]*)\s+/;
const isQuestion = (s: string) => /\?["“”»«'’)]*\s*$/.test(s.trim());
/** A quote that starts right after one of these words would turn a denial into a statement („nicht klinisch getestet“). */
const NEGATIONS = new Set(['nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines', 'nie', 'niemals', 'nichts', 'ohne', 'weder', 'not', 'no', 'never', 'without']);
/** Why a burned-in text is not a faithful quote of its sources: missing, cut off after a negation, or a question turned into a statement. */
export type QuoteProblem = 'missing' | 'negated' | 'question';
/**
 * Checks that `text` (whole words) appears literally inside ONE sentence of one source, keeps its meaning:
 * it does not start right after a negation, and a question is only quoted as a question (ending in „?“).
 * null = a faithful quote.
 */
export function quoteProblem(text: string, sources: readonly string[]): QuoteProblem | null {
  const t = sourceForm(text);
  if (!t.trim()) return 'missing';
  const asQuestion = isQuestion(text);
  let problem: QuoteProblem = 'missing';
  for (const src of sources)
    for (const sentence of src.split(SENTENCE_END)) {
      const f = sourceForm(sentence);
      for (let i = f.indexOf(t); i >= 0; i = f.indexOf(t, i + 1)) {
        if (NEGATIONS.has(f.slice(0, i).trim().split(' ').pop() ?? '')) problem = 'negated';
        else if (isQuestion(sentence) && !asQuestion) { if (problem === 'missing') problem = 'question'; }
        else return null;
      }
    }
  return problem;
}
/** True when `text` is a faithful literal quote of one of the sources (see `quoteProblem`). */
export const textFromSource = (text: string, sources: readonly string[]): boolean => quoteProblem(text, sources) === null;

/** Claim rules for burned-in text: the project's verified claims and every claim ever flagged in its scripts. */
/**
 * Stricter denial wording for text burned into the video (cannot be edited after the render). The caption
 * lint keeps the narrower `AD_DENIAL`/`AI_DENIAL`; here also „keine Anzeige“, „nicht bezahlt“, „kein Sponsoring“,
 * „nicht gesponsert/gesponsort“, „keine Kooperation“, „unbeauftragt“ and „ohne/kein Filter“, „ungefiltert“.
 */
export const BURNED_AD_DENIAL = /\b(?:keine?\s+(?:anzeige|werbung|sponsoring|kooperation|werbepartnerschaft)|nicht\s+(?:bezahlt|gesponsert|gesponsort|beauftragt)|unbezahlt|unbeauftragt|unsponsored|not\s+sponsored|no\s+ad)\b/i;
export const BURNED_AI_DENIAL = /\b(?:(?:ohne|keine?)\s+(?:ki|filter)|ungefiltert|100\s?%\s*echt|unbearbeitet|no\s+ai|not\s+ai|no\s+filter)\b/i;

export interface BurnedTextRules { allowed: readonly string[]; flagged: readonly string[] }
/** Compare form of a figure: whole token with its decimal part and %, „1,5“ = „1.5“, never a substring of another number. */
const numberKey = (n: string) => n.toLowerCase().replace(/\s+/g, '').replace(',', '.');
const numbersIn = (text: string) => (text.match(NUMBER_RE) ?? []).map((n) => ({ key: numberKey(n), shown: n.replace(/\s+/g, ' ').trim() }));
/**
 * The claim lint for every text burned into the video (hook, lower third, keyword): flagged claims,
 * figures that are not a figure of a verified claim (whole tokens: „5“ is not in „50 ml“), links, and
 * wording that denies a label. `where` names the element in the messages („im Hook“, „im Overlay“).
 */
export function burnedTextBlockers(text: string, rules: BurnedTextRules, where = 'im Hook'): string[] {
  const { claims, denials } = burnedTextFindings(text, rules, where);
  return [...claims, ...denials];
}

/**
 * `burnedTextBlockers`, split: `claims` (flagged claims, unverified figures, links) and `denials` (wording that
 * denies an ad or AI label). Etappe 10: personal projects get the claims as warnings only; denials stay errors
 * for every project.
 */
export function burnedTextFindings(text: string, rules: BurnedTextRules, where = 'im Hook'): { claims: string[]; denials: string[] } {
  const out: string[] = [];
  const flagged = claimsInText(rules.flagged, text);
  if (flagged.length) out.push(`Ungeprüfte Claims ${where}: ${flagged.join(' · ')}`);
  const allowed = new Set(rules.allowed.flatMap((c) => numbersIn(c).map((n) => n.key)));
  const seen = new Set<string>();
  const numbers = numbersIn(text).filter((n) => !allowed.has(n.key) && !seen.has(n.key) && seen.add(n.key)).map((n) => n.shown);
  if (numbers.length) out.push(`Zahlen ${where} ohne verifizierten Claim: ${numbers.join(', ')} – erfundene Ergebnisse werden nicht eingebrannt.`);
  if (URL_RE.test(text)) out.push(`Link ${where} – im Video nicht klickbar.`);
  const denials = AD_DENIAL.test(text) || AI_DENIAL.test(text) || BURNED_AD_DENIAL.test(text) || BURNED_AI_DENIAL.test(text)
    ? [`Der Text ${where} bestreitet eine Kennzeichnung (z. B. „keine Werbung“, „ohne KI“).`] : [];
  return { claims: out, denials };
}
/**
 * The lint for a FREE hook (text without a script behind it): `burnedTextBlockers`, and the user also has to
 * confirm that it states no unproven product or result claim (paraphrases are not detectable).
 * Not used by `validateEditPlan` since Etappe 10 (free hooks are personal: no confirmation, claims as warnings).
 */
export function freeHookBlockers(text: string, rules: BurnedTextRules, claimsReviewed: boolean): string[] {
  const out = burnedTextBlockers(text, rules, 'im Hook');
  if (!claimsReviewed) out.push('Bestätigung fehlt, dass der Hook keine unbelegten Produkt- oder Ergebnisaussagen enthält.');
  return out;
}

// ---------- Timed elements ----------

export interface TimedOverlay {
  clip: number; index: number; kind: OverlayKind; text: string; slot: Slot; direction: z.infer<typeof ArrowDirection>; startSec: number; endSec: number;
  /** Size step of a design-system look or of the element itself (absent = 1). */
  scale?: number;
  /** Etappe 13: free centre (absent = its slot) and overlay style (absent = the plan's). */
  pos?: NormPos;
  presetId?: string;
  /** Etappe 16b: own font and animation (absent = role/style). */
  font?: ElementFont;
  anim?: TextAnim;
}
export interface TimedHook { text: string; startSec: number; endSec: number; layout: HookLayout; presetId?: string; pos?: NormPos; font?: ElementFont; anim?: TextAnim }

/** Scale of an element: its own size step, else its role's (absent when it is 1, as before Etappe 13). */
const scaleOf = (size: SizeStep | undefined, role: number | undefined) => {
  const s = size ? SIZE_SCALE[size] : role;
  return s != null && s !== 1 ? s : undefined;
};

/**
 * Overlays and hook on the output timeline. An overlay spans ONE contiguous output range (first mapped
 * piece → last), so it does not blink at filler cuts; one that lies entirely inside a cut is dropped.
 * The hook runs from 0 to min(endSec, cut length).
 * `fit` (a design-system look): each element gets its role's size step and case (upper/lower case is applied to
 * the text here, so layout, conflicts and the ASS all see the same text). Without it nothing changes.
 * Etappe 13: an element's own `size` wins over its role's step; `pos` and `presetId` are carried through.
 */
export function timedElements(
  body: { clips: readonly { overlays?: readonly ClipOverlay[] }[]; hook?: PlanHook | null },
  tl: Timeline,
  fit?: OverlayFit,
): { overlays: TimedOverlay[]; hook: TimedHook | null; dropped: { clip: number; index: number }[] } {
  const overlays: TimedOverlay[] = [];
  const dropped: { clip: number; index: number }[] = [];
  body.clips.forEach((c, ci) => (c.overlays ?? []).forEach((o, k) => {
    const span = mapSpan(tl, ci, o.startSec, o.endSec);
    if (!span) { dropped.push({ clip: ci, index: k }); return; }
    const role = o.kind === 'lower_third' ? fit?.lowerThird : o.kind === 'keyword' ? fit?.keyword : undefined;
    const text = overlayHasText(o.kind) ? (role ? applyCase(o.text, role.textCase) : o.text) : '';
    const scale = scaleOf(o.size, role?.scale);
    overlays.push({
      clip: ci, index: k, kind: o.kind, text, slot: o.slot, direction: o.direction, ...span,
      ...(scale != null ? { scale } : {}), ...(o.pos && o.kind !== 'frame' ? { pos: o.pos } : {}), ...(o.presetId ? { presetId: o.presetId } : {}),
      ...(o.font && overlayHasText(o.kind) ? { font: o.font } : {}), ...(o.anim ? { anim: o.anim } : {}),
    });
  }));
  const h = body.hook;
  const hookText = h && fit ? applyCase(h.text, fit.hook.textCase) : h?.text ?? '';
  const layout = h ? hookLayout(hookText, h.slot, scaleOf(h.size, fit?.hook.scale) ?? 1, h.pos) : null;
  const end = h ? Math.round(Math.min(h.endSec, tl.durationSec) * 1000) / 1000 : 0;
  return {
    overlays,
    hook: h && layout && end > 0 ? { text: hookText, startSec: 0, endSec: end, layout, ...(h.presetId ? { presetId: h.presetId } : {}), ...(h.pos ? { pos: h.pos } : {}), ...(h.font ? { font: h.font } : {}), ...(h.anim ? { anim: h.anim } : {}) } : null,
    dropped,
  };
}

/** Pairs of visible elements that overlap in time AND on screen (each pair once), plus elements outside the content area. */
export function layoutConflicts(t: { overlays: readonly TimedOverlay[]; hook: TimedHook | null }): string[] {
  const items = [
    ...t.overlays.map((o) => ({ name: `Clip ${o.clip + 1}, Overlay ${o.index + 1}`, startSec: o.startSec, endSec: o.endSec, boxes: paintedBoxes(o) })),
    ...(t.hook ? [{ name: 'Hook', startSec: t.hook.startSec, endSec: t.hook.endSec, boxes: [t.hook.layout.box] }] : []),
  ];
  const out: string[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      if (Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec) <= 0.001) continue;
      if (a.boxes.some((x) => b.boxes.some((y) => intersects(x, y)))) out.push(`${a.name} und ${b.name} liegen gleichzeitig an derselben Stelle – anderen Platz oder andere Zeit wählen.`);
    }
  return out;
}

/**
 * Etappe 13: problems of elements at a FREE position (slot elements never leave the content area): the AI-label zone is
 * an error, Instagram's interface zones and burned subtitles are warnings (`freeBoxFindings`).
 */
export function freePositionFindings(t: { overlays: readonly TimedOverlay[]; hook: TimedHook | null }, subtitles?: Box | null): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const add = (f: { errors: string[]; warnings: string[] }) => { errors.push(...f.errors); warnings.push(...f.warnings); };
  for (const o of t.overlays) if (o.pos) add(freeBoxFindings(overlayBox(o), `Clip ${o.clip + 1}, Overlay ${o.index + 1}`, subtitles));
  if (t.hook?.pos) add(freeBoxFindings(t.hook.layout.box, 'Hook', subtitles));
  return { errors, warnings };
}

/** Etappe 16b: fonts the elements of a body chose themselves (text elements only). */
export const usedElementFonts = (body: { clips: readonly { overlays?: readonly { kind: OverlayKind; font?: ElementFont }[] }[]; hook?: { font?: ElementFont } | null }): ElementFont[] =>
  [...body.clips.flatMap((c) => (c.overlays ?? []).flatMap((o) => (o.font && overlayHasText(o.kind) ? [o.font] : []))), ...(body.hook?.font ? [body.hook.font] : [])];

/** Overlay styles the elements of a body name (besides the plan's own `look.preset`). */
export const usedPresetIds = (body: { clips: readonly { overlays?: readonly { presetId?: string }[] }[]; hook?: { presetId?: string } | null }): string[] =>
  [...new Set([...body.clips.flatMap((c) => (c.overlays ?? []).flatMap((o) => (o.presetId ? [o.presetId] : []))), ...(body.hook?.presetId ? [body.hook.presetId] : [])])].sort();

// ---------- ASS ----------

/** Layers: subtitles 0, shapes 1, overlay text 2, hook 3; the AI label is above all of them. */
export const LAYER = { subtitles: 0, shapes: 1, text: 2, hook: 3 } as const satisfies Record<string, number>;
// every overlay layer lies below the AI label (`LABEL_LAYER` from ./transcript, checked again in buildAss)
if (Math.max(...Object.values(LAYER)) >= LABEL_LAYER) throw new Error('Overlay-Ebene über dem KI-Label');

export interface OverlayAss { styles: string[]; events: string[] }

const rect = (w: number, h: number) => `m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h}`;
/** Down-pointing arrow (7 points), 120 x 180; rotated around its centre (`\an5`, so `\frz` turns in place). */
const ARROW = 'm 40 0 l 80 0 l 80 100 l 120 100 l 60 180 l 0 100 l 40 100';
const ARROW_ROT: Record<z.infer<typeof ArrowDirection>, number> = { down: 0, right: 90, up: 180, left: -90 };
const n0 = (x: number) => String(Math.round(x));

/**
 * What the ASS writer needs from a look. A legacy look (no `design`) maps to exactly the Etappe-8 values: every
 * text in the plan's font (bold), boxed hook, striped lower third, keyword box in the accent, fades on.
 */
export function renderSpec(look: LookTokens): DesignLook {
  if (look.design) return look.design;
  const font = OverlayFont.parse(look.font);
  const type = { family: font, assName: ASS_FONT_NAME[font], bold: true, scale: 1, textCase: 'none' as const, custom: false };
  return {
    presetId: 'legacy', presetName: 'Style Bible',
    hook: { type, shape: 'box', fill: look.box, text: look.text },
    lowerThird: { type, shape: 'stripe', fill: look.box, stripe: look.accent, text: look.text },
    keyword: { type, shape: 'box', fill: look.accent, text: readableOn(look.accent) },
    subtitle: { type: { ...type, family: 'Arial', assName: 'Arial' }, text: '#FFFFFF', outline: '#101010' },
    graphic: look.accent, animation: 'fade', customFonts: false,
  };
}
/** The look one element is drawn in: its own overlay style (`presetId`, resolved in `presetLooks`) or the plan's (stage and ASS agree). */
export const elementSpec = (look: LookTokens, presetId?: string | null): DesignLook => (presetId && look.presetLooks?.[presetId]) || renderSpec(look);
const boldFlag = (b: boolean) => (b ? '-1' : '0');
const italicFlag = (t: ResolvedType) => (t.italic ? '-1' : '0');

/**
 * Etappe 16b: the animation of one element – its own (`anim`), else its role's default in Meine Marke, else its overlay
 * style's Etappe-8 behaviour. `part` `shape` = the boxes of a lower third (they only fade with a pop). Stage and ASS use this.
 */
export function elementAnimSpec(kind: OverlayKind | 'hook', anim: TextAnim | undefined, d: DesignLook, part: 'text' | 'shape' = 'text'): AnimSpec {
  const role = kind === 'hook' ? d.anim?.hook : kind === 'lower_third' ? d.anim?.lowerThird : kind === 'keyword' ? d.anim?.keyword : undefined;
  const k = part === 'shape' || kind === 'arrow' || kind === 'frame' ? 'shape' : kind;
  return animSpec(k, anim ?? role, d.animation);
}
/** The font an element is drawn in: its own (resolved in `look.elementFonts`), else null (its role's). */
export const elementFontOf = (look: Pick<LookTokens, 'elementFonts'>, font?: ElementFont | null): ResolvedType | null =>
  (font ? look.elementFonts?.[elementFontKey(font)] ?? null : null);
/** ASS tags of an element's own font: name, weight and slant of exactly that face. */
const fontTags = (t: ResolvedType | null) => (t ? `\\fn${t.assName}\\b${t.bold ? 1 : 0}${t.italic ? '\\i1' : ''}` : '');

/** The LowerThird, Keyword and Hook styles of one look (`sfx` names the styles of an extra preset, e.g. `KeywordP1`). */
function textStyles(d: DesignLook, sfx: string): string[] {
  const c = hexToAssStyle;
  const { hook: hk, lowerThird: lt, keyword: kw } = d;
  // `outline` shapes: no box, the fill colour is the text outline (BorderStyle 1)
  const ltBorder = lt.shape === 'outline' ? `1,3,0` : '1,0,0';
  const kwBorder = kw.shape === 'outline' ? `1,4,0` : `3,${KEYWORD_PAD},0`;
  const hkBorder = hk.shape === 'outline' ? `1,4,0` : `3,${HOOK_PAD},0`;
  return [
    `Style: LowerThird${sfx},${lt.type.assName},${scaled(56, lt.type.scale)},${c(lt.text)},&H000000FF,${c(lt.fill)},&H00000000,${boldFlag(lt.type.bold)},${italicFlag(lt.type)},0,0,100,100,0,0,${ltBorder},4,0,0,0,1`,
    `Style: Keyword${sfx},${kw.type.assName},${scaled(72, kw.type.scale)},${c(kw.text)},&H000000FF,${c(kw.fill)},${c(kw.fill)},${boldFlag(kw.type.bold)},${italicFlag(kw.type)},0,0,100,100,0,0,${kwBorder},5,0,0,0,1`,
    `Style: Hook${sfx},${hk.type.assName},${scaled(96, hk.type.scale)},${c(hk.text)},&H000000FF,${c(hk.fill)},${c(hk.fill)},${boldFlag(hk.type.bold)},${italicFlag(hk.type)},0,0,100,100,0,0,${hkBorder},5,90,90,0,1`,
  ];
}

/**
 * Styles and Dialogue lines of the hook and the overlays. Shapes use their own `Shape` style without
 * outline or shadow; colours in tags use the `\1c&HBBGGRR&` form. Fonts come from the allow-list or her own
 * uploaded fonts (design system), never from free text. A legacy look gives the Etappe-8 bytes (snapshot test).
 * Etappe 13: every position comes from the element's box (slot or free `pos`, overlayLayout.ts); an element with its own
 * overlay style (`presetId`, resolved in `look.presetLooks`) uses that style's colours, shapes and animation through
 * extra styles `…P1`, `…P2` (only written when such elements exist, so older plans give the same bytes).
 */
export function overlayAss(t: { overlays: readonly TimedOverlay[]; hook: TimedHook | null }, look: LookTokens): OverlayAss {
  const base = renderSpec(look);
  const extra = Object.keys(look.presetLooks ?? {}).sort();
  const sfxOf = new Map(extra.map((id, i) => [id, `P${i + 1}`]));
  const specOf = (presetId?: string): { d: DesignLook; sfx: string } => {
    const d = presetId ? look.presetLooks?.[presetId] : undefined;
    return d ? { d, sfx: sfxOf.get(presetId!)! } : { d: base, sfx: '' };
  };
  const styles = [
    'Style: Shape,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    ...textStyles(base, ''),
    ...extra.flatMap((id) => textStyles(look.presetLooks![id]!, sfxOf.get(id)!)),
  ];
  const ev = (layer: number, s: number, e: number, style: string, body: string) => `Dialogue: ${layer},${assTime(s)},${assTime(e)},${style},,0,0,0,,${body}`;
  const shape = (s: number, e: number, colour: string, tags: string, drawing: string, fade: string) =>
    ev(LAYER.shapes, s, e, 'Shape', `{${tags}\\1c${hexToAssTag(colour)}\\1a&H00&\\bord0\\shad0${fade}\\p1}${drawing}{\\p0}`);
  const shapes: string[] = [], texts: string[] = [];
  for (const o of t.overlays) {
    if (o.endSec - o.startSec < 0.05) continue;
    const { d, sfx } = specOf(o.presetId);
    // Etappe 16b: one time description per element (stage and ASS); plans without `anim` get the Etappe-8 tags
    const fade = animAssTags(elementAnimSpec(o.kind, o.anim, d, 'shape'));
    const textAnim = animAssTags(elementAnimSpec(o.kind, o.anim, d, 'text'));
    const ft = fontTags(elementFontOf(look, o.font));
    const lt = d.lowerThird;
    const b = overlayBox(o);
    const cx = n0((b.x0 + b.x1) / 2), cy = n0((b.y0 + b.y1) / 2);
    if (o.kind === 'lower_third') {
      if (lt.shape === 'stripe') {
        shapes.push(shape(o.startSec, o.endSec, lt.fill, `\\an7\\pos(${n0(b.x0 + LOWER_THIRD.stripe)},${n0(b.y0)})`, rect(LOWER_THIRD.width - LOWER_THIRD.stripe, LOWER_THIRD.height), fade));
        shapes.push(shape(o.startSec, o.endSec, lt.stripe, `\\an7\\pos(${n0(b.x0)},${n0(b.y0)})`, rect(LOWER_THIRD.stripe, LOWER_THIRD.height), fade));
      } else if (lt.shape === 'box') {
        shapes.push(shape(o.startSec, o.endSec, lt.fill, `\\an7\\pos(${n0(b.x0)},${n0(b.y0)})`, rect(LOWER_THIRD.width, LOWER_THIRD.height), fade));
      }
      texts.push(ev(LAYER.text, o.startSec, o.endSec, `LowerThird${sfx}`, `{\\an4\\pos(${n0(b.x0 + LOWER_THIRD_TEXT_INSET)},${cy})\\fs${overlayFontSize('lower_third', o.text, o.scale)}\\q2${ft}${textAnim}}${escapeAss(o.text)}`));
    } else if (o.kind === 'keyword') {
      const s = overlayFontSize('keyword', o.text, o.scale);
      texts.push(ev(LAYER.text, o.startSec, o.endSec, `Keyword${sfx}`, `{\\an5\\pos(${cx},${cy})\\fs${s}\\q2${ft}${textAnim}}${escapeAss(o.text)}`));
    } else if (o.kind === 'arrow') {
      shapes.push(shape(o.startSec, o.endSec, d.graphic, `\\an5\\pos(${cx},${cy})\\frz${ARROW_ROT[o.direction]}`, ARROW, fade));
    } else {
      for (const bar of FRAME_BARS) shapes.push(shape(o.startSec, o.endSec, d.graphic, `\\an7\\pos(${bar.x0},${bar.y0})`, rect(bar.x1 - bar.x0, bar.y1 - bar.y0), fade));
    }
  }
  let hook: string[] = [];
  if (t.hook) {
    const { d, sfx } = specOf(t.hook.presetId);
    const hookAnim = animAssTags(elementAnimSpec('hook', t.hook.anim, d));
    const ft = fontTags(elementFontOf(look, t.hook.font));
    hook = [ev(LAYER.hook, t.hook.startSec, t.hook.endSec, `Hook${sfx}`, `{\\an5\\pos(${t.hook.layout.x},${t.hook.layout.y})\\fs${t.hook.layout.size}\\q2${ft}${hookAnim}}${t.hook.layout.lines.map(escapeAss).join('\\N')}`)];
  }
  return { styles, events: [...shapes, ...texts, ...hook] };
}

/**
 * Subtitle style of a design-system look for `buildAss` (font, size step, colours, case). undefined for legacy
 * looks: the subtitles keep the fixed Etappe-6 style (Arial 64, white, dark outline).
 */
export function subtitleStyleOf(look: Pick<LookTokens, 'design'> | null | undefined): SubtitleStyle | undefined {
  const s = look?.design?.subtitle;
  if (!s) return undefined;
  return { font: s.type.assName, fontSize: scaled(64, s.type.scale), bold: s.type.bold, primary: hexToAssStyle(s.text), outline: hexToAssStyle(s.outline), textCase: s.type.textCase, ...(s.type.italic ? { italic: true } : {}) };
}

/**
 * Etappe 16b: the subtitle mode a body renders with – its own, else the subtitle role's default of the look, else lines –
 * with words per line and the highlight colour (the look's accent). null = lines (the cues and ASS of every older plan).
 */
export function subtitleAnimationOf(body: { subtitleMode?: 'lines' | 'karaoke' | 'word'; subtitleWords?: number }, look: Pick<LookTokens, 'design' | 'accent'> | null | undefined): { mode: 'karaoke' | 'word'; wordsPerLine: number; highlight: string } | null {
  const mode = body.subtitleMode ?? look?.design?.subtitleMode ?? 'lines';
  if (mode === 'lines') return null;
  const wordsPerLine = mode === 'word' ? 1 : Math.max(1, Math.min(4, body.subtitleWords ?? look?.design?.wordsPerLine ?? DEFAULT_WORDS_PER_LINE));
  return { mode, wordsPerLine, highlight: look?.design ? look.design.subtitle.text === look.accent ? readableOn(look.accent) : look.accent : look?.accent ?? '#E8B04A' };
}

// ---------- libass gate, font check, summary ----------

/** Anything that is burned in with libass: subtitles, the AI label, a hook or an overlay. */
export function needsLibass(body: { subtitles: 'off' | 'burn'; hook?: PlanHook | null; clips: readonly { overlays?: readonly unknown[] }[] }, labels: readonly unknown[]): boolean {
  return body.subtitles === 'burn' || labels.length > 0 || body.hook != null || body.clips.some((c) => (c.overlays?.length ?? 0) > 0);
}
/** True when the plan has a hook or an overlay (the render then snapshots its look). */
export const hasGraphics = (body: { hook?: PlanHook | null; clips: readonly { overlays?: readonly unknown[] }[] }) =>
  body.hook != null || body.clips.some((c) => (c.overlays?.length ?? 0) > 0);

const fontKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * libass font fallback in the render log (FFmpeg loglevel info): libass logs every font it selects as
 * `fontselect: (Family, weight, italic) -> path, index, PostScriptName` and warns when a glyph has no font.
 * A requested family is missing only when NONE of its selections resolves to it: a glyph the font lacks
 * (an emoji, „→“) is looked up in another font and logged with the requested family too, which is a normal
 * per-glyph fallback while the family itself was found.
 */
export function fontFallbacks(stderr: string, expected: readonly { name: string; postscriptName: string }[] = []): string[] {
  const out = new Set<string>();
  const picks = new Map<string, { family: string; found: boolean; other: string; ps: Set<string> }>();
  for (const m of stderr.matchAll(/fontselect: \((.+?), (\d+), (\d+)\) -> (.*?), (-?\d+), (\S*)/g)) {
    const family = m[1]!.trim(), file = m[4]!, ps = m[6]!;
    const want = fontKey(family);
    if (!want) continue;
    if (m[3] === '0' && /italic|oblique/i.test(ps))
      out.add(`Schrift „${family.slice(0, 40)}“: libass hat den kursiven Schnitt „${ps.slice(0, 60)}“ genommen, obwohl kein Kursiv angefordert war.`);
    const p = picks.get(want) ?? { family, found: false, other: '', ps: new Set<string>() };
    p.ps.add(ps);
    if (fontKey(ps).includes(want) || fontKey(file).includes(want)) p.found = true;
    else p.other ||= ps || file;
    picks.set(want, p);
  }
  for (const p of picks.values())
    if (!p.found) out.add(`Schrift „${p.family.slice(0, 40)}“ nicht gefunden – libass hat „${p.other.slice(0, 60)}“ genommen.`);
  // Etappe 16b: a font chosen by face (Mac font, Google/own file) must resolve to exactly that face, not only the family
  for (const e of expected) {
    const p = picks.get(fontKey(e.name));
    if (p?.found && !p.ps.has(e.postscriptName)) out.add(`Schrift „${e.name.slice(0, 40)}“: libass hat „${[...p.ps][0]?.slice(0, 60) ?? '?'}“ statt „${e.postscriptName.slice(0, 60)}“ genommen.`);
  }
  for (const m of stderr.matchAll(/fontselect: failed to find any fallback with glyph 0x([0-9A-Fa-f]+) for font: \((.+?),/g))
    out.add(`Zeichen U+${m[1]!.toUpperCase()} fehlt in „${m[2]!.slice(0, 40)}“ und jeder Ersatzschrift.`);
  if (/no usable font|No fonts? (?:found|available)/i.test(stderr)) out.add('libass hat keine nutzbare Schrift gefunden.');
  return [...out];
}

/** Short summary of hook and overlays for the version list, e.g. „Hook · 2 Overlays“. */
export function graphicsSummary(body: { hook?: PlanHook | null; clips: readonly { overlays?: readonly unknown[] }[] }): string {
  const n = body.clips.reduce((s, c) => s + (c.overlays?.length ?? 0), 0);
  return [body.hook ? 'Hook' : '', n ? `${n} Overlay${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
}
