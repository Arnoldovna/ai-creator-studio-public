import { describe, expect, it } from 'vitest';
import { EditPlanBody } from '../src/edit';
import { overlayAss, styleTokens, subtitleAnimationOf, timedElements, type LookTokens } from '../src/overlays';
import { activeWordAt, animAssTags, animSpec, animStateAt, bigWordSize, karaokeSteps } from '../src/textAnim';
import { buildTimeline } from '../src/timeline';
import { buildTimelineView } from '../src/timelineView';
import { buildAss, cuesForTimeline, LABEL_LAYER, type TranscriptBody } from '../src/transcript';
import { DesignSystem, defaultPreset, defaultTypography } from '../src/designSystem';

/** Etappe 16b: fade, pop, word-by-word and one-big-word – ASS snapshots, the stage's time description, legacy bytes. */
const colors = Object.fromEntries(['primary', 'accent', 'surface', 'onSurface', 'onAccent', 'onVideo', 'background'].map((r) => [r, { hex: r === 'accent' ? '#E03A1E' : r.startsWith('on') ? '#FFFFFF' : '#203040' }]));
const version = (typography = defaultTypography()) => ({ id: 'v1', version: 1, approvedAt: '2026-11-19T00:00:00Z', rules: { design: DesignSystem.parse({ colors, typography, presets: [defaultPreset()], defaultPresetId: 'marke' }) } });
const look = (opts: Parameters<typeof styleTokens>[2] = {}, typography?: ReturnType<typeof defaultTypography>): LookTokens => styleTokens(version(typography), 'Avenir Next', { fontSource: 'design', ...opts });
const tl = buildTimeline([{ inSec: 0, outSec: 4, cuts: [] }]);
const body = (over: object) => ({ clips: [{ overlays: [{ kind: 'keyword' as const, startSec: 0.5, endSec: 2, text: 'Wolle', slot: 'center' as const, direction: 'down' as const, ...over }] }], hook: null });
const events = (b: ReturnType<typeof body>, l = look()) => overlayAss(timedElements(b, tl, undefined), l).events;

describe('fade and pop', () => {
  it('Etappe-8 behaviour without the new fields (keyword fade + pop 80 → 100 %, hook fade 120/200)', () => {
    expect(animAssTags(animSpec('keyword', undefined, 'fade'))).toBe('\\fad(150,150)\\fscx80\\fscy80\\t(0,150,\\fscx100\\fscy100)');
    expect(animAssTags(animSpec('hook', undefined, 'fade'))).toBe('\\fad(120,200)');
    expect(animAssTags(animSpec('lower_third', undefined, 'none'))).toBe('');
  });

  it('ASS snapshot: fade, pop and none on a keyword; pop on a lower third pops the text, its boxes only fade', () => {
    expect(events(body({ anim: 'fade' }))).toEqual(['Dialogue: 2,0:00:00.50,0:00:02.00,Keyword,,0,0,0,,{\\an5\\pos(540,766)\\fs84\\q2\\fad(150,150)}Wolle']);
    expect(events(body({ anim: 'pop' }))).toEqual(['Dialogue: 2,0:00:00.50,0:00:02.00,Keyword,,0,0,0,,{\\an5\\pos(540,766)\\fs84\\q2\\fad(100,150)\\fscx80\\fscy80\\t(0,120,\\fscx105\\fscy105)\\t(120,220,\\fscx100\\fscy100)}Wolle']);
    expect(events(body({ anim: 'none' }))).toEqual(['Dialogue: 2,0:00:00.50,0:00:02.00,Keyword,,0,0,0,,{\\an5\\pos(540,766)\\fs84\\q2}Wolle']);
    const lt = events(body({ kind: 'lower_third', text: 'Carola · Wolle', anim: 'pop' }));
    expect(lt.filter((e) => e.includes('\\p1')).every((e) => e.includes('\\fad(100,150)') && !e.includes('\\fscx'))).toBe(true);
    expect(lt.find((e) => e.includes('LowerThird'))).toContain('\\q2\\fad(100,150)\\fscx80\\fscy80\\t(0,120,\\fscx105\\fscy105)\\t(120,220,\\fscx100\\fscy100)}');
  });

  it('role default from Meine Marke; the element wins; hook pop', () => {
    const t = defaultTypography();
    const l = look({}, { ...t, keyword: { ...t.keyword, animation: 'pop' }, hook: { ...t.hook, animation: 'pop' } });
    expect(events(body({}), l)[0]).toContain('\\fad(100,150)\\fscx80');
    expect(events(body({ anim: 'none' }), l)[0]).toContain('\\q2}Wolle');
    const hook = overlayAss(timedElements({ clips: [{}], hook: { source: 'free', variantIndex: null, text: 'Hallo', endSec: 2, slot: 'upper', claimsReviewed: false } }, tl), l).events;
    expect(hook[0]).toMatch(/\\q2\\fad\(100,150\)\\fscx80\\fscy80\\t\(0,120,\\fscx105\\fscy105\)\\t\(120,220,\\fscx100\\fscy100\)\}Hallo$/);
  });

  it('stage parity: opacity and scale at t follow the same numbers the ASS carries (linear like libass)', () => {
    const pop = animSpec('keyword', 'pop', 'fade');
    expect(animStateAt(pop, 0, 1500)).toEqual({ opacity: 0, scale: 0.8 });
    expect(animStateAt(pop, 50, 1500)).toMatchObject({ opacity: 0.5 });
    expect(animStateAt(pop, 60, 1500).scale).toBeCloseTo(0.925, 5);
    expect(animStateAt(pop, 120, 1500)).toEqual({ opacity: 1, scale: 1.05 });
    expect(animStateAt(pop, 170, 1500).scale).toBeCloseTo(1.025, 5);
    expect(animStateAt(pop, 300, 1500)).toEqual({ opacity: 1, scale: 1 });
    expect(animStateAt(pop, 1425, 1500).opacity).toBeCloseTo(0.5, 5);
    expect(animStateAt(pop, 1500, 1500).opacity).toBe(0);
    // the tags are generated from exactly these keyframes
    const tags = animAssTags(pop);
    for (const k of pop.scale.slice(1)) expect(tags).toContain(`,${k.ms},\\fscx${Math.round(k.s * 100)}`);
  });

  it('the AI label stays static and on top, whatever the elements animate', () => {
    const ass = buildAss([], { labels: [{ startSec: 0, endSec: 4, text: 'KI-generiert' }], overlays: overlayAss(timedElements(body({ anim: 'pop' }), tl), look()) });
    const label = ass.split('\n').filter((l) => l.startsWith(`Dialogue: ${LABEL_LAYER},`));
    expect(label).toEqual(['Dialogue: 9,0:00:00.00,0:00:04.00,Label,,0,0,0,,KI-generiert']);
    expect(ass.trim().split('\n').pop()).toBe(label[0]);
  });
});

