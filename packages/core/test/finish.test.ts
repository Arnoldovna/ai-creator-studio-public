import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_DISCLOSURE, buildAlphaLayer, buildFcpxml, buildTimeline, cuesForTimeline, cutPoints, EditPlanBody, finishGuide, finishTexts, FinishTexts, missingWords, overlayBox,
  parseWhisperJson, positionWords, sheetTime, srtText, srtTime, styleTokens, textsToTxt, toSrt, transcriptWords, xmlAttr, type TranscriptBody,
} from '../src';

/** Two takes: the first with a cut in the middle (words after it move up), the second plain. */
const takeA: TranscriptBody = {
  language: 'de',
  segments: [
    { startSec: 0, endSec: 2, text: 'Heute färbe ich Wolle.', words: [
      { startSec: 0.1, endSec: 0.5, text: 'Heute' }, { startSec: 0.5, endSec: 1, text: 'färbe' }, { startSec: 1, endSec: 1.3, text: 'ich' }, { startSec: 1.3, endSec: 1.9, text: 'Wolle.' },
    ] },
    { startSec: 2, endSec: 5, text: 'Ähm, mit Zwiebelschalen und Essig.', words: [
      { startSec: 2.1, endSec: 2.5, text: 'Ähm,' }, { startSec: 3, endSec: 3.3, text: 'mit' }, { startSec: 3.3, endSec: 4.2, text: 'Zwiebelschalen' }, { startSec: 4.2, endSec: 4.5, text: 'und' }, { startSec: 4.5, endSec: 4.9, text: 'Essig.' },
    ] },
  ],
};
const takeB: TranscriptBody = { language: 'de', segments: [{ startSec: 0, endSec: 1.5, text: 'Probier es aus!', words: [{ startSec: 0.1, endSec: 0.6, text: 'Probier' }, { startSec: 0.6, endSec: 0.9, text: 'es' }, { startSec: 0.9, endSec: 1.4, text: 'aus!' }] }] };
const clips = [
  { subtitle: '', inSec: 0, outSec: 5, cuts: [{ startSec: 2, endSec: 3 }], transcript: takeA },
  { subtitle: '', inSec: 0, outSec: 1.5, cuts: [], transcript: takeB },
];
const tl = buildTimeline(clips);

describe('Etappe 17: SRT from the render cues', () => {
  it('times and text: SRT format, CRLF, the cut moves the later words up, fillers are left out (snapshot)', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3723.4567)).toBe('01:02:03,457');
    const srt = toSrt(cuesForTimeline(tl, clips));
    expect(srt).toBe([
      '1', '00:00:00,100 --> 00:00:01,900', 'Heute färbe ich Wolle.', '',
      '2', '00:00:02,000 --> 00:00:03,900', 'Mit Zwiebelschalen und Essig.', '',
      '3', '00:00:04,100 --> 00:00:05,400', 'Probier es aus!', '',
    ].join('\r\n'));
    // the cut [2, 3) is 1 s long: „mit“ (source 3.0) is at output 2.0; clip 2 starts at output 4.0
    expect(tl.durationSec).toBe(5.5);
    expect(srt.includes('Ähm')).toBe(false);
  });
  it('word-by-word SRT: one cue per word, on the same output times', () => {
    const words = cuesForTimeline(tl, clips, { maxWords: 1 });
    expect(words.map((c) => c.text)).toEqual(['Heute', 'färbe', 'ich', 'Wolle.', 'Mit', 'Zwiebelschalen', 'und', 'Essig.', 'Probier', 'es', 'aus!']);
    expect(words[4]).toEqual({ startSec: 2, endSec: 2.3, text: 'Mit' });
    expect(words[8]).toEqual({ startSec: 4.1, endSec: 4.6, text: 'Probier' });
    const srt = toSrt(words);
    expect(srt.split('\r\n\r\n')).toHaveLength(11);
    // the default (6 words) is unchanged by the new option
    expect(cuesForTimeline(tl, clips)).toEqual(cuesForTimeline(tl, clips, { maxWords: 6 }));
  });
  it('untrusted text cannot break the file: line breaks, the arrow and tags are neutralised; overlaps are trimmed', () => {
    expect(srtText('a\n\n2\n00:00:00,000 --> 00:00:09,000\n<b>x</b>')).toBe('a 2 00:00:00,000 → 00:00:09,000 ‹b›x‹/b›');
    const srt = toSrt([{ startSec: 1, endSec: 3, text: 'eins' }, { startSec: 0, endSec: 0.5, text: 'null' }, { startSec: 2, endSec: 4, text: 'zwei' }, { startSec: 5, endSec: 5, text: 'leer' }, { startSec: 6, endSec: 7, text: '   ' }]);
    expect(srt).toBe('1\r\n00:00:00,000 --> 00:00:00,500\r\nnull\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\neins\r\n\r\n3\r\n00:00:02,000 --> 00:00:04,000\r\nzwei\r\n');
  });
});

