import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addCuts, buildTimeline, claimRanges, cuesForTimeline, FILLER_PROMPT, isPromptEcho, isStrongFiller, isWeakFiller, matchScene,
  parseSilencedetect, parseVolumedetect, parseWhisperJson, silencedetectFilter, silenceThresholdDb, stripFillers, subtitleTranscript, suggestCuts,
  type TranscriptBody,
} from '../src';

/**
 * Etappe 8, part 2. Fixtures are REAL tool output on a synthetic voice (macOS `say -v Anna`, 11.12 s):
 * „Ähm, heute zeige ich euch, äh, wie ich meine Wolle färbe. [0,9 s Stille] Also, zuerst wasche ich, hm, das Garn
 * mit lauwarmem Wasser. Öhm, dann kommt die Farbe dazu.“ – whisper.cpp 1.9.5 large-v3-turbo-q5_0, once without
 * prompt, once with FILLER_PROMPT + `--carry-initial-prompt -dtw large.v3.turbo -nfa`; silencedetect at −38,5 dB
 * (mean −18,5 dB − 20). Model paths were removed from the JSON.
 */
const fx = (f: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', f), f.endsWith('.json') ? 'latin1' : 'utf8');
const withPrompt = parseWhisperJson(fx('whisper-filler-prompt-dtw.json'), { bytes: true });
const noPrompt = parseWhisperJson(fx('whisper-filler-noprompt.json'), { bytes: true });
const silences = parseSilencedetect(fx('silencedetect-filler.txt'), 11.12);
const clip = { inSec: 0, outSec: 11.12 };
const overlap = (a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }) => Math.min(a.endSec, b.endSec) > Math.max(a.startSec, b.startSec);

describe('silence scan parsing', () => {
  it('reads real silencedetect and volumedetect output; the threshold is relative to the mean, clamped', () => {
    expect(silences).toHaveLength(9);
    expect(silences[0]).toEqual({ startSec: 0.246, endSec: 0.451 });
    expect(silences[3]).toEqual({ startSec: 3.623, endSec: 4.697 }); // the 0,9 s pause
    expect(parseVolumedetect(fx('volumedetect-filler.txt'))).toEqual({ meanDb: -18.5, maxDb: -0.9 });
    expect(silenceThresholdDb(-18.5)).toBe(-38.5);
    expect(silenceThresholdDb(-35)).toBe(-55); // quiet phone recording: speech at −40 dB is not silence
    expect(silenceThresholdDb(-5)).toBe(-30);
    expect(silenceThresholdDb(-70)).toBe(-60);
    expect(silencedetectFilter(-38.5)).toBe('silencedetect=noise=-38.5dB:d=0.15');
    expect(parseVolumedetect('mean_volume: -inf dB')).toBeNull();
  });
  it('closes a silence still open at the end of the file, or drops it without a length', () => {
    const s = 'silence_start: 1.5\nsilence_end: 2 | silence_duration: 0.5\nsilence_start: 9.25\n';
    expect(parseSilencedetect(s, 10)).toEqual([{ startSec: 1.5, endSec: 2 }, { startSec: 9.25, endSec: 10 }]);
    expect(parseSilencedetect(s)).toEqual([{ startSec: 1.5, endSec: 2 }]);
    expect(parseSilencedetect('silence_start: -0.002\nsilence_end: 0.3')).toEqual([{ startSec: 0, endSec: 0.3 }]);
  });
});

