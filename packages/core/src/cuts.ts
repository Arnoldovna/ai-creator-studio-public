/**
 * Filler and pause suggestions (Release 3, Etappe 8). Pure and deterministic: the transcript says WHAT
 * was said, FFmpeg's silencedetect says WHERE the audio is quiet. A cut is only suggested where the
 * audio supports it, because plain whisper.cpp word times are often 0.1–1 s off.
 *
 * Nothing here cuts anything: suggestions are shown with a preview, the user accepts them one by one or
 * explicitly with „Alle sicheren übernehmen“, and they reach the video only after save, approval and
 * render review. Transcript text is untrusted data; it is only compared, never executed.
 */
import { normClaim } from './claims';
import { mergeCutPair, MIN_CLIP_SEC, normalizeCuts, type CutRange } from './edit';
import { isStrongFiller, isWeakFiller, type TranscriptBody, type TranscriptWord } from './transcript';

export interface TimeRange { startSec: number; endSec: number }

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------- Silence scan (FFmpeg volumedetect + silencedetect) ----------

/** Shortest silence the scan reports (s). */
export const SILENCE_MIN_SEC = 0.15;

/** Mean volume of the clip in dB from FFmpeg `volumedetect` (null when missing or -inf). */
export function parseVolumedetect(stderr: string): { meanDb: number; maxDb: number | null } | null {
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  if (!mean) return null;
  const max = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  return { meanDb: Number(mean[1]), maxDb: max ? Number(max[1]) : null };
}

/**
 * Silence threshold relative to the clip's mean volume (20 dB below it, clamped to −60…−30 dB).
 * A fixed −35 dB would count quiet speech in a phone recording as silence and cut real words.
 */
export function silenceThresholdDb(meanDb: number): number {
  return Math.round(Math.min(-30, Math.max(-60, meanDb - 20)) * 10) / 10;
}

/** The FFmpeg audio filter for the scan; all numbers are ours. */
export const silencedetectFilter = (noiseDb: number, minSec = SILENCE_MIN_SEC) => `silencedetect=noise=${noiseDb.toFixed(1)}dB:d=${minSec.toFixed(2)}`;

/**
 * Silence ranges from FFmpeg `silencedetect` output (stderr at loglevel info). A silence still open at
 * the end of the file is closed at `totalSec` (or dropped without it).
 */
export function parseSilencedetect(stderr: string, totalSec?: number | null): TimeRange[] {
  const out: TimeRange[] = [];
  let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (!Number.isFinite(t)) continue;
    if (m[1] === 'start') open = t;
    else if (open != null) {
      if (t > open) out.push({ startSec: r3(open), endSec: r3(t) });
      open = null;
    }
  }
  if (open != null && totalSec != null && totalSec > open) out.push({ startSec: r3(open), endSec: r3(totalSec) });
  return out;
}

// ---------- Suggestions ----------

export type SuggestionKind = 'filler' | 'weak_filler' | 'pause' | 'sound';
export interface CutSuggestion {
  /** Stable for the same input (UI key; also tells whether the clip already has this cut). */
  id: string;
  startSec: number;
  endSec: number;
  /** What the cut is stored as in the EDL. */
  reason: 'filler' | 'pause';
  kind: SuggestionKind;
  /** The filler as spoken („ähm“), or a label; stored with the cut and shown in the version list. */
  word: string;
  /** high = the audio shows a gap on both sides and nothing else is said there. */
  confidence: 'high' | 'low';
  /** Taken over by „Alle sicheren übernehmen“ (high confidence and not blocked). Never pre-checked. */
  safe: boolean;
  /** Why the confidence is low, or what else to know (German, for the UI). */
  note: string;
  /** Not offered at all (client claim sentence): the reason. */
  blocked: string | null;
}
export interface CutSuggestOptions {
  /** Silences at least this long are suggested as pause cuts. */
  pauseMinSec?: number;
  /** Silence kept on each side of a cut (natural rhythm). */
  keepPauseSec?: number;
  /** How far a DTW word time may lie outside its sound island. */
  snapSec?: number;
  /** Margin kept between a pause cut and a word. */
  padSec?: number;
  /** A filler's sound island may be at most this long (longer = glued to other words). */
  maxFillerSec?: number;
  /** Also suggest „unbenannter Laut“: short sounds between silences that no transcript word explains. Off by default. */
  sounds?: boolean;
}
export interface CutSuggestInput {
  transcript: TranscriptBody;
  /** Silence ranges of the whole take (source time). */
  silences: readonly TimeRange[];
  /** The clip's range in the take. */
  clip: { inSec: number; outSec: number };
  /** Ranges that must not be cut automatically (client claim sentences), with the reason shown. */
  protectedRanges?: readonly (TimeRange & { reason: string })[];
}
export interface CutSuggestResult {
  suggestions: CutSuggestion[];
  /** Fillers in the transcript that the audio does not separate from speech: not suggested. */
  skippedFillers: number;
  /** Words carry DTW times (`-dtw`): fillers can be placed in the audio. */
  dtw: boolean;
  /** Transcript segments without word timings (edited by the user): no filler suggestions there. */
  untimedSegments: number;
}

