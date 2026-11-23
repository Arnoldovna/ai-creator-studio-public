/**
 * Track model of the browser editor (Etappe 12, E6): clips, sound, subtitles, overlays and hook on the OUTPUT timeline,
 * the mapping source ↔ output time, snapping and the edit operations of the timeline. Pure and deterministic.
 *
 * Output time comes from `buildTimeline` (the same frame-quantised timeline the render, labels and subtitles use), so
 * what the editor shows at second t is what the render shows at second t. Operations take an EDL body and return a
 * new one; the result is still checked by `checkEditPlan` (the draft shows problems, the render refuses them).
 */
import { addCuts, suggestCuts, type CutSuggestOptions, type TimeRange } from './cuts';
import { applyCase, SIZE_SCALE, type ElementFont, type OverlayFit } from './designSystem';
import type { TextAnim } from './textAnim';
import { MIN_CLIP_SEC, normalizeCuts, type CutRange, type EditClip, type EditDraftBody } from './edit';
import { ClipOverlay, overlayHasText, PlanHook, TEXT_LIMIT, timedElements, type ElementSize, type OverlayKind, type Slot } from './overlays';
import { hookLayout, LABEL_ZONE, overlayBox, placeElement, type Box, type HookLayout, type NormPos } from './overlayLayout';
import type { CutSuggestion } from './cuts';
import { buildTimeline, clipPieces, TIMELINE_FPS, type Timeline } from './timeline';
import { cuesForTimeline, type SubtitleCue, type TranscriptBody } from './transcript';
import { ClipImage, imageBox, MAX_IMAGES_PER_CLIP, placeImage, timedImages, type TimedImage } from './imageLayer';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 0.0005;
export const FRAME_SEC = 1 / TIMELINE_FPS;
/** Most cuts a clip may carry (schema limit of `EditClip.cuts`). */
export const MAX_CUTS_PER_CLIP = 40;

type ClipLike = Pick<EditClip, 'assetId' | 'inSec' | 'outSec'> & { cuts?: readonly { startSec: number; endSec: number; reason?: string }[]; overlays?: readonly ClipOverlay[]; images?: readonly ClipImage[]; subtitle?: string; sceneIndex?: number | null };
type BodyLike = { clips: readonly ClipLike[]; hook?: PlanHook | null; subtitles?: 'off' | 'burn' };

// ---------- Track model ----------

/** One played piece of a clip (between its cuts), in source and output time. */
export interface ViewPiece { clip: number; segment: number; srcIn: number; srcOut: number; outStart: number; outEnd: number }
export interface ViewClip {
  index: number; assetId: string; sceneIndex: number | null;
  inSec: number; outSec: number; outStart: number; outEnd: number;
  pieces: ViewPiece[];
  cuts: { startSec: number; endSec: number; reason: string }[];
  /** Output times where a cut joins two pieces (seams inside the clip). */
  seams: number[];
}
/** A measured silence of the take on the output timeline (the sound track marks them). */
export interface ViewPause { clip: number; startSec: number; endSec: number; srcStart: number; srcEnd: number }
export interface ViewOverlay {
  clip: number; index: number; kind: OverlayKind; text: string; slot: Slot; direction: 'left' | 'right' | 'up' | 'down'; startSec: number; endSec: number; scale?: number;
  /** Etappe 13: free centre, own overlay style and size step (absent = slot, plan style, role size). */
  pos?: NormPos; presetId?: string; size?: ElementSize;
  /** Etappe 16b: own font and animation (absent = role/style). */
  font?: ElementFont; anim?: TextAnim;
  /** The box the render draws (`overlayBox`, PlayRes px): the stage places the element exactly there. */
  box: Box;
}
/** The hook as the render lays it out (`layout` from `hookLayout`: size, lines, centre and box in PlayRes px). */
export interface ViewHook { text: string; startSec: number; endSec: number; slot: Slot; pos?: NormPos; presetId?: string; size?: ElementSize; font?: ElementFont; anim?: TextAnim; layout: HookLayout; scale: number }
export interface TimelineView {
  timeline: Timeline;
  durationSec: number;
  clips: ViewClip[];
  pauses: ViewPause[];
  /** Subtitle cues as the render would burn them (shown also when burning is off, then dimmed). */
  subtitles: SubtitleCue[];
  overlays: ViewOverlay[];
  hook: ViewHook | null;
  /** Etappe 16: image overlays on the output timeline (box from `imageBox`, the render's geometry). */
  images: TimedImage[];
}

export interface ViewInput {
  /** Latest transcript per asset (untrusted spoken words, only displayed). */
  transcripts?: ReadonlyMap<string, { body: TranscriptBody; fillerPrompt?: boolean }>;
  /** Measured silences per asset (source time). */
  silences?: ReadonlyMap<string, readonly TimeRange[]>;
  /** Pauses shorter than this are not marked (default 0.3 s). */
  minPauseSec?: number;
  fit?: OverlayFit;
  /** Etappe 16b: word-by-word subtitles (`subtitleAnimationOf`): cues of that many words, with word times. Absent = lines. */
  subtitleWords?: number | null;
}

