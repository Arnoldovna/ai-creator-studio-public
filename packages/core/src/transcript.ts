/**
 * Release 3, Etappe 5: transcripts of the user's footage, deterministic take matching and ASS subtitles.
 * Transcript text is UNTRUSTED data (spoken words, possibly from other people in the shot): it is only
 * compared, displayed and escaped, never executed or used as an instruction.
 */
import { z } from 'zod';
import { ValidationError } from './schemas';
import type { Timeline } from './timeline';
import { bigWordSize, karaokeSteps, type CueWord } from './textAnim';

export const TranscriptWord = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  text: z.string().max(200),
  /**
   * whisper.cpp DTW time of the word's first token (`-dtw`, Etappe 8): a point inside the spoken word,
   * much closer to the audio than the token start/end. Absent on older transcripts and without DTW.
   */
  atSec: z.number().min(0).optional(),
});
export const TranscriptSegment = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  text: z.string().max(2000),
  /** Word timings from the recognizer; dropped when the user edits the segment text. */
  words: z.array(TranscriptWord).max(500).default([]),
});
export const TranscriptBody = z.object({
  language: z.string().max(10),
  segments: z.array(TranscriptSegment).max(5000),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;
export type TranscriptBody = z.infer<typeof TranscriptBody>;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Fixed initial prompt for whisper.cpp (Etappe 8): normal German casing and punctuation WITH hesitations,
 * so the recognizer writes „Ähm“/„äh“/„hm“ instead of dropping them, and capitalises and punctuates.
 * It is our constant, never user input. Switched off with WHISPER_FILLER_PROMPT=0.
 */
export const FILLER_PROMPT = 'Ähm, also, ich hab heute, äh, was ausprobiert. Hm, ja.';

const letters = (s: string) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}]/gu, '');
/** Strong hesitation sounds (ähm, äh, öhm, hm, mhm, ehm …). „im“, „er“ and „eh“ are words, never fillers. */
export const isStrongFiller = (word: string) => /^(?:ä+h*m*|ä+hem|ö+h+m*|e+h*m+|h+m+|m+h+m+)$/u.test(letters(word));
/**
 * Weak fillers: real words that are fillers only when they stand alone (between commas or pauses). They belong to her way
 * of speaking („also“, „ja“, „genau“, „sozusagen“): only ever suggested with low confidence, never cut automatically
 * (pacing and „Alle sicheren annehmen“ take safe suggestions only); she accepts each one herself. „genau“ since Etappe 13.
 */
export const WEAK_FILLERS: ReadonlySet<string> = new Set(['also', 'ja', 'genau', 'halt', 'sozusagen', 'quasi', 'naja']);
export const isWeakFiller = (word: string) => WEAK_FILLERS.has(letters(word));

const echoText = (s: string) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const PROMPT_ECHO = ` ${echoText(FILLER_PROMPT)} `;
/**
 * A text that only repeats a run of the whisper prompt: with a prompt, whisper can write the prompt itself
 * into near-silent audio. Only runs of at least 3 whole prompt words that contain a hesitation („heute, äh,
 * was“), or of at least 5 prompt words, count: „Also, ich hab heute …“ or „Was ausprobiert.“ are things
 * she can really say. Callers apply it only to whisper output made WITH the prompt (`subtitleTranscript`).
 */
export const isPromptEcho = (text: string) => {
  const t = echoText(text);
  const words = t.split(' ').filter(Boolean);
  return words.length >= 3 && (words.length >= 5 || words.some((w) => isStrongFiller(w))) && PROMPT_ECHO.includes(` ${t} `);
};

const SENTENCE_END = /[.!?…]$/;
const upperFirst = (s: string) => s.replace(/^(\P{L}*)(\p{L})/u, (_, pre: string, c: string) => pre + c.toUpperCase());
/**
 * Drops strong fillers from a token list (words of a segment, or its text split at spaces) and repairs the
 * text around them: a filler's sentence end moves to the previous kept token („dazu, hm.“ → „dazu.“), and a
 * sentence that started with a filler starts with a capital again („Ähm, heute“ → „Heute“).
 */
