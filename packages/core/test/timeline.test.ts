import { describe, expect, it } from 'vitest';
import { buildTimeline, clipPieces, mapRange, mapSpan, quantizeSec } from '../src/timeline';
import { cuesForTimeline, cuesFromWords, subtitleTranscript, wordsBetween, type TranscriptBody } from '../src/transcript';

describe('buildTimeline', () => {
  it('keeps clips without cuts exact (old plans) and sums their lengths', () => {
    const tl = buildTimeline([{ inSec: 1.5, outSec: 3 }, { inSec: 0, outSec: 2 }, { inSec: 5, outSec: 6.25 }]);
    expect(tl.segments.map((s) => [s.srcIn, s.srcOut, s.outStart, s.outEnd, s.fadeIn, s.fadeOut])).toEqual([
      [1.5, 3, 0, 1.5, false, false], [0, 2, 1.5, 3.5, false, false], [5, 6.25, 3.5, 4.75, false, false],
    ]);
    expect(tl.durationSec).toBe(4.75); // 1.25 s is not a whole number of frames and stays unquantised
  });

  it('splits a clip at cuts at the start, middle and end, with fades only at cut boundaries', () => {
    const tl = buildTimeline([{ inSec: 0, outSec: 10, cuts: [{ startSec: 0, endSec: 1 }, { startSec: 4, endSec: 5 }, { startSec: 9, endSec: 10 }] }]);
    expect(tl.segments.map((s) => [s.srcIn, s.srcOut, s.fadeIn, s.fadeOut, s.offsetInClip])).toEqual([
      [1, 4, true, true, 0], [5, 9, true, true, 3], // a cut up to Out also ends the audio mid-take
    ]);
    expect(tl.durationSec).toBe(7);
    expect(tl.clips[0]).toMatchObject({ outStart: 0, outEnd: 7, durationSec: 7, segments: [0, 1] });
  });

  it('quantises the pieces of a clip with cuts to whole frames and uses the same numbers everywhere', () => {
    const tl = buildTimeline([{ inSec: 0.01, outSec: 3.337, cuts: [{ startSec: 1.111, endSec: 1.5 }] }, { inSec: 2, outSec: 3 }]);
    for (const s of tl.segments.slice(0, 2)) {
      expect(Math.abs(s.durationSec * 30 - Math.round(s.durationSec * 30))).toBeLessThan(1e-9);
      expect(s.srcOut - s.srcIn).toBeCloseTo(s.durationSec, 9);
      expect(s.outEnd - s.outStart).toBeCloseTo(s.durationSec, 9);
    }
    expect(tl.segments[0]!.durationSec).toBe(quantizeSec(1.101));
    expect(tl.segments[2]!.outStart).toBeCloseTo(tl.clips[0]!.outEnd, 9);
    // the plan duration is the sum of exactly these segment lengths
    expect(tl.durationSec).toBe(Math.round(tl.segments.reduce((s, x) => s + x.durationSec, 0) * 1000) / 1000);
  });

  it('merges overlapping cuts and ignores cuts outside the clip range', () => {
    expect(clipPieces({ inSec: 0, outSec: 5, cuts: [{ startSec: 2, endSec: 3 }, { startSec: 1, endSec: 2.5 }, { startSec: 6, endSec: 7 }] }))
      .toEqual([{ srcIn: 0, srcOut: 1, rawSec: 1, fadeIn: false, fadeOut: true }, { srcIn: 3, srcOut: 5, rawSec: 2, fadeIn: true, fadeOut: false }]);
  });
});

describe('mapRange / mapSpan', () => {
  const tl = buildTimeline([{ inSec: 2, outSec: 4 }, { inSec: 0, outSec: 10, cuts: [{ startSec: 3, endSec: 4 }] }]);
  it('maps a source range onto the output timeline across a cut', () => {
    expect(mapRange(tl, 1, 2, 6)).toEqual([{ startSec: 4, endSec: 5 }, { startSec: 5, endSec: 7 }]);
    expect(mapSpan(tl, 1, 2, 6)).toEqual({ startSec: 4, endSec: 7 });
  });
  it('maps a range entirely inside a cut to nothing', () => {
    expect(mapRange(tl, 1, 3.1, 3.9)).toEqual([]);
    expect(mapSpan(tl, 1, 3.1, 3.9)).toBeNull();
  });
  it('maps the first clip unchanged and unknown clips to nothing', () => {
    expect(mapRange(tl, 0, 2.5, 3)).toEqual([{ startSec: 0.5, endSec: 1 }]);
    expect(mapRange(tl, 7, 0, 1)).toEqual([]);
  });
});