export function buildTimelineView(body: BodyLike, input: ViewInput = {}): TimelineView {
  const tl = buildTimeline(body.clips);
  const minPause = input.minPauseSec ?? 0.3;
  const clips: ViewClip[] = body.clips.map((c, i) => {
    const span = tl.clips[i]!;
    const pieces = span.segments.map((k) => {
      const s = tl.segments[k]!;
      return { clip: i, segment: k, srcIn: s.srcIn, srcOut: s.srcOut, outStart: s.outStart, outEnd: s.outEnd };
    });
    return {
      index: i, assetId: c.assetId, sceneIndex: c.sceneIndex ?? null, inSec: c.inSec, outSec: c.outSec, outStart: span.outStart, outEnd: span.outEnd, pieces,
      cuts: (c.cuts ?? []).map((x) => ({ startSec: x.startSec, endSec: x.endSec, reason: x.reason ?? 'manual' })),
      seams: pieces.slice(1).map((p) => p.outStart),
    };
  });
  const pauses: ViewPause[] = [];
  for (const c of clips) {
    for (const s of input.silences?.get(c.assetId) ?? []) {
      if (s.endSec - s.startSec < minPause) continue;
      for (const p of c.pieces) {
        const a = Math.max(s.startSec, p.srcIn), b = Math.min(s.endSec, p.srcOut);
        if (b - a < 0.05) continue;
        pauses.push({ clip: c.index, startSec: r3(p.outStart + a - p.srcIn), endSec: r3(p.outStart + b - p.srcIn), srcStart: a, srcEnd: b });
      }
    }
  }
  const subtitles = cuesForTimeline(tl, body.clips.map((c) => {
    const t = input.transcripts?.get(c.assetId);
    return { subtitle: c.subtitle ?? '', inSec: c.inSec, outSec: c.outSec, transcript: t?.body ?? null, fillerPrompt: t?.fillerPrompt ?? false };
  }), input.subtitleWords ? { maxWords: input.subtitleWords, withWords: true } : {});
  const timed = timedElements({ clips: body.clips.map((c) => ({ overlays: c.overlays ?? [] })), hook: body.hook ?? null }, tl, input.fit);
  return {
    timeline: tl, durationSec: tl.durationSec, clips, pauses, subtitles,
    overlays: timed.overlays.map((o) => {
      const size = body.clips[o.clip]?.overlays?.[o.index]?.size;
      return {
        clip: o.clip, index: o.index, kind: o.kind, text: o.text, slot: o.slot, direction: o.direction, startSec: o.startSec, endSec: o.endSec,
        ...(o.scale ? { scale: o.scale } : {}), ...(o.pos ? { pos: o.pos } : {}), ...(o.presetId ? { presetId: o.presetId } : {}), ...(size ? { size } : {}),
        ...(o.font ? { font: o.font } : {}), ...(o.anim ? { anim: o.anim } : {}),
        box: overlayBox(o),
      };
    }),
    images: timedImages(body, tl).images,
    hook: timed.hook ? {
      text: timed.hook.text, startSec: timed.hook.startSec, endSec: timed.hook.endSec, slot: body.hook!.slot, layout: timed.hook.layout, scale: body.hook!.size ? SIZE_SCALE[body.hook!.size] : input.fit?.hook.scale ?? 1,
      ...(body.hook!.pos ? { pos: body.hook!.pos } : {}), ...(body.hook!.presetId ? { presetId: body.hook!.presetId } : {}), ...(body.hook!.size ? { size: body.hook!.size } : {}),
      ...(timed.hook.font ? { font: timed.hook.font } : {}), ...(timed.hook.anim ? { anim: timed.hook.anim } : {}),
    } : null,
  };
}

// ---------- Source ↔ output ----------

export interface SourcePoint { clip: number; segment: number; srcSec: number }

/**
 * The source moment shown at output time t: the segment that contains t (a segment's end belongs to the next one).
 * t at or after the end maps to the last frame of the last segment; null for an empty timeline.
 */
export function outputToSource(tl: Timeline, t: number): SourcePoint | null {
  if (!tl.segments.length) return null;
  const at = Math.max(0, t);
  const i = tl.segments.findIndex((s) => at >= s.outStart - EPS && at < s.outEnd - EPS);
  if (i < 0) {
    const last = tl.segments[tl.segments.length - 1]!;
    return { clip: last.clip, segment: tl.segments.length - 1, srcSec: Math.max(last.srcIn, last.srcOut - FRAME_SEC) };
  }
  const s = tl.segments[i]!;
  return { clip: s.clip, segment: i, srcSec: s.srcIn + Math.max(0, at - s.outStart) };
}

/** Output time of source time `src` in clip `clip`; null when it is cut out or outside the clip. */
export function sourceToOutput(tl: Timeline, clip: number, src: number): number | null {
  const c = tl.clips[clip];
  if (!c) return null;
  for (const k of c.segments) {
    const s = tl.segments[k]!;
    if (src >= s.srcIn - EPS && src < s.srcOut + EPS) return r3(s.outStart + Math.min(s.durationSec, Math.max(0, src - s.srcIn)));
  }
  return null;
}

/** Like `sourceToOutput`, but a time inside a cut (or before/after the clip) maps to the nearest seam. */
export function sourceToOutputNearest(tl: Timeline, clip: number, src: number): number | null {
  const exact = sourceToOutput(tl, clip, src);
  if (exact != null) return exact;
  const c = tl.clips[clip];
  if (!c || !c.segments.length) return null;
  const next = c.segments.map((k) => tl.segments[k]!).find((s) => s.srcIn >= src);
  return r3(next ? next.outStart : c.outEnd);
}

/** The segment after the one that contains t (playback jumps there at a cut or a clip boundary); null at the end. */
export function nextSegment(tl: Timeline, segment: number) {
  return tl.segments[segment + 1] ?? null;
}