export function dropFillers<T>(items: readonly T[], text: (x: T) => string, withText: (x: T, t: string) => T): T[] {
  const out: T[] = [];
  let capital = false;
  items.forEach((it, i) => {
    const p = text(it);
    if (isStrongFiller(p)) {
      const prev = out[out.length - 1];
      if (SENTENCE_END.test(p) && prev !== undefined && !SENTENCE_END.test(text(prev))) out[out.length - 1] = withText(prev, text(prev).replace(/[,;:]$/, '') + p.slice(-1));
      if (i === 0 || SENTENCE_END.test(out.length ? text(out[out.length - 1]!) : '')) capital = true;
      return;
    }
    out.push(capital ? withText(it, upperFirst(p)) : it);
    capital = false;
  });
  return out;
}

/** Removes strong fillers from a text (subtitles); a sentence that started with one starts with a capital again. */
export const stripFillers = (text: string): string => dropFillers(text.split(/\s+/).filter(Boolean), (p) => p, (_, t) => t).join(' ');

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const ms = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x / 1000 : null);
/** whisper.cpp special tokens: [_BEG_], [_TT_123], [_SOT_] … */
const SPECIAL = /^\s*\[_[A-Z0-9_]+\]\s*$/;
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();

/** A string whose chars are raw bytes (file read as latin1) → UTF-8 text. */
const utf8 = (s: string) => new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff));

/**
 * Parses whisper.cpp `-ojf` (full JSON): segments with offsets in ms and sub-word tokens.
 * Tokens that start with a space begin a new word; special tokens are dropped. Throws on non-JSON.
 * whisper writes each token's raw bytes, so a multibyte character (ä, ß, emoji) can be split across two
 * tokens: pass the file read as latin1 with `{ bytes: true }` and words are decoded only after joining.
 * Words that still contain U+FFFD lose their timings (the segment text is spread evenly instead).
 */
export function parseWhisperJson(json: string, opts: { bytes?: boolean } = {}): TranscriptBody {
  const dec = opts.bytes ? utf8 : (s: string) => s;
  const root = obj(JSON.parse(json));
  const items = Array.isArray(root.transcription) ? root.transcription.map(obj) : [];
  const segments: TranscriptSegment[] = [];
  for (const it of items) {
    const off = obj(it.offsets);
    const start = ms(off.from), end = ms(off.to);
    const text = clean(dec(typeof it.text === 'string' ? it.text : ''));
    if (start == null || end == null || end < start || !text) continue;
    const words: TranscriptWord[] = [];
    for (const t of Array.isArray(it.tokens) ? it.tokens.map(obj) : []) {
      const raw = typeof t.text === 'string' ? t.text : '';
      if (!raw || SPECIAL.test(raw)) continue;
      const o = obj(t.offsets);
      const ts = ms(o.from), te = ms(o.to);
      if (ts == null || te == null) continue;
      // DTW token time (`-dtw`) in centiseconds; -1 when DTW did not run
      const dtw = typeof t.t_dtw === 'number' && Number.isFinite(t.t_dtw) && t.t_dtw >= 0 ? r3(t.t_dtw / 100) : null;
      const last = words[words.length - 1];
      if (last && !/^\s/.test(raw)) Object.assign(last, { text: last.text + raw, endSec: r3(Math.max(last.endSec, te)) });
      else words.push({ startSec: r3(ts), endSec: r3(Math.max(ts, te)), text: raw, ...(dtw != null ? { atSec: dtw } : {}) });
    }
    const ws = words.map((w) => ({ ...w, text: clean(dec(w.text)) })).filter((w) => w.text);
    const broken = ws.some((w) => w.text.includes('\uFFFD'));
    segments.push({ startSec: r3(start), endSec: r3(end), text: text.slice(0, 2000), words: broken ? [] : ws.slice(0, 500) });
  }
  return { language: typeof obj(root.result).language === 'string' ? String(obj(root.result).language).slice(0, 10) : 'de', segments };
}