describe('fillers', () => {
  it('knows strong and weak fillers; „im“, „er“ and „eh“ are words', () => {
    for (const w of ['Ähm,', 'äh', 'öhm', 'Hm.', 'hmm', 'mhm', 'ehm', 'Äh,']) expect(isStrongFiller(w)).toBe(true);
    for (const w of ['im', 'Im,', 'er', 'eh', 'ja', 'heute', 'Hammer', 'mehr']) expect(isStrongFiller(w)).toBe(false);
    expect(isWeakFiller('Also,')).toBe(true);
    expect(isWeakFiller('heute')).toBe(false);
  });
  it('strips fillers from subtitle text and restores the capital at a sentence start', () => {
    expect(stripFillers('Hm, heute zeige ich euch, äh, wie ich meine Wolle färbe.')).toBe('Heute zeige ich euch, wie ich meine Wolle färbe.');
    expect(stripFillers('mit Wasser, hm, dann')).toBe('mit Wasser, dann');
    expect(stripFillers('Das ist gut, hm.')).toBe('Das ist gut.');
    expect(stripFillers('Ähm.')).toBe('');
    expect(stripFillers('Gut. Hm. weiter')).toBe('Gut. Weiter');
  });
  it('recognises prompt echoes, but keeps short real answers', () => {
    expect(isPromptEcho(FILLER_PROMPT)).toBe(true);
    expect(isPromptEcho('ich hab heute, äh, was ausprobiert.')).toBe(true);
    expect(isPromptEcho('Ja.')).toBe(false);
    expect(isPromptEcho('Heute zeige ich euch was.')).toBe(false);
    // real openers that share words with the prompt are speech, not echoes
    expect(isPromptEcho('Also, ich hab heute')).toBe(false);
    expect(isPromptEcho('Was ausprobiert.')).toBe(false);
    expect(isPromptEcho('m also ich')).toBe(false); // whole words only
  });
  it('the prompt makes whisper write the fillers; DTW times are parsed', () => {
    expect(withPrompt.segments[0]!.text).toBe('Hm, heute zeige ich euch, äh, wie ich meine Wolle färbe.');
    expect(noPrompt.segments[0]!.text).toBe('Im, heute zeige ich euch, wie ich meine Wolle färbe.'); // „Ähm“ became the word „Im“
    expect(withPrompt.segments[0]!.words[0]).toMatchObject({ text: 'Hm,', atSec: 0.18 });
    expect(noPrompt.segments[0]!.words[0]!.atSec).toBeUndefined();
  });
});

describe('suggestCuts on real whisper + silencedetect output', () => {
  it('with prompt and DTW: every spoken filler is found as a safe cut over its sound island, pauses are shortened', () => {
    const r = suggestCuts({ transcript: withPrompt, silences, clip });
    expect(r.dtw).toBe(true);
    expect(r.skippedFillers).toBe(0);
    const fillers = r.suggestions.filter((s) => s.kind === 'filler');
    expect(fillers.map((s) => [s.word, s.startSec, s.endSec, s.confidence])).toEqual([
      ['Hm', 0, 0.349, 'high'], // at the clip start: from In to 0,1 s into the silence after it
      ['äh', 1.739, 2.097, 'high'], // island 1,838–1,997 between two 0,2 s silences
      ['hm', 6.561, 7.09, 'high'],
      ['hm', 9.015, 9.476, 'high'],
    ]);
    expect(fillers.every((s) => s.safe && s.reason === 'filler' && !s.blocked)).toBe(true);
    const pause = r.suggestions.find((s) => s.kind === 'pause')!;
    expect(pause).toMatchObject({ startSec: 3.773, endSec: 4.547, confidence: 'high', safe: true, reason: 'pause' }); // 1,07 s → 2 × 0,15 s kept
    // „Also,“ at the sentence start is a weak filler: suggested, never safe
    expect(r.suggestions.find((s) => s.kind === 'weak_filler')).toMatchObject({ word: 'Also', confidence: 'low', safe: false });
    // no cut overlaps a spoken non-filler word (by its DTW time)
    const spoken = withPrompt.segments.flatMap((s) => s.words).filter((w) => !isStrongFiller(w.text) && w.text !== 'Also,');
    for (const s of r.suggestions.filter((x) => x.kind !== 'weak_filler')) for (const w of spoken) expect(w.atSec! > s.startSec && w.atSec! < s.endSec).toBe(false);
  });
  it('without prompt and DTW: „Im“ is never a filler and nothing is offered as safe', () => {
    const r = suggestCuts({ transcript: noPrompt, silences, clip });
    expect(r.dtw).toBe(false);
    expect(r.suggestions.some((s) => s.word.toLowerCase() === 'im')).toBe(false);
    expect(r.suggestions.filter((s) => s.kind !== 'pause').every((s) => !s.safe && s.confidence === 'low')).toBe(true);
    expect(r.skippedFillers).toBe(1); // the „hm“ whisper placed a second away from its sound
  });
  it('respects the clip range and never leaves a sliver at In/Out', () => {
    const r = suggestCuts({ transcript: withPrompt, silences, clip: { inSec: 1, outSec: 9.2 } });
    for (const s of r.suggestions) {
      expect(s.startSec).toBeGreaterThanOrEqual(1);
      expect(s.endSec).toBeLessThanOrEqual(9.2);
      expect(s.startSec === 1 || s.startSec - 1 >= 0.2).toBe(true);
      expect(s.endSec === 9.2 || 9.2 - s.endSec >= 0.2).toBe(true);
    }
    expect(r.suggestions.find((s) => s.word === 'hm' && s.startSec > 9)).toBeUndefined(); // its island lies past Out
  });
  it('blocks suggestions inside client claim sentences', () => {
    const ranges = claimRanges(withPrompt, ['Garn mit lauwarmem Wasser']);
    expect(ranges).toHaveLength(1);
    const r = suggestCuts({ transcript: withPrompt, silences, clip, protectedRanges: ranges });
    const inClaim = r.suggestions.filter((s) => overlap(s, ranges[0]!));
    expect(inClaim.length).toBeGreaterThan(0);
    expect(inClaim.every((s) => s.blocked?.includes('Kunden-Claim') && !s.safe)).toBe(true);
    expect(r.suggestions.find((s) => s.word === 'äh')).toMatchObject({ blocked: null, safe: true }); // first sentence has no claim
  });
});

