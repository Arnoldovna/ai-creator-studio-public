/**
 * Anti-Slop-Hinweise (Etappe 15, Skills-Review 2: no-ai-slop, marketingskills „Social-specific tells“; eigene deutsche
 * Muster, nichts wörtlich übernommen). Deterministic and NON-blocking: the lint only returns hints, it never changes a
 * text and nothing is refused because of it.
 *
 * Hard exception list: disclosure and origin labels („Anzeige“, „Werbung“, „KI-generiert“, #ad, #werbung …, the studio's
 * own labels) are masked before any check. They are never reported, never part of an excerpt and never „fixed“.
 */
import { AD_DISCLOSURE, AI_DISCLOSURE } from './agents/scriptAgents';

export type SlopWhere = 'caption' | 'hook' | 'script' | 'overlay' | 'chat';
export type SlopKind = 'binary_contrast' | 'fake_kicker' | 'dash' | 'broetry' | 'engagement_bait' | 'stock_phrase' | 'emoji_bullets';

export interface SlopHint {
  kind: SlopKind;
  /** Short German explanation (shown as a quiet hint). */
  message: string;
  /** The matched text (never a protected label). */
  excerpt: string;
  start: number;
  end: number;
}

export const SLOP_KIND_LABEL: Record<SlopKind, string> = {
  binary_contrast: 'Floskel „nicht X, sondern Y“',
  fake_kicker: 'Fake-Kicker',
  dash: 'Gedankenstriche',
  broetry: 'Broetry (Ein-Satz-Zeilen)',
  engagement_bait: 'Engagement-Bait',
  stock_phrase: 'Stock-Floskel',
  emoji_bullets: 'Emoji als Aufzählung',
};

/**
 * Labels that are never touched or reported (fixed list; longer forms first so the whole label is masked). Matched
 * case-insensitively; hashtags with their #.
 */