/** Deterministic stand-in (mock mode): clearly labelled, timed evenly over the clip. */
export function mockTranscript(durationSec: number, seed: string): TranscriptBody {
  const n = Math.max(1, Math.min(6, Math.floor(durationSec / 3)));
  const step = durationSec / n;
  return {
    language: 'de',
    segments: Array.from({ length: n }, (_, i) => {
      const text = `MOCK-Transkript ${seed.slice(0, 6)} Satz ${i + 1}`;
      const s = r3(i * step), e = r3((i + 1) * step);
      const parts = text.split(' ');
      const w = (e - s) / parts.length;
      return { startSec: s, endSec: e, text, words: parts.map((p, j) => ({ startSec: r3(s + j * w), endSec: r3(s + (j + 1) * w), text: p })) };
    }),
  };
}

/** The user's correction: new texts per segment; changed segments lose their word timings. */
export function applyTranscriptEdit(body: TranscriptBody, texts: string[]): TranscriptBody {
  if (texts.length !== body.segments.length) throw new ValidationError('Anzahl der Segmente passt nicht zum Transkript.');
  return {
    ...body,
    segments: body.segments.map((s, i) => {
      const t = clean(texts[i] ?? '').slice(0, 2000);
      return t === s.text ? s : { ...s, text: t, words: [] };
    }),
  };
}

// ---------- Take matching (deterministic) ----------

/**
 * Lowercase word tokens without punctuation; umlauts kept, ß → ss. Strong fillers (ähm, äh, hm …) are
 * left out: a transcript made with the filler prompt contains them, the script dialogue does not.
 */
export const tokens = (s: string) =>
  s.toLowerCase().replace(/ß/g, 'ss').normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1 && !isStrongFiller(t));

/** Word-level timeline of a transcript (segments without word timings are spread evenly). */
function timeline(t: TranscriptBody): TranscriptWord[] {
  return t.segments.flatMap((s) => {
    if (s.words.length) return s.words;
    const parts = s.text.split(/\s+/).filter(Boolean);
    const w = (s.endSec - s.startSec) / Math.max(1, parts.length);
    return parts.map((p, j) => ({ startSec: r3(s.startSec + j * w), endSec: r3(s.startSec + (j + 1) * w), text: p }));
  });
}

/** Every word of a transcript with times, in order (segments without word timings spread evenly), for the editor's transcript panel. */
export const transcriptWords = (t: TranscriptBody): TranscriptWord[] => timeline(t);

export interface TakeCandidate { assetId: string; inSec: number; outSec: number; score: number; text: string }

/**
 * For one scene's dialogue: the best window of spoken words in each take, scored by token overlap
 * (Dice coefficient on word multisets, 0..1). Windows are as long as the dialogue ± 50 %.
 * Pure text comparison — no model call, so nothing leaves the machine and nothing costs money.
 */