describe('suggestCuts rules (synthetic)', () => {
  const t = (words: { text: string; startSec: number; endSec: number; atSec?: number }[]): TranscriptBody => ({
    language: 'de', segments: [{ startSec: words[0]!.startSec, endSec: words[words.length - 1]!.endSec, text: words.map((w) => w.text).join(' '), words }],
  });
  it('a zero-length „hm“ is widened to the sound island between silences', () => {
    const body = t([{ text: 'Gut,', startSec: 4, endSec: 4.4, atSec: 4.2 }, { text: 'hm,', startSec: 4.88, endSec: 4.88, atSec: 4.9 }, { text: 'weiter', startSec: 5.5, endSec: 5.9, atSec: 5.7 }]);
    const r = suggestCuts({ transcript: body, silences: [{ startSec: 4.5, endSec: 4.8 }, { startSec: 5.05, endSec: 5.4 }], clip: { inSec: 3, outSec: 7 } });
    expect(r.suggestions).toEqual([expect.objectContaining({ kind: 'filler', word: 'hm', startSec: 4.65, endSec: 5.25, confidence: 'high' })]);
  });
  it('a pause cut never overlaps a word, even when whisper puts one into the silence', () => {
    const body = t([{ text: 'eins', startSec: 1, endSec: 1.4, atSec: 1.2 }, { text: 'zwei', startSec: 2.1, endSec: 2.3, atSec: 2.2 }, { text: 'drei', startSec: 3.6, endSec: 4, atSec: 3.8 }]);
    const r = suggestCuts({ transcript: body, silences: [{ startSec: 1.5, endSec: 3.5 }], clip: { inSec: 0, outSec: 5 } });
    const pauses = r.suggestions.filter((s) => s.kind === 'pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toMatchObject({ confidence: 'low', safe: false });
    for (const w of body.segments[0]!.words) expect(overlap(pauses[0]!, w)).toBe(false);
  });
  it('a filler glued to speech (no gap in the audio) is not suggested but counted', () => {
    const body = t([{ text: 'also', startSec: 1, endSec: 1.3, atSec: 1.1 }, { text: 'äh', startSec: 1.3, endSec: 1.5, atSec: 1.4 }, { text: 'gut', startSec: 1.5, endSec: 1.8, atSec: 1.6 }]);
    const r = suggestCuts({ transcript: body, silences: [{ startSec: 0, endSec: 0.9 }, { startSec: 2.5, endSec: 3 }], clip: { inSec: 0, outSec: 3 } });
    expect(r.suggestions.filter((s) => s.kind === 'filler')).toEqual([]);
    expect(r.skippedFillers).toBe(1);
  });
  it('unexplained short sounds are only suggested on request, as unsafe', () => {
    const body = t([{ text: 'eins', startSec: 0.5, endSec: 1, atSec: 0.7 }, { text: 'zwei', startSec: 3, endSec: 3.5, atSec: 3.2 }]);
    const input = { transcript: body, silences: [{ startSec: 1.1, endSec: 1.8 }, { startSec: 2.1, endSec: 2.9 }], clip: { inSec: 0, outSec: 4 } };
    expect(suggestCuts(input).suggestions.some((s) => s.kind === 'sound')).toBe(false);
    const sound = suggestCuts(input, { sounds: true }).suggestions.find((s) => s.kind === 'sound');
    expect(sound).toMatchObject({ word: 'unbenannter Laut', reason: 'filler', confidence: 'low', safe: false, startSec: 1.25, endSec: 2.75 });
  });
  it('edited segments without word timings give no filler suggestions and mark pauses there as unsafe', () => {
    const body: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 5, text: 'Ähm, das ist korrigiert.', words: [] }] };
    const r = suggestCuts({ transcript: body, silences: [{ startSec: 1, endSec: 2 }], clip: { inSec: 0, outSec: 5 } });
    expect(r.untimedSegments).toBe(1);
    expect(r.suggestions).toEqual([expect.objectContaining({ kind: 'pause', safe: false })]);
  });
});

