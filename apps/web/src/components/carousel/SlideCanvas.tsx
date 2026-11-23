'use client';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { assEmFactor } from '@studio/core/lookBase';
import type { CarouselLook, SlideField, SlideLayout } from '@studio/core/carousel';
import type { ResolvedType } from '@studio/core/designSystem';
import { cssFontOfType } from '../fonts/fontCss';

/**
 * One slide as DOM (Etappe 18), drawn from the SAME core layout as the PNG (`layoutSlide`): boxes, line breaks, line
 * centres and sizes are the core's, so the preview and the FFmpeg picture agree in geometry (parity test); only the glyphs
 * are the browser's (CSS size = ASS size × `assEmFactor`, like the editor stage). The exact picture is „PNG rendern“.
 */
export interface SlideCanvasProps {
  layout: SlideLayout;
  look: CarouselLook;
  /** Rendered width in CSS px (the slide is 1080 wide). */
  width: number;
  /** Fields can be clicked (big editor); the selected field is outlined. */
  onFieldClick?: (field: SlideField) => void;
  selectedField?: SlideField | null;
  /** Library image URL (default `/api/media/<id>`). */
  imageUrl?: (id: string) => string;
  testId?: string;
  className?: string;
  /** Accessible name prefix (default „Slide n“; stories say „Story“). */
  label?: string;
}

const typeOf = (look: CarouselLook, font: 'title' | 'body'): ResolvedType => (font === 'title' ? look.title : look.body);

export function SlideCanvas({ layout, look, width, onFieldClick, selectedField, imageUrl = (id) => `/api/media/${id}`, testId = 'slide-canvas', className = '', label }: SlideCanvasProps) {
  const k = width / layout.width;
  const box = (b: { x0: number; y0: number; x1: number; y1: number }): CSSProperties => ({ position: 'absolute', left: b.x0 * k, top: b.y0 * k, width: (b.x1 - b.x0) * k, height: (b.y1 - b.y0) * k });
  return (
    <div className={`relative shrink-0 overflow-hidden ${className}`} style={{ width, height: layout.height * k, background: layout.bg }} data-testid={testId} role="img"
      aria-label={`${label ?? `Slide ${layout.index + 1}`}: ${layout.elements.flatMap((e) => (e.type === 'text' && e.field ? e.lines.map((l) => l.text) : [])).join(' ').slice(0, 200)}`}>
      {layout.elements.map((e, i) => {
        if (e.type === 'rect') return <div key={i} style={{ ...box(e.box), background: e.color }} data-testid="slide-rect" />;
        if (e.type === 'placeholder')
          return (
            <div key={i} style={{ ...box(e.box), background: e.color }} className="grid place-items-center text-center text-muted" data-testid="slide-placeholder">
              <span style={{ fontSize: Math.max(9, 28 * k) }}>{e.text}</span>
            </div>
          );
        // her image covers its box like FFmpeg's scale(increase)+crop
        // eslint-disable-next-line @next/next/no-img-element -- private library image, drawn exactly in its box
        if (e.type === 'image') return <img key={i} src={imageUrl(e.imageId)} alt="" style={{ ...box(e.box), objectFit: 'cover' }} data-testid="slide-image" />;
        if (e.type === 'label')
          return (
            <div key={i} style={{ ...box(e.box), background: '#000000', color: '#FFFFFF', zIndex: 5 }} data-testid="slide-ai-label">
              <span style={{ position: 'absolute', left: (e.x - e.box.x0) * k, top: (e.y - e.box.y0) * k, fontFamily: 'Arial, Helvetica, sans-serif', fontWeight: 700, fontSize: e.size * assEmFactor('Arial') * k, lineHeight: `${e.size * k}px`, whiteSpace: 'pre' }}>{e.text}</span>
            </div>
          );
        const t = typeOf(look, e.font);
        const w = (e.box.x1 - e.box.x0) * k;
        const fieldOf = e.field;
        const clickable = !!(onFieldClick && fieldOf);
        const selected = !!fieldOf && selectedField === fieldOf;
        const style: CSSProperties = { fontFamily: cssFontOfType(t), fontWeight: t.bold ? 700 : 400, fontStyle: t.italic ? 'italic' : undefined, color: e.color };
        return (
          <div key={i} data-testid="slide-text" data-field={fieldOf ?? undefined} data-overflow={e.overflow ? 'true' : undefined}
            onClick={clickable ? (ev: MouseEvent) => { ev.stopPropagation(); onFieldClick!(fieldOf!); } : undefined}
            onKeyDown={clickable ? (ev: KeyboardEvent) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onFieldClick!(fieldOf!); } } : undefined}
            role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined} aria-label={clickable ? `${fieldOf} bearbeiten` : undefined}
            style={{ ...box(e.box), cursor: clickable ? 'text' : undefined, outline: selected ? '2px solid #4a6116' : e.overflow ? '2px dashed #b3261e' : undefined, outlineOffset: 2, zIndex: 2 }}>
            {e.lines.map((l, j) => {
              // the line's anchor x (left / centre / right edge) and vertical centre are the core's
              const left = (e.align === 'left' ? l.x : e.align === 'right' ? l.x - (e.box.x1 - e.box.x0) : l.x - (e.box.x1 - e.box.x0) / 2) * k;
              return (
                <div key={j} data-testid="slide-line" data-align={e.align}
                  style={{ ...style, position: 'absolute', left: left - e.box.x0 * k, top: (l.cy - e.size / 2 - e.box.y0) * k, width: w, height: e.size * k, lineHeight: `${e.size * k}px`, fontSize: e.size * assEmFactor(t.family) * k, textAlign: e.align, whiteSpace: 'pre' }}>
                  {l.text}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
