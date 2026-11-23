/**
 * Shared base of the look (Etappe 14): the system font allow-list and the colour arithmetic. Split out of
 * overlays.ts so the design system (designSystem.ts) and the overlay renderer (overlays.ts) can both use it
 * without a circular import. overlays.ts re-exports everything here, so existing imports keep working.
 */
import { z } from 'zod';

/**
 * macOS system fonts present on the studio Mac (checked with `fc-list`). No font is downloaded or bundled;
 * a missing font is detected in the render log (`fontFallbacks`) and recorded as a warning on the render.
 */
export const OVERLAY_FONTS = ['Avenir Next', 'Helvetica Neue', 'Futura', 'Georgia', 'DIN Condensed'] as const;
export const OverlayFont = z.enum(OVERLAY_FONTS);
export type OverlayFont = z.infer<typeof OverlayFont>;
/** Design-system typography may also pick Arial (the subtitle and AI-label font since Etappe 6). */
export const SYSTEM_FONTS = [...OVERLAY_FONTS, 'Arial'] as const;
export type SystemFont = (typeof SYSTEM_FONTS)[number];
export const isSystemFont = (s: string): s is SystemFont => (SYSTEM_FONTS as readonly string[]).includes(s);

/**
 * Name written into the ASS styles. libass with the CoreText provider resolves „Avenir Next“ bold to the BoldItalic
 * face of Avenir Next.ttc (verified 2026-11-16, FFmpeg 9.0.2 ffmpeg-full, Apple Silicon), so that family gets its
 * exact PostScript name, bold and regular. The look keeps the family name.
 */
export const ASS_FONT_NAME: Readonly<Record<OverlayFont, string>> = {
  'Avenir Next': 'AvenirNext-Bold', 'Helvetica Neue': 'Helvetica Neue', Futura: 'Futura', Georgia: 'Georgia', 'DIN Condensed': 'DIN Condensed',
};
const ASS_FONT_NAME_REGULAR: Readonly<Partial<Record<SystemFont, string>>> = { 'Avenir Next': 'AvenirNext-Regular' };
/** ASS font name of a system font in the given weight. */
export const assSystemFontName = (family: SystemFont, bold: boolean): string =>
  bold ? (ASS_FONT_NAME as Record<string, string>)[family] ?? family : ASS_FONT_NAME_REGULAR[family] ?? family;

/**
 * libass draws a font size as the font's whole line height (ascender + descender), the browser as its em size, so the
 * same number gives smaller glyphs in the render. Measured 2026-11-19 (FFmpeg 9 + libass, Chromium, macOS system fonts:
 * cap height and width of „HHHHH“ at 200, libass ÷ browser). Other fonts: a middle value (the FFmpeg picture is exact).
 * Shared by the editor stage (Etappe 13) and the carousel preview (Etappe 18).
 */
export const ASS_EM: Readonly<Record<string, number>> = { 'Avenir Next': 0.73, 'Helvetica Neue': 0.84, Futura: 0.75, Georgia: 0.88, 'DIN Condensed': 0.84, Arial: 0.89 };
export const ASS_EM_DEFAULT = 0.82;
/** Glyph em of an ASS font size (`\fs`) as a share of that size: CSS font-size = ASS size × this. */
export const assEmFactor = (family: string) => ASS_EM[family] ?? ASS_EM_DEFAULT;

export const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9A-Fa-f]{6}$/.test(s);

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
/** Relative luminance (WCAG), 0 = black, 1 = white. */
export const luminance = lum;
/** WCAG contrast ratio of two colours (1..21). */
export const contrastRatio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
/** WCAG AA for normal text. */
export const AA_TEXT = 4.5;
/** White or near-black, whichever reads better on `bg`. */
export const readableOn = (bg: string) => (contrastRatio('#FFFFFF', bg) >= contrastRatio('#111111', bg) ? '#FFFFFF' : '#111111');
export const darken = (hex: string, f = 0.45) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
/** HSV saturation × value (0..1): how colourful a colour looks (greys and near-black are ~0). */
export const chroma = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...c) - Math.min(...c);
};

/**
 * Etappe 16b: a font installed on this Mac, referenced by its PostScript name (`mac:<PostScriptName>`). libass with the
 * CoreText provider resolves system fonts by PostScript name (as `AvenirNext-Bold` above), so the exact face is chosen;
 * the render log check (`fontFallbacks` with the expected PostScript name) reports any other pick. Only names libass and
 * the ASS style line can carry safely (A–Z, 0–9, `-`, `_`).
 */
export const MAC_FONT_RE = /^mac:[A-Za-z0-9_-]{1,63}$/;
export const isMacFontRef = (s: string) => MAC_FONT_RE.test(s);
export const macFontRef = (postscriptName: string) => `mac:${postscriptName}`;
/** PostScript name of a `mac:` reference, else null. */
export const macPostscriptName = (ref: string) => (MAC_FONT_RE.test(ref) ? ref.slice('mac:'.length) : null);
