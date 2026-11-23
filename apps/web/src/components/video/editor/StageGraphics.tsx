'use client';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { applyCase } from '@studio/core/designSystem';
import { FRAME_BARS, HOOK_PAD, KEYWORD_PAD, LOWER_THIRD, LOWER_THIRD_TEXT_INSET, overlayFontSize, subtitleMarginV, SUBTITLE_SIZE, type Box } from '@studio/core/overlayLayout';
import { elementAnimSpec, elementFontOf, elementSpec, renderSpec, type LookTokens } from '@studio/core/overlays';
import { activeWordAt, animStateAt, bigWordSize, type AnimSpec } from '@studio/core/textAnim';
import type { ResolvedType } from '@studio/core/designSystem';
import { assEmFactor } from '@studio/core/lookBase';
import { cssFontOfType } from '../../fonts/fontCss';
import type { SubtitleCue } from '@studio/core/transcript';
import type { ViewHook, ViewOverlay } from '@studio/core/timelineView';
import type { TimedImage } from '@studio/core/imageLayer';

/**
 * Hook, overlays and subtitles as DOM on the 9:16 stage (Etappe 13, E6). Every box comes from the core view (`overlayBox`,
 * `hookLayout` – the functions the ASS writer uses), colours, shapes and fonts from the element's look (`elementSpec`:
 * its own overlay style or the plan's). Glyphs are the browser's: exact is the FFmpeg frame („Standbild prüfen“).
 */
export type ElementRef = { type: 'overlay' | 'image'; clip: number; index: number } | { type: 'hook' };
export const sameRef = (a: ElementRef | null, b: ElementRef | null) =>
  !!a && !!b && a.type === b.type && (a.type === 'hook' || (b.type !== 'hook' && a.clip === b.clip && a.index === b.index));
/** An image of the stage with its opacity at the playhead (`imageAlphaAt`, the render's fade). */
export type StageImage = TimedImage & { alpha: number };
export const KIND_LABEL = { lower_third: 'Bauchbinde', keyword: 'Keyword', arrow: 'Pfeil', frame: 'Rahmen' } as const;
const ARROW_DEG = { down: 0, right: -90, up: 180, left: 90 } as const;

const cssFamily = (t: Pick<ResolvedType, 'family' | 'assName' | 'mac'>) => cssFontOfType(t);
/** libass ÷ browser glyph size (shared with the carousel preview, core `assEmFactor`). */
const cssSize = (family: string, assSize: number, k: number) => assSize * assEmFactor(family) * k;
const fontWeight = (bold: boolean) => (bold ? 700 : 400);
/** Etappe 16b: opacity and scale of an element at the playhead – the same time description as its ASS tags (`elementAnimSpec`). */
const animAt = (spec: AnimSpec, el: { startSec: number; endSec: number }, t: number | undefined, still: boolean) =>
  still || t == null ? { opacity: 1, scale: 1 } : animStateAt(spec, Math.round((t - el.startSec) * 1000), Math.round((el.endSec - el.startSec) * 1000));
const typeStyle = (t: ResolvedType) => ({ fontFamily: cssFamily(t), fontWeight: fontWeight(t.bold), fontStyle: t.italic ? 'italic' as const : undefined });

/** CSS box of a PlayRes box at stage scale k (the parity test reads exactly these numbers). */
export const cssBox = (b: Box, k: number) => ({ left: b.x0 * k, top: b.y0 * k, width: (b.x1 - b.x0) * k, height: (b.y1 - b.y0) * k });

export interface StageGraphicsProps {
  /** Etappe 16: her library images – drawn first (below text, hook and subtitles, as in the render). */
  images?: readonly StageImage[];
  overlays: readonly ViewOverlay[];
  hook: ViewHook | null;
  cue: SubtitleCue | null;
  subtitleY?: number;
  look: LookTokens;
  /** Stage width / 1080. */
  k: number;
  /** Etappe 16b: playhead (output time) – the lit word of word-by-word subtitles. */
  t?: number;
  /** Etappe 16b: while playing, fade/pop are drawn for the playhead moment (same numbers as the ASS); paused = static for editing (exact: „Standbild prüfen“). */
  playing?: boolean;
  /** Etappe 16b: word-by-word subtitles (null = lines). */
  subtitleAnim?: { mode: 'karaoke' | 'word'; highlight: string } | null;
  selected?: ElementRef | null;
  onElementPointerDown?: (ref: ElementRef, e: ReactPointerEvent<HTMLElement>) => void;
  onElementKeyDown?: (ref: ElementRef, e: ReactKeyboardEvent<HTMLElement>) => void;
}