const look = styleTokens(null, 'Avenir Next');
const planBody = EditPlanBody.parse({
  clips: [
    { assetId: 'a', inSec: 0, outSec: 5, cuts: [{ startSec: 2, endSec: 3 }], overlays: [
      { kind: 'keyword', text: 'Zwiebelschalen', startSec: 3.3, endSec: 4.2, slot: 'center' },
      { kind: 'lower_third', text: 'Carola · Wollwerkstatt', startSec: 0.5, endSec: 1.9, slot: 'lower' },
      { kind: 'arrow', startSec: 4.2, endSec: 5, slot: 'lower', direction: 'left', pos: { x: 0.8, y: 0.6 } },
    ], images: [{ referenceId: 'img-1', startSec: 0.5, endSec: 1.5, aspect: 1.5 }] },
    { assetId: 'b', inSec: 0, outSec: 1.5 },
  ],
  hook: { source: 'free', text: 'So färbst du Wolle mit Küchenresten', endSec: 2 },
});
const ptl = buildTimeline(planBody.clips);

describe('Etappe 17: texte.json / texte.txt', () => {
  const sheet = finishTexts(planBody, ptl, look, { disclosures: [AI_DISCLOSURE], imagesInVideo: false, image: () => ({ name: 'atelier.png', generated: true, file: 'bilder/atelier.png' }) });
  it('follows the schema: hook first, overlays on the output timeline with positions and the look', () => {
    expect(FinishTexts.safeParse(JSON.parse(JSON.stringify(sheet))).success).toBe(true);
    expect(sheet.items.map((i) => i.kind)).toEqual(['hook', 'lower_third', 'keyword', 'arrow']);
    const [hook, lt, kw, arrow] = sheet.items;
    expect(hook).toMatchObject({ text: 'So färbst du Wolle mit Küchenresten', startSec: 0, endSec: 2, start: '0:00.000', end: '0:02.000', clip: null, position: { slot: 'upper', words: 'obere Mitte mittig' } });
    expect(hook!.style).toMatchObject({ presetName: 'Style Bible', font: 'Avenir Next', bold: true, fill: look.box, textColor: look.text });
    // the keyword at source 3.3 s is at output 2.3 s (after the 1-s cut)
    expect(kw).toMatchObject({ text: 'Zwiebelschalen', startSec: 2.3, endSec: 3.2, start: '0:02.300', clip: 1, position: { slot: 'center', xPct: 50 } });
    expect(kw!.style.fill).toBe(look.accent);
    expect(lt!.position).toMatchObject({ words: 'Mitte mittig', slot: 'lower', yPct: 54.3 });
    expect(arrow).toMatchObject({ direction: 'left', text: '', position: { slot: 'frei', words: 'untere Mitte rechts' } });
    const b = overlayBox({ kind: 'keyword', text: 'Zwiebelschalen', slot: 'center' });
    expect(kw!.position.widthPct).toBeCloseTo(((b.x1 - b.x0) / 1080) * 100, 0);
    expect(sheet.images).toEqual([expect.objectContaining({ name: 'atelier.png', file: 'bilder/atelier.png', inCleanVideo: false, generated: true, start: '0:00.500' })]);
    expect(sheet.disclosures).toEqual([AI_DISCLOSURE]);
  });
  it('readable list with times, positions, style and the image note', () => {
    const txt = textsToTxt(sheet, 'Wolle v3');
    expect(txt).toContain('1. Hook: „So färbst du Wolle mit Küchenresten“');
    expect(txt).toContain('Zeit: 0:02.300 – 0:03.200');
    expect(txt).toContain('Pfeil (Clip 1): nach links');
    expect(txt).toContain('Schrift Avenir Next fett');
    expect(txt).toContain('KI-generiert: braucht das KI-Label');
    expect(txt).toContain(`Kennzeichnung: ${AI_DISCLOSURE}`);
    expect(sheetTime(65.25)).toBe('1:05.250');
    expect(positionWords({ x0: 0, y0: 0, x1: 100, y1: 100 })).toBe('oben links');
  });
});

/** A minimal XML well-formedness check: tags nest, attributes are quoted, entities are known. */
function wellFormed(xml: string): boolean {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '').replace(/<!DOCTYPE[^>]*>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null, pos = 0;
  while ((m = re.exec(body))) {
    if (m.index !== pos) return false;
    pos = re.lastIndex;
    if (m[5] != null) { if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(m[5])) return false; continue; }
    if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(m[3] ?? '')) return false;
    if (m[1]) { if (stack.pop() !== m[2]) return false; } else if (!m[4]) stack.push(m[2]!);
  }
  return pos === body.length && stack.length === 0;
}

