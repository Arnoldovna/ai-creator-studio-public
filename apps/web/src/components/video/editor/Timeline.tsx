'use client';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { peaksSlice, spriteTile, type PeaksFile } from '@studio/core/derived';
import { outputSnapTargets, snap, FRAME_SEC, type SnapTarget, type TimelineView, type ViewPiece } from '@studio/core/timelineView';
import type { EditorMedia } from '@/lib/types';
import { KIND_LABEL, sameRef, type ElementRef } from './StageGraphics';
import type { StoryTrack } from './StoryPanel';

/**
 * The timeline (Etappe 12, own build, see the decision in docs/IMPLEMENTATION_LOG.md): tracks for hook/overlays, clips with
 * thumbnails, sound with waveform and pauses, subtitles; ruler with scrubbing, playhead, zoom. Clips: drag an edge to trim
 * (snaps to word boundaries, pauses and the take's ends), drag the clip to reorder. Everything also works by keyboard:
 * the clip is a focusable button, its edges are sliders (←/→ one frame, Shift ten frames).
 * Etappe 13: hook and overlay blocks are selected by click, moved by dragging the block and trimmed at their edges (the
 * hook starts at 0, only its end moves); ←/→ moves a focused block by one frame (Shift ten). Filler and pause suggestions
 * are ghost blocks on their own track with „annehmen“/„ablehnen“ – nothing is applied without her click.
 */
export interface GhostSuggestion { id: string; clip: number; outStart: number; outEnd: number; kind: 'filler' | 'weak_filler' | 'pause' | 'sound'; word: string; safe: boolean; note: string }
const GHOST_LABEL = { filler: 'Füllwort', weak_filler: 'Füllwort (deine Sprechweise)', pause: 'Pause', sound: 'Laut' } as const;
const LABEL_W = 92;
const H = { ruler: 26, overlays: 30, clips: 58, audio: 46, ghosts: 26, subtitles: 28, story: 26 } as const;
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const SNAP_PX = 8;

export interface TimelineProps {
  view: TimelineView;
  t: number;
  media: ReadonlyMap<string, EditorMedia>;
  peaks: ReadonlyMap<string, PeaksFile | null>;
  /** Source-time snap targets of a take (word boundaries, pauses, file ends). */
  snapTargets: (assetId: string) => SnapTarget[];
  selected: number | null;
  mark: { in: number | null; out: number | null };
  subtitlesOn: boolean;
  onSeek: (t: number) => void;
  onScrubStart: () => void;
  onSelect: (clip: number | null) => void;
  onTrimPreview: (clip: number, edge: 'in' | 'out', src: number) => void;
  onTrimCommit: () => void;
  onTrimCancel: () => void;
  onTrimStep: (clip: number, edge: 'in' | 'out', deltaSec: number) => void;
  onMove: (from: number, to: number) => void;
  /** Etappe 13: the selected hook/overlay and its block drag (`preview` while moving, `commit` on drop, `cancel`). */
  selectedEl: ElementRef | null;
  onSelectEl: (ref: ElementRef | null) => void;
  onElementDrag: (ref: ElementRef, outStart: number, outEnd: number, edge: 'move' | 'start' | 'end', phase: 'preview' | 'commit' | 'cancel') => void;
  suggestions: readonly GhostSuggestion[];
  onSuggestion: (id: string, decision: 'accept' | 'reject') => void;
  /** Etappe 16: the dramaturgy proposal on the current cut – beats by role, suggested overlays/images/zooms as ghosts. */
  story?: StoryTrack | null;
  onStoryGhost?: (kind: 'overlay' | 'image' | 'zoom', id: string, decision: 'accept' | 'reject') => void;
  onStoryBeat?: (id: string) => void;
}

