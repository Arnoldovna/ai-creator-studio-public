/**
 * „Meine Marke“ – the design system (Etappe 14, E4). Pure and deterministic.
 *
 * - Stored as the optional, additive `rules.design` of a Style Bible version: one version line, cuts keep pinning
 *   `styleBibleVersionId`. A version without `rules.design` is a legacy version: `legacyDesignFromRules` maps its
 *   palette (`palette[0]` accent, `palette[1]` surface) to the same tokens, `lookKey` and ASS as before Etappe 14.
 * - Every token carries its origin (`Provenance`): manual, the palette, confirmed observations, references, the
 *   Voice Guide, a deterministic derivation, an AI suggestion she took over, or the legacy palette.
 * - Fonts come from the system allow-list (`SYSTEM_FONTS`) or from her own uploaded font files (`custom:<id>`),
 *   never from free text. Matching typography observations to fonts is an approximation and labelled as such.
 * - Nothing here changes a stored version: derive/suggest return proposals that she takes over in the UI.
 */
import { z } from 'zod';
import type { StyleBibleRules } from './schemas';
import { AA_TEXT, chroma, contrastRatio, darken, isHex, isMacFontRef, isSystemFont, luminance, macPostscriptName, readableOn, SYSTEM_FONTS, assSystemFontName, type SystemFont } from './lookBase';
import { SubtitleMode, TextAnim, WordsPerLine } from './textAnim';

// ---------- Schema ----------

const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Erwartet #RRGGBB').transform((h) => h.toUpperCase());
const Id = z.string().trim().min(1).max(100);
const SlotName = z.enum(['upper', 'center', 'lower']);
const ZoomName = z.enum(['none', 'push_in', 'push_out', 'punch_in']);

export const PROVENANCE_SOURCES = ['manual', 'palette', 'observation', 'reference', 'voice', 'derived', 'ai', 'legacy'] as const;
export const ProvenanceSource = z.enum(PROVENANCE_SOURCES);
export const PROVENANCE_LABELS: Record<(typeof PROVENANCE_SOURCES)[number], string> = {
  manual: 'manuell', palette: 'Palette der Style Bible', observation: 'bestätigte Beobachtung', reference: 'Referenz', voice: 'Voice Guide',
  derived: 'abgeleitet', ai: 'KI-Vorschlag (übernommen)', legacy: 'aus der alten Palette',
};
/** Where a token comes from. Observation/reference ids point into the studio data (kept while they exist). */
export const Provenance = z.object({
  source: ProvenanceSource,
  observationIds: z.array(Id).max(20).default([]),
  referenceIds: z.array(Id).max(24).default([]),
  note: z.string().trim().max(200).default(''),
});
export type Provenance = z.infer<typeof Provenance>;
const manual = (): Provenance => ({ source: 'manual', observationIds: [], referenceIds: [], note: '' });
const origin = (source: Provenance['source'], extra: Partial<Provenance> = {}): Provenance => ({ ...manual(), source, ...extra });
const Origin = Provenance.prefault({ source: 'manual' });

export const COLOR_ROLES = ['primary', 'accent', 'surface', 'onSurface', 'onAccent', 'onVideo', 'background'] as const;
export const ColorRole = z.enum(COLOR_ROLES);
export type ColorRole = z.infer<typeof ColorRole>;
export const COLOR_ROLE_LABELS: Record<ColorRole, { label: string; hint: string }> = {
  primary: { label: 'Hauptfarbe', hint: 'Die Farbe, an der man dich erkennt.' },
  accent: { label: 'Akzent', hint: 'Keywords, Streifen, Pfeile, Rahmen.' },
  surface: { label: 'Fläche', hint: 'Boxen hinter Hook und Bauchbinde.' },
  onSurface: { label: 'Text auf Fläche', hint: 'Schrift in den Boxen.' },
  onAccent: { label: 'Text auf Akzent', hint: 'Schrift in Keyword-Boxen.' },
  onVideo: { label: 'Text auf Video', hint: 'Untertitel und Text ohne Box.' },
  background: { label: 'Hintergrund', hint: 'Karussell- und Story-Hintergrund.' },
};
export const ColorToken = z.object({ hex: Hex, origin: Origin });
export type ColorToken = z.infer<typeof ColorToken>;
export const DesignColors = z.object({
  primary: ColorToken, accent: ColorToken, surface: ColorToken, onSurface: ColorToken, onAccent: ColorToken, onVideo: ColorToken, background: ColorToken,
});
export type DesignColors = z.infer<typeof DesignColors>;

/** Own font files (Etappe 14): `custom:<id>` of a font uploaded under /api/fonts. */
export const CUSTOM_FONT_RE = /^custom:[A-Za-z0-9-]{1,64}$/;
/** Etappe 16b: also `mac:<PostScriptName>` – a font installed on this Mac (exact face, see lookBase `MAC_FONT_RE`). */
export const FontRef = z.string().refine((s) => isSystemFont(s) || CUSTOM_FONT_RE.test(s) || isMacFontRef(s), 'Schrift nicht erlaubt (Systemschrift-Liste, installierte Mac-Schrift oder eigene Schrift).');
/**
 * Etappe 16b: what she picked for a `mac:` font (family, style, weight, italic), stored with the reference so the label,
 * the bold flag and „kursiv ausdrücklich gewählt“ do not depend on this Mac's font list at render time.
 */