export function matchScene(dialogue: string, takes: { assetId: string; transcript: TranscriptBody; durationSec: number | null }[], opts: { padSec?: number; minScore?: number } = {}): TakeCandidate[] {
  // bounded work: the search runs in a request (≤ 120 dialogue tokens, ≤ 6000 words per take)
  const target = tokens(dialogue).slice(0, 120);
  if (!target.length) return [];
  const want = new Map<string, number>();
  for (const t of target) want.set(t, (want.get(t) ?? 0) + 1);
  const pad = opts.padSec ?? 0.15;
  const out: TakeCandidate[] = [];
  for (const take of takes) {
    const words = timeline(take.transcript).map((w) => ({ ...w, tok: tokens(w.text) })).filter((w) => w.tok.length).slice(0, 6000);
    let best: TakeCandidate | null = null;
    const minLen = Math.max(1, Math.floor(target.length * 0.5)), maxLen = Math.ceil(target.length * 1.5);
    for (let i = 0; i < words.length; i++) {
      // a window starting on a word the dialogue does not contain scores lower than the one starting after it
      if (!words[i]!.tok.some((t) => want.has(t))) continue;
      const have = new Map<string, number>();
      let n = 0, common = 0;
      for (let j = i; j < words.length && j - i < maxLen; j++) {
        for (const t of words[j]!.tok) {
          n++;
          const c = (have.get(t) ?? 0) + 1;
          have.set(t, c);
          if (c <= (want.get(t) ?? 0)) common++;
        }
        if (j - i + 1 < minLen) continue;
        const score = (2 * common) / (n + target.length);
        if (!best || score > best.score + 1e-9) {
          const end = take.durationSec ?? words[j]!.endSec + pad;
          best = {
            assetId: take.assetId, score: Math.round(score * 1000) / 1000,
            inSec: r3(Math.max(0, words[i]!.startSec - pad)), outSec: r3(Math.min(end, words[j]!.endSec + pad)),
            text: words.slice(i, j + 1).map((w) => w.text).join(' ').slice(0, 300),
          };
        }
      }
    }
    if (best && best.score >= (opts.minScore ?? 0.35)) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Spoken words of a take between in and out, for the subtitle of that clip. */
export function wordsBetween(t: TranscriptBody, inSec: number, outSec: number): TranscriptWord[] {
  return timeline(t).filter((w) => w.endSec > inSec && w.startSec < outSec);
}

// ---------- ASS subtitles ----------

/** `words` (Etappe 16b, only with `withWords`): the cue's spoken words in output time, for the word-by-word modes. */
export interface SubtitleCue { startSec: number; endSec: number; text: string; words?: CueWord[] }

/**
 * Text for an ASS Dialogue line: override blocks `{…}`, backslash escapes (\N, \h …) and line breaks
 * from untrusted text are neutralised, so a transcript can never inject styling or positioning.
 */
export function escapeAss(text: string): string {
  return clean(text).replace(/\\/g, '⧵').replace(/\{/g, '(').replace(/\}/g, ')').slice(0, 300);
}

export const assTime = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

/** Splits long text into cues of at most `maxWords`, timed by the words when known. */
export function cuesFromWords(words: TranscriptWord[], offsetSec: number, clipIn: number, clipOut: number, maxWords = 6, withWords = false): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    const chunk = words.slice(i, i + maxWords);
    const s = Math.max(clipIn, chunk[0]!.startSec), e = Math.min(clipOut, chunk[chunk.length - 1]!.endSec);
    if (e - s < 0.05) continue;
    const cue: SubtitleCue = { startSec: r3(offsetSec + s - clipIn), endSec: r3(offsetSec + e - clipIn), text: chunk.map((w) => w.text).join(' ') };
    // Etappe 16b: word times in output time, inside the cue
    if (withWords) cue.words = chunk.map((w) => ({ text: w.text, startSec: r3(offsetSec + Math.min(e, Math.max(s, w.startSec)) - clipIn), endSec: r3(offsetSec + Math.min(e, Math.max(s, w.endSec)) - clipIn) }));
    cues.push(cue);
  }
  return cues;
}

/**
 * The transcript as subtitles show it: strong fillers (ähm, äh, hm …) are left out even when they are not
 * cut, with the sentence's capital and full stop repaired in the text AND in the timed words (the cues are
 * built from the words). Prompt echoes are dropped only from whisper output made with the filler prompt
 * (`fillerPrompt`) whose words are still the recognizer's: a segment the user corrected (no word timings)
 * or a transcript made without the prompt cannot contain an echo, and its text is shown as it is.
 */
export function subtitleTranscript(t: TranscriptBody, opts: { fillerPrompt?: boolean } = {}): TranscriptBody {
  return {
    ...t,
    segments: t.segments.flatMap((s) => {
      if (opts.fillerPrompt && s.words.length && isPromptEcho(s.text)) return [];
      const text = stripFillers(s.text);
      const words = dropFillers(s.words, (w) => w.text, (w, x) => ({ ...w, text: x }));
      // a segment of fillers only („Hm.“) is gone, also when it had word timings
      if (!text || (s.words.length && !words.length)) return [];
      return [{ ...s, text, words }];
    }),
  };
}

/**
 * Subtitle cues on the output timeline of an EDL (the same timeline the render uses), one item per clip:
 * a clip's own subtitle text spans the clip's whole output span; otherwise the take's (user-corrected)
 * transcript is used, without fillers and prompt echoes (`subtitleTranscript`; `fillerPrompt` = the transcript
 * version was made with the whisper filler prompt).
 * - A clip without cuts gives exactly the cues it gave before cuts existed.
 * - A clip with cuts: every word is kept or dropped by whether its middle lies inside a cut, and words after
 *   a cut move up by the cut length. A segment WITHOUT word timings (the user edited its text) has its words
 *   spread evenly over the segment, as in a clip without cuts, so text inside a cut is never shown and the
 *   cues keep the normal length. Near a cut edge such an estimated word can fall on the wrong side.
 */