interface Word extends TranscriptWord { seg: number; idx: number; prev: string | null }
const anchor = (w: TranscriptWord) => w.atSec ?? (w.startSec + w.endSec) / 2;
const overlaps = (a: TimeRange, b: TimeRange, by = 0) => Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec) > by;

/** Non-silent ranges of [from, to] between the silences. */
function islands(silences: readonly TimeRange[], from: number, to: number): TimeRange[] {
  const out: TimeRange[] = [];
  let at = from;
  for (const s of silences) {
    if (s.endSec <= from || s.startSec >= to) continue;
    if (s.startSec > at) out.push({ startSec: at, endSec: s.startSec });
    at = Math.max(at, s.endSec);
  }
  if (to > at) out.push({ startSec: at, endSec: to });
  return out;
}

/**
 * Suggests cuts for one clip of a take: strong fillers (high confidence only with audio evidence on both
 * sides and DTW word times), standalone weak fillers (always low), pauses of at least `pauseMinSec`
 * shortened to `keepPauseSec` per side (never over a word) and, on request, unexplained short sounds.
 * A cut never leaves a piece under MIN_CLIP_SEC at the clip's edges (it is extended to In/Out instead).
 */
export function suggestCuts(input: CutSuggestInput, opts: CutSuggestOptions = {}): CutSuggestResult {
  const pauseMin = opts.pauseMinSec ?? 0.6, keep = opts.keepPauseSec ?? 0.15, snap = opts.snapSec ?? 0.12;
  const pad = opts.padSec ?? 0.04, maxFiller = opts.maxFillerSec ?? 0.8;
  const { inSec, outSec } = input.clip;
  const silences = [...input.silences]
    .map((s) => ({ startSec: Math.max(inSec, s.startSec), endSec: Math.min(outSec, s.endSec) }))
    .filter((s) => s.endSec - s.startSec > 0.001)
    .sort((a, b) => a.startSec - b.startSec);
  const sound = islands(silences, inSec, outSec);
  const words: Word[] = input.transcript.segments.flatMap((s, seg) => s.words.map((w, idx) => ({ ...w, seg, idx, prev: idx > 0 ? s.words[idx - 1]!.text : null })));
  const untimed = input.transcript.segments.filter((s) => !s.words.length && s.text.trim() && s.endSec > inSec && s.startSec < outSec);
  const dtw = words.length > 0 && words.every((w) => w.atSec != null);
  const inClip = (t: number) => t >= inSec && t <= outSec;
  const out: CutSuggestion[] = [];
  let skippedFillers = 0;

  /** Cut over a sound island: keeps at most `keep` of the silence on each side; at a clip edge it starts/ends there. */
  const islandCut = (isl: TimeRange): TimeRange => {
    const before = silences.find((s) => Math.abs(s.endSec - isl.startSec) < 0.002);
    const after = silences.find((s) => Math.abs(s.startSec - isl.endSec) < 0.002);
    const a = before ? before.startSec + Math.min(keep, (before.endSec - before.startSec) / 2) : inSec;
    const b = after ? after.endSec - Math.min(keep, (after.endSec - after.startSec) / 2) : outSec;
    return { startSec: a, endSec: b };
  };
  const bounded = (isl: TimeRange) =>
    (isl.startSec <= inSec + 0.001 || silences.some((s) => Math.abs(s.endSec - isl.startSec) < 0.002))
    && (isl.endSec >= outSec - 0.001 || silences.some((s) => Math.abs(s.startSec - isl.endSec) < 0.002));

  // 1) fillers: the transcript names them, the audio has to show them as a short sound between silences
  const fillerIslands = new Map<TimeRange, { words: string[]; weak: boolean; others: boolean }>();
  for (const w of words) {
    const strong = isStrongFiller(w.text);
    // weak fillers count only when they stand alone: „Also, …“ at a sentence start or „…, ja, …“
    const weak = !strong && isWeakFiller(w.text) && /,$/.test(w.text) && (w.prev == null || /[,.!?;:…]$/.test(w.prev));
    if (!strong && !weak) continue;
    const t = anchor(w);
    if (!inClip(t)) continue;
    const tol = w.atSec != null ? snap : 0.3;
    const near = sound
      .map((i) => ({ i, d: t < i.startSec ? i.startSec - t : t > i.endSec ? t - i.endSec : 0 }))
      .filter((x) => x.d <= tol)
      .sort((a, b) => a.d - b.d)[0];
    if (!near || near.i.endSec - near.i.startSec > maxFiller || !bounded(near.i)) {
      if (strong) skippedFillers++;
      continue;
    }
    // another (non-filler) word placed inside the same island: whisper and the audio disagree
    const others = words.some((o) => o !== w && !isStrongFiller(o.text) && anchor(o) > near.i.startSec && anchor(o) < near.i.endSec);
    const entry = fillerIslands.get(near.i) ?? { words: [], weak: true, others: false };
    entry.words.push(w.text.replace(/[^\p{L}]/gu, '').slice(0, 20));
    entry.weak &&= weak;
    entry.others ||= others;
    fillerIslands.set(near.i, entry);
  }
  for (const [isl, e] of fillerIslands) {
    const cut = islandCut(isl);
    const notes: string[] = [];
    if (!dtw) notes.push('Wortzeiten ohne DTW (ungenau) – bitte anhören');
    if (e.others) notes.push('laut Transkript fällt hier noch ein anderes Wort');
    if (e.weak) notes.push('Füllwort, das auch Bedeutung tragen kann');
    // a word of her voice (also, ja, genau, sozusagen …) anywhere in the island: never a safe cut, she decides one by one
    const voice = words.some((o) => isWeakFiller(o.text) && anchor(o) >= isl.startSec - 0.001 && anchor(o) <= isl.endSec + 0.001);
    if (voice && !e.weak) notes.push('enthält ein Wort deiner Sprechweise – nur einzeln annehmen');
    const high = !e.weak && !voice && dtw && !e.others;
    out.push(make(cut, e.weak ? 'weak_filler' : 'filler', e.words.join(' '), high, notes.join('; ')));
  }

  // 2) pauses: long silences shortened to `keep` per side; never over a word (whisper times included)
  for (const s of silences) {
    if (s.endSec - s.startSec < pauseMin) continue;
    let a = s.startSec <= inSec + 0.001 ? inSec : s.startSec + keep;
    let b = s.endSec >= outSec - 0.001 ? outSec : s.endSec - keep;
    let shrunk = false;
    for (const w of words) {
      if (isStrongFiller(w.text)) continue;
      const span = { startSec: Math.min(w.startSec, anchor(w)), endSec: Math.max(w.endSec, anchor(w)) };
      if (!overlaps(span, { startSec: a, endSec: b }, 0.0001)) continue;
      shrunk = true;
      if (anchor(w) < (a + b) / 2) a = Math.max(a, span.endSec + pad);
      else b = Math.min(b, span.startSec - pad);
    }
    if (b - a < 0.25) continue;
    const notes: string[] = [];
    if (shrunk) notes.push('verkürzt, weil das Transkript dort ein Wort zeigt');
    const inUntimed = untimed.some((u) => overlaps(u, { startSec: a, endSec: b }));
    if (inUntimed) notes.push('in einem korrigierten Satz ohne Wortzeiten');
    out.push(make({ startSec: a, endSec: b }, 'pause', '', !shrunk && !inUntimed, notes.join('; ')));
  }

  // 3) optional: short sounds no word explains (a filler whisper left out) – low confidence, off by default
  if (opts.sounds) {
    for (const isl of sound) {
      const len = isl.endSec - isl.startSec;
      if (len < 0.08 || len > maxFiller || !bounded(isl) || fillerIslands.has(isl)) continue;
      if (words.some((w) => overlaps({ startSec: Math.min(w.startSec, anchor(w)) - 0.05, endSec: Math.max(w.endSec, anchor(w)) + 0.05 }, isl))) continue;
      if (untimed.some((u) => overlaps(u, isl))) continue;
      out.push(make(islandCut(isl), 'sound', 'unbenannter Laut', false, 'Laut ohne Wort im Transkript – kann auch ein leises echtes Wort sein'));
    }
  }

  function make(r: TimeRange, kind: SuggestionKind, word: string, high: boolean, note: string): CutSuggestion {
    // never leave a sliver at the clip edges: extend to In/Out instead
    let a = r.startSec - inSec < MIN_CLIP_SEC ? inSec : r.startSec;
    let b = outSec - r.endSec < MIN_CLIP_SEC ? outSec : r.endSec;
    a = r3(a);
    b = r3(b);
    const blocked = input.protectedRanges?.find((p) => overlaps(p, { startSec: a, endSec: b }))?.reason ?? null;
    const reason = kind === 'pause' ? 'pause' : 'filler';
    return {
      id: `${kind}-${a.toFixed(3)}-${b.toFixed(3)}`, startSec: a, endSec: b, reason, kind, word: word.slice(0, 40),
      confidence: high ? 'high' : 'low', safe: high && !blocked, note, blocked,
    };
  }

  const valid = out
    .filter((s) => s.endSec - s.startSec >= 0.05 && !(s.startSec <= inSec && s.endSec >= outSec))
    .sort((x, y) => x.startSec - y.startSec || x.endSec - y.endSec);
  // the same range twice (two fillers in one island are already merged): keep the first
  const seen = new Set<string>();
  return {
    suggestions: valid.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true))),
    skippedFillers, dtw, untimedSegments: untimed.length,
  };
}

