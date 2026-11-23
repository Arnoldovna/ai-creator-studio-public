'use client';
import { applyCase, customFontId, SIZE_SCALE, SPECIMEN_TEXT, specimenSlots, type DesignSystem, type OverlayPreset, type TypeToken } from '@studio/core/designSystem';
import { hookLayout, overlayBox, overlayFontSize, type Box } from '@studio/core/overlays';
import { cssFontOfRef } from '../fonts/fontCss';

/**
 * 9:16 preview of one overlay style as DOM (Etappe 14). The geometry comes from the same core functions as the ASS
 * (`hookLayout`, `overlayBox`, `overlayFontSize`); glyphs are the browser's, so the exact picture is the specimen
 * („Exaktes Musterbild“, FFmpeg + libass).
 */
/** CSS font-family of a type role (her own fonts are loaded with @font-face as `studio-font-<id>`, Mac fonts by local()). */
export const cssFont = (ref: string, family?: string) => cssFontOfRef(ref, family);
export const cssWeight = (t: TypeToken) => (customFontId(t.font) ? 400 : t.face && t.font.startsWith('mac:') ? t.face.weight : t.weight === 'bold' ? 700 : 400);

export function StagePreview({ design, preset, width = 270, testId = 'stage-preview' }: { design: DesignSystem; preset: OverlayPreset; width?: number; testId?: string }) {
  const k = width / 1080;
  const col = (r: keyof DesignSystem['colors']) => design.colors[r].hex;
  const t = design.typography;
  const slots = specimenSlots(preset);
  const hookText = applyCase(SPECIMEN_TEXT.hook, t.hook.textCase);
  const kwText = applyCase(SPECIMEN_TEXT.keyword, t.keyword.textCase);
  const ltText = applyCase(SPECIMEN_TEXT.lowerThird, t.lowerThird.textCase);
  const hook = hookLayout(hookText, slots.hook, SIZE_SCALE[t.hook.size]);
  const kw = overlayBox({ kind: 'keyword', text: kwText, slot: slots.keyword, scale: SIZE_SCALE[t.keyword.size] });
  const lt = overlayBox({ kind: 'lower_third', text: ltText, slot: slots.lowerThird, scale: SIZE_SCALE[t.lowerThird.size] });
  const pos = (b: Box) => ({ left: b.x0 * k, top: b.y0 * k, width: (b.x1 - b.x0) * k, height: (b.y1 - b.y0) * k });
  const outline = (c: string, w: number) => ({ textShadow: [-1, 1].flatMap((x) => [-1, 1].map((y) => `${x * w * k}px ${y * w * k}px 0 ${c}`)).join(', ') });
  const fadeClass = preset.animation === 'fade' ? 'stage-fade' : '';
  return (
    <div className="relative shrink-0 overflow-hidden rounded-lg border border-line" style={{ width, height: (width * 16) / 9, background: 'linear-gradient(160deg, #6b7068, #3e423c)' }} data-testid={testId} aria-label={`Vorschau Overlay-Stil ${preset.name}`} role="img">
      {hook ? (
        <div className={`absolute flex flex-col items-center justify-center text-center ${fadeClass}`} style={{
          ...pos(hook.box), background: preset.hook.shape === 'box' ? col(preset.hook.fill) : 'transparent', color: col(preset.hook.text),
          fontFamily: cssFont(t.hook.font), fontWeight: cssWeight(t.hook), fontSize: hook.size * k, lineHeight: 1.2,
          ...(preset.hook.shape === 'outline' ? outline(col(preset.hook.fill), 4) : {}),
        }}>{hook.lines.map((l, i) => <span key={i} className="whitespace-nowrap">{l}</span>)}</div>
      ) : null}
      <div className={`absolute flex items-center justify-center whitespace-nowrap ${fadeClass}`} style={{
        ...pos(kw), background: preset.keyword.shape === 'box' ? col(preset.keyword.fill) : 'transparent', color: col(preset.keyword.text),
        fontFamily: cssFont(t.keyword.font), fontWeight: cssWeight(t.keyword), fontSize: overlayFontSize('keyword', kwText, SIZE_SCALE[t.keyword.size]) * k,
        ...(preset.keyword.shape === 'outline' ? outline(col(preset.keyword.fill), 4) : {}),
      }}>{kwText}</div>
      <div className={`absolute ${fadeClass}`} style={pos(lt)}>
        {preset.lowerThird.shape !== 'outline' ? <div className="absolute inset-0" style={{ background: col(preset.lowerThird.fill) }} /> : null}
        {preset.lowerThird.shape === 'stripe' ? <div className="absolute top-0 bottom-0 left-0" style={{ width: 12 * k, background: col(preset.lowerThird.stripe) }} /> : null}
        <div className="absolute top-0 bottom-0 flex items-center whitespace-nowrap" style={{
          left: (108 - lt.x0) * k, color: col(preset.lowerThird.text), fontFamily: cssFont(t.lowerThird.font), fontWeight: cssWeight(t.lowerThird),
          fontSize: overlayFontSize('lower_third', ltText, SIZE_SCALE[t.lowerThird.size]) * k, ...(preset.lowerThird.shape === 'outline' ? outline(col(preset.lowerThird.fill), 3) : {}),
        }}>{ltText}</div>
      </div>
      <div className="absolute right-0 left-0 text-center" style={{
        top: (1540 - 64 * SIZE_SCALE[t.subtitle.size]) * k, color: col('onVideo'), fontFamily: cssFont(t.subtitle.font), fontWeight: cssWeight(t.subtitle),
        fontSize: 64 * SIZE_SCALE[t.subtitle.size] * k, ...outline('#101010', 4),
      }}>{applyCase(SPECIMEN_TEXT.subtitle, t.subtitle.textCase)}</div>
      <span className="absolute top-1 left-1 rounded bg-black/40 px-1 font-mono text-[8px] text-white">Vorschau (Browser)</span>
    </div>
  );
}

/** @font-face rules for her uploaded fonts (preview only; the render uses the files through libass). */
export function FontFaces({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  const css = ids.filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id)).map((id) => `@font-face{font-family:'studio-font-${id}';src:url('/api/fonts/${id}');font-display:swap;}`).join('\n');
  return <style>{css}</style>;
}