describe('element fonts (inspector)', () => {
  it('an element with its own font gets \\fn/\\b tags; plans without it keep their bytes and lookKey', () => {
    const font = { ref: 'mac:Rockwell-Bold', face: { family: 'Rockwell', style: 'Bold', weight: 700, italic: false } };
    const b = body({ font });
    const plain = look();
    const l = look({ elementFonts: [font] });
    expect(Object.keys(plain)).not.toContain('elementFonts');
    expect(events(b, l)[0]).toContain('\\q2\\fnRockwell-Bold\\b1\\fad(150,150)');
    // the same plan without the font: byte-identical to before
    expect(events(body({}), plain)[0]).toBe('Dialogue: 2,0:00:00.50,0:00:02.00,Keyword,,0,0,0,,{\\an5\\pos(540,766)\\fs84\\q2\\fad(150,150)\\fscx80\\fscy80\\t(0,150,\\fscx100\\fscy100)}Wolle');
  });
});

const transcript: TranscriptBody = {
  language: 'de',
  segments: [{ startSec: 0, endSec: 3, text: 'Heute stricke ich Socken mit dir', words: [
    { startSec: 0.2, endSec: 0.6, text: 'Heute' }, { startSec: 0.7, endSec: 1.2, text: 'stricke' }, { startSec: 1.3, endSec: 1.5, text: 'ich' },
    { startSec: 1.6, endSec: 2.1, text: 'Socken' }, { startSec: 2.2, endSec: 2.5, text: 'mit' }, { startSec: 2.6, endSec: 2.9, text: 'dir' },
  ] }],
};
const items = [{ subtitle: '', inSec: 0, outSec: 3, transcript }];
const tl3 = buildTimeline([{ inSec: 0, outSec: 3, cuts: [] }]);