/** Output time rounded to whole frames (the playhead never sits between frames). */
export const toFrame = (t: number) => Math.round(t * TIMELINE_FPS) / TIMELINE_FPS;

// ---------- Snapping ----------

export type SnapKind = 'word' | 'silence' | 'clip' | 'playhead';
export interface SnapTarget { t: number; kind: SnapKind }

/** Snap targets in SOURCE time of one take: word starts/ends, silence edges and the file's start/end. */
export function sourceSnapTargets(input: { words?: readonly { startSec: number; endSec: number }[]; silences?: readonly TimeRange[]; durationSec?: number | null }): SnapTarget[] {
  const out: SnapTarget[] = [{ t: 0, kind: 'clip' }];
  if (input.durationSec != null) out.push({ t: input.durationSec, kind: 'clip' });
  for (const w of input.words ?? []) out.push({ t: w.startSec, kind: 'word' }, { t: w.endSec, kind: 'word' });
  for (const s of input.silences ?? []) out.push({ t: s.startSec, kind: 'silence' }, { t: s.endSec, kind: 'silence' });
  return out.sort((a, b) => a.t - b.t);
}

/** Snap targets in OUTPUT time: clip boundaries and seams (and the playhead, when given). */
export function outputSnapTargets(view: Pick<TimelineView, 'clips' | 'durationSec'>, playhead?: number): SnapTarget[] {
  const out: SnapTarget[] = [{ t: 0, kind: 'clip' }, { t: view.durationSec, kind: 'clip' }];
  for (const c of view.clips) {
    out.push({ t: c.outStart, kind: 'clip' }, { t: c.outEnd, kind: 'clip' });
    for (const s of c.seams) out.push({ t: s, kind: 'clip' });
  }
  if (playhead != null) out.push({ t: playhead, kind: 'playhead' });
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Snaps t to the nearest target within `tolerance` (seconds). On equal distance clip boundaries win over word
 * boundaries, word boundaries over silence edges (a cut at a word edge keeps the word whole).
 */
export function snap(t: number, targets: readonly SnapTarget[], tolerance: number): { t: number; target: SnapTarget | null } {
  const rank: Record<SnapKind, number> = { playhead: 0, clip: 1, word: 2, silence: 3 };
  let best: SnapTarget | null = null, bestD = Infinity;
  for (const x of targets) {
    const d = Math.abs(x.t - t);
    if (d > tolerance) continue;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && rank[x.kind] < rank[best.kind])) {
      best = x;
      bestD = d;
    }
  }
  return best ? { t: best.t, target: best } : { t, target: null };
}

// ---------- Operations (return a new body) ----------

type DraftClip = EditDraftBody['clips'][number];
const withClips = <B extends { clips: readonly DraftClip[] }>(b: B, clips: DraftClip[]): B => ({ ...b, clips });

/** Cuts and overlays of a clip restricted to [inSec, outSec] (cuts clamped, overlays clamped or dropped). */
function fitToRange(c: DraftClip): { clip: DraftClip; droppedCuts: number; droppedOverlays: number } {
  const cuts = normalizeCuts(c.cuts.map((x) => ({ ...x, startSec: r3(Math.max(c.inSec, x.startSec)), endSec: r3(Math.min(c.outSec, x.endSec)) })).filter((x) => x.endSec - x.startSec > 0.01));
  const overlays = c.overlays.map((o) => ({ ...o, startSec: r3(Math.max(c.inSec, o.startSec)), endSec: r3(Math.min(c.outSec, o.endSec)) })).filter((o) => o.endSec - o.startSec >= 0.1);
  // Etappe 16: images like overlays (only when the clip has any, so older bodies keep their shape)
  const images = c.images?.map((o) => ({ ...o, startSec: r3(Math.max(c.inSec, o.startSec)), endSec: r3(Math.min(c.outSec, o.endSec)) })).filter((o) => o.endSec - o.startSec >= 0.1);
  return { clip: { ...c, cuts, overlays, ...(c.images ? { images } : {}) }, droppedCuts: c.cuts.length - cuts.length, droppedOverlays: c.overlays.length - overlays.length + (c.images?.length ?? 0) - (images?.length ?? 0) };
}

/**
 * Trims a clip's In or Out to source time `src` (dragging an edge of the clip), clamped so the clip keeps at least
 * MIN_CLIP_SEC and stays inside its take. Cuts and overlays outside the new range are clamped or removed (counted).
 */
export function trimClip<B extends { clips: readonly DraftClip[] }>(body: B, index: number, edge: 'in' | 'out', src: number, durationSec: number | null): { body: B; droppedCuts: number; droppedOverlays: number } {
  const c = body.clips[index];
  if (!c) return { body, droppedCuts: 0, droppedOverlays: 0 };
  const max = durationSec ?? c.outSec;
  const next = edge === 'in'
    ? { ...c, inSec: r3(Math.max(0, Math.min(src, c.outSec - MIN_CLIP_SEC))) }
    : { ...c, outSec: r3(Math.min(max, Math.max(src, c.inSec + MIN_CLIP_SEC))) };
  const fitted = fitToRange(next);
  const clips = [...body.clips];
  clips[index] = fitted.clip;
  return { body: withClips(body, clips), droppedCuts: fitted.droppedCuts, droppedOverlays: fitted.droppedOverlays };
}