export const FontFace = z.object({
  family: z.string().trim().min(1).max(80),
  style: z.string().trim().max(80).default(''),
  weight: z.number().int().min(1).max(1000).default(400),
  italic: z.boolean().default(false),
  /** The name libass gets (English full name, see fontCatalog `InstalledFace.assName`); absent = the PostScript name. */
  assName: z.string().regex(/^[A-Za-z0-9 _-]{1,63}$/).optional(),
});
export type FontFace = z.infer<typeof FontFace>;
/** A font chosen for one element (Etappe 16b, inspector): the reference and, for Mac fonts, the face. */
export const ElementFont = z.object({ ref: FontRef, face: FontFace.optional() });
export type ElementFont = z.infer<typeof ElementFont>;
export const customFontId = (ref: string) => (CUSTOM_FONT_RE.test(ref) ? ref.slice('custom:'.length) : null);

export const TYPE_ROLES = ['hook', 'lowerThird', 'keyword', 'subtitle', 'carouselTitle', 'carouselBody'] as const;
export const TypeRole = z.enum(TYPE_ROLES);
export type TypeRole = z.infer<typeof TypeRole>;
export const TYPE_ROLE_LABELS: Record<TypeRole, string> = {
  hook: 'Hook', lowerThird: 'Bauchbinde', keyword: 'Keyword', subtitle: 'Untertitel', carouselTitle: 'Karussell-Titel', carouselBody: 'Karussell-Text',
};
export const TextCase = z.enum(['none', 'upper', 'lower']);
export type TextCase = z.infer<typeof TextCase>;
export const SizeStep = z.enum(['S', 'M', 'L']);
export type SizeStep = z.infer<typeof SizeStep>;
/** Size steps relative to the Etappe-8 sizes (M = unchanged). Text stays inside its slot band at every step. */
export const SIZE_SCALE: Record<SizeStep, number> = { S: 0.85, M: 1, L: 1.15 };
export const TypeToken = z.object({
  font: FontRef,
  weight: z.enum(['regular', 'bold']).default('bold'),
  size: SizeStep.default('M'),
  textCase: TextCase.default('none'),
  origin: Origin,
  /** Etappe 16b (all optional, absent = as before): the face of a `mac:` font; the role's default animation (hook, lower third, keyword) or subtitle mode. */
  face: FontFace.optional(),
  animation: TextAnim.optional(),
  subtitleMode: SubtitleMode.optional(),
  wordsPerLine: WordsPerLine.optional(),
});
export type TypeToken = z.infer<typeof TypeToken>;
export const DesignTypography = z.object({
  hook: TypeToken, lowerThird: TypeToken, keyword: TypeToken, subtitle: TypeToken, carouselTitle: TypeToken, carouselBody: TypeToken,
});
export type DesignTypography = z.infer<typeof DesignTypography>;

/** One overlay look. `outline` = no box: the fill colour becomes the text outline. */
export const OverlayPreset = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Preset-ID: a–z, 0–9, Bindestrich'),
  name: z.string().trim().min(1).max(60),
  hook: z.object({ shape: z.enum(['box', 'outline']).default('box'), fill: ColorRole.default('surface'), text: ColorRole.default('onSurface') }).prefault({}),
  lowerThird: z.object({
    shape: z.enum(['stripe', 'box', 'outline']).default('stripe'), fill: ColorRole.default('surface'), stripe: ColorRole.default('accent'), text: ColorRole.default('onSurface'),
  }).prefault({}),
  keyword: z.object({ shape: z.enum(['box', 'outline']).default('box'), fill: ColorRole.default('accent'), text: ColorRole.default('onAccent') }).prefault({}),
  /** Arrows and frames. */
  graphic: ColorRole.default('accent'),
  /** Default positions for a new hook and new overlays in the editor. */
  hookSlot: SlotName.default('upper'),
  overlaySlot: SlotName.default('center'),
  /** `fade` = the Etappe-8 fades (and keyword pop); `none` = static. */
  animation: z.enum(['fade', 'none']).default('fade'),
  origin: Origin,
});
export type OverlayPreset = z.infer<typeof OverlayPreset>;

export const TRANSITIONS = ['hard_cut', 'soft_cut', 'punch_in'] as const;
export const TRANSITION_LABELS: Record<(typeof TRANSITIONS)[number], string> = { hard_cut: 'Harter Schnitt', soft_cut: 'Weicher Schnitt (Mini-Blende)', punch_in: 'Punch-in bei Schnitten' };
export const TEMPO_LABELS = { calm: 'ruhig', medium: 'mittel', fast: 'schnell' } as const;
export const DesignMotion = z.object({
  /** Target length of a shot in seconds (null = no target). */
  targetCutSec: z.number().finite().min(0.5).max(15).nullable().default(null),
  transitions: z.array(z.enum(TRANSITIONS)).max(3).default(['hard_cut']).transform((t) => [...new Set(t)]),
  zoom: ZoomName.default('none'),
  tempo: z.enum(['calm', 'medium', 'fast']).default('medium'),
  origin: Origin,
});
export type DesignMotion = z.infer<typeof DesignMotion>;