describe('word-by-word subtitles', () => {
  it('cues keep their text without words; with words they carry output times', () => {
    const plain = cuesForTimeline(tl3, items);
    expect(plain).toEqual([{ startSec: 0.2, endSec: 2.9, text: 'Heute stricke ich Socken mit dir' }]);
    const three = cuesForTimeline(tl3, items, { maxWords: 3, withWords: true });
    expect(three.map((c) => c.text)).toEqual(['Heute stricke ich', 'Socken mit dir']);
    expect(three[0]!.words!.map((w) => w.startSec)).toEqual([0.2, 0.7, 1.3]);
  });

  it('ASS snapshot karaoke: the spoken word in the accent, the line stays between words', () => {
    const cues = cuesForTimeline(tl3, items, { maxWords: 3, withWords: true });
    expect(karaokeSteps({ ...cues[0]!, words: cues[0]!.words! })).toEqual([{ startSec: 0.2, endSec: 0.7, active: 0 }, { startSec: 0.7, endSec: 1.3, active: 1 }, { startSec: 1.3, endSec: 1.5, active: 2 }]);
    const ass = buildAss(cues, { animation: { mode: 'karaoke', highlight: '#E03A1E' } });
    expect(ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'))).toEqual([
      'Dialogue: 0,0:00:00.20,0:00:00.70,Default,,0,0,0,,{\\1c&H1E3AE0&}Heute{\\r} stricke ich',
      'Dialogue: 0,0:00:00.70,0:00:01.30,Default,,0,0,0,,Heute {\\1c&H1E3AE0&}stricke{\\r} ich',
      'Dialogue: 0,0:00:01.30,0:00:01.50,Default,,0,0,0,,Heute stricke {\\1c&H1E3AE0&}ich{\\r}',
      'Dialogue: 0,0:00:01.60,0:00:02.20,Default,,0,0,0,,{\\1c&H1E3AE0&}Socken{\\r} mit dir',
      'Dialogue: 0,0:00:02.20,0:00:02.60,Default,,0,0,0,,Socken {\\1c&H1E3AE0&}mit{\\r} dir',
      'Dialogue: 0,0:00:02.60,0:00:02.90,Default,,0,0,0,,Socken mit {\\1c&H1E3AE0&}dir{\\r}',
    ]);
    // the stage asks the same question: which word is lit at t
    expect([0.25, 0.95, 1.45, 1.55].map((t) => activeWordAt(cues[0]!, t))).toEqual([0, 1, 2, null]);
  });

  it('ASS snapshot one big word; injected tags in a word are neutralised', () => {
    const cues = cuesForTimeline(tl3, items, { maxWords: 1, withWords: true });
    const lines = buildAss(cues, { animation: { mode: 'word', highlight: '#E03A1E' } }).split('\n').filter((l) => l.startsWith('Dialogue: 0,'));
    expect(lines[0]).toBe('Dialogue: 0,0:00:00.20,0:00:00.60,Default,,0,0,0,,{\\fs96}Heute');
    expect(lines).toHaveLength(6);
    expect(bigWordSize('Selbstständigkeitserklärung', 64)).toBeLessThan(60);
    const evil = buildAss([{ startSec: 0, endSec: 1, text: 'x', words: [{ startSec: 0, endSec: 1, text: '{\\fs200}Hack' }] }], { animation: { mode: 'karaoke', highlight: '#E03A1E' } });
    expect(evil).toContain('{\\1c&H1E3AE0&}(⧵fs200)Hack{\\r}');
    expect(() => buildAss([], { animation: { mode: 'karaoke', highlight: 'red' } })).toThrow();
    // an italic face chosen for the subtitle role asks libass for italic (review finding: else a false italic warning)
    const style = { font: 'Rockwell Italic', fontSize: 64, bold: false, primary: '&H00FFFFFF', outline: '&H00101010', textCase: 'none' as const };
    expect(buildAss([], { subtitle: { ...style, italic: true } })).toContain('Style: Default,Rockwell Italic,64,&H00FFFFFF,&H000000FF,&H00101010,&H64000000,0,-1,');
    expect(buildAss([], { subtitle: style })).toContain('&H64000000,0,0,0,0,');
  });

  it('old plans: no mode → lines, byte-identical ASS; mode from the body or the subtitle role', () => {
    const oldBody = EditPlanBody.parse({ clips: [{ assetId: 'a', inSec: 0, outSec: 3 }], subtitles: 'burn' });
    expect(Object.keys(oldBody)).not.toContain('subtitleMode');
    expect(subtitleAnimationOf(oldBody, look())).toBeNull();
    const cues = cuesForTimeline(tl3, items);
    expect(buildAss(cues)).toBe(buildAss(cues, {}));
    expect(subtitleAnimationOf({ subtitleMode: 'karaoke' }, look())).toEqual({ mode: 'karaoke', wordsPerLine: 3, highlight: '#E03A1E' });
    const t = defaultTypography();
    expect(subtitleAnimationOf({}, look({}, { ...t, subtitle: { ...t.subtitle, subtitleMode: 'word' } }))).toMatchObject({ mode: 'word', wordsPerLine: 1 });
    expect(subtitleAnimationOf({ subtitleMode: 'lines' }, look({}, { ...t, subtitle: { ...t.subtitle, subtitleMode: 'word' } }))).toBeNull();
    // the editor view carries the word times only when asked
    const view = buildTimelineView({ clips: [{ assetId: 'a', inSec: 0, outSec: 3 }] }, { transcripts: new Map([['a', { body: transcript }]]), subtitleWords: 2 });
    expect(view.subtitles.map((c) => c.text)).toEqual(['Heute stricke', 'ich Socken', 'mit dir']);
    expect(buildTimelineView({ clips: [{ assetId: 'a', inSec: 0, outSec: 3 }] }, { transcripts: new Map([['a', { body: transcript }]]) }).subtitles[0]).not.toHaveProperty('words');
  });
});
