/**
 * KI-Dramaturgie (Etappe 16, E8): a storytelling proposal for a Freier Schnitt, built on the transcript.
 *
 * - The model sees the transcript as NUMBERED SENTENCES and answers with sentence numbers and texts only (no seconds).
 *   This module maps everything deterministically onto source times: a sentence starts and ends at word boundaries with a
 *   small pad that never reaches into the neighbouring word (`buildStorySentences`).
 * - `normalizeStory` turns the model's answer into a `StoryPlanBody`: valid beats (roles, ranges, limits), up to six hook
 *   options (a quote must really be in the transcript, otherwise it is marked „neu formuliert“; invented figures, flagged
 *   claims, denials of a label and testimonial wording are refused), overlays in her design presets, images only from her
 *   usable library images, zoom and tempo hints.
 * - `storyToDraft` applies a selection to the working draft: chosen beats in her order become clips (each beat its own
 *   clip, so it stays reorderable), the chosen hook, overlays, images and zooms are added as ordinary draft elements.
 *   Nothing is cut inside a sentence; a sentence that consists only of fillers („Also.“, „Genau.“) stays with its
 *   neighbouring beat – fillers belong to her voice and are never proposed as a cut.
 * Pure and deterministic.
 */
import { z } from 'zod';
import { burnedTextFindings, ClipOverlay, hookLayout, TEXT_LIMIT, textFromSource } from './overlays';
import { applyCase, type OverlayFit } from './designSystem';
import { EditClip, EditDraftBody, MAX_CUT_SEC, MIN_CLIP_SEC, normalizeCuts, type ZoomKind } from './edit';
import { buildTimeline, clipPieces, mapSpan } from './timeline';
import { insertImage, keepClearOfLabel, setHook, HOOK_MAX_SEC } from './timelineView';
import { isStrongFiller, isWeakFiller, transcriptWords, type TranscriptBody } from './transcript';
import { collapseWs, unique } from './text';
import { slopHints, type SlopHint } from './slopLint';
import type { Slot } from './overlayLayout';

// ---------- Roles, formulas ----------

export const BEAT_ROLES = ['hook', 'context', 'turn', 'payoff', 'cta', 'other'] as const;
export const BeatRole = z.enum(BEAT_ROLES);
export type BeatRole = z.infer<typeof BeatRole>;
export const BEAT_ROLE_LABEL: Record<BeatRole, string> = { hook: 'Hook', context: 'Kontext', turn: 'Wendung', payoff: 'Payoff', cta: 'CTA', other: 'Sonstiges' };
/** Colours of the story track (light enough for dark text). */
export const BEAT_ROLE_COLOR: Record<BeatRole, string> = { hook: '#d8fb96', context: '#9cc3e6', turn: '#f2b56b', payoff: '#e8a0c0', cta: '#c3b4f2', other: '#cfd3c8' };

/**
 * Hook formulas the model names (own German labels; the idea of a formula, never another creator's line). Formulas that
 * live on a figure are only usable with a figure she really says.
 */
export const HOOK_FORMULAS = {
  quote: 'Starker Satz aus dem Video',
  nobody_tells: 'Was dir keiner sagt',
  negative_command: 'Hör auf mit …',
  permission: 'Du brauchst kein …',
  mid_sentence: 'Mitten im Satz',
  verbatim_question: 'Echte Frage',
  if_then: 'Wenn du …',
  numbered: 'Liste mit Favorit',
  before_after: 'Vorher und nachher',
  contrarian: 'Umgedrehte Weisheit',
  reveal: 'Das ist …',
  cold_open: 'Direkt rein',
  callout: 'Ansprache einer Gruppe',
  objection: 'Echter Einwand',
  flop_record: 'Was nicht geklappt hat',
  superlative: 'Der einfachste Weg',
  other: 'Eigene Formel',
} as const;
export type HookFormula = keyof typeof HOOK_FORMULAS;
const isFormula = (f: string): f is HookFormula => Object.prototype.hasOwnProperty.call(HOOK_FORMULAS, f);

export const MAX_BEATS = 12;
export const MAX_HOOK_OPTIONS = 6;
export const MAX_STORY_OVERLAYS = 6;
export const MAX_STORY_IMAGES = 3;
export const MAX_STORY_SENTENCES = 120;
/** A beat shorter than this is not a beat (dropped with a note). */
export const MIN_BEAT_SEC = 0.6;
/** Pad around a sentence (s), never past the end of the previous or the start of the next word. */
export const SENTENCE_PAD = { in: 0.08, out: 0.12 } as const;
export const STORY_TARGET_SEC = { min: 7, max: MAX_CUT_SEC, default: 35 } as const;

/** Shown with every hook option that is not a literal quote. */
export const REPHRASED_NOTE = 'Neu formuliert, kein Zitat: Prüfe, dass der Hook nur sagt, was du im Video wirklich sagst (keine Zahlen, Ergebnisse oder Versprechen, die nicht von dir kommen).';

