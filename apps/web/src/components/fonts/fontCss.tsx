'use client';
import { customFontId, type ResolvedType } from '@studio/core/designSystem';
import { macPostscriptName } from '@studio/core/lookBase';

/**
 * Etappe 16b: how the browser draws the fonts of the library. System fonts by family, her own and Google font files via
 * `@font-face` from `/api/fonts/<id>`, fonts installed on this Mac via `@font-face { src: local('<PostScriptName>') }`
 * (Chromium/Safari match local() by PostScript and full name, so the preview shows exactly the chosen face).
 */
export const CSS_FONT: Record<string, string> = {
  'Avenir Next': "'Avenir Next', Avenir, 'Helvetica Neue', sans-serif",
  'Helvetica Neue': "'Helvetica Neue', Helvetica, Arial, sans-serif",
  Futura: "Futura, 'Century Gothic', sans-serif",
  Georgia: 'Georgia, serif',
  'DIN Condensed': "'DIN Condensed', 'Arial Narrow', sans-serif",
  Arial: 'Arial, Helvetica, sans-serif',
};
const SAFE_PS = /^[A-Za-z0-9_-]{1,63}$/;
const SAFE_NAME = /^[A-Za-z0-9 _-]{1,80}$/;
export const macAlias = (name: string) => `studio-mac-${name.replace(/ /g, '_')}`;
const quote = (s: string) => `'${s.replace(/['\\]/g, '')}'`;

/** CSS font-family of a font reference (type role or element font). */
export function cssFontOfRef(ref: string, family?: string): string {
  const ps = macPostscriptName(ref);
  if (ps) return `${quote(macAlias(ps))}, ${family && SAFE_NAME.test(family) ? `${quote(family)}, ` : ''}sans-serif`;
  const id = customFontId(ref);
  if (id) return `'studio-font-${id}', sans-serif`;
  return CSS_FONT[ref] ?? 'sans-serif';
}

/** CSS font-family of a resolved font of a look (stage). Her own files are loaded by family name (`CustomFontFaces`). */
export function cssFontOfType(t: Pick<ResolvedType, 'family' | 'assName' | 'mac'>): string {
  if (t.mac) return `${quote(macAlias(t.assName))}, sans-serif`;
  return CSS_FONT[t.family] ?? `${quote(t.family)}, sans-serif`;
}

/** `@font-face` rules for Mac fonts by PostScript name (preview only; the render resolves them through CoreText). */
export function MacFontFaces({ names }: { names: readonly string[] }) {
  // PostScript names (picker) or English full names (resolved look); local() matches both
  const ok = [...new Set(names)].filter((n) => SAFE_PS.test(n) || /^[A-Za-z0-9 _-]{1,63}$/.test(n));
  if (!ok.length) return null;
  return <style>{ok.map((n) => `@font-face{font-family:'${macAlias(n)}';src:local('${n}');font-display:swap;}`).join('\n')}</style>;
}

/** `@font-face` rules for Google families she has not added yet (small subset files fetched by the studio server). */
export function GooglePreviewFaces({ families }: { families: readonly { family: string; weight: number }[] }) {
  const ok = families.filter((f) => SAFE_NAME.test(f.family));
  if (!ok.length) return null;
  return <style>{ok.map((f) => `@font-face{font-family:'${googleAlias(f.family)}';src:url('/api/fonts/google/preview?family=${encodeURIComponent(f.family)}&weight=${f.weight}');font-display:swap;}`).join('\n')}</style>;
}
export const googleAlias = (family: string) => `studio-gf-${family.replace(/[^A-Za-z0-9]/g, '')}`;