/** Moves a clip to another position (reordering on the clip track). */
export function moveClip<B extends { clips: readonly DraftClip[] }>(body: B, from: number, to: number): B {
  if (from === to || !body.clips[from]) return body;
  const clips = [...body.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(clips.length, to)), 0, c!);
  return withClips(body, clips);
}

export function removeClip<B extends { clips: readonly DraftClip[] }>(body: B, index: number): B {
  return withClips(body, body.clips.filter((_, i) => i !== index));
}

/**
 * Splits the clip under output time t into two clips at that source moment (the playhead, „S“). Not possible inside
 * the first or last MIN_CLIP_SEC of the clip: null. Cuts and overlays go to the side they lie on (clamped).
 */
export function splitAt<B extends { clips: readonly DraftClip[] }>(body: B, t: number): { body: B; index: number } | null {
  const tl = buildTimeline(body.clips);
  const p = outputToSource(tl, t);
  if (!p) return null;
  const c = body.clips[p.clip]!;
  const src = r3(p.srcSec);
  if (src - c.inSec < MIN_CLIP_SEC || c.outSec - src < MIN_CLIP_SEC) return null;
  const a = fitToRange({ ...c, outSec: src }).clip, b = fitToRange({ ...c, inSec: src }).clip;
  const clips = [...body.clips];
  clips.splice(p.clip, 1, a, b);
  return { body: withClips(body, clips), index: p.clip + 1 };
}

/**
 * Cuts the OUTPUT range [a, b] out of the cut (I/O, then Entf): each clip it touches gets a manual cut over the
 * source part it shows there; a clip that would lose everything is removed instead. Returns how many cuts/clips changed.
 */
export function cutOutputRange<B extends { clips: readonly DraftClip[] }>(body: B, a: number, b: number): { body: B; cuts: number; removedClips: number; capped: number } {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (hi - lo < FRAME_SEC / 2) return { body, cuts: 0, removedClips: 0, capped: 0 };
  const tl = buildTimeline(body.clips);
  const added = new Map<number, CutRange[]>();
  const whole = new Set<number>();
  tl.clips.forEach((span, ci) => {
    if (span.outEnd <= lo + EPS || span.outStart >= hi - EPS) return;
    if (lo <= span.outStart + EPS && hi >= span.outEnd - EPS) { whole.add(ci); return; }
    const raw = clipPieces(body.clips[ci]!);
    for (const k of span.segments) {
      const s = tl.segments[k]!;
      let x = Math.max(lo, s.outStart), y = Math.min(hi, s.outEnd);
      if (y - x < 0.01) continue;
      // never leave a sliver under MIN_CLIP_SEC between the new cut and the piece's edge
      if (x - s.outStart < MIN_CLIP_SEC) x = s.outStart;
      if (s.outEnd - y < MIN_CLIP_SEC) y = s.outEnd;
      // at a piece edge the cut reaches the raw boundary (In/Out or the neighbouring cut), so the cuts merge exactly
      const piece = raw[s.piece]!;
      const start = x <= s.outStart + EPS ? piece.srcIn : s.srcIn + (x - s.outStart);
      const end = y >= s.outEnd - EPS ? piece.srcOut : s.srcIn + (y - s.outStart);
      added.set(ci, [...(added.get(ci) ?? []), { startSec: r3(start), endSec: r3(end), reason: 'manual', word: '' }]);
    }
  });
  let cuts = 0, capped = 0;
  const clips = body.clips.flatMap((c, i) => {
    if (whole.has(i)) return [];
    const add = added.get(i);
    if (!add) return [c];
    cuts += add.length;
    let merged = normalizeCuts([...c.cuts, ...add]).map((x) => ({ ...x, startSec: r3(Math.max(c.inSec, x.startSec)), endSec: r3(Math.min(c.outSec, x.endSec)) }));
    if (merged.length > MAX_CUTS_PER_CLIP) {
      // over the limit: her manual cuts win, the shortest suggestion cuts (pause/filler) go (counted, never silent)
      const auto = merged.filter((x) => x.reason !== 'manual').sort((x, y) => (x.endSec - x.startSec) - (y.endSec - y.startSec));
      const drop = new Set(auto.slice(0, merged.length - MAX_CUTS_PER_CLIP));
      capped += drop.size;
      merged = merged.filter((x) => !drop.has(x)).slice(0, MAX_CUTS_PER_CLIP);
    }
    return [{ ...c, cuts: merged }];
  });
  return { body: withClips(body, clips), cuts, removedClips: whole.size, capped };
}

/** Removes one cut of a clip (the cut part plays again). */
export function removeCut<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, cutIndex: number): B {
  const c = body.clips[clip];
  if (!c) return body;
  const clips = [...body.clips];
  clips[clip] = { ...c, cuts: c.cuts.filter((_, k) => k !== cutIndex) };
  return withClips(body, clips);
}

// ---------- Pacing presets ----------

export const PACING_PRESETS = {
  calm: { label: 'ruhig', hint: 'nur lange Pausen kürzen (ab 1 s), viel Luft lassen', opts: { pauseMinSec: 1.0, keepPauseSec: 0.3 }, fillers: false },
  normal: { label: 'normal', hint: 'Pausen ab 0,6 s kürzen und sichere Füllwörter („ähm“) entfernen', opts: { pauseMinSec: 0.6, keepPauseSec: 0.15 }, fillers: true },
  brisk: { label: 'zügig', hint: 'Pausen ab 0,35 s straff kürzen und sichere Füllwörter entfernen', opts: { pauseMinSec: 0.35, keepPauseSec: 0.08 }, fillers: true },
} as const satisfies Record<string, { label: string; hint: string; opts: CutSuggestOptions; fillers: boolean }>;
export type PacingPreset = keyof typeof PACING_PRESETS;