describe('cuesForTimeline (subtitles on the cut timeline)', () => {
  const w = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text });
  const timed: TranscriptBody = {
    language: 'de',
    segments: [{ startSec: 0, endSec: 6, text: 'ich hab ähm heute was ausprobiert', words: [w(0, 0.5, 'ich'), w(0.5, 1, 'hab'), w(1.1, 1.6, 'ähm'), w(2, 2.5, 'heute'), w(2.5, 3, 'was'), w(3, 4, 'ausprobiert')] }],
  };

  it('drops a word inside a cut and moves later words up by the cut length', () => {
    const items = [{ subtitle: '', inSec: 0, outSec: 6, cuts: [{ startSec: 1, endSec: 2 }], transcript: timed }];
    const cues = cuesForTimeline(buildTimeline(items), items);
    expect(cues.map((c) => c.text).join(' ')).toBe('ich hab heute was ausprobiert');
    expect(cues.some((c) => c.text.includes('ähm'))).toBe(false);
    // „heute“ starts at 2.0 s in the take, 1.0 s cut away before it → 1.0 s in the output
    const later = cues.find((c) => c.text.startsWith('heute'))!;
    expect(later.startSec).toBeCloseTo(1, 2);
    expect(later.endSec).toBeCloseTo(3, 2);
  });

  it('spreads a corrected segment without word timings evenly and drops its words inside a cut', () => {
    const edited: TranscriptBody = { language: 'de', segments: [
      { startSec: 0, endSec: 4, text: 'Ich hab heute was ausprobiert.', words: [] },
      { startSec: 6, endSec: 8, text: 'Komplett in einer Pause', words: [] },
    ] };
    const items = [{ subtitle: '', inSec: 0, outSec: 10, cuts: [{ startSec: 1, endSec: 2 }, { startSec: 5.5, endSec: 8.5 }], transcript: edited }];
    const cues = cuesForTimeline(buildTimeline(items), items);
    // 0.8 s per word: „hab“ (0.8-1.6, middle 1.2) lies in the 1-2 s cut; the second segment lies entirely in a cut
    expect(cues).toEqual([{ startSec: 0, endSec: 0.8, text: 'Ich' }, { startSec: 1, endSec: 3, text: 'heute was ausprobiert.' }]);
  });

  it('never burns in the cut-out sentence of a corrected segment, and keeps cues short', () => {
    const text = 'Heute zeige ich euch meine Morgenroutine und wie ich sie schaffe. Das ist gelogen hier. Und dann geht es los mit Kaffee am Morgen.';
    const n = text.split(' ').length;
    const edited: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: n, text, words: [] }] }; // 1 s per word
    const cutFrom = text.split(' ').indexOf('Das'), cutTo = text.split(' ').indexOf('hier.') + 1;
    const items = [{ subtitle: '', inSec: 0, outSec: n, cuts: [{ startSec: cutFrom, endSec: cutTo }], transcript: edited }];
    const cues = cuesForTimeline(buildTimeline(items), items);
    const shown = cues.map((c) => c.text).join(' ');
    expect(shown).not.toMatch(/gelogen/);
    expect(shown).toBe(text.replace(' Das ist gelogen hier.', ''));
    expect(cues.every((c) => c.text.split(' ').length <= 6)).toBe(true);
    expect(cues.length).toBeGreaterThan(2);
  });

  it('gives a clip its own subtitle text over its whole output span', () => {
    const items = [
      { subtitle: '', inSec: 0, outSec: 2, cuts: [], transcript: null },
      { subtitle: 'Eigener Text', inSec: 0, outSec: 6, cuts: [{ startSec: 1, endSec: 2 }], transcript: timed },
    ];
    expect(cuesForTimeline(buildTimeline(items), items)).toEqual([{ startSec: 2, endSec: 7, text: 'Eigener Text' }]);
  });

  it('gives a plan without cuts the same cues as before cuts existed', () => {
    const edited: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 3, text: 'eins zwei drei', words: [] }] };
    const items = [{ subtitle: '', inSec: 0.5, outSec: 5, cuts: [], transcript: timed }, { subtitle: 'Text', inSec: 0, outSec: 1.25, cuts: [], transcript: null }, { subtitle: '', inSec: 0, outSec: 3, cuts: [], transcript: edited }];
    // the pre-Etappe-8 algorithm: running offset, words of the whole clip range (fillers left out since part 2)
    const before: ReturnType<typeof cuesForTimeline> = [];
    let offset = 0;
    for (const c of items) {
      if (c.subtitle.trim()) before.push({ startSec: offset, endSec: offset + c.outSec - c.inSec, text: c.subtitle });
      else if (c.transcript) before.push(...cuesFromWords(wordsBetween(subtitleTranscript(c.transcript), c.inSec, c.outSec), offset, c.inSec, c.outSec));
      offset += c.outSec - c.inSec;
    }
    expect(cuesForTimeline(buildTimeline(items), items)).toEqual(before);
    expect(before[0]!.text).toBe('hab heute was ausprobiert'); // „ähm“ is not shown, even uncut
  });
});
