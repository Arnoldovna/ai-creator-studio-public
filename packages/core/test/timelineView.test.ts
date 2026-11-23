import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPacing, buildTimeline, buildTimelineView, checkEditPlan, computePeaks, cutOutputRange, EditDraftBody, moveClip, outputSnapTargets, outputToSource,
  parseSilencedetect, parseWhisperJson, peaksRate, peaksSlice, PEAKS, removeClip, removeCut, snap, sourceSnapTargets, sourceToOutput, sourceToOutputNearest,
  splitAt, spritePlan, spriteTile, toFrame, transcriptWords, trimClip, validateEditPlan, MIN_CLIP_SEC, type EditAssetInfo, type TranscriptBody,
} from '../src';

const body = (clips: Record<string, unknown>[], extra: Record<string, unknown> = {}) => EditDraftBody.parse({ clips, ...extra });
const transcript: TranscriptBody = {
  language: 'de',
  segments: [{ startSec: 0, endSec: 4, text: 'Heute zeige ich euch Wolle', words: [
    { startSec: 0.2, endSec: 0.6, text: 'Heute' }, { startSec: 0.7, endSec: 1.1, text: 'zeige' }, { startSec: 1.2, endSec: 1.4, text: 'ich' },
    { startSec: 2.5, endSec: 2.9, text: 'euch' }, { startSec: 3.0, endSec: 3.6, text: 'Wolle' },
  ] }],
};

describe('timeline view: track model', () => {
  it('maps clips, pieces, seams, pauses, subtitles, overlays and hook onto the output timeline (same numbers as buildTimeline)', () => {
    const b = body([
      { assetId: 'a', inSec: 0, outSec: 4, cuts: [{ startSec: 1.5, endSec: 2.4 }], overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 3, endSec: 3.8 }] },
      { assetId: 'b', inSec: 1, outSec: 3 },
    ], { hook: { source: 'free', text: 'Mein Morgen', endSec: 2 } });
    const v = buildTimelineView(b, {
      transcripts: new Map([['a', { body: transcript }]]),
      silences: new Map([['a', [{ startSec: 1.4, endSec: 2.5 }, { startSec: 3.6, endSec: 4 }]]]),
    });
    const tl = buildTimeline(b.clips);
    expect(v.durationSec).toBe(tl.durationSec);
    expect(v.clips).toHaveLength(2);
    expect(v.clips[0]!.pieces.map((p) => [p.srcIn, p.outStart])).toEqual([[0, 0], [2.4, tl.segments[1]!.outStart]]);
    expect(v.clips[0]!.seams).toEqual([tl.segments[1]!.outStart]);
    expect(v.clips[1]!.outStart).toBe(tl.clips[1]!.outStart);
    // the pause inside the cut is only shown where it still plays
    expect(v.pauses.every((p) => p.endSec <= v.clips[0]!.outEnd + 1e-9)).toBe(true);
    expect(v.pauses.some((p) => p.srcStart === 3.6)).toBe(true);
    // „ich“ (1.2–1.4) stays, „euch“ after the cut moves up by the cut
    expect(v.subtitles.map((c) => c.text).join(' ')).toContain('Heute zeige ich euch Wolle');
    expect(v.overlays).toEqual([expect.objectContaining({ clip: 0, kind: 'keyword', text: 'Wolle' })]);
    expect(v.overlays[0]!.startSec).toBeCloseTo(3 - 0.9, 1);
    expect(v.hook).toMatchObject({ text: 'Mein Morgen', startSec: 0, endSec: 2, slot: 'upper' });
  });

  it('an empty draft is an empty timeline', () => {
    const v = buildTimelineView(body([]));
    expect(v).toMatchObject({ durationSec: 0, clips: [], subtitles: [], overlays: [], hook: null });
    expect(outputToSource(v.timeline, 1)).toBeNull();
  });
});

