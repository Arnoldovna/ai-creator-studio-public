import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyTranscriptEdit, buildAss, cuesFromWords, escapeAss, matchScene, mockTranscript, parseWhisperJson, wordsBetween } from '../src/transcript';
import { buildRender } from '../src/edit';

const fixture = readFileSync(new URL('./fixtures/whisper-ojf.json', import.meta.url), 'utf8');

describe('whisper.cpp -ojf parser', () => {
  it('reads segments, merges sub-word tokens into words, drops special tokens and broken segments', () => {
    const t = parseWhisperJson(fixture);
    expect(t.language).toBe('de');
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0]).toMatchObject({ startSec: 0, endSec: 2.4, text: 'Heute zeige ich euch, wie ich Wolle färbe.' });
    expect(t.segments[0]!.words.map((w) => w.text)).toEqual(['Heute', 'zeige', 'ich', 'euch,', 'wie', 'ich', 'Wolle', 'färbe.']);
    expect(t.segments[0]!.words[6]).toEqual({ startSec: 1.38, endSec: 1.75, text: 'Wolle' });
    expect(() => parseWhisperJson('not json')).toThrow();
    expect(parseWhisperJson('{"transcription": 5}').segments).toEqual([]);
  });

  it('decodes umlauts split across tokens when read as bytes, and drops broken word timings otherwise', () => {
    // "für" with ü (0xC3 0xBC) split over two tokens, as whisper.cpp writes raw token bytes
    const bytes = (s: string) => Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join('');
    const raw = JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: bytes(' für dich'), tokens: [
      { text: ' f\u00c3', offsets: { from: 0, to: 300 } }, { text: '\u00bcr', offsets: { from: 300, to: 500 } }, { text: bytes(' dich'), offsets: { from: 500, to: 1000 } },
    ] }] });
    const t = parseWhisperJson(raw, { bytes: true });
    expect(t.segments[0]!.text).toBe('für dich');
    expect(t.segments[0]!.words.map((w) => w.text)).toEqual(['für', 'dich']);
    // the same file read as UTF-8 (broken halves) keeps the text but no word timings
    const broken = raw.replaceAll('\u00c3', '\ufffd').replaceAll('\u00bc', '\ufffd');
    expect(parseWhisperJson(broken).segments[0]!.words).toEqual([]);
  });

  it('mock transcripts are deterministic and labelled', () => {
    expect(mockTranscript(9, 'abcdef123')).toEqual(mockTranscript(9, 'abcdef123'));
    expect(mockTranscript(9, 'abcdef123').segments[0]!.text).toMatch(/^MOCK-Transkript/);
  });

  it('user corrections replace text and drop stale word timings only where changed', () => {
    const t = parseWhisperJson(fixture);
    const e = applyTranscriptEdit(t, ['Heute zeige ich euch, wie ich Wolle färbe.', 'Und dann  spüle ich.']);
    expect(e.segments[0]!.words).toHaveLength(8);
    expect(e.segments[1]).toMatchObject({ text: 'Und dann spüle ich.', words: [] });
    expect(() => applyTranscriptEdit(t, ['nur eins'])).toThrow();
  });
});

describe('take matching', () => {
  const takeA = parseWhisperJson(fixture);
  const takeB = { language: 'de', segments: [{ startSec: 0, endSec: 3, text: 'Ganz anderes Thema heute im Garten.', words: [] }] };

  it('finds the window of the dialogue in the right take with in/out from the word timings', () => {
    const c = matchScene('Ich zeige euch, wie ich Wolle färbe!', [
      { assetId: 'b', transcript: takeB, durationSec: 3 },
      { assetId: 'a', transcript: takeA, durationSec: 5 },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ assetId: 'a', inSec: 0.23, outSec: 2.55, text: 'zeige ich euch, wie ich Wolle färbe.' });
    expect(c[0]!.score).toBeGreaterThan(0.8);
  });

  it('returns nothing for empty dialogue or unrelated takes', () => {
    expect(matchScene('', [{ assetId: 'a', transcript: takeA, durationSec: 5 }])).toEqual([]);
    expect(matchScene('Kuchen backen mit Zimt', [{ assetId: 'b', transcript: takeB, durationSec: 3 }])).toEqual([]);
  });

  it('subtitle words of a clip are shifted onto the output timeline in short cues', () => {
    const words = wordsBetween(takeA, 0.7, 2.4);
    expect(words[0]!.text).toBe('ich');
    const cues = cuesFromWords(words, 10, 0.7, 2.4, 3);
    expect(cues[0]).toEqual({ startSec: 10, endSec: 10.55, text: 'ich euch, wie' });
    expect(cues.every((c) => c.startSec >= 10 && c.endSec <= 11.7)).toBe(true);
  });
});

describe('ASS subtitles', () => {
  it('builds a 1080x1920 file with bottom-centred style and timed dialogue lines', () => {
    const ass = buildAss([{ startSec: 0, endSec: 1.5, text: 'Heute färbe ich Wolle' }, { startSec: 61.25, endSec: 3725.5, text: 'Ende' }]);
    expect(ass).toContain('PlayResX: 1080\nPlayResY: 1920');
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,Heute färbe ich Wolle');
    expect(ass).toContain('Dialogue: 0,0:01:01.25,1:02:05.50,Default,,0,0,0,,Ende');
  });

  it('neutralises override tags, escapes and line breaks from untrusted transcript text', () => {
    const t = parseWhisperJson(fixture);
    const line = escapeAss(t.segments[1]!.text);
    expect(line).not.toMatch(/[{}\\]/);
    expect(escapeAss('a\nDialogue: 0,0:00:00.00,9:00:00.00,Default,,0,0,0,,fake')).not.toContain('\n');
    const ass = buildAss([{ startSec: 0, endSec: 1, text: '{\\an8\\fs200}oben\\Ngroß' }]);
    expect(ass.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(1);
    expect(ass).not.toContain('\\an8');
    expect(buildAss([], { font: 'Evil,Font\nX' })).toContain('Style: Default,EvilFontX,');
  });

  it('burns subtitles through the subtitles filter and refuses unsafe paths', () => {
    const clip = [{ path: '/d/a.mp4', hasAudio: true, inSec: 0, outSec: 1 }];
    const args = buildRender(clip, '/w/out.mp4', { preset: 'off', measured: null }, '/w/job/subs.ass');
    expect(args[args.indexOf('-filter_complex') + 1]).toContain("[vcat]subtitles=filename='/w/job/subs.ass'[vsub];");
    expect(args[args.indexOf('[vsub]') - 1]).toBe('-map');
    expect(() => buildRender(clip, '/w/out.mp4', { preset: 'off', measured: null }, "/w/it's.ass")).toThrow();
    expect(() => buildRender(clip, '/w/out.mp4', { preset: 'off', measured: null }, '/w/a:b.ass')).toThrow();
  });
});