function Thumbs({ piece, m, pps }: { piece: ViewPiece; m: EditorMedia | undefined; pps: number }) {
  const th = m?.derived?.thumbs;
  const width = (piece.outEnd - piece.outStart) * pps;
  if (!th || !m) return <div className="absolute inset-0 bg-[#3a4530]" />;
  const s = H.clips / th.tileHeight;
  const tileW = th.tileWidth * s;
  const n = Math.max(1, Math.ceil(width / tileW));
  return (
    <div className="absolute inset-0 flex overflow-hidden" aria-hidden>
      {Array.from({ length: n }, (_, i) => {
        const src = piece.srcIn + (i * tileW) / pps;
        const { x, y } = spriteTile(th, src);
        return <div key={i} className="h-full shrink-0" data-testid="clip-thumb" style={{
          width: tileW, backgroundImage: `url(/api/media/${m.id}?variant=thumbs)`, backgroundSize: `${th.columns * th.tileWidth * s}px ${th.rows * th.tileHeight * s}px`,
          backgroundPosition: `${-x * s}px ${-y * s}px`,
        }} />;
      })}
    </div>
  );
}

function Wave({ piece, peaks, pps }: { piece: ViewPiece; peaks: PeaksFile | null | undefined; pps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = Math.max(1, Math.round((piece.outEnd - piece.outStart) * pps));
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks || !peaks.peaks.length) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = H.audio * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, H.audio);
    const bins = Math.max(1, Math.floor(width / 2));
    const vals = peaksSlice(peaks, piece.srcIn, piece.srcOut, bins);
    ctx.fillStyle = '#b9d982';
    const mid = H.audio / 2;
    vals.forEach((v, i) => {
      const h = Math.max(1, (v / 255) * (H.audio - 6));
      ctx.fillRect((i * width) / bins, mid - h / 2, Math.max(1, width / bins - 0.5), h);
    });
  }, [peaks, piece.srcIn, piece.srcOut, width]);
  if (!peaks) return <div className="absolute inset-0 grid place-items-center text-[9px] text-white/50">{peaks === null ? 'ohne Ton' : 'Wellenform …'}</div>;
  return <canvas ref={ref} className="absolute inset-0" style={{ width, height: H.audio }} data-testid="clip-wave" aria-hidden />;
}

type Drag = { pps: number } & (
  | { kind: 'trim'; clip: number; edge: 'in' | 'out'; x0: number; src0: number; assetId: string }
  | { kind: 'move'; clip: number; x0: number; moved: boolean; to: number }
  | { kind: 'element'; ref: ElementRef; edge: 'move' | 'start' | 'end'; x0: number; s0: number; e0: number; moved: boolean }
  | { kind: 'scrub' });