export interface PacingInput {
  transcript: TranscriptBody | null;
  silences: readonly TimeRange[] | null;
  /** Client claim sentences (never shortened by a suggestion). */
  protectedRanges?: readonly (TimeRange & { reason: string })[];
}

/**
 * One-click pacing: replaces the clip's suggestion cuts (reason pause/filler) with the SAFE suggestions of the preset
 * (`suggestCuts` with the preset's thresholds: high confidence only, never weak fillers or blocked claim sentences).
 * Manual cuts stay. A clip without transcript or silence scan is left as it is (counted in `skipped`). The result is
 * a normal body: the cuts can be undone or removed one by one.
 */
export function applyPacing<B extends { clips: readonly DraftClip[] }>(body: B, preset: PacingPreset, inputs: ReadonlyMap<string, PacingInput>): { body: B; added: number; removed: number; skipped: number; capped: number } {
  const p = PACING_PRESETS[preset];
  let added = 0, removed = 0, skipped = 0, capped = 0;
  const clips = body.clips.map((c) => {
    const inp = inputs.get(c.assetId);
    if (!inp?.transcript || !inp.silences) { skipped++; return c; }
    const manual = c.cuts.filter((x) => x.reason === 'manual');
    removed += c.cuts.length - manual.length;
    const res = suggestCuts({ transcript: inp.transcript, silences: inp.silences, clip: { inSec: c.inSec, outSec: c.outSec }, protectedRanges: inp.protectedRanges }, p.opts);
    const pick = res.suggestions.filter((s) => s.safe && (s.kind === 'pause' || (p.fillers && s.kind === 'filler')))
      .map((s): CutRange => ({ startSec: s.startSec, endSec: s.endSec, reason: s.reason, word: s.word }));
    const merged = addCuts(manual, pick, { inSec: c.inSec, outSec: c.outSec }, inp.silences);
    let cuts = merged.cuts;
    if (cuts.length > MAX_CUTS_PER_CLIP) {
      // keep every manual cut and the longest suggestion cuts
      const auto = cuts.filter((x) => x.reason !== 'manual').sort((x, y) => (y.endSec - y.startSec) - (x.endSec - x.startSec));
      const room = Math.max(0, MAX_CUTS_PER_CLIP - cuts.filter((x) => x.reason === 'manual').length);
      capped += auto.length - room;
      const keep = new Set(auto.slice(0, room));
      cuts = cuts.filter((x) => x.reason === 'manual' || keep.has(x));
    }
    added += cuts.length - manual.length;
    return { ...c, cuts };
  });
  return { body: withClips(body, clips), added, removed, skipped, capped };
}

// ---------- Overlays and hook (Etappe 13) ----------

/** Shortest overlay the editor creates or leaves after a drag. */
export const MIN_OVERLAY_SEC = 0.3;
/** Most overlays per clip (schema limit of `EditClip.overlays`). */
export const MAX_OVERLAYS_PER_CLIP = 8;
/** Default length of a new overlay. */
export const DEFAULT_OVERLAY_SEC = 2;

/** Source time of clip `clip` shown at output time t, with t clamped into that clip's output span (overlays never leave their clip). */
export function sourceInClip(tl: Timeline, clip: number, t: number): number | null {
  const c = tl.clips[clip];
  if (!c || !c.segments.length) return null;
  const tt = Math.max(c.outStart, Math.min(c.outEnd, t));
  for (const k of c.segments) {
    const s = tl.segments[k]!;
    if (tt <= s.outEnd + EPS) return r3(s.srcIn + Math.max(0, Math.min(s.durationSec, tt - s.outStart)));
  }
  const last = tl.segments[c.segments[c.segments.length - 1]!]!;
  return last.srcOut;
}

export type OverlayDraft = { kind: OverlayKind; text?: string; slot?: Slot; presetId?: string; direction?: 'left' | 'right' | 'up' | 'down'; size?: ElementSize };
export type OverlayEdit<B> = { body: B; clip: number; index: number } | { error: string };

function insertOverlay<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, start: number, end: number, o: OverlayDraft): OverlayEdit<B> {
  const c = body.clips[clip];
  if (!c) return { error: 'Kein Clip an dieser Stelle.' };
  if (c.overlays.length >= MAX_OVERLAYS_PER_CLIP) return { error: `Höchstens ${MAX_OVERLAYS_PER_CLIP} Overlays je Clip – erst eines entfernen.` };
  if (end - start < MIN_OVERLAY_SEC - EPS) return { error: 'Hier ist zu wenig Platz für ein Overlay (Clip-Ende) – Playhead etwas früher setzen.' };
  const text = overlayHasText(o.kind) ? (o.text ?? '').trim() : '';
  if (overlayHasText(o.kind) && !text) return { error: 'Bauchbinde und Keyword brauchen einen Text.' };
  if (o.kind === 'lower_third' || o.kind === 'keyword') {
    if (text.length > TEXT_LIMIT[o.kind]) return { error: `${o.kind === 'keyword' ? 'Ein Keyword' : 'Eine Bauchbinde'} hat höchstens ${TEXT_LIMIT[o.kind]} Zeichen – kürzer markieren.` };
  }
  const overlay = ClipOverlay.parse({ kind: o.kind, startSec: r3(start), endSec: r3(end), text, slot: o.slot ?? 'center', direction: o.direction ?? 'down', ...(o.presetId ? { presetId: o.presetId } : {}), ...(o.size ? { size: o.size } : {}) });
  const clips = [...body.clips];
  clips[clip] = { ...c, overlays: [...c.overlays, overlay] };
  return { body: withClips(body, clips), clip, index: c.overlays.length };
}