export function cuesForTimeline(tl: Timeline, items: readonly { subtitle: string; inSec: number; outSec: number; transcript: TranscriptBody | null; fillerPrompt?: boolean }[], opts: { maxWords?: number; withWords?: boolean } = {}): SubtitleCue[] {
  // Etappe 17: `maxWords: 1` gives one cue per spoken word (word-by-word SRT, QA „fehlende Wörter“); default 6 as before
  const maxWords = opts.maxWords ?? 6;
  // Etappe 16b: `withWords` adds each cue's word times (word-by-word subtitles); without it the cues are as before
  const withWords = opts.withWords ?? false;
  const cues: SubtitleCue[] = [];
  items.forEach((item, ci) => {
    const span = tl.clips[ci];
    if (!span || !span.segments.length) return;
    if (item.subtitle.trim()) {
      cues.push({ startSec: span.outStart, endSec: span.outEnd, text: item.subtitle });
      return;
    }
    if (!item.transcript) return;
    const c = { ...item, transcript: subtitleTranscript(item.transcript, { fillerPrompt: item.fillerPrompt }) };
    const segs = span.segments.map((k) => tl.segments[k]!);
    const hasCuts = segs.length > 1 || segs.some((s) => s.fadeIn || s.fadeOut);
    if (!hasCuts) {
      const s = segs[0]!;
      cues.push(...cuesFromWords(wordsBetween(c.transcript, s.srcIn, s.srcOut), s.outStart, s.srcIn, s.srcOut, maxWords, withWords));
      return;
    }
    const mid = (w: TranscriptWord) => (w.startSec + w.endSec) / 2;
    const own: SubtitleCue[] = [];
    for (const s of segs) {
      const words = wordsBetween(c.transcript, s.srcIn, s.srcOut).filter((w) => (!s.fadeIn || mid(w) >= s.srcIn) && (!s.fadeOut || mid(w) < s.srcOut));
      own.push(...cuesFromWords(words, s.outStart, s.srcIn, s.srcOut, maxWords, withWords));
    }
    cues.push(...own.sort((a, b) => a.startSec - b.startSec));
  });
  return cues;
}

/** Subtitle style from a design-system look (`subtitleStyleOf` in overlays.ts); colours already in ASS form. */
export interface SubtitleStyle { font: string; fontSize: number; bold: boolean; primary: string; outline: string; textCase: 'none' | 'upper' | 'lower'; /** Etappe 16b: an italic face she chose (absent = upright, as before). */ italic?: boolean }
const ASS_COLOUR = /^&H[0-9A-F]{8}$/;

/** The AI label's layer: above subtitles (0), shapes (1), overlay text (2) and the hook (3). */
export const LABEL_LAYER = 9;
/** The AI label always uses this font, whatever the look of the plan says. */
export const LABEL_FONT = 'Arial';

/**
 * ASS file for 1080x1920: one bottom-centred subtitle style, large readable type with outline, safe margins
 * for the Instagram UI. `overlays` (hook, lower thirds, keywords, shapes from core `overlayAss`) are written
 * between the subtitles and the labels; every overlay line must sit on a layer below `LABEL_LAYER`, and the
 * AI label lines are always written last, on `LABEL_LAYER` with their own fixed font.
 */
/**
 * Etappe 16b: word-by-word subtitles. `karaoke`: the line of 1–4 words stays, the spoken word is drawn in `highlight`
 * (her accent) from its start to the next word's start; `word`: one word at a time, bigger. Cues need `words` (cues
 * without word times, e.g. her own clip text, stay plain lines).
 */
export interface SubtitleAnimation { mode: 'karaoke' | 'word'; highlight: string }