describe('source ↔ output mapping', () => {
  const b = body([{ assetId: 'a', inSec: 1, outSec: 5, cuts: [{ startSec: 2, endSec: 3 }] }, { assetId: 'b', inSec: 10, outSec: 12 }]);
  const tl = buildTimeline(b.clips);
  it('output → source finds the segment (a segment end belongs to the next segment)', () => {
    expect(outputToSource(tl, 0)).toEqual({ clip: 0, segment: 0, srcSec: 1 });
    expect(outputToSource(tl, 0.5)!.srcSec).toBeCloseTo(1.5, 6);
    expect(outputToSource(tl, 1)).toMatchObject({ clip: 0, segment: 1, srcSec: 3 }); // jumps over the cut
    expect(outputToSource(tl, 3)).toMatchObject({ clip: 1, segment: 2, srcSec: 10 });
    // at and past the end: the last frame of the last clip
    expect(outputToSource(tl, 99)).toMatchObject({ clip: 1, srcSec: 12 - 1 / 30 });
  });
  it('source → output is the inverse, null inside a cut; nearest maps a cut moment to its seam', () => {
    for (const t of [0, 0.4, 1.2, 2.9, 3.5, 4.9]) {
      const p = outputToSource(tl, t)!;
      expect(sourceToOutput(tl, p.clip, p.srcSec)).toBeCloseTo(t, 3);
    }
    expect(sourceToOutput(tl, 0, 2.5)).toBeNull();
    expect(sourceToOutput(tl, 0, 0.5)).toBeNull(); // before In
    expect(sourceToOutputNearest(tl, 0, 2.5)).toBe(1);
    expect(sourceToOutputNearest(tl, 0, 7)).toBe(3);
    expect(toFrame(1.016)).toBeCloseTo(1, 9);
    expect(toFrame(1.02)).toBeCloseTo(31 / 30, 9);
  });
});

describe('snapping', () => {
  it('snaps to word boundaries, silences and clip bounds within the tolerance; clip bounds win ties', () => {
    const targets = sourceSnapTargets({ words: transcript.segments[0]!.words, silences: [{ startSec: 1.4, endSec: 2.5 }], durationSec: 4 });
    expect(snap(1.13, targets, 0.05)).toEqual({ t: 1.1, target: { t: 1.1, kind: 'word' } });
    expect(snap(1.9, targets, 0.05)).toEqual({ t: 1.9, target: null });
    expect(snap(2.52, targets, 0.05).t).toBe(2.5); // word start and silence end coincide: word wins (rank)
    expect(snap(2.52, targets, 0.05).target!.kind).toBe('word');
    expect(snap(3.98, targets, 0.05).target).toEqual({ t: 4, kind: 'clip' });
    const v = buildTimelineView(body([{ assetId: 'a', inSec: 0, outSec: 2 }, { assetId: 'b', inSec: 0, outSec: 1 }]));
    expect(snap(2.03, outputSnapTargets(v, 2.6), 0.05).t).toBe(2);
    expect(snap(2.58, outputSnapTargets(v, 2.6), 0.05).target!.kind).toBe('playhead');
  });
});