export const TEMPERATURES = ['warm', 'neutral', 'cool', 'mixed'] as const;
export const TEMPERATURE_LABELS: Record<(typeof TEMPERATURES)[number], string> = { warm: 'warm', neutral: 'neutral', cool: 'kühl', mixed: 'gemischt' };
export const DesignImagery = z.object({
  keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  light: z.string().trim().max(600).default(''),
  temperature: z.enum(TEMPERATURES).nullable().default(null),
  /** Reference images that show the look (her selection). */
  referenceIds: z.array(Id).max(24).default([]),
  origin: Origin,
});
export type DesignImagery = z.infer<typeof DesignImagery>;
export const Phrase = z.object({ text: z.string().trim().min(1).max(160), origin: Origin });

export const DESIGN_VERSION = 1;
export const DesignSystem = z.object({
  version: z.literal(DESIGN_VERSION).default(DESIGN_VERSION),
  colors: DesignColors,
  typography: DesignTypography,
  presets: z.array(OverlayPreset).min(1).max(8),
  defaultPresetId: z.string().min(1).max(40),
  motion: DesignMotion.prefault({}),
  imagery: DesignImagery.prefault({}),
  /** Her own words and phrases (from the Voice Guide or typed in). */
  phrases: z.array(Phrase).max(40).default([]),
  /** Guidelines for the AI (plain text; read as her rules by later agents). */
  guidelines: z.string().trim().max(2000).default(''),
  guidelinesOrigin: Origin,
})
  .refine((d) => new Set(d.presets.map((p) => p.id)).size === d.presets.length, { message: 'Preset-IDs doppelt.', path: ['presets'] })
  .refine((d) => d.presets.some((p) => p.id === d.defaultPresetId), { message: 'Standard-Preset fehlt.', path: ['defaultPresetId'] });
export type DesignSystem = z.infer<typeof DesignSystem>;
export type DesignSystemInput = z.input<typeof DesignSystem>;

// ---------- Defaults and legacy ----------

export const DEFAULT_PRESET_ID = 'marke';
/** The Etappe-8 look expressed as a preset: boxed hook, striped lower third, keyword box in the accent. */
export const defaultPreset = (o: Provenance = origin('derived')): OverlayPreset => OverlayPreset.parse({ id: DEFAULT_PRESET_ID, name: 'Marke', origin: o });

const typeToken = (font: SystemFont | string, weight: 'regular' | 'bold', o: Provenance): TypeToken => ({ font, weight, size: 'M', textCase: 'none', origin: o });
/** Etappe-8 typography: Avenir Next bold for the overlays, Arial bold for the subtitles. */
export const defaultTypography = (o: Provenance = origin('derived')): DesignTypography => ({
  hook: typeToken('Avenir Next', 'bold', o), lowerThird: typeToken('Avenir Next', 'bold', o), keyword: typeToken('Avenir Next', 'bold', o),
  subtitle: typeToken('Arial', 'bold', o), carouselTitle: typeToken('Avenir Next', 'bold', o), carouselBody: typeToken('Avenir Next', 'regular', o),
});

const paletteOf = (rules: Pick<StyleBibleRules, 'visual'> | { visual?: { palette?: readonly string[] } }) =>
  ((rules.visual?.palette ?? []) as readonly unknown[]).filter(isHex).map((h) => h.toUpperCase());

/**
 * The design system of a version saved before Etappe 14 (no `rules.design`): accent = `palette[0]`, surface =
 * `palette[1]` (else a darker accent), text = whichever of white/near-black reads better. Same colours as
 * `styleTokens` always used, so tokens, `lookKey` and the ASS stay identical (parity test). null = no palette.
 */
export function legacyDesignFromRules(rules: { visual?: { palette?: readonly string[]; lighting?: string }; motion?: { transitions?: readonly string[] } }): DesignSystem | null {
  const palette = paletteOf(rules);
  if (!palette.length) return null;
  const o = origin('legacy');
  const accent = palette[0]!;
  const surface = palette[1] ?? darken(accent);
  const c = (hex: string, note = ''): ColorToken => ({ hex, origin: { ...o, note } });
  return DesignSystem.parse({
    colors: {
      primary: c(accent, 'palette[0]'), accent: c(accent, 'palette[0]'), surface: c(surface, palette[1] ? 'palette[1]' : 'abgedunkelter Akzent'),
      onSurface: c(readableOn(surface), 'Kontrastfarbe'), onAccent: c(readableOn(accent), 'Kontrastfarbe'), onVideo: c('#FFFFFF'), background: c(surface),
    },
    typography: defaultTypography(o),
    presets: [defaultPreset(o)],
    defaultPresetId: DEFAULT_PRESET_ID,
    imagery: { light: (rules.visual?.lighting ?? '').slice(0, 600), origin: o },
    motion: { origin: o },
    guidelinesOrigin: o,
  });
}

/** The version's own design system, else the legacy one (null = no colours at all). Invalid stored data → legacy. */
export function designOf(rules: { design?: unknown; visual?: { palette?: readonly string[]; lighting?: string } }): { design: DesignSystem; legacy: boolean } | null {
  if (rules.design != null) {
    const parsed = DesignSystem.safeParse(rules.design);
    if (parsed.success) return { design: parsed.data, legacy: false };
  }
  const legacy = legacyDesignFromRules(rules);
  return legacy ? { design: legacy, legacy: true } : null;
}

// ---------- Colour derivation ----------

export interface ColorCandidate { hex: string; source: 'palette' | 'observation'; observationIds: string[]; referenceIds: string[] }
export interface ContrastCheck { label: string; fg: ColorRole; bg: ColorRole; ratio: number; aa: boolean }