describe('addCuts', () => {
  it('merges, extends slivers at the edges, and joins close cuts only over measured silence', () => {
    const existing = [{ startSec: 1, endSec: 1.5, reason: 'manual' as const, word: '' }];
    const add = [
      { startSec: 1.6, endSec: 2, reason: 'filler' as const, word: 'äh' },
      { startSec: 0.1, endSec: 0.5, reason: 'filler' as const, word: 'hm' },
      { startSec: 4, endSec: 4.9, reason: 'pause' as const, word: '' },
    ];
    const r = addCuts(existing, add, { inSec: 0, outSec: 5 }, [{ startSec: 1.45, endSec: 1.65 }]);
    expect(r.cuts).toEqual([
      { startSec: 0, endSec: 0.5, reason: 'filler', word: 'hm' },
      // manual + filler: the strictest reason wins, so the client-claim gate still checks it
      { startSec: 1, endSec: 2, reason: 'filler', word: 'äh' },
      { startSec: 4, endSec: 5, reason: 'pause', word: '' },
    ]);
    expect(r).toMatchObject({ joined: 1, refused: 0 });
  });
  it('refuses a new cut whose gap to a neighbour is not silent (it may hold the end of a word)', () => {
    const existing = [{ startSec: 5, endSec: 5.3, reason: 'manual' as const, word: '' }];
    const r = addCuts(existing, [{ startSec: 5.45, endSec: 6, reason: 'pause', word: '' }], { inSec: 0, outSec: 10 }, [{ startSec: 5.4, endSec: 6.2 }]);
    expect(r.cuts).toEqual(existing);
    expect(r).toMatchObject({ joined: 0, refused: 1 });
    // a new cut before an existing one: the existing one is kept
    const r2 = addCuts(existing, [{ startSec: 4.5, endSec: 4.9, reason: 'filler', word: 'äh' }], { inSec: 0, outSec: 10 });
    expect(r2.cuts).toEqual(existing);
    expect(r2.refused).toBe(1);
  });
  it('a filler cut overlapping a manual cut keeps the filler reason', () => {
    const r = addCuts([{ startSec: 2, endSec: 2.5, reason: 'manual', word: '' }], [{ startSec: 2.4, endSec: 2.8, reason: 'filler', word: 'ähm' }], { inSec: 0, outSec: 5 });
    expect(r.cuts).toEqual([{ startSec: 2, endSec: 2.8, reason: 'filler', word: 'ähm' }]);
  });
});

describe('claimRanges', () => {
  const seg = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text, words: [] });
  it('matches a claim interrupted by a filler', () => {
    const t: TranscriptBody = { language: 'de', segments: [seg(0, 2, 'Hallo zusammen.'), seg(2, 5, 'Die Creme hält, äh, 24 Stunden.')] };
    expect(claimRanges(t, ['Die Creme hält 24 Stunden'])).toEqual([expect.objectContaining({ startSec: 2, endSec: 5, claim: 'Die Creme hält 24 Stunden' })]);
  });
  it('protects both segments of a claim whisper split in two', () => {
    const t: TranscriptBody = { language: 'de', segments: [seg(0, 1.5, 'Die Creme hält'), seg(1.5, 3, '24 Stunden.'), seg(3, 4, 'Danke.')] };
    const r = claimRanges(t, ['Die Creme hält 24 Stunden']);
    expect(r).toEqual([expect.objectContaining({ startSec: 0, endSec: 3 })]);
    // a filler cut inside the second half is blocked
    const s = suggestCuts({ transcript: { language: 'de', segments: [seg(0, 1.5, 'Die Creme hält'), { startSec: 1.5, endSec: 3, text: '24, ähm, Stunden.', words: [
      { text: '24,', startSec: 1.5, endSec: 1.8, atSec: 1.6 }, { text: 'ähm,', startSec: 2, endSec: 2.2, atSec: 2.1 }, { text: 'Stunden.', startSec: 2.5, endSec: 2.9, atSec: 2.7 }] }] },
    silences: [{ startSec: 1.85, endSec: 2.0 }, { startSec: 2.2, endSec: 2.45 }], clip: { inSec: 0, outSec: 3 }, protectedRanges: claimRanges({ language: 'de', segments: [seg(0, 1.5, 'Die Creme hält'), seg(1.5, 3, '24, ähm, Stunden.')] }, ['Die Creme hält 24 Stunden']) });
    const f = s.suggestions.find((x) => x.word === 'ähm')!;
    expect(f.blocked).toMatch(/Kunden-Claim/);
    expect(f.safe).toBe(false);
  });
});