export function buildAss(cues: SubtitleCue[], opts: { font?: string; fontSize?: number; labels?: SubtitleCue[]; overlays?: { styles: string[]; events: string[] }; subtitle?: SubtitleStyle; marginV?: number; animation?: SubtitleAnimation } = {}): string {
  const sub = opts.subtitle;
  if (sub && (!ASS_COLOUR.test(sub.primary) || !ASS_COLOUR.test(sub.outline))) throw new ValidationError('Untertitel-Farbe ungültig.');
  const font = ((sub?.font ?? opts.font) ?? 'Arial').replace(/[^\w -]/g, '').slice(0, 63) || 'Arial';
  const size = Math.max(30, Math.min(120, Math.round(sub?.fontSize ?? opts.fontSize ?? 64)));
  const textCase = sub?.textCase ?? 'none';
  // Etappe 13: the subtitle height of the plan (`subtitleMarginV`); absent = the fixed 380 px of every older plan
  const marginV = Math.max(100, Math.min(960, Math.round(opts.marginV ?? 380)));
  const extra = opts.overlays ?? { styles: [], events: [] };
  for (const e of extra.events) {
    const layer = /^Dialogue: (\d+),/.exec(e);
    if (!layer || Number(layer[1]) >= LABEL_LAYER || /[\r\n]/.test(e)) throw new ValidationError('Overlay-Zeile ungültig oder nicht unter dem KI-Label.');
  }
  if (extra.styles.some((x) => !/^Style: (?!Default,|Label,)\w+,/.test(x) || /[\r\n]/.test(x))) throw new ValidationError('Overlay-Stil ungültig.');
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // white text, dark outline; bottom centre, 380 px above the bottom edge by default (Etappe 13: `marginV`)
    `Style: Default,${font},${size},${sub?.primary ?? '&H00FFFFFF'},&H000000FF,${sub?.outline ?? '&H00101010'},&H64000000,${sub && !sub.bold ? '0' : '-1'},${sub?.italic ? '-1' : '0'},0,0,100,100,0,0,1,4,0,2,90,90,${marginV},1`,
    // AI disclosure: boxed (BorderStyle 3), top left below the Instagram header, on its own layer above everything else
    `Style: Label,${LABEL_FONT},44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,7,60,60,170,1`,
    ...extra.styles,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const cased = (t: string) => (textCase === 'upper' ? t.toLocaleUpperCase('de-DE') : textCase === 'lower' ? t.toLocaleLowerCase('de-DE') : t);
  const anim = opts.animation;
  if (anim && !/^#[0-9A-Fa-f]{6}$/.test(anim.highlight)) throw new ValidationError('Hervorhebungsfarbe ungültig.');
  const hl = anim ? `&H${anim.highlight.slice(5, 7)}${anim.highlight.slice(3, 5)}${anim.highlight.slice(1, 3)}&`.toUpperCase() : '';
  const line = (s: number, e: number, text: string) => `Dialogue: 0,${assTime(s)},${assTime(e)},Default,,0,0,0,,${text}`;
  const lines = cues
    .filter((c) => c.endSec > c.startSec && c.text.trim())
    .flatMap((c) => {
      if (!anim || !c.words?.length) return [line(c.startSec, c.endSec, escapeAss(cased(c.text)))];
      const words = c.words.map((w) => escapeAss(cased(w.text)));
      if (anim.mode === 'word') return [line(c.startSec, c.endSec, `{\\fs${bigWordSize(words.join(' '), size)}}${words.join(' ')}`)];
      // the spoken word in the accent; `\r` returns to the style colour for the rest of the line
      return karaokeSteps({ ...c, words: c.words }).map((st) => line(st.startSec, st.endSec, words.map((w, i) => (i === st.active ? `{\\1c${hl}}${w}{\\r}` : w)).join(' ')));
    });
  const labels = (opts.labels ?? [])
    .filter((c) => c.endSec > c.startSec && c.text.trim())
    .map((c) => `Dialogue: ${LABEL_LAYER},${assTime(c.startSec)},${assTime(c.endSec)},Label,,0,0,0,,${escapeAss(c.text)}`);
  return `${[...head, ...lines, ...extra.events, ...labels].join('\n')}\n`;
}