/** Palette colours first, then colours of confirmed observations (ids merged when a colour repeats). */
export function colorCandidates(palette: readonly string[], observations: readonly { id: string; referenceId: string; colors: readonly string[] }[]): ColorCandidate[] {
  const out = new Map<string, ColorCandidate>();
  for (const h of palette.filter(isHex)) {
    const hex = h.toUpperCase();
    if (!out.has(hex)) out.set(hex, { hex, source: 'palette', observationIds: [], referenceIds: [] });
  }
  for (const o of observations)
    for (const h of o.colors.filter(isHex)) {
      const hex = h.toUpperCase();
      const c = out.get(hex) ?? { hex, source: 'observation' as const, observationIds: [], referenceIds: [] };
      if (!c.observationIds.includes(o.id) && c.observationIds.length < 20) c.observationIds.push(o.id);
      if (!c.referenceIds.includes(o.referenceId) && c.referenceIds.length < 24) c.referenceIds.push(o.referenceId);
      out.set(hex, c);
    }
  return [...out.values()].slice(0, 40);
}

const fromCandidate = (c: ColorCandidate, note = ''): ColorToken => ({
  hex: c.hex,
  origin: c.observationIds.length && c.source === 'observation'
    ? origin('observation', { observationIds: c.observationIds, referenceIds: c.referenceIds, note })
    : origin('palette', { observationIds: c.observationIds, referenceIds: c.referenceIds, note }),
});
const derivedToken = (hex: string, note: string): ColorToken => ({ hex, origin: origin('derived', { note }) });

/** First candidate with AA contrast to `bg`; else white, near-black or black, whichever reads best. */
function readableToken(bg: string, cands: readonly ColorCandidate[], exclude: readonly string[]): ColorToken {
  const hit = cands.find((c) => !exclude.includes(c.hex) && contrastRatio(c.hex, bg) >= AA_TEXT);
  if (hit) return fromCandidate(hit, 'Kontrast ≥ 4,5:1');
  const best = ['#FFFFFF', '#111111', '#000000'].reduce((a, b) => (contrastRatio(b, bg) > contrastRatio(a, bg) ? b : a));
  return derivedToken(best, `Kontrastfarbe (${contrastRatio(best, bg).toFixed(1)}:1)`);
}

/**
 * Colour roles from the Style Bible palette and the colours of CONFIRMED observations, deterministic:
 * - primary: the first candidate (palette order wins);
 * - surface: the darkest candidate that carries white text (AA), else the lightest that carries dark text, else a
 *   darkened primary (always ≥ 7:1 with white);
 * - accent: the most colourful candidate other than the surface (greys do not count), else the primary;
 * - onSurface / onAccent: the first candidate with AA contrast, else white or near-black;
 * - onVideo: a near-white candidate, else white (subtitles always get a contrasting outline);
 * - background: the lightest candidate (carousels), else the surface.
 * null = no colour at all. Every role carries its origin; `checks` lists the text/background pairs with ratio and AA.
 */
export function deriveColorRoles(input: { palette: readonly string[]; observations: readonly { id: string; referenceId: string; colors: readonly string[] }[] }): { colors: DesignColors; checks: ContrastCheck[] } | null {
  const cands = colorCandidates(input.palette, input.observations);
  if (!cands.length) return null;
  const byLum = [...cands].sort((a, b) => luminance(a.hex) - luminance(b.hex) || a.hex.localeCompare(b.hex));
  const primary = fromCandidate(cands[0]!, 'erste Farbe');
  const darkSurface = byLum.find((c) => contrastRatio('#FFFFFF', c.hex) >= AA_TEXT);
  const lightSurface = [...byLum].reverse().find((c) => contrastRatio('#111111', c.hex) >= AA_TEXT);
  const surface = darkSurface ? fromCandidate(darkSurface, 'dunkelste Farbe mit lesbarem Text')
    : lightSurface ? fromCandidate(lightSurface, 'hellste Farbe mit lesbarem Text')
    : derivedToken(darken(primary.hex, 0.35), 'abgedunkelte Hauptfarbe');
  const colourful = cands.filter((c) => c.hex !== surface.hex && chroma(c.hex) >= 0.15);
  const mostColourful = colourful.reduce<ColorCandidate | null>((a, b) => (!a || chroma(b.hex) > chroma(a.hex) + 1e-9 ? b : a), null);
  const accent = mostColourful ? fromCandidate(mostColourful, 'farbigste Farbe') : primary.hex !== surface.hex ? { ...primary, origin: { ...primary.origin, note: 'Hauptfarbe' } } : derivedToken(readableOn(surface.hex) === '#FFFFFF' ? '#E8B04A' : '#2F5D50', 'Ersatzakzent');
  const onSurface = readableToken(surface.hex, cands, [surface.hex, accent.hex]);
  const onAccent = readableToken(accent.hex, cands, [accent.hex]);
  const nearWhite = [...byLum].reverse().find((c) => luminance(c.hex) >= 0.85);
  const onVideo = nearWhite ? fromCandidate(nearWhite, 'fast weiß') : derivedToken('#FFFFFF', 'Weiß mit Kontur');
  const lightest = byLum[byLum.length - 1]!;
  const background = luminance(lightest.hex) >= 0.6 ? fromCandidate(lightest, 'hellste Farbe') : { ...surface };
  const colors: DesignColors = { primary, accent, surface, onSurface, onAccent, onVideo, background };
  return { colors, checks: contrastChecks(colors) };
}

