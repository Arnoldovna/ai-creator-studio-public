'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { outputToSource, toFrame, FRAME_SEC } from '@studio/core/timelineView';
import type { Timeline } from '@studio/core/timeline';

/**
 * Playback of the cut on the OUTPUT timeline (Etappe 12): one <video> per take plays its proxy; at the end of a segment
 * (a cut or a clip boundary) playback jumps to the next segment, on the same video or on the next take's (pre-seeked).
 * A take without proxy yet (still preparing) is played on the clock, so the timeline still runs. The truth is the
 * render; the proxy's short GOP keeps the jumps quick, a small stutter at a jump is expected (exact preview: Etappe 13).
 */
export function usePlayback(tl: Timeline) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const tlRef = useRef(tl);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [activeAsset, setActiveAsset] = useState<string | null>(null);
  const tRef = useRef(0);
  const seg = useRef(-1);
  const raf = useRef<number | null>(null);
  const clock = useRef<{ wall: number; t: number } | null>(null);
  const reverse = useRef<ReturnType<typeof setInterval> | null>(null);
  const playingRef = useRef(false);
  // the frame loop calls the latest `tick` through this ref (a callback cannot schedule itself by name)
  const loop = useRef<() => void>(() => undefined);
  const rateRef = useRef(1);

  const assetOf = useCallback((segment: number) => {
    const s = tlRef.current.segments[segment];
    return s ? s : null;
  }, []);

  const register = useCallback((assetId: string, el: HTMLVideoElement | null) => {
    if (el) videos.current.set(assetId, el);
    else videos.current.delete(assetId);
  }, []);

  /** Shows output time `at` (paused or playing on): picks the segment, the take's video and its source time. */
  const showAt = useCallback((at: number, assetIds: readonly string[]) => {
    const cur = tlRef.current;
    const clamped = Math.max(0, Math.min(at, cur.durationSec));
    tRef.current = clamped;
    setT(clamped);
    const p = outputToSource(cur, clamped);
    if (!p) { seg.current = -1; setActiveAsset(null); return; }
    seg.current = p.segment;
    const assetId = assetIds[p.clip] ?? null;
    setActiveAsset(assetId);
    const v = assetId ? videos.current.get(assetId) : undefined;
    for (const [id, other] of videos.current) if (id !== assetId && !other.paused) other.pause();
    if (v && Math.abs(v.currentTime - p.srcSec) > 0.02) v.currentTime = p.srcSec;
    return v;
  }, []);

  const clipAssets = useRef<readonly string[]>([]);

  const stopLoop = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = null;
    clock.current = null;
  }, []);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    stopLoop();
    if (reverse.current) { clearInterval(reverse.current); reverse.current = null; }
    for (const v of videos.current.values()) if (!v.paused) v.pause();
  }, [stopLoop]);

  const tick = useCallback(() => {
    const cur = tlRef.current;
    const s = cur.segments[seg.current];
    if (!playingRef.current || !s) return;
    const assetId = clipAssets.current[s.clip];
    const v = assetId ? videos.current.get(assetId) : undefined;
    let src: number;
    // review fix: a proxy can be a frame shorter than the take, and a refused play() leaves it paused – both would
    // freeze the playhead; the end of the file counts as the end of the segment, a stalled video runs on the clock
    const atFileEnd = !!v && (v.ended || (Number.isFinite(v.duration) && v.duration > 0 && v.currentTime >= v.duration - 0.05));
    if (v && v.readyState >= 2 && !v.paused && !atFileEnd) {
      src = v.currentTime;
      clock.current = null;
    } else if (atFileEnd) {
      src = s.srcOut;
    } else {
      // no proxy (yet): run on the clock
      const now = performance.now();
      clock.current ??= { wall: now, t: tRef.current };
      src = s.srcIn + (clock.current.t + ((now - clock.current.wall) / 1000) * rateRef.current - s.outStart);
    }
    const out = s.outStart + Math.max(0, src - s.srcIn);
    if (src >= s.srcOut - FRAME_SEC / 2) {
      const next = cur.segments[seg.current + 1];
      if (!next) {
        pause();
        tRef.current = cur.durationSec;
        setT(cur.durationSec);
        return;
      }
      seg.current += 1;
      clock.current = null;
      const nextAsset = clipAssets.current[next.clip];
      const nv = nextAsset ? videos.current.get(nextAsset) : undefined;
      if (nv !== v && v && !v.paused) v.pause();
      if (nextAsset !== assetId) setActiveAsset(nextAsset ?? null);
      if (nv) {
        nv.currentTime = next.srcIn;
        nv.playbackRate = rateRef.current;
        if (nv.paused) void nv.play().catch(() => undefined);
      }
      tRef.current = next.outStart;
      setT(next.outStart);
    } else {
      tRef.current = out;
      setT(out);
      // pre-seek the next take's video shortly before the jump
      const next = cur.segments[seg.current + 1];
      if (next && s.srcOut - src < 0.4) {
        const na = clipAssets.current[next.clip];
        const nv = na && na !== assetId ? videos.current.get(na) : undefined;
        if (nv && nv.paused && Math.abs(nv.currentTime - next.srcIn) > 0.05) nv.currentTime = next.srcIn;
      }
    }
    raf.current = requestAnimationFrame(() => loop.current());
  }, [pause]);
  useEffect(() => { loop.current = tick; }, [tick]);

  const play = useCallback((assetIds: readonly string[], speed = 1) => {
    clipAssets.current = assetIds;
    const cur = tlRef.current;
    if (!cur.segments.length) return;
    if (reverse.current) { clearInterval(reverse.current); reverse.current = null; }
    const start = tRef.current >= cur.durationSec - FRAME_SEC ? 0 : tRef.current;
    const v = showAt(start, assetIds);
    rateRef.current = speed;
    setRate(speed);
    playingRef.current = true;
    setPlaying(true);
    if (v) {
      v.playbackRate = speed;
      void v.play().catch(() => undefined);
    }
    stopLoop();
    raf.current = requestAnimationFrame(() => loop.current());
  }, [showAt, stopLoop]);

  /** J: shuttle backwards (HTML video cannot play in reverse: stepped seeks). */
  const playReverse = useCallback((assetIds: readonly string[], speed = 1) => {
    pause();
    clipAssets.current = assetIds;
    rateRef.current = speed;
    setRate(-speed);
    setPlaying(true);
    reverse.current = setInterval(() => {
      const next = tRef.current - 0.1 * speed;
      showAt(next, assetIds);
      if (next <= 0) pause();
    }, 100);
  }, [pause, showAt]);

  const seek = useCallback((at: number, assetIds: readonly string[]) => {
    clipAssets.current = assetIds;
    const wasPlaying = playingRef.current && !reverse.current;
    const v = showAt(toFrame(at), assetIds);
    clock.current = null;
    if (wasPlaying && v && v.paused) void v.play().catch(() => undefined);
  }, [showAt]);

  // a changed timeline (trim, cut, reorder): keep the playhead, re-resolve the segment
  useEffect(() => {
    tlRef.current = tl;
    if (tRef.current > tl.durationSec) {
      tRef.current = tl.durationSec;
      setT(tl.durationSec);
    }
    const p = outputToSource(tl, tRef.current);
    seg.current = p ? p.segment : -1;
  }, [tl]);

  useEffect(() => () => {
    stopLoop();
    if (reverse.current) clearInterval(reverse.current);
  }, [stopLoop]);

  return { t, playing, rate, activeAsset, register, play, playReverse, pause, seek, assetOf };
}