describe('subtitles and take matching with fillers', () => {
  it('subtitles leave out fillers and prompt echoes, also without cuts', () => {
    const echoWords = ['ich', 'hab', 'heute,', 'äh,', 'was', 'ausprobiert.'].map((text, i) => ({ text, startSec: 10.98 + i * 0.02, endSec: 11 + i * 0.02 }));
    const echo: TranscriptBody = { ...withPrompt, segments: [...withPrompt.segments, { startSec: 10.98, endSec: 11.1, text: 'ich hab heute, äh, was ausprobiert.', words: echoWords }] };
    expect(subtitleTranscript(echo, { fillerPrompt: true }).segments.map((s) => s.text)).toEqual([
      'Heute zeige ich euch, wie ich meine Wolle färbe.',
      'Also, zuerst wasche ich, das Garn mit lauwarmem Wasser, dann kommt die Farbe dazu.',
    ]);
    const tl = buildTimeline([{ inSec: 0, outSec: 11.12 }]);
    const cues = cuesForTimeline(tl, [{ subtitle: '', inSec: 0, outSec: 11.12, transcript: echo, fillerPrompt: true }]);
    const text = cues.map((c) => c.text).join(' ');
    expect(text).not.toMatch(/\b(hm|äh)\b/i);
    expect(text).not.toContain('ausprobiert');
    expect(text).toContain('Wolle');
  });
  it('word-timed cues keep the sentence start capital and the full stop of a dropped filler', () => {
    const tl = buildTimeline([{ inSec: 0, outSec: 11.12 }]);
    const text = cuesForTimeline(tl, [{ subtitle: '', inSec: 0, outSec: 11.12, transcript: withPrompt, fillerPrompt: true }]).map((c) => c.text).join(' ');
    expect(text).toMatch(/^Heute /);
    expect(text).toMatch(/ dazu\.$/);
    const w = (text: string, startSec: number) => ({ text, startSec, endSec: startSec + 0.3 });
    const t: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 2, text: 'Ähm, heute zeige ich euch dazu, hm.', words: [w('Ähm,', 0), w('heute', 0.3), w('zeige', 0.6), w('ich', 0.9), w('euch', 1.2), w('dazu,', 1.5), w('hm.', 1.8)] }] };
    expect(subtitleTranscript(t).segments[0]!.words.map((x) => x.text)).toEqual(['Heute', 'zeige', 'ich', 'euch', 'dazu.']);
  });
  it('keeps prompt-like real speech, corrected segments and transcripts made without the prompt', () => {
    const w = (text: string, i: number) => ({ text, startSec: i * 0.3, endSec: i * 0.3 + 0.25 });
    const real: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 1.2, text: 'Also, ich hab heute', words: ['Also,', 'ich', 'hab', 'heute'].map(w) }] };
    expect(subtitleTranscript(real, { fillerPrompt: true }).segments.map((s) => s.text)).toEqual(['Also, ich hab heute']);
    const echoLike: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 2, text: 'ich hab heute, äh, was ausprobiert.', words: ['ich', 'hab', 'heute,', 'äh,', 'was', 'ausprobiert.'].map(w) }] };
    expect(subtitleTranscript(echoLike, { fillerPrompt: true }).segments).toEqual([]);
    // no prompt used: it cannot be an echo
    expect(subtitleTranscript(echoLike).segments.map((s) => s.text)).toEqual(['ich hab heute, was ausprobiert.']);
    // the user corrected the segment (no word timings): her text counts
    const edited: TranscriptBody = { language: 'de', segments: [{ ...echoLike.segments[0]!, words: [] }] };
    expect(subtitleTranscript(edited, { fillerPrompt: true }).segments.map((s) => s.text)).toEqual(['ich hab heute, was ausprobiert.']);
  });
  it('take matching scores the same with and without filler tokens', () => {
    const dialogue = 'Heute zeige ich euch, wie ich meine Wolle färbe.';
    const plain: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 3, text: dialogue, words: [] }] };
    const filled: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 3, text: 'Ähm, heute zeige ich euch, äh, wie ich, hm, meine Wolle färbe.', words: [] }] };
    const [a] = matchScene(dialogue, [{ assetId: 'a', transcript: plain, durationSec: 3 }]);
    const [b] = matchScene(dialogue, [{ assetId: 'b', transcript: filled, durationSec: 3 }]);
    expect(a!.score).toBe(1);
    expect(b!.score).toBe(a!.score);
  });
});