describe('Etappe 17: FCPXML', () => {
  it('is well-formed with escaped markers, one clip of the right length, 30p rational times', () => {
    const xml = buildFcpxml({ title: 'Wolle & „Zwiebel“ <v3>', durationSec: 5.5, hasAudio: true, videoFile: 'video-clean.mp4', markers: [{ startSec: 0, text: 'Hook: "So" & <so>' }, { startSec: 2.3, text: 'Keyword: Zwiebelschalen' }] });
    expect(wellFormed(xml)).toBe(true);
    expect(xml).toContain('<fcpxml version="1.10">');
    expect(xml).toContain('duration="165/30s"');
    expect(xml).toContain('<marker start="69/30s" duration="1/30s" value="Keyword: Zwiebelschalen"/>');
    expect(xml).toContain('value="Hook: &quot;So&quot; &amp; &lt;so&gt;"');
    expect(xml).toContain('<project name="Wolle &amp; „Zwiebel“ &lt;v3&gt;">');
    expect(xml).toContain('src="video-clean.mp4"');
    expect(wellFormed(buildFcpxml({ title: 'x', durationSec: 1, hasAudio: false, videoFile: 'video-clean.mp4', markers: [] }))).toBe(true);
    expect(wellFormed('<a><b></a></b>')).toBe(false); // the checker itself rejects broken nesting
    expect(xmlAttr('a\u0001b')).toBe('ab');
  });
});

describe('Etappe 17: the guide', () => {
  const base = { title: 'Wolle v3', durationSec: 5.5, disclosures: [], generatedImagesOutside: false, imagesInVideo: true, files: { videoWithText: true, wordSrt: true, alpha: true, fcpxml: true, caption: false, images: false, subtitles: true } };
  it('keeps the AI label note when the clean video carries it, the ad note for client projects, careful about CapCut', () => {
    const g = finishGuide({ ...base, client: true, labelBurned: true, disclosures: ['Anzeige', AI_DISCLOSURE] });
    expect(g).toContain('# In CapCut fertigstellen');
    expect(g).toContain(`Das Label „${AI_DISCLOSURE}“ ist oben links eingebrannt`);
    expect(g).toContain('„Anzeige“');
    expect(g).toContain('bezahlte Partnerschaft');
    expect(g).toContain('nicht geprüft');
    expect(g).toContain('1080 × 1920, 30 fps');
    expect(g).toMatch(/je nach Version|je nach CapCut-Version|zwischen Versionen/);
    const own = finishGuide({ ...base, client: false, labelBurned: false });
    expect(own).toContain('kein KI-Label eingebrannt');
    expect(own).not.toContain('„Anzeige“');
    expect(own).toContain('Keine Kennzeichnung entfernen');
  });
});

describe('Etappe 17: QA „fehlende Wörter“', () => {
  const expected = cuesForTimeline(tl, clips, { maxWords: 1 });
  it('finds a word the fresh transcription did not hear, and marks it at a cut', () => {
    // the render clipped „Mit“ right after the cut and the recognizer wrote „Zwiebel schalen“ apart
    const heard = ['Heute', 'färbe', 'ich', 'Wolle.', 'Zwiebel', 'schalen', 'und', 'Essig.', 'Probier', 'es', 'aus!'].map((text) => ({ text }));
    const r = missingWords(expected, heard, { cuts: cutPoints(tl) });
    expect(r.expected).toBe(11);
    expect(r.findings).toEqual([{ text: 'Mit', startSec: 2, endSec: 2.3, words: 1, atCut: true }]);
  });
  it('groups a run of missing words, not at a cut; nothing missing gives no findings', () => {
    const heard = ['Heute', 'Wolle', 'mit', 'Zwiebelschalen', 'und', 'Essig', 'Probier', 'es', 'aus'].map((text) => ({ text }));
    const r = missingWords(expected, heard, { cuts: cutPoints(tl) });
    expect(r.findings).toEqual([{ text: 'färbe ich', startSec: 0.5, endSec: 1.3, words: 2, atCut: false }]);
    expect(missingWords(expected, expected, { cuts: [] }).findings).toEqual([]);
    // small inflection noise is tolerated („färben“ for „färbe“)
    expect(missingWords([{ startSec: 0, endSec: 1, text: 'färbe' }], [{ text: 'färben' }], { cuts: [] }).findings).toEqual([]);
  });
  it('works on a real whisper.cpp fixture (words joined from sub-word tokens)', () => {
    const fx = parseWhisperJson(readFileSync(path.join(import.meta.dirname, 'fixtures', 'whisper-ojf.json'), 'latin1'), { bytes: true });
    const words = transcriptWords(fx);
    expect(words.length).toBeGreaterThan(3);
    const exp = words.map((w) => ({ startSec: w.startSec, endSec: w.endSec, text: w.text }));
    const dropped = words.filter((_, i) => i !== 2);
    const r = missingWords(exp, dropped, { cuts: [0] });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.text).toBe(words[2]!.text);
  });
});

describe('Etappe 17: alpha layer arguments', () => {
  it('transparent canvas, libass with alpha=1, ProRes 4444 with alpha; refuses quoting characters in paths', () => {
    const a = buildAlphaLayer('/tmp/x/ov.ass', 5.5, '/tmp/x/a.mov');
    expect(a.join(' ')).toContain('color=c=black@0:s=1080x1920:r=30:d=5.500,format=rgba');
    expect(a).toContain("subtitles=filename='/tmp/x/ov.ass':alpha=1");
    expect(a.join(' ')).toContain('-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le');
    expect(() => buildAlphaLayer("/tmp/x'/ov.ass", 1, '/tmp/a.mov')).toThrow();
  });
});