export class StoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryError';
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------- Sentences ----------

/** A spoken sentence of a take (numbered from 1 over all takes of the draft), in SOURCE time, snapped to word boundaries. */
export interface StorySentence {
  n: number;
  assetId: string;
  startSec: number;
  endSec: number;
  text: string;
  /** Only fillers („Also.“, „Genau.“, „Ähm.“): never left out between two beats. */
  fillerOnly: boolean;
}

const SENTENCE_END = /[.!?…]["“”»«'’)]*$/;
const fillerWord = (w: string) => isWeakFiller(w) || isStrongFiller(w);

/**
 * Numbered sentences of the takes (in the given order, each take once): a transcript segment split at sentence ends
 * (. ! ? …). A sentence starts SENTENCE_PAD.in before its first word and ends SENTENCE_PAD.out after its last word, but
 * never inside the previous or next word and never past the take.
 */
export function buildStorySentences(sources: readonly { assetId: string; transcript: TranscriptBody | null; durationSec: number | null }[], max = MAX_STORY_SENTENCES): StorySentence[] {
  const out: StorySentence[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (seen.has(src.assetId) || !src.transcript) continue;
    seen.add(src.assetId);
    // review fix: words per segment (filtered per segment), so a dropped word never shifts the following segments
    const words: { startSec: number; endSec: number; text: string }[] = [];
    const groups: { from: number; to: number }[] = [];
    for (const seg of src.transcript.segments) {
      const segWords = transcriptWords({ language: src.transcript.language, segments: [seg] }).filter((w) => w.text.trim() && w.endSec >= w.startSec);
      let start = words.length;
      segWords.forEach((w, k) => {
        words.push(w);
        if (SENTENCE_END.test(w.text.trim()) || k === segWords.length - 1) { groups.push({ from: start, to: words.length - 1 }); start = words.length; }
      });
    }
    for (const g of groups) {
      const first = words[g.from], last = words[g.to];
      if (!first || !last) continue;
      const prevEnd = g.from > 0 ? words[g.from - 1]!.endSec : 0;
      const nextStart = g.to + 1 < words.length ? words[g.to + 1]!.startSec : src.durationSec ?? last.endSec + SENTENCE_PAD.out;
      // review fix: the gap to a neighbouring word is split at its middle, so two sentences never overlap
      const startSec = r3(Math.max(0, Math.min(first.startSec, (prevEnd + first.startSec) / 2), first.startSec - SENTENCE_PAD.in));
      const endSec = r3(Math.min(src.durationSec ?? Infinity, Math.max(last.endSec, Math.min((last.endSec + nextStart) / 2, last.endSec + SENTENCE_PAD.out))));
      const parts = words.slice(g.from, g.to + 1).map((w) => w.text);
      const text = collapseWs(parts.join(' '), 300);
      if (!text || endSec - startSec < 0.05) continue;
      out.push({ n: 0, assetId: src.assetId, startSec, endSec, text, fillerOnly: parts.every(fillerWord) });
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out.map((s, i) => ({ ...s, n: i + 1 }));
}

const sentenceSec = (s: Pick<StorySentence, 'startSec' | 'endSec'>) => s.endSec - s.startSec;

// ---------- Wire (what the model writes) ----------

export const EditDirectionWire = z.object({
  summary: z.string(),
  beats: z.array(z.object({ role: z.string(), from: z.number(), to: z.number(), why: z.string(), pillarId: z.string().nullable(), zoom: z.string().nullable() })),
  hooks: z.array(z.object({ text: z.string(), formula: z.string(), source: z.string(), sentence: z.number().nullable(), why: z.string() })),
  overlays: z.array(z.object({ kind: z.string(), text: z.string(), sentence: z.number(), presetId: z.string().nullable(), why: z.string() })),
  images: z.array(z.object({ referenceId: z.string(), sentence: z.number(), why: z.string() })),
  tempo: z.string().nullable(),
  tempoNote: z.string(),
});
export type EditDirectionWire = z.infer<typeof EditDirectionWire>;

// ---------- Stored plan ----------

export const StoryZoom = z.enum(['none', 'push_in', 'push_out', 'punch_in']);
export const STORY_ZOOM_LABEL: Record<z.infer<typeof StoryZoom>, string> = { none: 'kein Zoom', push_in: 'Push-in', push_out: 'Push-out', punch_in: 'Punch-in' };
export interface StoryBeat { id: string; role: BeatRole; from: number; to: number; why: string; pillarId: string | null; zoom: ZoomKind }
export interface StoryHook { id: string; text: string; formula: HookFormula; source: 'quote' | 'rephrased'; sentence: number | null; why: string; notes: string[]; lint: SlopHint[] }
export type StoryOverlayKind = 'keyword' | 'lower_third' | 'arrow';
export interface StoryOverlay { id: string; kind: StoryOverlayKind; text: string; sentence: number; presetId: string | null; why: string }
export interface StoryImage { id: string; referenceId: string; sentence: number; why: string }
export interface StoryPlanBody {
  summary: string;
  sentences: StorySentence[];
  beats: StoryBeat[];
  hooks: StoryHook[];
  overlays: StoryOverlay[];
  images: StoryImage[];
  tempo: { preset: 'calm' | 'normal' | 'brisk' | null; note: string };
  targetSec: number;
  warnings: string[];
}

/** What the normalisation checks against (all from the store, never from the model). */
export interface StoryContext {
  sentences: readonly StorySentence[];
  targetSec: number;
  presetIds: readonly string[];
  defaultPresetId: string | null;
  pillars: readonly { id: string; name: string }[];
  /** Library images she marked as usable (own, licensed with source, or generated = labelled). */
  images: readonly { id: string; name: string }[];
  /** Verified claims of the project (a figure in a hook must come from her words or one of these). */
  allowedClaims?: readonly string[];
  flaggedClaims?: readonly string[];
  fit?: OverlayFit;
  hookSlot?: Slot;
}

/** Testimonial or third-party praise that a rephrased hook must not invent. */
const TESTIMONIAL = /\b(?:kund(?:in|innen|en)|follower(?:innen)?|zuschauer(?:innen)?|alle|jede[rs]?|viele|tausende)\s+(?:sagen|sagt|lieben|liebt|schwören|schwört|feiern|bestätigen)\b|\btestimonial|\b\d+\s*(?:sterne|bewertungen)\b|\b(?:bewiesen|garantiert|wissenschaftlich belegt)\b/i;
const ZOOMS = new Set<string>(StoryZoom.options);

/** Problems that keep a text out of the proposal (invented figures, flagged claims, links, denials, testimonials). */
export function storyTextProblems(text: string, ctx: Pick<StoryContext, 'sentences' | 'allowedClaims' | 'flaggedClaims'>, where: string, rephrased: boolean): string[] {
  // figures are fine when she says them herself (any sentence of the transcript) or they are a verified claim
  const f = burnedTextFindings(text, { allowed: [...(ctx.allowedClaims ?? []), ...ctx.sentences.map((s) => s.text)], flagged: ctx.flaggedClaims ?? [] }, where);
  const out = [...f.claims, ...f.denials];
  if (rephrased && TESTIMONIAL.test(text)) out.push(`Der Text ${where} klingt nach Testimonial, Garantie oder fremdem Lob – das wird nicht erfunden.`);
  return out;
}

/** The hook text as the render would lay it out fits the picture (≤ 4 lines). */
const hookFits = (text: string, ctx: Pick<StoryContext, 'fit' | 'hookSlot'>) =>
  !!hookLayout(ctx.fit ? applyCase(text, ctx.fit.hook.textCase) : text, ctx.hookSlot ?? 'upper', ctx.fit?.hook.scale ?? 1);

/**
 * Validates the model's answer against the transcript and her studio state. Everything that does not hold is dropped with
 * a note (never silently): invalid sentence numbers, overlapping or too short beats, beats beyond the maximum length,
 * hook options with invented figures, unknown presets, pillars and images.
 */
export function normalizeStory(wire: EditDirectionWire, ctx: StoryContext): StoryPlanBody {
  const warnings: string[] = [];
  const N = ctx.sentences.length;
  const sent = (n: number) => (Number.isInteger(n) && n >= 1 && n <= N ? ctx.sentences[n - 1]! : null);
  const clean = (s: string, max: number) => collapseWs(s, max);
  const pillarIds = new Set(ctx.pillars.map((p) => p.id));
  const used = new Set<number>();

  // beats: in the model's order (the narrative order), no sentence twice, each at least MIN_BEAT_SEC
  const beats: StoryBeat[] = [];
  let total = 0;
  for (const b of wire.beats) {
    if (beats.length >= MAX_BEATS) { warnings.push(`Mehr als ${MAX_BEATS} Beats vorgeschlagen – die übrigen wurden weggelassen.`); break; }
    let from = Math.round(Math.min(b.from, b.to)), to = Math.round(Math.max(b.from, b.to));
    if (!sent(from) || !sent(to)) { warnings.push(`Beat mit Satz ${b.from}–${b.to} verworfen: diese Sätze gibt es nicht.`); continue; }
    while (from <= to && used.has(from)) from++;
    while (to >= from && used.has(to)) to--;
    if (from > to || [...Array(to - from + 1).keys()].some((k) => used.has(from + k))) { warnings.push(`Beat mit Satz ${b.from}–${b.to} verworfen: die Sätze stecken schon in einem anderen Beat.`); continue; }
    const dur = ctx.sentences.slice(from - 1, to).reduce((s, x) => s + sentenceSec(x), 0);
    if (dur < MIN_BEAT_SEC) { warnings.push(`Beat mit Satz ${from}–${to} verworfen: kürzer als ${MIN_BEAT_SEC} s.`); continue; }
    if (total + dur > MAX_CUT_SEC) { warnings.push(`Beat mit Satz ${from}–${to} weggelassen: der Schnitt wäre länger als ${MAX_CUT_SEC} s.`); continue; }
    total += dur;
    for (let k = from; k <= to; k++) used.add(k);
    const role = BeatRole.safeParse(b.role.trim().toLowerCase());
    const zoom = b.zoom && ZOOMS.has(b.zoom) ? (b.zoom as ZoomKind) : 'none';
    beats.push({ id: `b${beats.length + 1}`, role: role.success ? role.data : 'other', from, to, why: clean(b.why, 300), pillarId: b.pillarId && pillarIds.has(b.pillarId) ? b.pillarId : null, zoom });
  }
  if (!beats.length && wire.beats.length) warnings.push('Kein gültiger Beat übrig – der Schnitt bleibt, wie er ist; Hooks und Overlays lassen sich trotzdem übernehmen.');
  if (total > ctx.targetSec * 1.25) warnings.push(`Die Beats ergeben ${total.toFixed(1)} s, gewünscht waren etwa ${ctx.targetSec} s – einzelne Beats abwählen.`);

  // hooks: quotes must be literal, rephrased ones are marked; invented figures/claims/testimonials are refused
  const hooks: StoryHook[] = [];
  const seenHooks = new Set<string>();
  for (const h of wire.hooks) {
    if (hooks.length >= MAX_HOOK_OPTIONS) { warnings.push(`Mehr als ${MAX_HOOK_OPTIONS} Hook-Ideen – die übrigen wurden weggelassen.`); break; }
    const text = clean(h.text, 200).replace(/^[„"'‚‘»«]+|[“"'‘’»«]+$/g, '').trim();
    if (!text || seenHooks.has(text.toLowerCase())) continue;
    if (text.length > TEXT_LIMIT.free_hook) { warnings.push(`Hook „${text.slice(0, 40)}…“ verworfen: länger als ${TEXT_LIMIT.free_hook} Zeichen.`); continue; }
    let source: StoryHook['source'] = h.source === 'quote' ? 'quote' : 'rephrased';
    let sentence = h.sentence != null && sent(Math.round(h.sentence)) ? Math.round(h.sentence) : null;
    if (source === 'quote') {
      const own = sentence != null && textFromSource(text, [ctx.sentences[sentence - 1]!.text]);
      const found = own ? sentence : ctx.sentences.find((s) => textFromSource(text, [s.text]))?.n ?? null;
      if (found == null) { source = 'rephrased'; warnings.push(`Hook „${text}“ steht so nicht im Transkript – als „neu formuliert“ markiert.`); }
      sentence = found;
    }
    const problems = storyTextProblems(text, ctx, 'im Hook', source === 'rephrased');
    if (problems.length) { warnings.push(`Hook „${text}“ verworfen: ${problems.join(' ')}`); continue; }
    if (!hookFits(text, ctx)) { warnings.push(`Hook „${text}“ verworfen: zu lang für das Bild.`); continue; }
    seenHooks.add(text.toLowerCase());
    const formula = isFormula(h.formula) ? h.formula : source === 'quote' ? 'quote' : 'other';
    hooks.push({
      id: `h${hooks.length + 1}`, text, formula, source, sentence, why: clean(h.why, 300),
      notes: source === 'rephrased' ? [REPHRASED_NOTE] : [], lint: slopHints(text, 'hook'),
    });
  }

  // overlays: text kinds in her presets, anchored to a sentence
  const presets = new Set(ctx.presetIds);
  const overlays: StoryOverlay[] = [];
  for (const o of wire.overlays) {
    if (overlays.length >= MAX_STORY_OVERLAYS) { warnings.push(`Mehr als ${MAX_STORY_OVERLAYS} Overlay-Ideen – die übrigen wurden weggelassen.`); break; }
    const kind = o.kind === 'keyword' || o.kind === 'lower_third' || o.kind === 'arrow' ? o.kind : null;
    if (!kind) { warnings.push(`Overlay „${clean(o.kind, 20)}“ verworfen: unbekannte Art.`); continue; }
    if (!sent(Math.round(o.sentence))) { warnings.push(`Overlay zu Satz ${o.sentence} verworfen: diesen Satz gibt es nicht.`); continue; }
    const text = kind === 'arrow' ? '' : clean(o.text, 200).replace(/^[„"'‚‘»«]+|[“"'‘’»«]+$/g, '').trim();
    if (kind !== 'arrow') {
      if (!text) continue;
      if (text.length > TEXT_LIMIT[kind]) { warnings.push(`Overlay „${text.slice(0, 30)}…“ verworfen: höchstens ${TEXT_LIMIT[kind]} Zeichen.`); continue; }
      const problems = storyTextProblems(text, ctx, 'im Overlay', true);
      if (problems.length) { warnings.push(`Overlay „${text}“ verworfen: ${problems.join(' ')}`); continue; }
    }
    const presetId = o.presetId && presets.has(o.presetId) ? o.presetId : ctx.defaultPresetId && presets.has(ctx.defaultPresetId) ? ctx.defaultPresetId : null;
    if (o.presetId && !presets.has(o.presetId)) warnings.push(`Overlay-Stil „${clean(o.presetId, 40)}“ gibt es in Meine Marke nicht – Standard-Stil verwendet.`);
    overlays.push({ id: `o${overlays.length + 1}`, kind, text, sentence: Math.round(o.sentence), presetId, why: clean(o.why, 300) });
  }

  // images: only her usable library images
  const usable = new Set(ctx.images.map((i) => i.id));
  const images: StoryImage[] = [];
  for (const im of wire.images) {
    if (images.length >= MAX_STORY_IMAGES) break;
    if (!usable.has(im.referenceId)) { warnings.push('Ein Bild-Vorschlag verworfen: das Bild ist nicht als eigenes oder lizenziertes Bild freigegeben.'); continue; }
    if (!sent(Math.round(im.sentence))) continue;
    if (images.some((x) => x.referenceId === im.referenceId)) continue;
    images.push({ id: `i${images.length + 1}`, referenceId: im.referenceId, sentence: Math.round(im.sentence), why: clean(im.why, 300) });
  }

  const tempo = wire.tempo === 'calm' || wire.tempo === 'normal' || wire.tempo === 'brisk' ? wire.tempo : null;
  return {
    summary: clean(wire.summary, 600), sentences: [...ctx.sentences], beats, hooks, overlays, images,
    tempo: { preset: tempo, note: clean(wire.tempoNote, 300) }, targetSec: ctx.targetSec, warnings: unique(warnings).slice(0, 30),
  };
}

// ---------- „Warum“: pillar and cut rhythm ----------

/** Duration of a beat (sum of its sentences). */
export const beatSec = (b: Pick<StoryBeat, 'from' | 'to'>, sentences: readonly StorySentence[]) => r3(sentences.slice(b.from - 1, b.to).reduce((s, x) => s + sentenceSec(x), 0));

/** The deterministic part of the „Warum“ note: length against her cut rhythm from „Meine Marke“ and the pillar. */
export function beatRhythmNote(b: StoryBeat, sentences: readonly StorySentence[], motion: { targetCutSec: number | null; tempo: 'calm' | 'medium' | 'fast' } | null, pillars: readonly { id: string; name: string }[]): string {
  const sec = beatSec(b, sentences);
  const parts = [`${sec.toFixed(1).replace('.', ',')} s`];
  if (motion?.targetCutSec) {
    const shots = Math.max(1, Math.round(sec / motion.targetCutSec));
    parts.push(`Schnittrhythmus aus Meine Marke: etwa ${motion.targetCutSec.toString().replace('.', ',')} s je Einstellung → ${shots === 1 ? 'eine Einstellung' : `${shots} Einstellungen (Zoom oder Bild hilft)`}`);
  } else if (motion) parts.push(`Tempo aus Meine Marke: ${motion.tempo === 'fast' ? 'zügig' : motion.tempo === 'calm' ? 'ruhig' : 'mittel'}`);
  const pillar = b.pillarId ? pillars.find((p) => p.id === b.pillarId) : null;
  if (pillar) parts.push(`Säule „${pillar.name}“`);
  return parts.join(' · ');
}

// ---------- Selection ----------

export const StorySelection = z.object({
  /** Beat ids in her order; null = keep the clips as they are (only add hook/overlays/images/zooms). */
  beats: z.array(z.string().regex(/^b\d{1,2}$/)).max(MAX_BEATS).nullable(),
  /** Hook option; null = keep the hook as it is. */
  hookId: z.string().regex(/^h\d$/).nullable(),
  overlayIds: z.array(z.string().regex(/^o\d{1,2}$/)).max(MAX_STORY_OVERLAYS * 2).default([]),
  imageIds: z.array(z.string().regex(/^i\d$/)).max(MAX_STORY_IMAGES * 2).default([]),
  zoomBeatIds: z.array(z.string().regex(/^b\d{1,2}$/)).max(MAX_BEATS).default([]),
}).strict();
export type StorySelection = z.infer<typeof StorySelection>;

/** Everything selected, in the proposed order (the editor's starting point). */
export const defaultSelection = (s: Pick<StoryPlanBody, 'beats' | 'hooks' | 'overlays' | 'images'>): StorySelection => ({
  beats: s.beats.map((b) => b.id), hookId: s.hooks[0]?.id ?? null, overlayIds: s.overlays.map((o) => o.id), imageIds: s.images.map((i) => i.id),
  zoomBeatIds: s.beats.filter((b) => b.zoom !== 'none').map((b) => b.id),
});

/** Moves a beat in the selection (drag or keyboard): `to` is the new index among the selected beats. */
export function moveBeat(sel: StorySelection, id: string, to: number): StorySelection {
  if (!sel.beats) return sel;
  const from = sel.beats.indexOf(id);
  if (from < 0) return sel;
  const beats = [...sel.beats];
  beats.splice(from, 1);
  beats.splice(Math.max(0, Math.min(beats.length, to)), 0, id);
  return { ...sel, beats };
}

/** Selects or deselects a beat; a re-selected beat goes back to its proposed position among the selected ones. */
export function toggleBeat(sel: StorySelection, id: string, story: Pick<StoryPlanBody, 'beats'>): StorySelection {
  const current = sel.beats ?? story.beats.map((b) => b.id);
  if (current.includes(id)) return { ...sel, beats: current.filter((x) => x !== id) };
  // after the last selected beat that comes before it in the proposal (her reordering of the others stays)
  const order = story.beats.map((b) => b.id);
  const before = current.map((x, i) => (order.indexOf(x) < order.indexOf(id) ? i : -1)).filter((i) => i >= 0);
  const beats = [...current];
  beats.splice(before.length ? before[before.length - 1]! + 1 : 0, 0, id);
  return { ...sel, beats };
}

// ---------- Apply ----------

export interface StoryApplyContext {
  /** Duration of every take (clips are clamped to it). */
  durations: ReadonlyMap<string, number | null>;
  /** Aspect ratio (w/h) of the library images the story may place. */
  imageAspects: ReadonlyMap<string, number>;
  scriptless: boolean;
  fit?: OverlayFit;
  hookSlot: Slot;
  overlaySlot: Slot;
}
export interface StoryChange { label: string; before: string; after: string }

const fmtSec = (t: number) => `${t.toFixed(1).replace('.', ',')} s`;
const OVERLAY_LABEL: Record<StoryOverlayKind, string> = { keyword: 'Keyword', lower_third: 'Bauchbinde', arrow: 'Pfeil' };
const SLOTS: readonly Slot[] = ['upper', 'center', 'lower'];

/** Sentence range of a beat, widened by neighbouring filler-only sentences of the same take that no other chosen beat has. */
function beatRange(b: StoryBeat, sentences: readonly StorySentence[], taken: ReadonlySet<number>): { from: number; to: number } {
  let from = b.from, to = b.to;
  const same = (k: number) => sentences[k - 1] && sentences[k - 1]!.assetId === sentences[b.from - 1]!.assetId;
  while (from > 1 && same(from - 1) && sentences[from - 2]!.fillerOnly && !taken.has(from - 1)) from--;
  while (to < sentences.length && same(to + 1) && sentences[to]!.fillerOnly && !taken.has(to + 1)) to++;
  return { from, to };
}

/**
 * Applies a selection of a story to her draft. Throws `StoryError` for a selection that does not fit the story (unknown
 * ids) or a draft that cannot take it. Everything else that cannot be placed is reported in `warnings`.
 */
export function storyToDraft(base: EditDraftBody, story: StoryPlanBody, rawSel: StorySelection, ctx: StoryApplyContext): { body: EditDraftBody; changes: StoryChange[]; warnings: string[] } {
  const sel = StorySelection.parse(rawSel);
  const warnings: string[] = [];
  const changes: StoryChange[] = [];
  const byId = <T extends { id: string }>(list: readonly T[], id: string, what: string) => {
    const x = list.find((y) => y.id === id);
    if (!x) throw new StoryError(`${what} ${id} gibt es in diesem Vorschlag nicht.`);
    return x;
  };
  const S = story.sentences;
  const sentence = (n: number) => S[n - 1] ?? null;
  let body: EditDraftBody = EditDraftBody.parse(base);

  // 1. beats → clips (each beat its own clip(s); runs split where the take changes)
  if (sel.beats) {
    if (!sel.beats.length) throw new StoryError('Mindestens ein Beat muss ausgewählt sein.');
    if (new Set(sel.beats).size !== sel.beats.length) throw new StoryError('Ein Beat ist doppelt ausgewählt.');
    const chosen = sel.beats.map((id) => byId(story.beats, id, 'Beat'));
    const taken = new Set(chosen.flatMap((b) => Array.from({ length: b.to - b.from + 1 }, (_, k) => b.from + k)));
    const zoomed = new Set(sel.zoomBeatIds);
    const clips: EditClip[] = [];
    let total = 0;
    for (const b of chosen) {
      const { from, to } = beatRange(b, S, taken);
      for (let k = from; k <= to; k++) taken.add(k);
      const runs: { assetId: string; inSec: number; outSec: number }[] = [];
      for (let k = from; k <= to; k++) {
        const s = sentence(k)!;
        const last = runs[runs.length - 1];
        if (last && last.assetId === s.assetId && s.startSec <= last.outSec + 0.5) last.outSec = Math.max(last.outSec, s.endSec);
        else runs.push({ assetId: s.assetId, inSec: s.startSec, outSec: s.endSec });
      }
      for (const r of runs) {
        const dur = ctx.durations.get(r.assetId);
        if (dur === undefined) { warnings.push(`Beat ${b.id.slice(1)}: die Aufnahme ist nicht mehr im Projekt.`); continue; }
        const inSec = r3(Math.max(0, r.inSec)), outSec = r3(Math.min(dur ?? r.outSec, r.outSec));
        if (outSec - inSec < MIN_CLIP_SEC) { warnings.push(`Beat ${b.id.slice(1)}: zu kurz für einen Clip.`); continue; }
        if (total + outSec - inSec > MAX_CUT_SEC) { warnings.push(`Beat ${b.id.slice(1)} weggelassen: der Schnitt wäre länger als ${MAX_CUT_SEC} s.`); continue; }
        total += outSec - inSec;
        clips.push(EditClip.parse({ assetId: r.assetId, inSec, outSec, zoom: zoomed.has(b.id) && b.zoom !== 'none' ? { kind: b.zoom } : {} }));
      }
    }
    if (!clips.length) throw new StoryError('Aus der Auswahl entsteht kein Clip.');
    // her overlays and images stay where their moment is still in the cut (same take, inside a new clip)
    let dropped = 0;
    for (const old of body.clips) {
      for (const o of old.overlays) {
        const c = clips.find((x) => x.assetId === old.assetId && o.startSec >= x.inSec - 0.001 && o.endSec <= x.outSec + 0.001 && x.overlays.length < 8);
        if (c) c.overlays.push(o); else dropped++;
      }
      for (const im of old.images ?? []) {
        const c = clips.find((x) => x.assetId === old.assetId && im.startSec >= x.inSec - 0.001 && im.endSec <= x.outSec + 0.001 && (x.images?.length ?? 0) < 4);
        if (c) c.images = [...(c.images ?? []), im]; else dropped++;
      }
    }
    // review fix: her cuts (text-based cutting, pacing, a retake she removed) stay where they fall inside a new clip
    for (const old of body.clips) for (const cut of old.cuts) for (const c of clips) {
      if (c.assetId !== old.assetId) continue;
      const a = Math.max(c.inSec, cut.startSec), e = Math.min(c.outSec, cut.endSec);
      if (e - a > 0.01 && c.cuts.length < 40) c.cuts.push({ ...cut, startSec: r3(a), endSec: r3(e) });
    }
    for (const c of clips) {
      c.cuts = normalizeCuts(c.cuts);
      // a cut that would leave nothing (or a sliver) of the clip is dropped rather than breaking the draft
      const kept = clipPieces(c);
      if (!kept.length || kept.some((p) => p.rawSec < MIN_CLIP_SEC)) c.cuts = [];
    }
    const lostSubtitles = body.clips.filter((c) => c.subtitle.trim()).length;
    if (lostSubtitles) warnings.push(`${lostSubtitles} eigene(r) Untertiteltext(e) der bisherigen Clips gilt/gelten nicht für die neuen Beat-Clips (Strg/⌘+Z holt alles zurück).`);
    if (dropped) warnings.push(`${dropped} vorhandene(s) Overlay/Bild lag(en) außerhalb der gewählten Beats und ist/sind nicht mehr im Schnitt (Strg/⌘+Z holt alles zurück).`);
    const before = buildTimeline(body.clips).durationSec;
    body = { ...body, clips };
    changes.push({ label: 'Beats als Clips', before: `${base.clips.length} Clip(s), ${fmtSec(before)}`, after: `${chosen.length} Beat(s) → ${clips.length} Clip(s), ${fmtSec(buildTimeline(clips).durationSec)}: ${chosen.map((b) => `${BEAT_ROLE_LABEL[b.role]} (Satz ${b.from}${b.to !== b.from ? `–${b.to}` : ''})`).join(' · ')}` });
  } else if (sel.zoomBeatIds.length) {
    // zooms without new clips: the clip that holds the beat's first sentence
    for (const id of sel.zoomBeatIds) {
      const b = byId(story.beats, id, 'Beat');
      const s = sentence(b.from)!;
      const i = body.clips.findIndex((c) => c.assetId === s.assetId && s.startSec >= c.inSec - 0.05 && s.startSec < c.outSec);
      if (i < 0 || b.zoom === 'none') { warnings.push(`Zoom für Beat ${id.slice(1)}: Satz ${b.from} ist nicht im Schnitt.`); continue; }
      const c = body.clips[i]!;
      body = { ...body, clips: body.clips.map((x, k) => (k === i ? { ...x, zoom: { ...x.zoom, kind: b.zoom, punchOnCuts: false } } : x)) };
      changes.push({ label: `Zoom Clip ${i + 1}`, before: STORY_ZOOM_LABEL[c.zoom.kind], after: STORY_ZOOM_LABEL[b.zoom] });
    }
  }
  if (sel.beats) for (const id of sel.zoomBeatIds) {
    const b = byId(story.beats, id, 'Beat');
    if (b.zoom !== 'none' && sel.beats.includes(id)) changes.push({ label: `Zoom Beat ${id.slice(1)}`, before: 'kein Zoom', after: STORY_ZOOM_LABEL[b.zoom] });
  }

  // 2. hook (free hook of the Freier Schnitt)
  if (sel.hookId) {
    const h = byId(story.hooks, sel.hookId, 'Hook');
    if (!ctx.scriptless) throw new StoryError('Im Skript-Schnitt kommt der Hook aus dem Skript – Hook-Optionen gibt es nur im Freien Schnitt.');
    const before = body.hook ? `„${body.hook.text}“` : '–';
    body = setHook(body, { source: 'free', variantIndex: null, text: h.text, slot: body.hook?.slot ?? ctx.hookSlot, endSec: Math.min(HOOK_MAX_SEC, body.hook?.endSec ?? 2.5) });
    changes.push({ label: 'Hook', before, after: `„${h.text}“ (${h.source === 'quote' ? 'Zitat aus dem Transkript' : 'neu formuliert'})` });
  }

  // 3. overlays and 4. images, anchored to their sentence in the (new) cut
  const tl = () => buildTimeline(body.clips);
  const clipOf = (n: number) => {
    const s = sentence(n);
    if (!s) return null;
    const i = body.clips.findIndex((c) => c.assetId === s.assetId && s.endSec > c.inSec + 0.05 && s.startSec < c.outSec - 0.05);
    return i < 0 ? null : { i, s, c: body.clips[i]! };
  };
  const hookEnd = () => (body.hook ? Math.min(body.hook.endSec, tl().durationSec) : 0);
  for (const id of sel.overlayIds) {
    const o = byId(story.overlays, id, 'Overlay');
    const at = clipOf(o.sentence);
    if (!at) { warnings.push(`${OVERLAY_LABEL[o.kind]}${o.text ? ` „${o.text}“` : ''}: Satz ${o.sentence} ist nicht im Schnitt.`); continue; }
    if (at.c.overlays.length >= 8) { warnings.push(`${OVERLAY_LABEL[o.kind]} „${o.text}“: der Clip hat schon 8 Overlays.`); continue; }
    const start = r3(Math.max(at.c.inSec, at.s.startSec));
    const end = r3(Math.min(at.c.outSec, start + Math.min(2.5, Math.max(1.2, sentenceSec(at.s)))));
    if (end - start < 0.3) { warnings.push(`${OVERLAY_LABEL[o.kind]} „${o.text}“: zu wenig Platz im Clip.`); continue; }
    // a free slot: not the hook's while the hook is shown, not one a time-overlapping overlay of the clip uses
    const span = mapSpan(tl(), at.i, start, end);
    const preferred: Slot = o.kind === 'lower_third' ? 'lower' : ctx.overlaySlot;
    const slot = [preferred, ...SLOTS.filter((x) => x !== preferred)].find((x) =>
      !(body.hook && span && span.startSec < hookEnd() && x === body.hook.slot) &&
      !at.c.overlays.some((y) => y.slot === x && Math.min(y.endSec, end) - Math.max(y.startSec, start) > 0.001)) ?? preferred;
    const overlay = ClipOverlay.parse({ kind: o.kind, startSec: start, endSec: end, text: o.text, slot, ...(o.presetId ? { presetId: o.presetId } : {}) });
    body = { ...body, clips: body.clips.map((c, k) => (k === at.i ? { ...c, overlays: [...c.overlays, overlay] } : c)) };
    changes.push({ label: `${OVERLAY_LABEL[o.kind]} hinzufügen`, before: '–', after: `${o.text ? `„${o.text}“ ` : ''}bei Satz ${o.sentence}${o.presetId ? ` · Stil „${o.presetId}“` : ''}` });
  }
  for (const id of sel.imageIds) {
    const im = byId(story.images, id, 'Bild');
    const aspect = ctx.imageAspects.get(im.referenceId);
    if (!aspect) { warnings.push(`Bild ${id.slice(1)}: das Bild ist nicht (mehr) als nutzbar markiert.`); continue; }
    const at = clipOf(im.sentence);
    if (!at) { warnings.push(`Bild ${id.slice(1)}: Satz ${im.sentence} ist nicht im Schnitt.`); continue; }
    const start = Math.max(at.c.inSec, at.s.startSec);
    const r = insertImage(body, at.i, start, start + Math.min(3, Math.max(1.2, sentenceSec(at.s))), { referenceId: im.referenceId, aspect });
    if ('error' in r) { warnings.push(`Bild ${id.slice(1)}: ${r.error}`); continue; }
    body = r.body;
    changes.push({ label: 'Bild einblenden', before: '–', after: `bei Satz ${im.sentence}` });
  }

  const parsed = EditDraftBody.safeParse(body);
  if (!parsed.success) throw new StoryError(`Entwurf danach ungültig: ${parsed.error.issues.slice(0, 3).map((i) => i.message).join('; ')}`);
  if (!changes.length) throw new StoryError('Die Auswahl ändert am Entwurf nichts.');
  return { body: keepClearOfLabel(parsed.data, ctx.fit), changes, warnings };
}