/** Text/background pairs of the colour roles (and of a preset, if given) with ratio and WCAG AA (4.5:1). */
export function contrastChecks(colors: DesignColors, preset?: OverlayPreset): ContrastCheck[] {
  const pairs: { label: string; fg: ColorRole; bg: ColorRole }[] = [
    { label: 'Text auf Fläche', fg: 'onSurface', bg: 'surface' },
    { label: 'Text auf Akzent', fg: 'onAccent', bg: 'accent' },
  ];
  if (preset) {
    if (preset.hook.shape === 'box') pairs.push({ label: `${preset.name}: Hook`, fg: preset.hook.text, bg: preset.hook.fill });
    if (preset.lowerThird.shape !== 'outline') pairs.push({ label: `${preset.name}: Bauchbinde`, fg: preset.lowerThird.text, bg: preset.lowerThird.fill });
    if (preset.keyword.shape === 'box') pairs.push({ label: `${preset.name}: Keyword`, fg: preset.keyword.text, bg: preset.keyword.fill });
  }
  const seen = new Set<string>();
  return pairs.filter((p) => !seen.has(`${p.fg}/${p.bg}`) && seen.add(`${p.fg}/${p.bg}`)).map((p) => {
    const ratio = Math.round(contrastRatio(colors[p.fg].hex, colors[p.bg].hex) * 100) / 100;
    return { ...p, ratio, aa: ratio >= AA_TEXT };
  });
}

// ---------- Full deterministic derivation („Aus meinen Favoriten ableiten“) ----------

export interface DeriveInput {
  rules: Pick<StyleBibleRules, 'visual' | 'motion'>;
  /** Only CONFIRMED observations. */
  observations: readonly { id: string; referenceId: string; dimension: string; statement: string; colors: readonly string[] }[];
  /** Liked references (her favourites): id, palette, tags. */
  references: readonly { id: string; palette: readonly string[]; likes: readonly string[]; tags: readonly string[] }[];
  /** Verbatim phrases from her texts (Voice Director suggestion), and her Voice Guide traits. */
  voice: { phrases: readonly string[] } | null;
  /** The current design (her choices for typography/presets/phrases are kept). */
  current: DesignSystem | null;
}

/** Font from typography observations – an approximation (labelled), never a font name from free text. */
const FONT_HINTS: [RegExp, SystemFont][] = [
  [/serif(?!enlos)|antiqua|klassisch|editorial/i, 'Georgia'],
  [/condensed|schmal|kondensiert|eng gesetzt/i, 'DIN Condensed'],
  [/geometr|futura|bauhaus/i, 'Futura'],
  [/grotesk|helvetica|neutral|swiss|schweizer/i, 'Helvetica Neue'],
];
export function fontFromObservations(obs: readonly { id: string; dimension: string; statement: string }[]): { font: SystemFont; ids: string[] } | null {
  for (const [re, font] of FONT_HINTS) {
    const ids = obs.filter((o) => o.dimension === 'typography' && re.test(o.statement)).map((o) => o.id).slice(0, 20);
    if (ids.length) return { font, ids };
  }
  return null;
}

const TEMP_HINTS: [RegExp, (typeof TEMPERATURES)[number]][] = [[/warm|golden|sonnig/i, 'warm'], [/kühl|kalt|cool|bläulich/i, 'cool'], [/neutral/i, 'neutral']];
const TEMPO_HINTS: [RegExp, DesignMotion['tempo']][] = [[/schnell|zügig|dynamisch|fast/i, 'fast'], [/ruhig|langsam|calm|entspannt/i, 'calm']];
const firstHit = <T>(text: string, hints: [RegExp, T][]) => hints.find(([re]) => re.test(text))?.[1] ?? null;
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

/**
 * A complete design-system proposal from her favourites, deterministic (same input → same output):
 * colour roles from `deriveColorRoles`, typography from the current design (or a font matched from typography
 * observations, labelled as approximation), presets kept, motion from the Style Bible's pacing/transitions, image
 * look from lighting/texture observations and liked references, phrases from the Voice Guide, guidelines from the
 * Style Bible rules. Only a proposal: nothing is stored.
 */
