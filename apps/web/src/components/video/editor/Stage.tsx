'use client';
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { placeElement, STAGE_ZONES, type Placement, type PlaceTarget } from '@studio/core/overlayLayout';
import { lookFontTypes, renderSpec, type LookTokens } from '@studio/core/overlays';
import { MacFontFaces } from '../../fonts/fontCss';
import type { TimelineView } from '@studio/core/timelineView';
import type { EditorMedia } from '@/lib/types';
import { imageAlphaAt, placeImage } from '@studio/core/imageLayer';
import { cssBox, sameRef, StageGraphics, type ElementRef, type StageImage } from './StageGraphics';

/**
 * The 9:16 stage (Etappe 12/13, E6): the proxy video as the clock, hook, overlays and subtitles as a DOM layer on top
 * (`StageGraphics`, geometry from the core view). Etappe 13: elements are selected by click and placed by drag – the
 * drop goes through core `placeElement` (snaps into slots and to the centre lines, never into the AI-label zone; Alt =
 * no snapping); arrow keys move a selected element. „Exakte Vorschau“ and „Standbild prüfen“ are shown in the same frame.
 */
export type ExactView = { kind: 'video'; url: string } | { kind: 'image'; url: string; t: number } | null;

/** @font-face by family name for her uploaded fonts (the look names them by family, the files are served by id). */
export function CustomFontFaces({ enabled, fontsKey }: { enabled: boolean; fontsKey: string }) {
  const [css, setCss] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetch('/api/fonts', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).then((list: { id: string; family: string; weight: number }[]) => {
      if (!live) return;
      setCss(list.filter((f) => /^[A-Za-z0-9-]{1,64}$/.test(f.id) && /^[A-Za-z0-9 _-]{1,63}$/.test(f.family))
        .map((f) => `@font-face{font-family:'${f.family}';src:url('/api/fonts/${f.id}');font-weight:${f.weight};font-display:swap;}`).join('\n'));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [enabled, fontsKey]);
  return css ? <style>{css}</style> : null;
}

const SNAP_LABEL: Record<NonNullable<Placement['snapped']>, string> = { slot: 'Platz', center: 'Mitte (waagrecht)', middle: 'Bildmitte (senkrecht)' };
const SLOT_LABEL = { upper: 'oben', center: 'Mitte', lower: 'unten' } as const;

export interface StageProps {
  view: TimelineView; t: number; look: LookTokens | null; media: readonly EditorMedia[]; assetIds: readonly string[];
  activeAsset: string | null; register: (assetId: string, el: HTMLVideoElement | null) => void; showZones: boolean; subtitlesOn: boolean; subtitleY?: number; height: number;
  /** Etappe 16b: word-by-word subtitles (null = lines). */
  subtitleAnim?: { mode: 'karaoke' | 'word'; highlight: string } | null;
  /** Etappe 16b: animations run on the stage while playing. */
  playing?: boolean;
  selected: ElementRef | null;
  onSelect: (ref: ElementRef | null) => void;
  /** Drag on the stage: `preview` while moving (no undo step), `commit` on drop, `cancel` when the drag is aborted. */
  onPlace: (ref: ElementRef, placement: Placement | null, phase: 'preview' | 'commit' | 'cancel') => void;
  onRemove: (ref: ElementRef) => void;
  /** Size step of the selected element from the stage chips (undefined = the role's size). */
  onSize: (ref: ElementRef, size: 'S' | 'M' | 'L' | undefined) => void;
  exact: ExactView;
  onCloseExact: () => void;
}

type Drag = { ref: ElementRef; target: PlaceTarget | { kind: 'image'; aspect: number; size: 'S' | 'M' | 'L' }; x0: number; y0: number; cx0: number; cy0: number; moved: boolean; last: Placement | null };

/** Where an element lands: text elements snap (`placeElement`), images stay in the picture below the label zone (`placeImage`). */
const placeOf = (target: Drag['target'], cx: number, cy: number, free: boolean): Placement | null =>
  target.kind === 'image' ? { pos: placeImage(target, cx, cy), snapped: null } : placeElement(target, cx, cy, { free });

export function Stage(p: StageProps) {
  const { view, t, look, media, assetIds, activeAsset, height } = p;
  const width = Math.round((height * 9) / 16);
  const k = width / 1080;
  const spec = look ? renderSpec(look) : null;
  // Etappe 16b: every font the look draws with (roles, element styles, element fonts) for the browser's @font-face
  const fontTypes = look ? [...lookFontTypes(look), ...(spec ? [spec.hook.type, spec.keyword.type, spec.lowerThird.type, spec.subtitle.type] : [])] : [];
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const at = (a: { startSec: number; endSec: number }) => t >= a.startSec && t < a.endSec;
  // the element being dragged or selected stays visible, also a moment outside its time
  const overlays = view.overlays.filter((o) => at(o) || sameRef(p.selected, { type: 'overlay', clip: o.clip, index: o.index }));
  const hook = view.hook && (at(view.hook) || sameRef(p.selected, { type: 'hook' })) ? view.hook : null;
  // Etappe 16: images with their opacity at the playhead (a selected one stays visible)
  const images: StageImage[] = view.images.flatMap((im) => {
    const sel = sameRef(p.selected, { type: 'image', clip: im.clip, index: im.index });
    const alpha = imageAlphaAt(im, t);
    return alpha > 0 || sel ? [{ ...im, alpha: Math.max(alpha, sel ? 0.6 : 0) }] : [];
  });
  // burned subtitles only when the cut burns them (the track shows the cues either way)
  const cue = p.subtitlesOn ? view.subtitles.find(at) ?? null : null;
  const used = [...new Set(assetIds)];
  const active = media.find((m) => m.id === activeAsset) ?? null;

  function targetOf(ref: ElementRef): { target: Drag['target']; cx: number; cy: number } | null {
    if (ref.type === 'image') {
      const im = view.images.find((x) => x.clip === ref.clip && x.index === ref.index);
      return im ? { target: { kind: 'image', aspect: im.aspect, size: im.size }, cx: (im.box.x0 + im.box.x1) / 2, cy: (im.box.y0 + im.box.y1) / 2 } : null;
    }
    if (ref.type === 'hook') {
      if (!view.hook) return null;
      const b = view.hook.layout.box;
      return { target: { kind: 'hook', text: view.hook.text, scale: view.hook.scale }, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 };
    }
    const o = view.overlays.find((x) => x.clip === ref.clip && x.index === ref.index);
    if (!o || o.kind === 'frame') return null;
    return { target: { kind: o.kind, text: o.text, scale: o.scale }, cx: (o.box.x0 + o.box.x1) / 2, cy: (o.box.y0 + o.box.y1) / 2 };
  }

  /** The selected element as the stage chips need it (null for frames and elements that are gone). */
  function selectedInfo(ref: ElementRef): { size?: 'S' | 'M' | 'L' } | null {
    if (ref.type === 'hook') return view.hook ? { size: view.hook.size } : null;
    if (ref.type === 'image') {
      const im = view.images.find((x) => x.clip === ref.clip && x.index === ref.index);
      return im ? { size: im.size } : null;
    }
    const o = view.overlays.find((x) => x.clip === ref.clip && x.index === ref.index);
    return o && o.kind !== 'frame' ? { size: o.size } : null;
  }

  function onElementPointerDown(ref: ElementRef, e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.stopPropagation();
    p.onSelect(ref);
    const tg = targetOf(ref);
    if (!tg) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ ref, target: tg.target, x0: e.clientX, y0: e.clientY, cx0: tg.cx, cy0: tg.cy, moved: false, last: null });
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) return;
    const place = placeOf(drag.target, drag.cx0 + (e.clientX - drag.x0) / k, drag.cy0 + (e.clientY - drag.y0) / k, e.altKey);
    setDrag({ ...drag, moved: true, last: place });
    setHint(place?.snapped ? `rastet ein: ${SNAP_LABEL[place.snapped]}${place.slot ? ` (${SLOT_LABEL[place.slot]})` : ''}` : null);
    if (place) p.onPlace(drag.ref, place, 'preview');
  }
  function endDrag(cancel: boolean) {
    if (drag?.moved) p.onPlace(drag.ref, cancel ? null : drag.last, cancel ? 'cancel' : 'commit');
    setDrag(null);
    setHint(null);
  }
  function onElementKeyDown(ref: ElementRef, e: ReactKeyboardEvent<HTMLElement>) {
    const step = e.shiftKey ? 50 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = moves[e.key];
    if (d) {
      e.preventDefault();
      e.stopPropagation();
      p.onSelect(ref);
      const tg = targetOf(ref);
      const place = tg ? placeOf(tg.target, tg.cx + d[0], tg.cy + d[1], true) : null;
      if (place) { p.onPlace(ref, place, 'preview'); p.onPlace(ref, place, 'commit'); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      p.onSelect(ref);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      p.onRemove(ref);
    } else if (e.key === '+' || e.key === '-') {
      e.preventDefault();
      e.stopPropagation();
      const order = ['S', 'M', 'L'] as const;
      const cur = selectedInfo(ref)?.size ?? 'M';
      const i = order.indexOf(cur) + (e.key === '+' ? 1 : -1);
      if (i >= 0 && i < order.length) p.onSize(ref, order[i]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      p.onSelect(null);
    }
  }

  return (
    <div className="relative shrink-0 overflow-hidden rounded-lg bg-black" style={{ width, height }} data-testid="editor-stage" aria-label="Bühne 9:16 (Vorschau im Browser)" role="region"
      onPointerMove={onPointerMove} onPointerUp={() => endDrag(false)} onPointerCancel={() => endDrag(true)} onPointerDown={() => p.onSelect(null)}>
      <CustomFontFaces enabled={fontTypes.some((x) => x.custom)} fontsKey={[...new Set(fontTypes.filter((x) => x.custom).map((x) => x.assName))].sort().join('|')} />
      <MacFontFaces names={fontTypes.flatMap((x) => (x.mac ? [x.assName] : []))} />
      {used.map((id) => {
        const m = media.find((x) => x.id === id);
        if (!m?.derived) return null;
        return (
          <video key={id} ref={(el) => p.register(id, el)} src={`/api/media/${id}?variant=proxy`} preload="auto" playsInline muted={false}
            className="absolute inset-0 h-full w-full object-cover" style={{ visibility: id === activeAsset ? 'visible' : 'hidden' }}
            data-testid="stage-video" aria-hidden={id !== activeAsset} />
        );
      })}
      {!view.clips.length ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-xs text-white/70">Noch kein Clip. Footage hochladen oder in der Bibliothek „In den Schnitt“ wählen.</div>
      ) : active && !active.derived ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-xs text-white/80" data-testid="stage-preparing">
          {active.prepare.status === 'failed' ? `Vorbereitung fehlgeschlagen: ${active.prepare.error ?? ''}` : `Vorschau wird vorbereitet … ${active.prepare.progress != null ? `${Math.round(active.prepare.progress * 100)} %` : ''}`}
        </div>
      ) : null}

      {p.showZones ? (
        <div className="pointer-events-none absolute inset-0" data-testid="stage-zones">
          {Object.entries(STAGE_ZONES).map(([key, z]) => (
            <div key={key} className={`absolute border border-dashed ${key === 'label' ? 'border-[#ff8a65]/80 bg-[#ff8a65]/15' : 'border-white/50 bg-white/10'}`} style={cssBox(z, k)} title={z.title}>
              <span className="absolute top-0.5 left-1 font-mono text-[8px] text-white/80">{key === 'label' ? 'KI-Label / Kopf – hier nichts' : key === 'caption' ? 'Instagram unten' : 'Aktionen'}</span>
            </div>
          ))}
        </div>
      ) : null}

      {look ? (
        <StageGraphics images={images} overlays={overlays} hook={hook} cue={cue} subtitleY={p.subtitleY} look={look} k={k} t={t} playing={p.playing} subtitleAnim={p.subtitleAnim ?? null} selected={p.selected}
          onElementPointerDown={onElementPointerDown} onElementKeyDown={onElementKeyDown} />
      ) : null}

      {p.selected && !p.exact && selectedInfo(p.selected) ? (
        <div className="absolute bottom-6 left-1 z-10 flex items-center gap-0.5 rounded bg-black/70 p-0.5 text-[10px] text-white" role="group" aria-label="Größe des gewählten Elements" data-testid="stage-size" onPointerDown={(e) => e.stopPropagation()}>
          <span className="px-1">Größe</span>
          {(['S', 'M', 'L'] as const).map((z) => (
            <button key={z} type="button" className={`rounded px-1.5 ${selectedInfo(p.selected!)!.size === z ? 'bg-lime text-olive-ink' : 'hover:bg-white/20'}`} aria-pressed={selectedInfo(p.selected!)!.size === z}
              onClick={() => p.onSize(p.selected!, selectedInfo(p.selected!)!.size === z ? undefined : z)}>{z}</button>
          ))}
        </div>
      ) : null}
      {hint ? <span className="pointer-events-none absolute top-1 right-1 rounded bg-lime px-1.5 font-mono text-[9px] text-olive-ink" data-testid="stage-snap">{hint}</span> : null}

      {p.exact ? (
        <div className="absolute inset-0 z-20 bg-black" data-testid={p.exact.kind === 'image' ? 'stage-still' : 'stage-exact'} onPointerDown={(e) => e.stopPropagation()}>
          {p.exact.kind === 'image'
            // eslint-disable-next-line @next/next/no-img-element -- a private PNG from the studio's own API
            ? <img src={p.exact.url} alt={`Standbild (FFmpeg) bei ${p.exact.t.toFixed(2)} s`} className="h-full w-full object-contain" />
            : <video src={p.exact.url} className="h-full w-full" controls autoPlay playsInline aria-label="Exakte Vorschau (FFmpeg, 540×960)" />}
          <span className="absolute top-1 left-1 rounded bg-black/60 px-1 font-mono text-[9px] text-white">{p.exact.kind === 'image' ? `Standbild · FFmpeg · ${p.exact.t.toFixed(2)} s` : 'Exakte Vorschau · FFmpeg · 540×960'}</span>
          <button type="button" className="absolute top-1 right-1 rounded bg-white/90 px-2 text-[11px] text-black" onClick={p.onCloseExact} data-testid="close-exact">Schließen</button>
        </div>
      ) : null}
      <span className="pointer-events-none absolute right-1 bottom-1 rounded bg-black/50 px-1 font-mono text-[8px] text-white">Vorschau (Browser) · exakt: Standbild/Exakte Vorschau</span>
    </div>
  );
}