describe('timeline operations', () => {
  it('trim: In/Out clamped to the take and to MIN_CLIP_SEC; cuts and overlays outside are clamped or dropped', () => {
    const b = body([{ assetId: 'a', inSec: 0, outSec: 4, cuts: [{ startSec: 3, endSec: 3.5 }], overlays: [{ kind: 'arrow', startSec: 3.2, endSec: 3.9 }] }]);
    const out = trimClip(b, 0, 'out', 2.5, 10);
    expect(out.body.clips[0]).toMatchObject({ inSec: 0, outSec: 2.5, cuts: [], overlays: [] });
    expect(out).toMatchObject({ droppedCuts: 1, droppedOverlays: 1 });
    expect(trimClip(b, 0, 'out', 99, 6).body.clips[0]!.outSec).toBe(6);
    expect(trimClip(b, 0, 'in', 3.95, 6).body.clips[0]!.inSec).toBeCloseTo(4 - MIN_CLIP_SEC, 6);
    expect(trimClip(b, 0, 'in', -1, 6).body.clips[0]!.inSec).toBe(0);
    const partial = trimClip(b, 0, 'out', 3.3, 6).body.clips[0]!;
    expect(partial.cuts).toEqual([expect.objectContaining({ startSec: 3, endSec: 3.3 })]);
    expect(b.clips[0]!.outSec).toBe(4); // the input is not mutated
  });

  it('move, remove, split at the playhead, remove a cut', () => {
    const b = body([{ assetId: 'a', inSec: 0, outSec: 4, overlays: [{ kind: 'keyword', text: 'X', startSec: 1, endSec: 3 }] }, { assetId: 'b', inSec: 0, outSec: 2 }]);
    expect(moveClip(b, 1, 0).clips.map((c) => c.assetId)).toEqual(['b', 'a']);
    expect(removeClip(b, 0).clips.map((c) => c.assetId)).toEqual(['b']);
    const s = splitAt(b, 2)!;
    expect(s.index).toBe(1);
    expect(s.body.clips.map((c) => [c.assetId, c.inSec, c.outSec])).toEqual([['a', 0, 2], ['a', 2, 4], ['b', 0, 2]]);
    expect(s.body.clips[0]!.overlays[0]).toMatchObject({ startSec: 1, endSec: 2 });
    expect(s.body.clips[1]!.overlays[0]).toMatchObject({ startSec: 2, endSec: 3 });
    expect(buildTimeline(s.body.clips).durationSec).toBe(buildTimeline(b.clips).durationSec); // a split changes nothing in the picture
    expect(splitAt(b, 0.1)).toBeNull(); // too close to In
    const withCut = body([{ assetId: 'a', inSec: 0, outSec: 4, cuts: [{ startSec: 1, endSec: 2 }] }]);
    expect(removeCut(withCut, 0, 0).clips[0]!.cuts).toEqual([]);
  });

  it('cut an output range (I/O + Entf): manual cut in source time, across a seam merging with the cut, a covered clip is removed', () => {
    const b = body([{ assetId: 'a', inSec: 0, outSec: 6, cuts: [{ startSec: 2, endSec: 3 }] }, { assetId: 'b', inSec: 0, outSec: 1 }]);
    // output 1.5–2.5 = source 1.5–2 (before the cut) + 3–3.5 (after it): one merged cut 1.5–3.5
    const out = cutOutputRange(b, 1.5, 2.5);
    expect(out.body.clips[0]!.cuts.map((c) => [c.startSec, c.endSec, c.reason])).toEqual([[1.5, 3.5, 'manual']]);
    expect(buildTimeline(out.body.clips).durationSec).toBeCloseTo(buildTimeline(b.clips).durationSec - 1, 1);
    // a range that covers clip 2 completely removes it
    const tl = buildTimeline(b.clips);
    const gone = cutOutputRange(b, tl.clips[1]!.outStart, tl.durationSec);
    expect(gone).toMatchObject({ removedClips: 1 });
    expect(gone.body.clips).toHaveLength(1);
    // a sliver under MIN_CLIP_SEC next to the edge is cut with it (no invalid piece)
    const edge = cutOutputRange(body([{ assetId: 'a', inSec: 0, outSec: 4 }]), 0.1, 2);
    expect(edge.body.clips[0]!.cuts[0]).toMatchObject({ startSec: 0, endSec: 2 });
    // the result validates
    const assets = new Map<string, EditAssetInfo>([['a', { origin: 'own', durationSec: 6, hasAudio: true, hasVideo: true }], ['b', { origin: 'own', durationSec: 1, hasAudio: true, hasVideo: true }]]);
    expect(checkEditPlan(out.body, { scenes: null, assets, projectKind: 'PERSONAL_CONTENT' }).errors).toEqual([]);
  });
});

describe('cut limit (review fix)', () => {
  it('a manual range cut on a clip full of suggestion cuts wins over the shortest suggestion cut and is counted', () => {
    const auto = Array.from({ length: 40 }, (_, k) => ({ startSec: 1 + k * 0.5, endSec: 1.1 + k * 0.5 + (k === 7 ? 0.05 : 0), reason: 'pause' as const }));
    const b = body([{ assetId: 'a', inSec: 0, outSec: 30, cuts: auto }]);
    const tl = buildTimeline(b.clips);
    const start = tl.durationSec - 2;
    const r = cutOutputRange(b, start, start + 0.5);
    expect(r.capped).toBe(1);
    const cuts = r.body.clips[0]!.cuts;
    expect(cuts).toHaveLength(40);
    expect(cuts.some((c) => c.reason === 'manual')).toBe(true);
    expect(cuts.some((c) => c.startSec === 1 + 7 * 0.5)).toBe(true); // the longer suggestion cut stays
  });
});