export function deriveDesignSystem(input: DeriveInput): { design: DesignSystem; checks: ContrastCheck[]; notes: string[] } {
  const notes: string[] = [];
  const current = input.current;
  const derived = deriveColorRoles({ palette: input.rules.visual.palette, observations: input.observations.filter((o) => o.dimension === 'color' || o.colors.length) });
  const colors = derived?.colors ?? current?.colors ?? legacyDesignFromRules({ visual: { palette: ['#9AA0A6', '#111111'] } })!.colors;
  if (!derived) notes.push('Keine Farben in Palette oder bestätigten Beobachtungen – Farben unverändert.');
  let typography = current?.typography ?? defaultTypography();
  const match = fontFromObservations(input.observations);
  if (match && !current) {
    const o = origin('observation', { observationIds: match.ids, note: 'Annäherung: Schrift aus Typografie-Beobachtungen zugeordnet' });
    typography = { ...typography, hook: { ...typography.hook, font: match.font, origin: o }, keyword: { ...typography.keyword, font: match.font, origin: o }, carouselTitle: { ...typography.carouselTitle, font: match.font, origin: o } };
    notes.push(`Schrift „${match.font}“ ist eine Annäherung an die Typografie-Beobachtungen, keine erkannte Schrift.`);
  }
  const presets = current?.presets ?? [defaultPreset()];
  const pacing = `${input.rules.motion.pacing} ${input.rules.motion.transitions.join(' ')}`;
  const transitions = uniq([
    ...(/hart|hard|jump/i.test(pacing) ? ['hard_cut' as const] : []),
    ...(/weich|blende|soft|fade/i.test(pacing) ? ['soft_cut' as const] : []),
    ...(/punch|zoom/i.test(pacing) ? ['punch_in' as const] : []),
  ]);
  const motion = DesignMotion.parse({
    ...(current?.motion ?? {}),
    tempo: firstHit(pacing, TEMPO_HINTS) ?? current?.motion.tempo ?? 'medium',
    transitions: transitions.length ? transitions : current?.motion.transitions ?? ['hard_cut'],
    origin: origin('derived', { note: 'aus Tempo und Übergängen der Style Bible' }),
  });
  const lookObs = input.observations.filter((o) => ['lighting', 'texture', 'aesthetic', 'composition'].includes(o.dimension));
  const liked = input.references.filter((r) => r.likes.length);
  const lightText = [input.rules.visual.lighting, ...input.observations.filter((o) => o.dimension === 'lighting').map((o) => o.statement)].join(' ');
  const imagery = DesignImagery.parse({
    keywords: uniq([...input.rules.visual.traits, ...liked.flatMap((r) => r.tags)].map((k) => k.trim().slice(0, 80)).filter(Boolean)).slice(0, 20),
    light: (input.rules.visual.lighting || input.observations.filter((o) => o.dimension === 'lighting').map((o) => o.statement).join(' ')).slice(0, 600),
    temperature: firstHit(lightText, TEMP_HINTS) ?? current?.imagery.temperature ?? null,
    referenceIds: uniq([...(current?.imagery.referenceIds ?? []), ...liked.map((r) => r.id)]).slice(0, 24),
    origin: origin(lookObs.length ? 'observation' : 'derived', { observationIds: lookObs.map((o) => o.id).slice(0, 20), referenceIds: liked.map((r) => r.id).slice(0, 24) }),
  });
  const phrases = uniq([...(current?.phrases.map((p) => p.text) ?? []), ...(input.voice?.phrases ?? []).map((p) => p.trim().slice(0, 160)).filter(Boolean)]).slice(0, 40)
    .map((text) => current?.phrases.find((p) => p.text === text) ?? { text, origin: origin('voice') });
  const g = input.rules.visual;
  const guidelines = current?.guidelines || [
    g.traits.length ? `Bildsprache: ${g.traits.slice(0, 12).join(', ')}.` : '',
    g.avoid.length ? `Vermeiden: ${g.avoid.slice(0, 12).join(', ')}.` : '',
    g.composition ? `Komposition: ${g.composition}` : '',
    'Eigene Handschrift, keine Kopie fremder Creator, Marken oder Logos.',
  ].filter(Boolean).join('\n').slice(0, 2000);
  const design = DesignSystem.parse({
    colors, typography, presets, defaultPresetId: current?.defaultPresetId ?? DEFAULT_PRESET_ID, motion, imagery, phrases, guidelines,
    guidelinesOrigin: current?.guidelines ? current.guidelinesOrigin : origin('derived', { note: 'aus Merkmalen und Vermeiden der Style Bible' }),
  });
  return { design, checks: contrastChecks(design.colors, design.presets.find((p) => p.id === design.defaultPresetId)), notes };
}

/** Plain-text summary for AI agents (her rules; agents treat references and observations as untrusted). */
export function designGuidelineText(d: DesignSystem): string {
  const c = d.colors, t = d.typography;
  return [
    `Farben: Hauptfarbe ${c.primary.hex}, Akzent ${c.accent.hex}, Fläche ${c.surface.hex}, Text auf Fläche ${c.onSurface.hex}, Hintergrund ${c.background.hex}.`,
    `Schriften: Hook ${fontLabel(t.hook.font)} ${t.hook.weight}, Untertitel ${fontLabel(t.subtitle.font)}, Karussell ${fontLabel(t.carouselTitle.font)}.`,
    `Tempo ${TEMPO_LABELS[d.motion.tempo]}${d.motion.targetCutSec ? `, Einstellungen ca. ${d.motion.targetCutSec} s` : ''}; Übergänge: ${d.motion.transitions.map((x) => TRANSITION_LABELS[x]).join(', ')}.`,
    d.imagery.keywords.length || d.imagery.light ? `Bildlook: ${[d.imagery.keywords.join(', '), d.imagery.light, d.imagery.temperature ? `Farbtemperatur ${TEMPERATURE_LABELS[d.imagery.temperature]}` : ''].filter(Boolean).join(' · ')}.` : '',
    d.phrases.length ? `Eigene Wörter: ${d.phrases.map((p) => `„${p.text}“`).join(', ')}.` : '',
    d.guidelines,
  ].filter(Boolean).join('\n');
}
export const fontLabel = (ref: string) => (customFontId(ref) ? 'eigene Schrift' : macPostscriptName(ref) ? `Mac-Schrift ${macPostscriptName(ref)}` : ref);

// ---------- Resolution for rendering ----------

