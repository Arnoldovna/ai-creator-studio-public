/**
 * Etappe 16b: the few text animations (fade, pop) and the subtitle modes (word-by-word highlight, one big word).
 * ONE time description (`AnimSpec`) per element: the ASS writer turns it into `\fad`/`\t` tags, the editor stage computes
 * opacity and scale at the playhead from the same numbers (`animStateAt`), so stage, still frame, exact preview and
 * render agree. Linear like libass (`\fad` and `\t` without acceleration). The AI label is never animated.
 */
import { z } from 'zod';

export const TEXT_ANIMS = ['none', 'fade', 'pop'] as const;
export const TextAnim = z.enum(TEXT_ANIMS);
export type TextAnim = z.infer<typeof TextAnim>;
export const TEXT_ANIM_LABELS: Record<TextAnim, string> = { none: 'keine', fade: 'Einblenden', pop: 'Pop-in' };

export const SUBTITLE_MODES = ['lines', 'karaoke', 'word'] as const;
export const SubtitleMode = z.enum(SUBTITLE_MODES);
export type SubtitleMode = z.infer<typeof SubtitleMode>;
export const SUBTITLE_MODE_LABELS: Record<SubtitleMode, string> = { lines: 'Zeilen', karaoke: 'Wort für Wort (Hervorhebung)', word: 'Ein Wort groß' };
/** Words per line of the word-by-word mode (1–4). */
export const WordsPerLine = z.number().int().min(1).max(4);
export const DEFAULT_WORDS_PER_LINE = 3;

/** Opacity and scale over the element's life, in ms from its start; the fade out ends at the element's end. */
export interface AnimSpec { fadeInMs: number; fadeOutMs: number; scale: { ms: number; s: number }[] }
const NONE: AnimSpec = { fadeInMs: 0, fadeOutMs: 0, scale: [] };

/** Pop: 80 % → 105 % → 100 % with a short fade (Etappe 16b). */
export const POP_SCALE = [{ ms: 0, s: 0.8 }, { ms: 120, s: 1.05 }, { ms: 220, s: 1 }] as const;

export type AnimKind = 'hook' | 'lower_third' | 'keyword' | 'shape';
/**
 * The animation of one element. `anim` = chosen for the element or as its role's default; absent = the overlay style's
 * Etappe-8 behaviour (`presetAnimation` `fade`: fades, the keyword also its pop 80 → 100 %; `none`: static), so plans
 * without the new fields keep their bytes.
 */
export function animSpec(kind: AnimKind, anim: TextAnim | undefined, presetAnimation: 'fade' | 'none'): AnimSpec {
  const fade = kind === 'hook' ? { fadeInMs: 120, fadeOutMs: 200 } : { fadeInMs: 150, fadeOutMs: 150 };
  if (anim === undefined) {
    if (presetAnimation !== 'fade') return NONE;
    return { ...fade, scale: kind === 'keyword' ? [{ ms: 0, s: 0.8 }, { ms: 150, s: 1 }] : [] };
  }
  if (anim === 'none') return NONE;
  if (anim === 'fade') return { ...fade, scale: [] };
  // pop: shapes (lower-third boxes, arrows, frames) only fade with it; text and boxed hook/keyword scale
  return { fadeInMs: 100, fadeOutMs: 150, scale: kind === 'shape' ? [] : POP_SCALE.map((x) => ({ ...x })) };
}

const pct = (s: number) => String(Math.round(s * 100));
/** ASS override tags of a spec (inside `{…}`): `\fad(in,out)` and the scale keyframes as `\fscx…\fscy…\t(…)`. */
export function animAssTags(a: AnimSpec): string {
  let out = a.fadeInMs || a.fadeOutMs ? `\\fad(${a.fadeInMs},${a.fadeOutMs})` : '';
  if (a.scale.length) {
    out += `\\fscx${pct(a.scale[0]!.s)}\\fscy${pct(a.scale[0]!.s)}`;
    for (let i = 1; i < a.scale.length; i++) out += `\\t(${a.scale[i - 1]!.ms},${a.scale[i]!.ms},\\fscx${pct(a.scale[i]!.s)}\\fscy${pct(a.scale[i]!.s)})`;
  }
  return out;
}

/**
 * Opacity (0..1) and scale of a spec `tMs` after the element's start, for an element of `durMs`: what libass draws at
 * that moment (linear fades, linear `\t`, the last keyframe held). Outside the element: opacity 0.
 */
export function animStateAt(a: AnimSpec, tMs: number, durMs: number): { opacity: number; scale: number } {
  if (tMs < 0 || tMs >= durMs) return { opacity: 0, scale: a.scale[0]?.s ?? 1 };
  let opacity = 1;
  if (a.fadeInMs > 0 && tMs < a.fadeInMs) opacity = tMs / a.fadeInMs;
  if (a.fadeOutMs > 0 && tMs > durMs - a.fadeOutMs) opacity = Math.min(opacity, (durMs - tMs) / a.fadeOutMs);
  let scale = 1;
  if (a.scale.length) {
    scale = a.scale[a.scale.length - 1]!.s;
    if (tMs <= a.scale[0]!.ms) scale = a.scale[0]!.s;
    else for (let i = 1; i < a.scale.length; i++) {
      const p = a.scale[i - 1]!, q = a.scale[i]!;
      if (tMs < q.ms) { scale = p.s + ((q.s - p.s) * (tMs - p.ms)) / Math.max(1, q.ms - p.ms); break; }
    }
  }
  return { opacity: Math.max(0, Math.min(1, opacity)), scale };
}

/** One word of a word-timed cue, in output time. */
export interface CueWord { startSec: number; endSec: number; text: string }
/**
 * The highlight steps of a word-by-word cue: the line stays the same, word i is coloured from its start until the next
 * word starts (the last until the cue ends), so the line never blinks between words. Before the first word: none.
 */
export function karaokeSteps(cue: { startSec: number; endSec: number; words: readonly CueWord[] }): { startSec: number; endSec: number; active: number }[] {
  const out: { startSec: number; endSec: number; active: number }[] = [];
  const w = cue.words;
  for (let i = 0; i < w.length; i++) {
    const s = i === 0 ? cue.startSec : Math.max(cue.startSec, w[i]!.startSec);
    const e = i + 1 < w.length ? Math.min(cue.endSec, Math.max(s, w[i + 1]!.startSec)) : cue.endSec;
    if (e - s >= 0.01) out.push({ startSec: Math.round(s * 1000) / 1000, endSec: Math.round(e * 1000) / 1000, active: i });
  }
  return out;
}

/** Index of the highlighted word at output time t (null outside the cue). */
export function activeWordAt(cue: { startSec: number; endSec: number; words?: readonly CueWord[] }, t: number): number | null {
  if (!cue.words?.length) return null;
  return karaokeSteps({ ...cue, words: cue.words }).find((s) => t >= s.startSec && t < s.endSec)?.active ?? null;
}

/** Size of the „one big word“ mode: 1.5 × the subtitle size, smaller for long words so one word fits in 900 px (≈ 0.62 em per character, like the overlay estimate). */
export function bigWordSize(word: string, subtitleSize: number): number {
  const want = Math.round(subtitleSize * 1.5);
  const fit = Math.floor(900 / (0.62 * Math.max(1, [...word].length)));
  return Math.max(30, Math.min(120, want, fit));
}