export const PROTECTED_LABELS: readonly string[] = [
  AI_DISCLOSURE, 'KI-generierte Bildelemente', 'KI-generiertes Video', 'KI-generiertes Bild', 'KI-generierte Inhalte', 'KI-generiert', 'KI generiert',
  'mit KI erstellt', 'unbezahlte Werbung', 'bezahlte Partnerschaft', 'Werbung', AD_DISCLOSURE, 'Anzeige', 'Kooperation',
  '#werbung', '#anzeige', '#ad', '#ki', '#kigeneriert', '#aigenerated', '#sponsored', '#unbezahltewerbung',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LABEL_RE = new RegExp(
  [...new Set(PROTECTED_LABELS)].sort((a, b) => b.length - a.length).map((l) => (l.startsWith('#') ? `${escapeRe(l)}(?![\\p{L}\\p{N}_])` : `(?<![\\p{L}\\p{N}])${escapeRe(l)}(?![\\p{L}\\p{N}])`)).join('|'),
  'giu',
);

/** Every protected label in the text (lower case, as found). */
export const findProtectedLabels = (text: string): string[] => [...text.matchAll(LABEL_RE)].map((m) => m[0].toLowerCase());

/** The text with every protected label replaced by spaces of the same length (offsets stay valid). */
export function maskProtectedLabels(text: string): string {
  return text.replace(LABEL_RE, (m) => ' '.repeat(m.length));
}

interface Rule { kind: SlopKind; re: RegExp; message: string; where?: readonly SlopWhere[] }

const RULES: readonly Rule[] = [
  {
    kind: 'binary_contrast',
    re: /\b(?:nicht|kein(?:e|en|er)?)\s+(?:nur\s+)?[^.!?\n;:]{1,50}?,?\s+sondern\b/giu,
    message: 'Binärer Kontrast („nicht X, sondern Y“) – sag direkt, was gilt.',
  },
  {
    kind: 'binary_contrast',
    re: /\bes geht nicht (?:um|darum)\b[^.!?\n]{1,60}[.,]\s*es geht (?:um|darum)\b/giu,
    message: 'Binärer Kontrast („Es geht nicht um X. Es geht um Y.“) – sag direkt, worum es geht.',
  },
  {
    kind: 'fake_kicker',
    re: /(?:^|(?<=[.!?]\s))(?:und\s+)?(?:das|genau das|dieser moment|das alles)\s+(?:ändert|veränderte?)\s+alles[.!]?/gimu,
    message: 'Fake-Kicker („Das ändert alles.“) – lieber streichen als umdichten.',
  },
  {
    kind: 'fake_kicker',
    re: /(?:^|(?<=[.!?]\s))(?:hier ist die sache|die wahrheit ist|das beste daran|und das beste|spoiler|plot ?twist|das ergebnis|der clou|der trick|das geheimnis|die lösung|und jetzt kommt'?s)\s*[:?!]/gimu,
    message: 'Fake-Kicker / Doppelpunkt-Enthüllung – die Aussage direkt bringen.',
  },
  {
    kind: 'fake_kicker',
    re: /(?:^|(?<=[.!?]\s))(?:und genau das ist (?:der punkt|das problem|die lösung)|lass das mal sacken|denk mal drüber nach|mehr muss man nicht wissen)[.!]?/gimu,
    message: 'Fake-tiefsinniger Schluss – streichen.',
  },
  {
    kind: 'engagement_bait',
    re: /\b(?:kommentier(?:e|t)?\s+(?:mal\s+)?(?:[„"»'‚]|\b[A-ZÄÖÜ]{2,}\b|ein\b|eine?n?\b|mit\b|unten\b|„)|schreib(?:e|t)?\s+(?:mir\s+)?(?:[„"»'‚]\S+[“"«'‘]\s+)?(?:in die|unten in die)\s+kommentare|tagg?(?:e|t)?\s+(?:jemanden|eine freundin|einen freund|deine?n?\s+\w+)|markier(?:e|t)?\s+(?:jemanden|eine freundin|einen freund)|folg(?:e|t)?\s+(?:mir\s+)?für mehr|like(?:n)?,?\s+wenn|doppel-?(?:tipp|tap)|teil(?:e|t)?\s+(?:das|diesen (?:post|reel))\s+mit|link in (?:der |meiner )?bio)\b/giu,
    message: 'Engagement-Bait (Kommentar-/Tag-/Follow-Köder) – passt nicht zu deiner Strategie.',
  },
  {
    kind: 'stock_phrase',
    re: /\b(?:in der heutigen (?:schnelllebigen |digitalen )?(?:welt|zeit)|lass(?:t)? uns (?:direkt )?eintauchen|tauchen wir (?:direkt )?ein|game-?changer|auf das nächste level|aufs nächste level|ein absolutes muss|mehrwert (?:bieten|liefern)|ganzheitlich(?:e|en|er)?|nahtlos(?:e|en|er)?|in diesem video zeige ich (?:dir|euch)|hör auf zu scrollen|stopp? (?:das )?scrollen|stop scrolling|follow for more|you won'?t believe)\b/giu,
    message: 'Stock-Floskel – durch dein eigenes Wort ersetzen.',
  },
];

const EMOJI_LINE = /^\s*\p{Extended_Pictographic}/u;
const DASH_RE = /\s[–—]\s|—/gu;

function sentenceCount(line: string) {
  return line.split(/[.!?]+\s/).filter((x) => x.trim()).length;
}

/**
 * Hints for one text. `where` tunes the checks: dashes are reported in short burned-in texts (overlay, hook) and captions
 * already at one, elsewhere only when they pile up; broetry and emoji bullets only in multi-line texts.
 */
export function slopHints(text: string, where: SlopWhere): SlopHint[] {
  if (!text?.trim()) return [];
  const masked = maskProtectedLabels(text.slice(0, 20_000));
  // a hint never touches a label: matches that overlap one are not reported (she must never be nudged to drop it)
  const labels = [...text.slice(0, 20_000).matchAll(LABEL_RE)].map((m) => [m.index, m.index + m[0].length] as const);
  const hints: SlopHint[] = [];
  const add = (kind: SlopKind, message: string, start: number, end: number) => {
    const excerpt = text.slice(start, end).trim();
    if (!excerpt || hints.some((h) => h.kind === kind && h.start === start)) return;
    if (kind !== 'broetry' && kind !== 'emoji_bullets' && labels.some(([a, b]) => a < end && start < b)) return;
    hints.push({ kind, message, excerpt: excerpt.slice(0, 120), start, end });
  };
  for (const r of RULES) {
    if (r.where && !r.where.includes(where)) continue;
    for (const m of masked.matchAll(r.re)) add(r.kind, r.message, m.index, m.index + m[0].length);
  }
  const dashes = [...masked.matchAll(DASH_RE)];
  const short = where === 'overlay' || where === 'hook' || where === 'caption';
  const tooMany = short ? dashes.length >= 1 : dashes.length >= 3 || (dashes.length >= 2 && masked.length < 400);
  if (tooMany && dashes[0]) {
    const first = dashes[0];
    add('dash', short ? 'Gedankenstrich in kurzem Text – Komma, Punkt oder Doppelpunkt wirken natürlicher.' : `Gedankenstrich-Häufung (${dashes.length}×) – einige durch Komma oder Punkt ersetzen.`, first.index, first.index + first[0].length);
  }
  if (where !== 'overlay' && where !== 'hook') {
    const lines = masked.split('\n');
    let run = 0, runStart = 0, offset = 0, emoji = 0, emojiStart = -1;
    const flushRun = (endOffset: number) => {
      if (run >= 4) add('broetry', `Broetry: ${run} Ein-Satz-Zeilen hintereinander – zu Absätzen zusammenziehen.`, runStart, endOffset);
      run = 0;
    };
    for (const line of lines) {
      const t = line.trim();
      const words = t ? t.split(/\s+/).length : 0;
      if (t && words <= 9 && sentenceCount(t) <= 1 && !t.startsWith('#')) {
        if (run === 0) runStart = offset;
        run++;
      } else flushRun(offset);
      if (EMOJI_LINE.test(line)) { if (emojiStart < 0) emojiStart = offset; emoji++; }
      offset += line.length + 1;
    }
    flushRun(offset - 1);
    if (emoji >= 3) add('emoji_bullets', 'Emojis als Aufzählungszeichen – wirkt nach Vorlage.', emojiStart, Math.min(text.length, emojiStart + 40));
  }
  return hints.sort((a, b) => a.start - b.start);
}

/** Prompt rule for agents that write text (chat, later dramaturgy): the same patterns as instructions. */
export const ANTI_SLOP_PROMPT_RULE = [
  'Schreibstil: kurz, konkret, in ihrer Stimme. Vermeide „nicht X, sondern Y“, Fake-Kicker („Das ändert alles.“, „Das Ergebnis?“),',
  'Doppelpunkt-Enthüllungen, Gedankenstrich-Ketten, Ein-Satz-Zeilen-Ketten (Broetry), Emojis als Aufzählung und Engagement-Bait',
  '(„Kommentiere X“, „Tagge jemanden“, „Folge für mehr“). Kennzeichnungen wie „Anzeige“, „Werbung“, „KI-generiert“ oder #ad bleiben immer unverändert.',
].join(' ');