/** An uploaded font file (metadata read from its name/OS2 tables at upload). */
/**
 * An uploaded font file (metadata read from its name/OS2 tables at upload). `assName` is the name written into the ASS
 * style: its full name (name ID 4), which libass matches for fonts from `fontsdir` (verified 2026-11-19, FFmpeg 9.0.2
 * CoreText: the PostScript name is NOT matched for these, the full name selects the exact face).
 */
export interface CustomFontInfo { id: string; family: string; postscriptName: string; assName: string; weight: number; italic: boolean }
export interface ResolvedType {
  family: string; assName: string; bold: boolean; scale: number; textCase: TextCase; custom: boolean;
  /** Etappe 16b (only set when true, so older looks keep their JSON): a font installed on this Mac (`assName` = PostScript name); an italic face she chose explicitly. */
  mac?: true; italic?: true;
  /** Mac fonts: the PostScript name of the chosen face (the render check expects exactly it). */
  postscriptName?: string;
}
/** Everything the ASS writer needs for one look (all colours resolved to #RRGGBB). */
export interface DesignLook {
  presetId: string; presetName: string;
  hook: { type: ResolvedType; shape: 'box' | 'outline'; fill: string; text: string };
  lowerThird: { type: ResolvedType; shape: 'stripe' | 'box' | 'outline'; fill: string; stripe: string; text: string };
  keyword: { type: ResolvedType; shape: 'box' | 'outline'; fill: string; text: string };
  subtitle: { type: ResolvedType; text: string; outline: string };
  graphic: string;
  animation: 'fade' | 'none';
  /** True when a role uses an uploaded font: the render passes libass the fonts folder. */
  customFonts: boolean;
  /** Etappe 16b: default animations of the roles (only roles that set one; absent = the preset's `animation`). */
  anim?: Partial<Record<'hook' | 'lowerThird' | 'keyword', TextAnim>>;
  /** Etappe 16b: default subtitle mode of the subtitle role (absent = lines) and its words per line. */
  subtitleMode?: SubtitleMode; wordsPerLine?: number;
}

const ASS_SAFE = /^[A-Za-z0-9 _-]{1,63}$/;
function resolveType(t: TypeToken, fonts: readonly CustomFontInfo[], warnings: string[], role: string, override: SystemFont | null): ResolvedType {
  const scale = SIZE_SCALE[t.size];
  if (override) return { family: override, assName: assSystemFontName(override, true), bold: true, scale, textCase: t.textCase, custom: false };
  const ps = macPostscriptName(t.font);
  if (ps) return resolveMacFont(ps, t.face, scale, t.textCase);
  const id = customFontId(t.font);
  if (id) {
    const f = fonts.find((x) => x.id === id);
    if (f && ASS_SAFE.test(f.assName)) {
      // the exact uploaded face by its full name; bold only when the file is bold (no synthetic bolding)
      return { family: f.family, assName: f.assName, bold: f.weight >= 600, scale, textCase: t.textCase, custom: true };
    }
    warnings.push(`${role}: eigene Schrift nicht mehr vorhanden – Avenir Next verwendet.`);
    return { family: 'Avenir Next', assName: assSystemFontName('Avenir Next', true), bold: true, scale, textCase: t.textCase, custom: false };
  }
  const family = isSystemFont(t.font) ? t.font : 'Avenir Next';
  const bold = t.weight === 'bold';
  return { family, assName: assSystemFontName(family, bold), bold, scale, textCase: t.textCase, custom: false };
}

/** Etappe 18: one type role resolved for rendering (carousel title/text use their own roles, outside the overlay look). */
export function resolveTypeToken(t: TypeToken, fonts: readonly CustomFontInfo[], warnings: string[], role: string): ResolvedType {
  return resolveType(t, fonts, warnings, role, null);
}

/**
 * A font installed on this Mac: the ASS gets its English full name (`face.assName`; CoreText resolves it to exactly this
 * face – the PostScript name fails for some TrueType files, e.g. Georgia-Bold), else the PostScript name; bold only
 * when the face is bold (no synthetic bolding), italic only when she chose an italic face.
 */
export function resolveMacFont(ps: string, face: FontFace | undefined, scale: number, textCase: TextCase): ResolvedType {
  return { family: face?.family ?? ps, assName: face?.assName ?? ps, bold: (face?.weight ?? 400) >= 600, scale, textCase, custom: false, mac: true, postscriptName: ps, ...(face?.italic ? { italic: true as const } : {}) };
}

/** An element's own font (inspector) resolved like a role's; unknown own font → null (the role's font stays, with a warning). */
export function resolveElementFont(f: ElementFont, fonts: readonly CustomFontInfo[], warnings: string[]): ResolvedType | null {
  const ps = macPostscriptName(f.ref);
  if (ps) return resolveMacFont(ps, f.face, 1, 'none');
  const id = customFontId(f.ref);
  if (id) {
    const c = fonts.find((x) => x.id === id);
    if (c && ASS_SAFE.test(c.assName)) return { family: c.family, assName: c.assName, bold: c.weight >= 600, scale: 1, textCase: 'none', custom: true };
    warnings.push('Element: eigene Schrift nicht mehr vorhanden – Schrift der Rolle verwendet.');
    return null;
  }
  return isSystemFont(f.ref) ? { family: f.ref, assName: assSystemFontName(f.ref, true), bold: true, scale: 1, textCase: 'none', custom: false } : null;
}
/** Key of an element font in `LookTokens.elementFonts`. */
export const elementFontKey = (f: ElementFont) => `${f.ref}${f.face ? `|${f.face.weight}|${f.face.italic ? 'i' : ''}` : ''}`;