/** Claim tokens: whitespace words without strong fillers, normalised like the claim allowlist. */
const claimTokens = (s: string) => s.split(/\s+/).filter((w) => w && !isStrongFiller(w)).map(normClaim).filter(Boolean);

/**
 * Transcript ranges of a client project that state a claim of its allowlist (verified facts, product
 * claims, the script's verifiedClaims): they are never shortened by a suggestion, only by a manual cut
 * (ADR-007 provenance). Matching is literal after normClaim on the text WITHOUT strong fillers („Die Creme
 * hält, äh, 24 Stunden“ states „Die Creme hält 24 Stunden“), over all segments joined, so a claim that
 * whisper split across two segments protects both.
 */
export function claimRanges(t: TranscriptBody, claims: readonly string[]): (TimeRange & { reason: string; claim: string })[] {
  const norm = [...new Set(claims)].map((c) => ({ c, n: claimTokens(c).join(' ') })).filter((x) => x.n.length > 0);
  if (!norm.length) return [];
  // all segments as one filler-free text; segAt[k] = the segment of character k (a joining space belongs to the next word)
  let text = '';
  const segAt: number[] = [];
  t.segments.forEach((s, i) => {
    for (const w of claimTokens(s.text)) {
      const part = text ? ` ${w}` : w;
      text += part;
      for (let k = 0; k < part.length; k++) segAt.push(i);
    }
  });
  const out: (TimeRange & { reason: string; claim: string })[] = [];
  const seen = new Set<string>();
  for (const { c, n } of norm) {
    for (let at = text.indexOf(n); at >= 0; at = text.indexOf(n, at + 1)) {
      const first = segAt[at]!, last = segAt[at + n.length - 1]!;
      const key = `${first}-${last}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ startSec: t.segments[first]!.startSec, endSec: t.segments[last]!.endSec, claim: c, reason: `Satz mit Kunden-Claim „${c.slice(0, 60)}“ – nur manuell schneiden` });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Adds accepted suggestions to a clip's cuts, sorted and merged (strictest reason kept). Two cuts closer
 * than MIN_CLIP_SEC would leave an invalid sliver: they are joined only when the gap between them lies in a
 * measured silence (`silences`, source time), because joining cuts away whatever is in the gap. Otherwise
 * the newly added cut is refused (counted in `refused`) and the user decides by hand.
 */
export function addCuts(
  existing: readonly CutRange[], add: readonly CutRange[], clip: { inSec: number; outSec: number }, silences: readonly TimeRange[] = [],
): { cuts: CutRange[]; joined: number; refused: number } {
  type Tagged = CutRange & { added: boolean };
  // a cut that would leave a sliver at In/Out reaches In/Out instead
  const edge = (c: Tagged): Tagged => ({
    ...c,
    startSec: c.startSec - clip.inSec < MIN_CLIP_SEC ? clip.inSec : c.startSec,
    endSec: clip.outSec - c.endSec < MIN_CLIP_SEC ? clip.outSec : c.endSec,
  });
  const tagged = [...existing.map((c) => ({ ...c, added: false })), ...add.map((c) => ({ ...c, added: true }))];
  const all = normalizeCuts(tagged.map((c) => edge({ ...c, startSec: Math.max(clip.inSec, c.startSec), endSec: Math.min(clip.outSec, c.endSec) })).filter((c) => c.endSec > c.startSec));
  const silent = (a: number, b: number) => silences.some((s) => s.startSec <= a + 0.001 && s.endSec >= b - 0.001);
  const out: Tagged[] = [];
  let joined = 0, refused = 0;
  for (const c of all) {
    const last = out[out.length - 1];
    if (!last || c.startSec - last.endSec >= MIN_CLIP_SEC) {
      out.push({ ...c });
    } else if (silent(last.endSec, c.startSec) || (!last.added && !c.added)) {
      out[out.length - 1] = mergeCutPair(last, c);
      joined++;
    } else {
      // the gap may hold the end of a word: keep the existing cut, drop the new one
      refused++;
      if (!c.added) out[out.length - 1] = { ...c };
    }
  }
  return { cuts: out.map((c) => ({ startSec: c.startSec, endSec: c.endSec, reason: c.reason, word: c.word })), joined, refused };
}