/**
 * New overlay at output time t (the playhead, „+ Keyword“, key T): in the clip under t, from t for `durationSec` or up to
 * the clip's end; when t is too close to the end it starts earlier. Times are stored in source time of the take.
 */
export function addOverlayAt<B extends { clips: readonly DraftClip[] }>(body: B, t: number, o: OverlayDraft & { durationSec?: number }): OverlayEdit<B> {
  const tl = buildTimeline(body.clips);
  const p = outputToSource(tl, t);
  if (!p) return { error: 'Noch kein Clip im Schnitt.' };
  const span = tl.clips[p.clip]!;
  const dur = o.durationSec ?? DEFAULT_OVERLAY_SEC;
  let a = Math.max(span.outStart, Math.min(t, span.outEnd));
  const b = Math.min(span.outEnd, a + dur);
  if (b - a < Math.min(dur, MIN_OVERLAY_SEC * 2)) a = Math.max(span.outStart, b - dur);
  return insertOverlay(body, p.clip, sourceInClip(tl, p.clip, a)!, sourceInClip(tl, p.clip, b)!, o);
}

/** New overlay over the OUTPUT range [a, b] (a transcript selection): in the clip that shows a, clamped to that clip. */
export function addOverlayForRange<B extends { clips: readonly DraftClip[] }>(body: B, a: number, b: number, o: OverlayDraft): OverlayEdit<B> {
  const tl = buildTimeline(body.clips);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const p = outputToSource(tl, lo);
  if (!p) return { error: 'Noch kein Clip im Schnitt.' };
  const span = tl.clips[p.clip]!;
  const end = Math.min(span.outEnd, Math.max(hi, lo + MIN_OVERLAY_SEC * 2));
  return insertOverlay(body, p.clip, sourceInClip(tl, p.clip, lo)!, sourceInClip(tl, p.clip, end)!, o);
}

/**
 * Moves or trims an overlay on the timeline: new OUTPUT start/end (dragging the block or one of its edges), mapped back
 * into source time inside its own clip and kept at least MIN_OVERLAY_SEC long. `edge` says what is dragged: both edges
 * keep the length when the block moves.
 */
export function retimeOverlay<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, index: number, outStart: number, outEnd: number, edge: 'move' | 'start' | 'end'): B {
  const c = body.clips[clip];
  const o = c?.overlays[index];
  if (!c || !o) return body;
  const tl = buildTimeline(body.clips);
  const span = tl.clips[clip]!;
  let a = outStart, b = outEnd;
  if (edge === 'move') {
    const len = Math.max(MIN_OVERLAY_SEC, b - a);
    a = Math.max(span.outStart, Math.min(span.outEnd - len, a));
    b = Math.min(span.outEnd, a + len);
  } else if (edge === 'start') a = Math.max(span.outStart, Math.min(a, b - MIN_OVERLAY_SEC));
  else b = Math.min(span.outEnd, Math.max(b, a + MIN_OVERLAY_SEC));
  const start = sourceInClip(tl, clip, a)!, end = sourceInClip(tl, clip, b)!;
  if (end - start < MIN_OVERLAY_SEC - EPS) return body;
  return updateOverlay(body, clip, index, { startSec: r3(start), endSec: r3(end) });
}

/**
 * Changes fields of one overlay (inspector, stage drag). A key set to `undefined` is removed (`pos: undefined` puts it back
 * into its slot). Text of arrows and frames stays empty.
 */
export function updateOverlay<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, index: number, patch: Partial<ClipOverlay>): B {
  const c = body.clips[clip];
  const o = c?.overlays[index];
  if (!c || !o) return body;
  const next: Record<string, unknown> = { ...o, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  if (!overlayHasText(next.kind as OverlayKind)) next.text = '';
  const clips = [...body.clips];
  clips[clip] = { ...c, overlays: c.overlays.map((x, k) => (k === index ? (next as ClipOverlay) : x)) };
  return withClips(body, clips);
}

export function removeOverlay<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, index: number): B {
  const c = body.clips[clip];
  if (!c) return body;
  const clips = [...body.clips];
  clips[clip] = { ...c, overlays: c.overlays.filter((_, k) => k !== index) };
  return withClips(body, clips);
}

// ---------- Etappe 16: image overlays ----------

/** New image at output time t (the playhead or a story suggestion): in the clip under t, for `durationSec` or up to its end. */
export function addImageAt<B extends { clips: readonly DraftClip[] }>(body: B, t: number, o: { referenceId: string; aspect: number; durationSec?: number; size?: ClipImage['size']; pos?: NormPos }): OverlayEdit<B> {
  const tl = buildTimeline(body.clips);
  const p = outputToSource(tl, t);
  if (!p) return { error: 'Noch kein Clip im Schnitt.' };
  const span = tl.clips[p.clip]!;
  const dur = o.durationSec ?? DEFAULT_OVERLAY_SEC;
  let a = Math.max(span.outStart, Math.min(t, span.outEnd));
  const b = Math.min(span.outEnd, a + dur);
  if (b - a < Math.min(dur, MIN_OVERLAY_SEC * 2)) a = Math.max(span.outStart, b - dur);
  return insertImage(body, p.clip, sourceInClip(tl, p.clip, a)!, sourceInClip(tl, p.clip, b)!, o);
}