/** Outline colour of text without a box: near-black or white, whichever contrasts more with the text. */
export const outlineFor = (text: string) => (contrastRatio(text, '#101010') >= contrastRatio(text, '#FFFFFF') ? '#101010' : '#FFFFFF');

/**
 * Resolves a design system and a preset to concrete fonts and colours. Unknown preset → default preset (warning).
 * `fontOverride` (a plan that keeps its own font) replaces the family of hook, lower third and keyword.
 */
export function resolveDesignLook(design: DesignSystem, opts: { presetId?: string | null; fontOverride?: SystemFont | null; fonts?: readonly CustomFontInfo[] } = {}): { look: DesignLook; warnings: string[] } {
  const warnings: string[] = [];
  const fonts = opts.fonts ?? [];
  let preset = design.presets.find((p) => p.id === (opts.presetId ?? design.defaultPresetId));
  if (!preset) {
    if (opts.presetId) warnings.push(`Overlay-Stil „${opts.presetId}“ gibt es in dieser Version nicht – Standard-Stil verwendet.`);
    preset = design.presets.find((p) => p.id === design.defaultPresetId) ?? design.presets[0]!;
  }
  const col = (r: ColorRole) => design.colors[r].hex;
  const ov = opts.fontOverride ?? null;
  const t = design.typography;
  const look: DesignLook = {
    presetId: preset.id, presetName: preset.name,
    hook: { type: resolveType(t.hook, fonts, warnings, 'Hook', ov), shape: preset.hook.shape, fill: col(preset.hook.fill), text: col(preset.hook.text) },
    lowerThird: { type: resolveType(t.lowerThird, fonts, warnings, 'Bauchbinde', ov), shape: preset.lowerThird.shape, fill: col(preset.lowerThird.fill), stripe: col(preset.lowerThird.stripe), text: col(preset.lowerThird.text) },
    keyword: { type: resolveType(t.keyword, fonts, warnings, 'Keyword', ov), shape: preset.keyword.shape, fill: col(preset.keyword.fill), text: col(preset.keyword.text) },
    subtitle: { type: resolveType(t.subtitle, fonts, warnings, 'Untertitel', null), text: col('onVideo'), outline: outlineFor(col('onVideo')) },
    graphic: col(preset.graphic),
    animation: preset.animation,
    customFonts: false,
  };
  look.customFonts = [look.hook, look.lowerThird, look.keyword, look.subtitle].some((x) => x.type.custom);
  // Etappe 16b: role defaults – only written when a role sets one, so older designs resolve to the same JSON (lookKey)
  const anim: NonNullable<DesignLook['anim']> = {};
  for (const r of ['hook', 'lowerThird', 'keyword'] as const) if (t[r].animation) anim[r] = t[r].animation;
  if (Object.keys(anim).length) look.anim = anim;
  if (t.subtitle.subtitleMode && t.subtitle.subtitleMode !== 'lines') {
    look.subtitleMode = t.subtitle.subtitleMode;
    if (t.subtitle.subtitleMode === 'karaoke') look.wordsPerLine = t.subtitle.wordsPerLine ?? 3;
  }
  for (const c of contrastChecks(design.colors, preset).filter((x) => !x.aa && x.label.startsWith(preset.name)))
    warnings.push(`${c.label}: Kontrast ${c.ratio.toFixed(1)}:1 liegt unter WCAG AA (4,5:1).`);
  return { look, warnings };
}

/** Text in the role's case (German upper case: ß → SS). */
export const applyCase = (text: string, c: TextCase) => (c === 'upper' ? text.toLocaleUpperCase('de-DE') : c === 'lower' ? text.toLocaleLowerCase('de-DE') : text);

/** Per-element size scale and case for layout (absent = Etappe-8 sizes, text unchanged). */
export interface OverlayFit { hook: { scale: number; textCase: TextCase }; lowerThird: { scale: number; textCase: TextCase }; keyword: { scale: number; textCase: TextCase } }
export const fitOf = (d: DesignLook): OverlayFit => ({
  hook: { scale: d.hook.type.scale, textCase: d.hook.type.textCase },
  lowerThird: { scale: d.lowerThird.type.scale, textCase: d.lowerThird.type.textCase },
  keyword: { scale: d.keyword.type.scale, textCase: d.keyword.type.textCase },
});

/** Sample texts and slots of the specimen and the page preview (hook in its slot, keyword and lower third in the others). */
export const SPECIMEN_TEXT = { hook: 'So sieht dein Hook aus', lowerThird: 'Dein Name · Thema', keyword: 'Keyword', subtitle: 'So sehen deine Untertitel aus' } as const;
type SlotName = z.infer<typeof SlotName>;
export function specimenSlots(preset: Pick<OverlayPreset, 'hookSlot' | 'overlaySlot'>): { hook: SlotName; keyword: SlotName; lowerThird: SlotName } {
  const all: SlotName[] = ['upper', 'center', 'lower'];
  const keyword = preset.overlaySlot !== preset.hookSlot ? preset.overlaySlot : all.find((s) => s !== preset.hookSlot)!;
  return { hook: preset.hookSlot, keyword, lowerThird: all.find((s) => s !== preset.hookSlot && s !== keyword)! };
}

export { SYSTEM_FONTS };