export function Timeline(p: TimelineProps) {
  const { view, t } = p;
  const scroller = useRef<HTMLDivElement>(null);
  // null = fit the whole cut into the visible width (follows the cut's length); a number = zoomed by hand
  const [pps, setPps] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapHint, setSnapHint] = useState<string | null>(null);
  const [width, setWidth] = useState(800);
  const dur = Math.max(view.durationSec, 1);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitPps = Math.max(5, Math.min(400, (width - LABEL_W - 24) / dur));
  // while dragging, the scale stays as it was when the drag began (a trim changes the length)
  const scale = pps ?? drag?.pps ?? fitPps;
  const contentW = Math.max(dur * scale + 40, 200);
  const xOf = (sec: number) => sec * scale;

  // keep the playhead in view while it moves
  useEffect(() => {
    const el = scroller.current;
    if (!el || drag) return;
    const x = LABEL_W + xOf(t);
    if (x < el.scrollLeft + LABEL_W || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - LABEL_W - 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on playhead moves
  }, [t]);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(view.durationSec, (clientX - r.left + el.scrollLeft - LABEL_W) / scale));
  };

  const ticks = useMemo(() => {
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * scale >= 70) ?? 120;
    return Array.from({ length: Math.floor(dur / step) + 1 }, (_, i) => i * step);
  }, [dur, scale]);

  function startScrub(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    p.onScrubStart();
    setDrag({ kind: 'scrub', pps: scale });
    p.onSeek(timeAt(e.clientX));
  }
  function onMoveEvt(e: ReactPointerEvent) {
    if (!drag) return;
    if (drag.kind === 'scrub') p.onSeek(timeAt(e.clientX));
    else if (drag.kind === 'element') {
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
      const delta = (e.clientX - drag.x0) / scale;
      const targets = outputSnapTargets(view, t);
      let a = drag.s0 + (drag.edge === 'end' ? 0 : delta), b = drag.e0 + (drag.edge === 'start' ? 0 : delta);
      if (!e.altKey) {
        // the moving edge snaps (playhead, clip boundaries, seams); a moved block keeps its length
        const edgeT = drag.edge === 'end' ? b : a;
        const s = snap(edgeT, targets, SNAP_PX / scale);
        if (s.target) {
          if (drag.edge === 'move') { b += s.t - a; a = s.t; } else if (drag.edge === 'start') a = s.t; else b = s.t;
        }
        setSnapHint(s.target ? { word: 'Wortgrenze', silence: 'Pause', clip: 'Clipgrenze', playhead: 'Playhead' }[s.target.kind] : null);
      }
      if (!drag.moved) setDrag({ ...drag, moved: true });
      p.onElementDrag(drag.ref, a, b, drag.edge, 'preview');
    } else if (drag.kind === 'trim') {
      const raw = drag.src0 + (e.clientX - drag.x0) / scale;
      const s = e.altKey ? { t: raw, target: null } : snap(raw, p.snapTargets(drag.assetId), SNAP_PX / scale);
      setSnapHint(s.target ? { word: 'Wortgrenze', silence: 'Pause', clip: 'Clipgrenze', playhead: 'Playhead' }[s.target.kind] : null);
      p.onTrimPreview(drag.clip, drag.edge, s.t);
    } else {
      const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 6;
      const at = timeAt(e.clientX);
      const to = view.clips.filter((c, i) => i !== drag.clip && (c.outStart + c.outEnd) / 2 < at).length;
      setDrag({ ...drag, moved, to });
    }
  }
  function endDrag(e: ReactPointerEvent) {
    if (!drag) return;
    if (drag.kind === 'trim') p.onTrimCommit();
    if (drag.kind === 'element' && drag.moved) p.onElementDrag(drag.ref, 0, 0, drag.edge, 'commit');
    if (drag.kind === 'move') {
      if (drag.moved && drag.to !== drag.clip) p.onMove(drag.clip, drag.to);
      else if (!drag.moved) { p.onSelect(drag.clip); p.onSeek(timeAt(e.clientX)); }
    }
    setSnapHint(null);
    setDrag(null);
  }
  function cancelDrag() {
    if (drag?.kind === 'trim') p.onTrimCancel();
    if (drag?.kind === 'element' && drag.moved) p.onElementDrag(drag.ref, 0, 0, drag.edge, 'cancel');
    setSnapHint(null);
    setDrag(null);
  }

  const trackRow = (label: string, h: number, children: ReactNode, testId: string) => (
    <div className="relative flex border-b border-white/10" style={{ height: h }} data-testid={testId}>
      <div className="sticky left-0 z-20 flex shrink-0 items-center bg-[#20271a] px-2 text-[10px] font-semibold tracking-wide text-white/70 uppercase" style={{ width: LABEL_W }}>{label}</div>
      <div className="relative" style={{ width: contentW }}>{children}</div>
    </div>
  );
  const markLo = p.mark.in != null && p.mark.out != null ? Math.min(p.mark.in, p.mark.out) : p.mark.in;
  const markHi = p.mark.in != null && p.mark.out != null ? Math.max(p.mark.in, p.mark.out) : null;

  type Block = { ref: ElementRef; startSec: number; endSec: number; label: string; hook: boolean; lane: number };
  // Etappe 16: images in their own lanes (same blocks as overlays: drag moves, edges change the duration)
  const imageEnds: number[] = [];
  const imageLanes: Block[] = [...view.images].sort((a, b) => a.startSec - b.startSec).map((im) => {
    let lane = imageEnds.findIndex((end) => end <= im.startSec + 0.001);
    if (lane < 0) { lane = imageEnds.length; imageEnds.push(im.endSec); } else imageEnds[lane] = im.endSec;
    return { ref: { type: 'image', clip: im.clip, index: im.index }, startSec: im.startSec, endSec: im.endSec, label: 'Bild', hook: false, lane };
  });
  // overlays that overlap in time get their own lane, so every block stays visible and draggable
  const laneEnds: number[] = [];
  const overlayLanes: Block[] = [...view.overlays].sort((a, b) => a.startSec - b.startSec).map((o) => {
    let lane = laneEnds.findIndex((end) => end <= o.startSec + 0.001);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(o.endSec); } else laneEnds[lane] = o.endSec;
    return { ref: { type: 'overlay', clip: o.clip, index: o.index }, startSec: o.startSec, endSec: o.endSec, label: o.text || KIND_LABEL[o.kind], hook: false, lane };
  });
  const laneCount = Math.max(1, laneEnds.length);
  const elementBlocks = (list: Block[]) => (
    <>
      {list.map((el) => {
      const sel = sameRef(p.selectedEl, el.ref);
      const key = el.ref.type === 'hook' ? 'hook' : `${el.ref.type}-${el.ref.clip}-${el.ref.index}`;
      const startDrag = (edge: 'move' | 'start' | 'end') => (e: ReactPointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        p.onSelectEl(el.ref);
        if (el.hook && edge !== 'end') return; // the hook always starts at 0
        setDrag({ kind: 'element', ref: el.ref, edge, x0: e.clientX, s0: el.startSec, e0: el.endSec, moved: false, pps: scale });
      };
      return (
        <div key={key} className={`absolute ${drag?.kind === 'element' && sameRef(drag.ref, el.ref) && drag.moved ? 'opacity-80' : ''}`} style={{ left: xOf(el.startSec), width: Math.max(8, xOf(el.endSec - el.startSec)), top: 4 + el.lane * 24, height: 22 }}>
          <div role="button" tabIndex={0} aria-pressed={sel} data-testid={el.hook ? 'track-hook' : el.ref.type === 'image' ? 'track-image' : 'track-overlay'}
            aria-label={`${el.label}, ${fmt(el.startSec)}–${fmt(el.endSec)}. Ziehen verschiebt, Ränder ändern die Dauer, ←/→ verschiebt um ein Bild.`}
            className={`tl-focus absolute inset-0 truncate rounded px-1.5 text-[10px] leading-[20px] ${el.hook ? 'bg-[#d8fb96] text-[#2c3a0c]' : el.ref.type === 'image' ? 'bg-[#c9a77a] text-[#2b1d0d]' : 'bg-[#7aa3c9] text-[#0d2236]'} ${sel ? 'ring-2 ring-white' : ''} ${el.hook ? 'cursor-pointer' : 'cursor-grab'}`}
            title={el.label} onPointerDown={startDrag('move')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); p.onSelectEl(el.ref); p.onSeek(el.startSec); return; }
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              e.stopPropagation();
              const d = (e.key === 'ArrowLeft' ? -1 : 1) * FRAME_SEC * (e.shiftKey ? 10 : 1);
              const edge = el.hook ? 'end' : 'move';
              p.onElementDrag(el.ref, el.startSec + (el.hook ? 0 : d), el.endSec + d, edge, 'preview');
              p.onElementDrag(el.ref, 0, 0, edge, 'commit');
            }}>{el.label}</div>
          {!el.hook ? <div className="absolute top-0 bottom-0 left-0 z-10 w-1.5 cursor-ew-resize rounded-l bg-white/40 hover:bg-white" onPointerDown={startDrag('start')} data-testid="overlay-edge-start" aria-hidden /> : null}
          <div className="absolute top-0 right-0 bottom-0 z-10 w-1.5 cursor-ew-resize rounded-r bg-white/40 hover:bg-white" onPointerDown={startDrag('end')} data-testid={el.hook ? 'hook-edge-end' : 'overlay-edge-end'} aria-hidden />
        </div>
      );
      })}
    </>
  );

  return (
    <div className="min-w-0 rounded-lg border border-[#2d3626] bg-[#1a2015] text-white" data-testid="timeline">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[11px]">
        <span className="font-mono text-white/80" data-testid="timeline-time" aria-live="off">{fmt(t)} / {fmt(view.durationSec)}</span>
        {snapHint ? <span className="rounded bg-lime/20 px-1.5 text-lime">rastet ein: {snapHint}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          <span className="text-white/60">Zoom</span>
          <button type="button" className="rounded border border-white/20 px-2" aria-label="Zeitachse verkleinern" onClick={() => setPps((x) => Math.max(5, (x ?? scale) / 1.5))}>−</button>
          <button type="button" className="rounded border border-white/20 px-2" aria-label="Zeitachse vergrößern" onClick={() => setPps((x) => Math.min(600, (x ?? scale) * 1.5))}>+</button>
          <button type="button" className="rounded border border-white/20 px-2" onClick={() => setPps(null)}>Einpassen</button>
        </span>
      </div>
      <div ref={scroller} className="relative overflow-x-auto overflow-y-hidden select-none" onPointerMove={onMoveEvt} onPointerUp={endDrag} onPointerCancel={cancelDrag}
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setPps((x) => Math.max(5, Math.min(600, (x ?? scale) * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))); } }}>
        <div style={{ width: LABEL_W + contentW }} className="relative">
          {/* ruler: click or drag to scrub */}
          <div className="relative flex border-b border-white/10" style={{ height: H.ruler }}>
            <div className="sticky left-0 z-20 shrink-0 bg-[#20271a]" style={{ width: LABEL_W }} />
            <div className="relative cursor-ew-resize" style={{ width: contentW }} onPointerDown={startScrub} data-testid="timeline-ruler"
              role="slider" tabIndex={0} aria-label="Playhead" aria-valuemin={0} aria-valuemax={view.durationSec} aria-valuenow={Number(t.toFixed(2))} aria-valuetext={fmt(t)}
              onKeyDown={(e) => { if (e.key === 'Home') { e.preventDefault(); p.onSeek(0); } else if (e.key === 'End') { e.preventDefault(); p.onSeek(view.durationSec); } }}>
              {ticks.map((s) => (
                <div key={s} className="absolute top-0 h-full border-l border-white/20" style={{ left: xOf(s) }}>
                  <span className="absolute top-1 left-1 font-mono text-[9px] text-white/60">{fmt(s).replace(/\.0$/, '')}</span>
                </div>
              ))}
              {markLo != null ? <div className="absolute top-0 h-full bg-lime/25" style={{ left: xOf(markLo), width: markHi != null ? xOf(markHi - markLo) : 2 }} data-testid="timeline-mark" /> : null}
            </div>
          </div>

          {p.story?.beats.length ? trackRow('Story', H.story, (
            p.story.beats.map((b) => (
              <button key={b.id} type="button" className={`absolute top-1 bottom-1 truncate rounded px-1 text-left text-[10px] leading-[16px] font-semibold text-[#1d2416] ${b.selected ? '' : 'opacity-40'}`}
                style={{ left: xOf(b.outStart), width: Math.max(10, xOf(b.outEnd - b.outStart)), background: b.color }} data-testid="track-story-beat" data-beat={b.id} data-selected={b.selected}
                title={`${b.label}${b.selected ? '' : ' (abgewählt)'} – Klick springt hin`} onClick={() => { p.onSeek(b.outStart); p.onStoryBeat?.(b.id); }}>{b.label}</button>
            ))
          ), 'track-story') : null}
          {p.story?.ghosts.length ? trackRow('Story-Ideen', H.ghosts, (
            p.story.ghosts.map((g) => (
              <div key={`${g.kind}-${g.id}`} className={`absolute top-1 bottom-1 flex items-center overflow-hidden rounded border border-dashed border-[#c3b4f2] bg-[#c3b4f2]/15 text-[9px] text-[#e2d9ff] ${g.selected ? '' : 'opacity-50'}`}
                style={{ left: xOf(g.outStart), width: Math.max(18, xOf(g.outEnd - g.outStart)) }} data-testid="story-ghost" data-kind={g.kind} title={`Vorschlag: ${g.label}`}>
                <button type="button" className="h-full px-0.5 hover:bg-white/20" aria-label={`${g.label} jetzt übernehmen`} data-testid="story-ghost-accept" onClick={() => p.onStoryGhost?.(g.kind, g.id, 'accept')}>✓</button>
                <button type="button" className="h-full px-0.5 hover:bg-white/20" aria-label={`${g.label} ablehnen`} data-testid="story-ghost-reject" onClick={() => p.onStoryGhost?.(g.kind, g.id, 'reject')}>✕</button>
                <span className="truncate px-0.5">{g.label}</span>
              </div>
            ))
          ), 'track-story-ghosts') : null}
          {view.hook ? trackRow('Hook', H.overlays, elementBlocks([{ ref: { type: 'hook' }, startSec: view.hook.startSec, endSec: view.hook.endSec, label: `Hook: ${view.hook.text}`, hook: true, lane: 0 }]), 'track-hook-row') : null}
          {trackRow('Text/Grafik', Math.max(H.overlays, 6 + laneCount * 24), elementBlocks(overlayLanes), 'track-overlays')}
          {imageLanes.length ? trackRow('Bilder', Math.max(H.overlays, 6 + imageEnds.length * 24), elementBlocks(imageLanes), 'track-images') : null}

          {trackRow('Clips', H.clips, (
            <>
              {view.clips.map((c) => {
                const m = p.media.get(c.assetId);
                const sel = p.selected === c.index;
                const moving = drag?.kind === 'move' && drag.clip === c.index && drag.moved;
                return (
                  <div key={c.index} className={`absolute top-0 bottom-0 ${moving ? 'opacity-50' : ''}`} style={{ left: xOf(c.outStart), width: Math.max(6, xOf(c.outEnd - c.outStart)) }} data-testid="timeline-clip">
                    <div role="button" tabIndex={0} aria-pressed={sel} className={`tl-focus absolute inset-0 cursor-grab overflow-hidden rounded border-2 ${sel ? 'border-lime' : 'border-[#56614a]'} bg-[#2d3626]`}
                      aria-label={`Clip ${c.index + 1}: ${m?.name ?? 'Footage fehlt'}, ${fmt(c.inSec)} bis ${fmt(c.outSec)} der Aufnahme, im Schnitt ${fmt(c.outStart)}–${fmt(c.outEnd)}. Alt+Pfeil verschiebt.`}
                      onPointerDown={(e) => { if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDrag({ kind: 'move', clip: c.index, x0: e.clientX, moved: false, to: c.index, pps: scale }); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); p.onSelect(c.index); p.onSeek(c.outStart); }
                        else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); e.stopPropagation(); p.onMove(c.index, c.index + (e.key === 'ArrowLeft' ? -1 : 1)); }
                      }}>
                      {c.pieces.map((pc) => (
                        <div key={pc.segment} className="absolute top-0 bottom-0" style={{ left: xOf(pc.outStart - c.outStart), width: xOf(pc.outEnd - pc.outStart) }}>
                          <Thumbs piece={pc} m={m} pps={scale} />
                        </div>
                      ))}
                      {c.seams.map((s) => <div key={s} className="absolute top-0 bottom-0 w-0.5 bg-[#ff8a65]" style={{ left: xOf(s - c.outStart) }} title="Schnitt" />)}
                      <span className="absolute top-0.5 left-3 max-w-[90%] truncate rounded bg-black/55 px-1 text-[9px] text-white">{c.index + 1} · {m?.name ?? 'fehlt'}{c.cuts.length ? ` · ${c.cuts.length} Schnitt${c.cuts.length === 1 ? '' : 'e'}` : ''}</span>
                    </div>
                    {(['in', 'out'] as const).map((edge) => (
                      <div key={edge} role="slider" tabIndex={0} data-testid={`trim-${edge}`}
                        aria-label={`Clip ${c.index + 1} ${edge === 'in' ? 'Anfang (In)' : 'Ende (Out)'} kürzen oder verlängern`} aria-valuemin={0} aria-valuemax={m?.durationSec ?? c.outSec}
                        aria-valuenow={Number((edge === 'in' ? c.inSec : c.outSec).toFixed(2))} aria-valuetext={fmt(edge === 'in' ? c.inSec : c.outSec)}
                        className={`tl-focus absolute top-0 bottom-0 z-10 w-2.5 cursor-ew-resize rounded-sm bg-lime/80 hover:bg-lime ${edge === 'in' ? 'left-0' : 'right-0'}`}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                          p.onSelect(c.index);
                          setDrag({ kind: 'trim', clip: c.index, edge, x0: e.clientX, src0: edge === 'in' ? c.inSec : c.outSec, assetId: c.assetId, pps: scale });
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                          e.preventDefault();
                          e.stopPropagation();
                          p.onTrimStep(c.index, edge, (e.key === 'ArrowLeft' ? -1 : 1) * FRAME_SEC * (e.shiftKey ? 10 : 1));
                        }} />
                    ))}
                  </div>
                );
              })}
              {drag?.kind === 'move' && drag.moved ? (
                <div className="absolute top-0 bottom-0 z-30 w-1 bg-lime" style={{ left: xOf(view.clips.filter((c) => c.index !== drag.clip)[drag.to]?.outStart ?? view.durationSec) - 2 }} data-testid="move-indicator" />
              ) : null}
            </>
          ), 'track-clips')}

          {trackRow('Ton', H.audio, (
            <>
              {view.clips.flatMap((c) => c.pieces.map((pc) => (
                <div key={`${c.index}-${pc.segment}`} className="absolute top-0 bottom-0 overflow-hidden border-r border-black/40 bg-[#26301e]" style={{ left: xOf(pc.outStart), width: xOf(pc.outEnd - pc.outStart) }}>
                  <Wave piece={pc} peaks={p.peaks.get(c.assetId)} pps={scale} />
                </div>
              )))}
              {view.pauses.map((x, i) => (
                <div key={i} className="absolute top-0 bottom-0 border-x border-dashed border-[#ffb38a]/60 bg-[#ffb38a]/20" style={{ left: xOf(x.startSec), width: xOf(x.endSec - x.startSec) }} title={`Pause ${(x.endSec - x.startSec).toFixed(1)} s`} data-testid="track-pause" />
              ))}
            </>
          ), 'track-audio')}

          {p.suggestions.length ? trackRow('Vorschläge', H.ghosts, (
            p.suggestions.map((g) => (
              <div key={g.id} className={`group absolute top-1 bottom-1 flex items-center overflow-hidden rounded border border-dashed text-[9px] ${g.kind === 'weak_filler' ? 'border-[#e8cf7a] bg-[#e8cf7a]/15 text-[#f3e2a6]' : 'border-[#ffb38a] bg-[#ffb38a]/15 text-[#ffd2b8]'}`}
                style={{ left: xOf(g.outStart), width: Math.max(14, xOf(g.outEnd - g.outStart)) }} data-testid="ghost-suggestion" data-kind={g.kind}
                title={`${GHOST_LABEL[g.kind]}${g.word ? ` „${g.word}“` : ''} ${(g.outEnd - g.outStart).toFixed(2)} s${g.note ? ` – ${g.note}` : ''}${g.safe ? ' · sicher' : ''}`}>
                <button type="button" className="h-full px-0.5 hover:bg-white/20" aria-label={`${GHOST_LABEL[g.kind]}${g.word ? ` „${g.word}“` : ''} bei ${fmt(g.outStart)} schneiden`} data-testid="ghost-accept" onClick={() => p.onSuggestion(g.id, 'accept')}>✓</button>
                <button type="button" className="h-full px-0.5 hover:bg-white/20" aria-label={`Vorschlag bei ${fmt(g.outStart)} ablehnen`} data-testid="ghost-reject" onClick={() => p.onSuggestion(g.id, 'reject')}>✕</button>
                <span className="truncate px-0.5">{g.word || GHOST_LABEL[g.kind]}</span>
              </div>
            ))
          ), 'track-ghosts') : null}

          {trackRow('Untertitel', H.subtitles, (
            view.subtitles.map((c, i) => (
              <div key={i} className={`absolute top-1 bottom-1 truncate rounded border border-white/20 bg-white/10 px-1 text-[10px] leading-[18px] ${p.subtitlesOn ? 'text-white' : 'text-white/40'}`}
                style={{ left: xOf(c.startSec), width: Math.max(3, xOf(c.endSec - c.startSec)) }} title={c.text} data-testid="track-subtitle">{c.text}</div>
            ))
          ), 'track-subtitles')}

          {/* playhead over all tracks */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-[#ff5a36]" style={{ left: LABEL_W + xOf(t) }} data-testid="playhead">
            <div className="absolute -top-0.5 -left-1.5 h-2.5 w-3.5 rounded-sm bg-[#ff5a36]" />
          </div>
        </div>
      </div>
      {!p.subtitlesOn && view.subtitles.length ? <p className="m-0 px-3 py-1 text-[10px] text-white/50">Untertitel sind aus – die Spur zeigt, was eingebrannt würde.</p> : null}
    </div>
  );
}