/** New image over a SOURCE range of one clip (story suggestions anchor to a spoken sentence). */
export function insertImage<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, start: number, end: number, o: { referenceId: string; aspect: number; size?: ClipImage['size']; pos?: NormPos }): OverlayEdit<B> {
  const c = body.clips[clip];
  if (!c) return { error: 'Kein Clip an dieser Stelle.' };
  const list = c.images ?? [];
  if (list.length >= MAX_IMAGES_PER_CLIP) return { error: `Höchstens ${MAX_IMAGES_PER_CLIP} Bilder je Clip – erst eines entfernen.` };
  const a = Math.max(c.inSec, start), e = Math.min(c.outSec, end);
  if (e - a < MIN_OVERLAY_SEC - EPS) return { error: 'Hier ist zu wenig Platz für ein Bild (Clip-Ende) – Playhead etwas früher setzen.' };
  // review fix: a panorama or a broken measurement is clamped to the schema's range instead of throwing
  const aspect = Number.isFinite(o.aspect) && o.aspect > 0 ? Math.min(5, Math.max(0.2, o.aspect)) : 1;
  const parsed = ClipImage.safeParse({ referenceId: o.referenceId, aspect, startSec: r3(a), endSec: r3(e), ...(o.size ? { size: o.size } : {}), ...(o.pos ? { pos: o.pos } : {}) });
  if (!parsed.success) return { error: 'Dieses Bild lässt sich hier nicht einblenden.' };
  const image = parsed.data;
  const clips = [...body.clips];
  clips[clip] = { ...c, images: [...list, image] };
  return { body: withClips(body, clips), clip, index: list.length };
}

/** Changes fields of one image; a key set to `undefined` is removed (`pos: undefined` = default centre). */
export function updateImage<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, index: number, patch: Partial<ClipImage>): B {
  const c = body.clips[clip];
  const o = c?.images?.[index];
  if (!c || !o) return body;
  const next: Record<string, unknown> = { ...o, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const clips = [...body.clips];
  clips[clip] = { ...c, images: c.images!.map((x, k) => (k === index ? (next as ClipImage) : x)) };
  return withClips(body, clips);
}

export function removeImage<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, index: number): B {
  const c = body.clips[clip];
  if (!c?.images) return body;
  const clips = [...body.clips];
  const images = c.images.filter((_, k) => k !== index);
  const { images: _drop, ...rest } = c;
  void _drop;
  clips[clip] = images.length ? { ...c, images } : rest;
  return withClips(body, clips);
}

/** Moves or trims an image on the timeline (output times, mapped into its clip like `retimeOverlay`). */
export function retimeImage<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, index: number, outStart: number, outEnd: number, edge: 'move' | 'start' | 'end'): B {
  const c = body.clips[clip];
  const o = c?.images?.[index];
  if (!c || !o) return body;
  const tl = buildTimeline(body.clips);
  const span = tl.clips[clip]!;
  let a = outStart, b = outEnd;
  if (edge === 'move') {
    const len = Math.max(MIN_OVERLAY_SEC, b - a);
    a = Math.max(span.outStart, Math.min(span.outEnd - len, a));
    b = Math.min(span.outEnd, a + len);
  } else if (edge === 'start') a = Math.max(span.outStart, Math.min(a, b - MIN_OVERLAY_SEC));
  else b = Math.min(span.outEnd, Math.max(b, a + MIN_OVERLAY_SEC));
  const start = sourceInClip(tl, clip, a)!, end = sourceInClip(tl, clip, b)!;
  if (end - start < MIN_OVERLAY_SEC - EPS) return body;
  return updateImage(body, clip, index, { startSec: r3(start), endSec: r3(end) });
}

/**
 * Keeps free-positioned elements out of the AI-label zone after a change that makes them larger (size step, text,
 * kind): an element whose box now reaches into the zone is moved down just enough (`placeElement`). The stage drag
 * already never places anything there; this covers the inspector. Returns the same body when nothing moved.
 */
export function keepClearOfLabel<B extends { clips: readonly DraftClip[]; hook?: PlanHook | null }>(body: B, fit?: OverlayFit): B {
  let changed = false;
  const clips = body.clips.map((c) => {
    let touched = false;
    const overlays = c.overlays.map((o) => {
      if (!o.pos || o.kind === 'frame') return o;
      const role = o.kind === 'lower_third' ? fit?.lowerThird : o.kind === 'keyword' ? fit?.keyword : undefined;
      const scale = o.size ? SIZE_SCALE[o.size] : role?.scale ?? 1;
      const text = role ? applyCase(o.text, role.textCase) : o.text;
      const b = overlayBox({ kind: o.kind, text, slot: o.slot, scale, pos: o.pos });
      if (b.y0 >= LABEL_ZONE.y1) return o;
      const p = placeElement({ kind: o.kind, text, scale }, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, { free: true });
      if (!p?.pos) return o;
      touched = true;
      return { ...o, pos: p.pos };
    });
    // review fix (Etappe 16): images too – a larger size step can push a free image into the label zone
    const images = c.images?.map((o) => {
      if (!o.pos) return o;
      const b = imageBox(o);
      if (b.y0 >= LABEL_ZONE.y1) return o;
      touched = true;
      return { ...o, pos: placeImage(o, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2) };
    });
    if (!touched) return c;
    changed = true;
    return { ...c, overlays, ...(images ? { images } : {}) };
  });
  let hook = body.hook;
  if (hook?.pos) {
    const scale = hook.size ? SIZE_SCALE[hook.size] : fit?.hook.scale ?? 1;
    const text = fit ? applyCase(hook.text, fit.hook.textCase) : hook.text;
    const l = hookLayout(text, hook.slot, scale, hook.pos);
    if (l && l.box.y0 < LABEL_ZONE.y1) {
      const p = placeElement({ kind: 'hook', text, scale }, l.x, l.y, { free: true });
      if (p?.pos) { hook = { ...hook, pos: p.pos }; changed = true; }
    }
  }
  return changed ? { ...body, clips, hook } : body;
}