export function StageGraphics({ images = [], overlays, hook, cue, subtitleY, look, k, t, playing = false, subtitleAnim = null, selected = null, onElementPointerDown, onElementKeyDown }: StageGraphicsProps) {
  const animT = playing ? t : undefined;
  const base = renderSpec(look);
  const outline = (c: string, w: number) => ({ textShadow: [-1, 1].flatMap((x) => [-1, 1].map((y) => `${x * w * k}px ${y * w * k}px 0 ${c}`)).join(', ') });
  const interactive = !!onElementPointerDown;
  const hit = (ref: ElementRef, label: string) => interactive ? {
    role: 'button' as const, tabIndex: 0, 'aria-label': label, 'aria-pressed': sameRef(selected, ref),
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onElementPointerDown?.(ref, e),
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => onElementKeyDown?.(ref, e),
  } : {};
  const ring = (ref: ElementRef) => (sameRef(selected, ref) ? 'outline outline-2 outline-offset-2 outline-[#d8fb96]' : interactive ? 'hover:outline hover:outline-1 hover:outline-white/70' : '');
  const cursor = interactive ? 'pointer-events-auto cursor-move touch-none' : '';
  const sub = base.subtitle;

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="stage-graphics">
      {images.map((im) => {
        const ref: ElementRef = { type: 'image', clip: im.clip, index: im.index };
        return (
          // eslint-disable-next-line @next/next/no-img-element -- her own library image from the studio's API, the box is the render's
          <img key={`img-${im.clip}-${im.index}`} src={`/api/media/${im.referenceId}`} alt="" draggable={false} data-testid="stage-image" data-clip={im.clip} data-index={im.index}
            {...hit(ref, 'Bild verschieben (Pfeiltasten) oder auswählen')} className={`absolute object-fill ${cursor} ${ring(ref)}`} style={{ ...cssBox(im.box, k), opacity: im.alpha }} />
        );
      })}
      {overlays.map((o) => {
        const ref: ElementRef = { type: 'overlay', clip: o.clip, index: o.index };
        const spec = elementSpec(look, o.presetId);
        const b = o.box;
        const still = sameRef(selected, ref);
        const textAnim = animAt(elementAnimSpec(o.kind, o.anim, spec, 'text'), o, animT, still);
        const shapeAnim = animAt(elementAnimSpec(o.kind, o.anim, spec, 'shape'), o, animT, still);
        const own = elementFontOf(look, o.font);
        const common = { 'data-testid': 'stage-overlay', 'data-clip': o.clip, 'data-index': o.index, 'data-kind': o.kind, ...hit(ref, `${KIND_LABEL[o.kind]}${o.text ? ` „${o.text}“` : ''} verschieben (Pfeiltasten) oder auswählen`) };
        if (o.kind === 'keyword') {
          const kw = spec.keyword;
          // the outer box is the core box (selection, collisions); the visible box wraps the glyphs like libass (BorderStyle 3, 18 px)
          return (
            <div key={`${o.clip}-${o.index}`} {...common} data-opacity={textAnim.opacity.toFixed(2)} data-scale={textAnim.scale.toFixed(3)} className={`absolute flex items-center justify-center whitespace-nowrap ${cursor} ${ring(ref)}`} style={{ ...cssBox(b, k), opacity: textAnim.opacity }}>
              <span style={{
                background: kw.shape === 'box' ? kw.fill : 'transparent', padding: kw.shape === 'box' ? KEYWORD_PAD * k : 0, color: kw.text, lineHeight: 1, ...typeStyle(own ?? kw.type),
                fontSize: cssSize((own ?? kw.type).family, overlayFontSize('keyword', o.text, o.scale), k), ...(kw.shape === 'outline' ? outline(kw.fill, 4) : {}),
                transform: textAnim.scale !== 1 ? `scale(${textAnim.scale})` : undefined,
              }}>{o.text}</span>
            </div>
          );
        }
        if (o.kind === 'lower_third') {
          const lt = spec.lowerThird;
          return (
            <div key={`${o.clip}-${o.index}`} {...common} data-opacity={textAnim.opacity.toFixed(2)} data-scale={textAnim.scale.toFixed(3)} className={`absolute ${cursor} ${ring(ref)}`} style={cssBox(b, k)}>
              {lt.shape !== 'outline' ? <div className="absolute inset-0" style={{ background: lt.fill, opacity: shapeAnim.opacity }} /> : null}
              {lt.shape === 'stripe' ? <div className="absolute top-0 bottom-0 left-0" style={{ width: LOWER_THIRD.stripe * k, background: lt.stripe, opacity: shapeAnim.opacity }} /> : null}
              <div className="absolute top-0 bottom-0 flex items-center whitespace-nowrap" style={{
                left: LOWER_THIRD_TEXT_INSET * k, color: lt.text, ...typeStyle(own ?? lt.type), opacity: textAnim.opacity,
                // libass scales \an4 text around its left-centre anchor
                transform: textAnim.scale !== 1 ? `scale(${textAnim.scale})` : undefined, transformOrigin: 'left center',
                fontSize: cssSize((own ?? lt.type).family, overlayFontSize('lower_third', o.text, o.scale), k), ...(lt.shape === 'outline' ? outline(lt.fill, 3) : {}),
              }}>{o.text}</div>
            </div>
          );
        }
        if (o.kind === 'frame') {
          return (
            <div key={`${o.clip}-${o.index}`} {...common} className={`absolute ${cursor} ${ring(ref)}`} style={{ ...cssBox(b, k), opacity: shapeAnim.opacity }}>
              {FRAME_BARS.map((bar, i) => <div key={i} className="absolute" style={{ ...cssBox({ x0: bar.x0 - b.x0, y0: bar.y0 - b.y0, x1: bar.x1 - b.x0, y1: bar.y1 - b.y0 }, k), background: spec.graphic }} />)}
            </div>
          );
        }
        // the same 7-point arrow as the ASS drawing (120×180, centred, turned in place)
        return (
          <div key={`${o.clip}-${o.index}`} {...common} className={`absolute grid place-items-center ${cursor} ${ring(ref)}`} style={{ ...cssBox(b, k), opacity: shapeAnim.opacity }}>
            <svg width={120 * k} height={180 * k} viewBox="0 0 120 180" style={{ transform: `rotate(${ARROW_DEG[o.direction]}deg)` }} aria-hidden>
              <path d="M40 0 L80 0 L80 100 L120 100 L60 180 L0 100 L40 100 Z" fill={spec.graphic} />
            </svg>
          </div>
        );
      })}
      {hook ? (() => {
        const ref: ElementRef = { type: 'hook' };
        const hs = elementSpec(look, hook.presetId);
        const hk = hs.hook;
        const ht = elementFontOf(look, hook.font) ?? hk.type;
        const a = animAt(elementAnimSpec('hook', hook.anim, hs), hook, animT, sameRef(selected, ref));
        return (
          <div data-testid="stage-hook" data-font={ht.family} data-opacity={a.opacity.toFixed(2)} data-scale={a.scale.toFixed(3)} {...hit(ref, `Hook „${hook.text}“ verschieben (Pfeiltasten) oder auswählen`)} className={`absolute flex items-center justify-center text-center ${cursor} ${ring(ref)}`} style={{ ...cssBox(hook.layout.box, k), opacity: a.opacity, transform: a.scale !== 1 ? `scale(${a.scale})` : undefined }}>
            {/* a box per line around the glyphs, like libass (BorderStyle 3, 18 px); lines as the core wrapped them */}
            <span style={{
              background: hk.shape === 'box' ? hk.fill : 'transparent', padding: hk.shape === 'box' ? HOOK_PAD * k : 0, boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone',
              color: hk.text, ...typeStyle(ht), fontSize: cssSize(ht.family, hook.layout.size, k), lineHeight: `${hook.layout.size * k}px`,
              ...(hk.shape === 'outline' ? outline(hk.fill, 4) : {}),
            }}>{hook.layout.lines.map((l, i) => <span key={i} className="whitespace-nowrap">{i ? <br /> : null}{l}</span>)}</span>
          </div>
        );
      })() : null}
      {cue ? (() => {
        // Etappe 16b: word-by-word (the spoken word in the accent) or one big word, from the cue's word times
        const words = subtitleAnim && cue.words?.length ? cue.words : null;
        const size = SUBTITLE_SIZE * sub.type.scale;
        const big = words && subtitleAnim?.mode === 'word' ? bigWordSize(applyCase(words.map((w) => w.text).join(' '), sub.type.textCase), Math.round(size)) : null;
        const lit = words && subtitleAnim?.mode === 'karaoke' && t != null ? activeWordAt(cue, t) : null;
        const shown = big ?? size;
        return (
          <div className="absolute text-center" data-testid="stage-subtitle" data-mode={words ? subtitleAnim!.mode : 'lines'} data-active={lit ?? ''} style={{
            left: 90 * k, right: 90 * k, bottom: subtitleMarginV(subtitleY) * k, color: sub.text, ...typeStyle(sub.type), lineHeight: `${shown * k}px`,
            fontSize: cssSize(sub.type.family, shown, k), ...outline(sub.outline, 4),
          }}>{words && subtitleAnim?.mode === 'karaoke'
              ? words.map((w, i) => <span key={i} data-testid="stage-subtitle-word" style={i === lit ? { color: subtitleAnim.highlight } : undefined}>{i ? ' ' : ''}{applyCase(w.text, sub.type.textCase)}</span>)
              : applyCase(words ? words.map((w) => w.text).join(' ') : cue.text, sub.type.textCase)}</div>
        );
      })() : null}
    </div>
  );
}