describe('pacing presets (real whisper + silencedetect fixtures)', () => {
  const fx = (f: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', f), f.endsWith('.json') ? 'latin1' : 'utf8');
  const t = parseWhisperJson(fx('whisper-filler-prompt-dtw.json'), { bytes: true });
  const sil = parseSilencedetect(fx('silencedetect-filler.txt'), 11.12);
  const inputs = new Map([['a', { transcript: t, silences: sil }]]);
  const b = body([{ assetId: 'a', inSec: 0, outSec: 11.12, cuts: [{ startSec: 10.5, endSec: 10.9, reason: 'manual' }] }]);
  const len = (x: typeof b) => buildTimeline(x.clips).durationSec;

  it('ruhig < normal < zügig removes more; manual cuts stay; only safe suggestions; re-applying replaces, not stacks', () => {
    const calm = applyPacing(b, 'calm', inputs), normal = applyPacing(b, 'normal', inputs), brisk = applyPacing(b, 'brisk', inputs);
    expect(len(calm.body)).toBeGreaterThanOrEqual(len(normal.body));
    expect(len(normal.body)).toBeGreaterThan(len(brisk.body));
    expect(len(b)).toBeGreaterThan(len(calm.body));
    for (const r of [calm, normal, brisk]) expect(r.body.clips[0]!.cuts.some((c) => c.reason === 'manual' && c.startSec === 10.5)).toBe(true);
    expect(calm.body.clips[0]!.cuts.some((c) => c.reason === 'filler')).toBe(false); // ruhig: no fillers
    expect(normal.body.clips[0]!.cuts.some((c) => c.reason === 'filler')).toBe(true);
    // switching presets replaces the suggestion cuts
    const again = applyPacing(brisk.body, 'calm', inputs);
    expect(again.body.clips[0]!.cuts).toEqual(calm.body.clips[0]!.cuts);
    expect(again.removed).toBe(brisk.added);
    // the result is a valid EDL
    const assets = new Map<string, EditAssetInfo>([['a', { origin: 'own', durationSec: 11.12, hasAudio: true, hasVideo: true }]]);
    expect(() => validateEditPlan(brisk.body, { scenes: null, assets, projectKind: 'PERSONAL_CONTENT' })).not.toThrow();
  });

  it('a clip without transcript or scan is left alone; claim sentences are never shortened', () => {
    const r = applyPacing(b, 'brisk', new Map());
    expect(r).toMatchObject({ added: 0, skipped: 1 });
    expect(r.body.clips[0]!.cuts).toHaveLength(1);
    const prot = applyPacing(b, 'brisk', new Map([['a', { transcript: t, silences: sil, protectedRanges: [{ startSec: 0, endSec: 11.12, reason: 'Claim' }] }]]));
    expect(prot.added).toBe(0);
  });
});

describe('checkEditPlan (lenient twin of validateEditPlan)', () => {
  it('returns the same messages validateEditPlan throws', () => {
    const assets = new Map<string, EditAssetInfo>([['a', { origin: 'own', durationSec: 3, hasAudio: true, hasVideo: true }]]);
    const raw = { clips: [{ assetId: 'a', inSec: 0, outSec: 5 }, { assetId: 'gone', inSec: 0, outSec: 1 }] };
    const ctx = { scenes: null, assets, projectKind: 'PERSONAL_CONTENT' as const };
    const { errors } = checkEditPlan(raw, ctx);
    expect(errors.length).toBe(2);
    expect(() => validateEditPlan(raw, ctx)).toThrow(errors.join(' '));
  });
});

describe('derived media (proxy, sprite, peaks)', () => {
  it('sprite: 1 tile per second, at most 300 tiles; tile positions', () => {
    expect(spritePlan(12.4)).toMatchObject({ intervalSec: 1, count: 13, columns: 10, rows: 2 });
    const long = spritePlan(1200);
    expect(long.count).toBeLessThanOrEqual(300);
    expect(long.intervalSec).toBe(4);
    expect(spriteTile(spritePlan(12.4), 11.5)).toEqual({ index: 11, x: 96, y: 170 });
    expect(spriteTile(spritePlan(3), 99).index).toBe(2);
  });
  it('peaks: max |sample| per bin scaled to 0..255, sliced per piece', () => {
    const s = new Int16Array(8000).fill(0);
    s[10] = 32767; s[200] = -16384;
    const p = computePeaks(s, 8000, 50);
    expect(p).toHaveLength(50);
    expect(p[0]).toBe(255);
    expect(p[1]).toBe(128);
    expect(p[2]).toBe(0);
    expect(peaksSlice({ perSec: 50, peaks: p }, 0, 0.04, 1)).toEqual([255]);
    expect(peaksSlice({ perSec: 50, peaks: p }, 0.5, 1, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(peaksRate(60)).toBe(PEAKS.perSec);
    expect(peaksRate(3600) * 3600).toBeLessThanOrEqual(PEAKS.maxBins);
  });
  it('transcriptWords spreads words of a corrected segment', () => {
    const w = transcriptWords({ language: 'de', segments: [{ startSec: 0, endSec: 2, text: 'eins zwei', words: [] }] });
    expect(w).toEqual([{ startSec: 0, endSec: 1, text: 'eins' }, { startSec: 1, endSec: 2, text: 'zwei' }]);
  });
});