/** Longest hook (`PlanHook.endSec`). */
export const HOOK_MAX_SEC = 5;
/** Sets, changes (a key set to `undefined` is removed) or removes (null) the hook. A new hook is a free text hook. */
export function setHook<B extends { hook?: PlanHook | null }>(body: B, patch: Partial<PlanHook> | null): B {
  if (patch === null) return { ...body, hook: null };
  const base: Record<string, unknown> = { ...(body.hook ?? { source: 'free', variantIndex: null, text: '', endSec: 2.5, slot: 'upper', claimsReviewed: false }), ...patch };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  if (typeof base.endSec === 'number') base.endSec = r3(Math.max(0.5, Math.min(HOOK_MAX_SEC, base.endSec)));
  return { ...body, hook: base as PlanHook };
}

/** A spoken word of the cut, in source time of its clip (transcript panel). */
export interface CutWord { clip: number; startSec: number; endSec: number; text: string }

/** Output range [a, b] of a selection of words (first word's start to last word's end; words inside a cut map to the seam). */
export function wordsOutputRange(tl: Timeline, words: readonly CutWord[]): { a: number; b: number } | null {
  if (!words.length) return null;
  const outs = words.flatMap((w) => [sourceToOutputNearest(tl, w.clip, w.startSec), sourceToOutputNearest(tl, w.clip, w.endSec)]).filter((x): x is number => x != null);
  return outs.length ? { a: Math.min(...outs), b: Math.max(...outs) } : null;
}

/** Cuts the selected words out („Schneiden“ in the transcript): a manual cut over their output range (`cutOutputRange`). */
export function cutWords<B extends { clips: readonly DraftClip[] }>(body: B, words: readonly CutWord[]): ReturnType<typeof cutOutputRange<B>> {
  const r = wordsOutputRange(buildTimeline(body.clips), words);
  return r ? cutOutputRange(body, r.a, r.b) : { body, cuts: 0, removedClips: 0, capped: 0 };
}

/**
 * Text of a selection for an overlay or hook: the words as spoken, without sentence punctuation at the edges (a closing
 * „?“ stays, a question remains a question for the quote rule). Spoken words are untrusted data: only text, never markup.
 */
export function phraseOf(words: readonly string[]): string {
  const raw = words.join(' ').replace(/\s+/g, ' ').trim();
  const question = /\?["“”»«'’)]*$/.test(raw);
  const core = raw.replace(/^[\s.,;:!?…"„“”»«'’()–—-]+/, '').replace(/[\s.,;:!?…"„“”»«'’()–—-]+$/, '');
  return question && core ? `${core}?` : core;
}

// ---------- Cut suggestions (ghost blocks) ----------

/** True when the clip already has a cut over the whole suggestion (it was accepted). */
export const suggestionApplied = (cuts: readonly { startSec: number; endSec: number }[], s: { startSec: number; endSec: number }) =>
  cuts.some((c) => c.startSec <= s.startSec + 0.01 && c.endSec >= s.endSec - 0.01);

/**
 * The suggestions „Alle sicheren annehmen“ takes: high confidence, not blocked, and never a weak filler. „also“, „ja“,
 * „genau“, „sozusagen“ … belong to her voice: they are only ever cut one by one, when she accepts that single suggestion.
 */
export const safeSuggestions = <S extends Pick<CutSuggestion, 'safe' | 'kind' | 'blocked'>>(list: readonly S[]): S[] => list.filter((s) => s.safe && !s.blocked && s.kind !== 'weak_filler');

/** Accepts suggestions of one clip: they become filler/pause cuts (`addCuts`: joins only over measured silence, counts refusals). */
export function acceptSuggestions<B extends { clips: readonly DraftClip[] }>(body: B, clip: number, list: readonly Pick<CutSuggestion, 'startSec' | 'endSec' | 'reason' | 'word'>[], silences: readonly TimeRange[] = []): { body: B; added: number; refused: number } {
  const c = body.clips[clip];
  if (!c || !list.length) return { body, added: 0, refused: 0 };
  const res = addCuts(c.cuts, list.map((s) => ({ startSec: s.startSec, endSec: s.endSec, reason: s.reason, word: s.word })), { inSec: c.inSec, outSec: c.outSec }, silences);
  if (res.cuts.length > MAX_CUTS_PER_CLIP) return { body, added: 0, refused: list.length };
  const clips = [...body.clips];
  clips[clip] = { ...c, cuts: res.cuts };
  return { body: withClips(body, clips), added: list.length - res.refused, refused: res.refused };
}

// ---------- Stage zones ----------

/** Moved to overlayLayout.ts in Etappe 13 (one geometry source for ASS, stage and validator). */
export { STAGE_ZONES } from './overlayLayout';
