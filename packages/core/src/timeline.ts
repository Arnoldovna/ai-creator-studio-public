/**
 * Output timeline of an EDL (Etappe 8): the single source of output time for the render, the
 * AI label, subtitles, the duration and the progress. A clip plays its range [inSec, outSec] of the
 * take minus its cuts; every remaining piece is one segment (one FFmpeg input).
 *
 * Pieces of a clip WITH cuts are frame-quantised (1/30 s), and the same quantised duration is used for
 * the video trim, the audio trim and every time on the output timeline, so audio and video cannot drift
 * apart over many cuts. A clip WITHOUT cuts keeps its exact length, so plans from before Etappe 8 render
 * with byte-identical FFmpeg arguments.
 */

export const TIMELINE_FPS = 30;
/** Rounds a duration to whole output frames. */
export const quantizeSec = (d: number) => Math.round(d * TIMELINE_FPS) / TIMELINE_FPS;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 0.0005;

export interface TimelineCut { startSec: number; endSec: number }
export interface TimelineClipInput { inSec: number; outSec: number; cuts?: readonly TimelineCut[] }

/** A piece of a clip in source time before quantisation (what the validator checks). */
export interface ClipPiece { srcIn: number; srcOut: number; rawSec: number; fadeIn: boolean; fadeOut: boolean }

export interface TimelineSegment {
  clip: number;
  /** Index of the piece inside its clip (0, 1, …). */
  piece: number;
  srcIn: number;
  /** srcIn + durationSec (the quantised end; may differ from the cut boundary by up to half a frame). */
  srcOut: number;
  durationSec: number;
  outStart: number;
  outEnd: number;
  /** The boundary was created by a cut: a 12 ms audio fade avoids a click there. */
  fadeIn: boolean;
  fadeOut: boolean;
  /** Output time from the clip's first segment to this one (a push zoom continues across cuts). */
  offsetInClip: number;
}
export interface TimelineClip { outStart: number; outEnd: number; durationSec: number; segments: number[] }
export interface Timeline { segments: TimelineSegment[]; clips: TimelineClip[]; durationSec: number }

/** Cuts clamped to the clip range, sorted and merged. */
function clampCuts(c: TimelineClipInput): TimelineCut[] {
  const cuts = [...(c.cuts ?? [])]
    .map((x) => ({ startSec: Math.max(c.inSec, x.startSec), endSec: Math.min(c.outSec, x.endSec) }))
    .filter((x) => x.endSec - x.startSec > EPS)
    .sort((a, b) => a.startSec - b.startSec);
  const out: TimelineCut[] = [];
  for (const x of cuts) {
    const last = out[out.length - 1];
    if (last && x.startSec <= last.endSec + EPS) last.endSec = Math.max(last.endSec, x.endSec);
    else out.push({ ...x });
  }
  return out;
}

/** The pieces a clip plays, in source time. A clip without cuts is one piece without fades. */
export function clipPieces(c: TimelineClipInput): ClipPiece[] {
  const cuts = clampCuts(c);
  if (!cuts.length) return [{ srcIn: c.inSec, srcOut: c.outSec, rawSec: Math.max(0, c.outSec - c.inSec), fadeIn: false, fadeOut: false }];
  const pieces: ClipPiece[] = [];
  let at = c.inSec, fadeIn = false;
  for (const x of cuts) {
    if (x.startSec - at > EPS) pieces.push({ srcIn: at, srcOut: x.startSec, rawSec: x.startSec - at, fadeIn, fadeOut: true });
    at = x.endSec;
    fadeIn = true;
  }
  if (c.outSec - at > EPS) pieces.push({ srcIn: at, srcOut: c.outSec, rawSec: c.outSec - at, fadeIn, fadeOut: false });
  return pieces;
}

/** Builds the output timeline. Pieces of clips with cuts are frame-quantised (see the file comment). */
export function buildTimeline(clips: readonly TimelineClipInput[]): Timeline {
  const segments: TimelineSegment[] = [];
  const out: TimelineClip[] = [];
  let t = 0;
  clips.forEach((c, ci) => {
    const hasCuts = clampCuts(c).length > 0;
    const start = t;
    const idx: number[] = [];
    clipPieces(c).forEach((p, pi) => {
      // the last piece ends at Out, maybe the end of the file: rounded down, never past it
      const d = !hasCuts ? p.rawSec : p.fadeOut ? quantizeSec(p.rawSec) : Math.floor(p.rawSec * TIMELINE_FPS + 1e-6) / TIMELINE_FPS;
      if (hasCuts && d <= 0) return; // shorter than half a frame: nothing to play
      idx.push(segments.length);
      segments.push({ clip: ci, piece: pi, srcIn: p.srcIn, srcOut: p.srcIn + d, durationSec: d, outStart: t, outEnd: t + d, fadeIn: p.fadeIn, fadeOut: p.fadeOut, offsetInClip: t - start });
      t += d;
    });
    out.push({ outStart: start, outEnd: t, durationSec: t - start, segments: idx });
  });
  return { segments, clips: out, durationSec: r3(t) };
}

export interface OutputRange { startSec: number; endSec: number }

/**
 * Maps a source range of one clip onto the output timeline: one piece per segment it touches
 * (pieces under 0.05 s are dropped). A range that lies entirely inside a cut maps to nothing.
 */
export function mapRange(tl: Timeline, clip: number, srcStart: number, srcEnd: number): OutputRange[] {
  const c = tl.clips[clip];
  if (!c) return [];
  return c.segments.flatMap((i) => {
    const s = tl.segments[i]!;
    const a = Math.max(srcStart, s.srcIn), b = Math.min(srcEnd, s.srcOut);
    if (b - a < 0.05) return [];
    return [{ startSec: r3(s.outStart + a - s.srcIn), endSec: r3(s.outStart + b - s.srcIn) }];
  });
}

/** One contiguous output span from the first to the last mapped piece (overlays must not blink at cuts). */
export function mapSpan(tl: Timeline, clip: number, srcStart: number, srcEnd: number): OutputRange | null {
  const parts = mapRange(tl, clip, srcStart, srcEnd);
  return parts.length ? { startSec: parts[0]!.startSec, endSec: parts[parts.length - 1]!.endSec } : null;
}
