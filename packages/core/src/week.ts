/**
 * Wochenboard (Etappe 20): one week at a glance, in HER rhythm – without pressure. Pure and deterministic.
 *
 * - Weeks start on Monday; dates are plain calendar days (`YYYY-MM-DD`), no time zones.
 * - A board item is a planned post: a main post (reel, carousel, idea) or a story, optionally linked to the material it
 *   comes from. Its status (idea → in progress → ready → posted) is hers; „posted“ is only ever set by her – the studio
 *   never posts, schedules or reminds. Empty days are neutral: no warnings, no streaks, nothing marked as missed.
 * - The pillar mix of a week (`weekPillarMix`) is information only (her strategy's target shares next to the planned ones).
 * - Chat patch `week` („verschieb das Reel von Freitag auf Donnerstag“, „Mittwoch frei“, „tausch Montag und Dienstag“):
 *   `applyWeekPatch` works on the week as the model saw it; the studio applies it on her click.
 */
import { z } from 'zod';
import { collapseWs } from './text';

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const IsoDate = z.string().regex(ISO_DATE, 'Datum als JJJJ-MM-TT').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'Ungültiges Datum');

export const WEEKDAYS = ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABEL: Record<Weekday, string> = { mo: 'Montag', di: 'Dienstag', mi: 'Mittwoch', do: 'Donnerstag', fr: 'Freitag', sa: 'Samstag', so: 'Sonntag' };
export const WEEKDAY_SHORT: Record<Weekday, string> = { mo: 'Mo', di: 'Di', mi: 'Mi', do: 'Do', fr: 'Fr', sa: 'Sa', so: 'So' };

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const x = day(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
/** Monday of the week that contains `d`. */
export function weekStartOf(d: string): string {
  const wd = (day(d).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(d, -wd);
}
export const weekDays = (start: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(start, i));
export const weekdayOf = (d: string): Weekday => WEEKDAYS[(day(d).getUTCDay() + 6) % 7]!;
export const inWeek = (start: string, d: string | null): boolean => !!d && d >= start && d <= addDays(start, 6);
/** „KW 47 · 17.–23. Nov. 2026“ */
export function weekLabel(start: string): string {
  const s = day(start), e = day(addDays(start, 6));
  // ISO week number (Thursday rule)
  const th = day(addDays(start, 3));
  const jan4 = new Date(Date.UTC(th.getUTCFullYear(), 0, 4));
  const kw = 1 + Math.round(((th.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  const m = (x: Date) => x.toLocaleDateString('de-DE', { month: 'short', timeZone: 'UTC' });
  return `KW ${kw} · ${s.getUTCDate()}.${m(s) === m(e) ? '' : ` ${m(s)}`}–${e.getUTCDate()}. ${m(e)} ${e.getUTCFullYear()}`;
}

// ---------- Items ----------

export const BOARD_KINDS = ['reel', 'carousel', 'story', 'idea'] as const;
export const BoardKind = z.enum(BOARD_KINDS);
export type BoardKind = z.infer<typeof BoardKind>;
export const BOARD_KIND_LABEL: Record<BoardKind, string> = { reel: 'Reel', carousel: 'Karussell', story: 'Story', idea: 'Idee' };
export const BOARD_SLOTS = ['main', 'story'] as const;
export const BoardSlot = z.enum(BOARD_SLOTS);
export type BoardSlot = z.infer<typeof BoardSlot>;
export const slotOfKind = (k: BoardKind): BoardSlot => (k === 'story' ? 'story' : 'main');
export const BOARD_STATUSES = ['idea', 'in_progress', 'ready', 'posted'] as const;
export const BoardStatus = z.enum(BOARD_STATUSES);
export type BoardStatus = z.infer<typeof BoardStatus>;
export const BOARD_STATUS_LABEL: Record<BoardStatus, string> = { idea: 'Idee', in_progress: 'in Arbeit', ready: 'fertig', posted: 'gepostet' };
/** Where a board item comes from (its editor). */
export const BOARD_REF_KINDS = ['render', 'edit_draft', 'carousel', 'story', 'concept'] as const;
export const BoardRefKind = z.enum(BOARD_REF_KINDS);
export type BoardRefKind = z.infer<typeof BoardRefKind>;
export const REF_KIND_OF: Record<BoardRefKind, BoardKind> = { render: 'reel', edit_draft: 'reel', carousel: 'carousel', story: 'story', concept: 'idea' };
export const MAX_ITEMS_PER_DAY = { main: 3, story: 10 } as const;

/** Her permalink: only a plain https link (shown as a link – no other schemes). */
export const Permalink = z.string().trim().max(500).refine((u) => u === '' || /^https:\/\/[^\s<>"']+$/i.test(u), 'Link bitte als https://…');

export interface WeekItemLike { id: string; date: string | null; slot: BoardSlot; kind: BoardKind; order: number; title: string; pillarId: string | null; status: BoardStatus }

/** Items of a day in order (main posts first, then stories). */
export const dayItems = <T extends WeekItemLike>(items: readonly T[], date: string | null) =>
  items.filter((i) => i.date === date).sort((a, b) => (a.slot === b.slot ? a.order - b.order : a.slot === 'main' ? -1 : 1));

/** Moves an item to `date` (null = „ohne Tag“) at `index` within its slot; the orders of both days are renumbered. */
export function moveBoardItem<T extends WeekItemLike>(items: readonly T[], id: string, date: string | null, index?: number): T[] {
  const it = items.find((x) => x.id === id);
  if (!it) return [...items];
  const others = items.filter((x) => x.id !== id);
  const target = others.filter((x) => x.date === date && x.slot === it.slot).sort((a, b) => a.order - b.order);
  const at = Math.max(0, Math.min(target.length, index ?? target.length));
  target.splice(at, 0, { ...it, date });
  const order = new Map(target.map((x, i) => [x.id, i]));
  const source = others.filter((x) => x.date === it.date && x.slot === it.slot && it.date !== date).sort((a, b) => a.order - b.order);
  source.forEach((x, i) => order.set(x.id, i));
  return items.map((x) => (x.id === id ? { ...x, date, order: order.get(id)! } : order.has(x.id) ? { ...x, order: order.get(x.id)! } : x));
}

export interface WeekMixRow { pillarId: string; name: string; targetShare: number; count: number; share: number }
/**
 * The pillar mix of the week's main posts (stories excluded): planned count and share per pillar next to the strategy's
 * target share. Information only – nothing is warned, enforced or changed.
 */
export function weekPillarMix(items: readonly Pick<WeekItemLike, 'slot' | 'pillarId'>[], pillars: readonly { id: string; name: string; targetShare: number }[]): { rows: WeekMixRow[]; withoutPillar: number; total: number } {
  const main = items.filter((i) => i.slot === 'main');
  const total = main.length;
  const known = new Set(pillars.map((p) => p.id));
  const rows = pillars.map((p) => {
    const count = main.filter((i) => i.pillarId === p.id).length;
    return { pillarId: p.id, name: p.name, targetShare: p.targetShare, count, share: total ? Math.round((count / total) * 100) : 0 };
  });
  return { rows, withoutPillar: main.filter((i) => !i.pillarId || !known.has(i.pillarId)).length, total };
}

/** A stable key of the week's items (ids, days, slots, order): the base a chat proposal was made on. */
export const weekKey = (items: readonly Pick<WeekItemLike, 'id' | 'date' | 'slot' | 'order'>[]) =>
  [...items].sort((a, b) => a.id.localeCompare(b.id)).map((i) => `${i.id}@${i.date ?? '-'}/${i.slot}/${i.order}`).join(';');

// ---------- Chat patch `week` ----------

export const WeekOp = z.union([
  /** Moves the item (or the first item of `kind`) from one day to another. */
  z.object({ op: z.literal('move'), from: z.enum(WEEKDAYS), to: z.enum(WEEKDAYS), kind: BoardKind.nullable(), itemId: z.string().max(100).nullable() }).strict(),
  /** Frees a day: its items go to „ohne Tag“ (nothing is deleted). */
  z.object({ op: z.literal('clear_day'), day: z.enum(WEEKDAYS) }).strict(),
  z.object({ op: z.literal('swap_days'), a: z.enum(WEEKDAYS), b: z.enum(WEEKDAYS) }).strict(),
]);
export type WeekOp = z.infer<typeof WeekOp>;

export class WeekPatchError extends Error {
  constructor(message: string) { super(message); this.name = 'WeekPatchError'; }
}

export interface WeekChange { label: string; kind: 'text'; before: string; after: string }
/**
 * Applies chat ops to the week (`start` = Monday). Returns the moved items (id → new date) and the visible changes.
 * Throws `WeekPatchError` when a named day has nothing to move.
 */
export function applyWeekPatch<T extends WeekItemLike>(start: string, items: readonly T[], rawOps: readonly unknown[]): { items: T[]; moves: { id: string; date: string | null; order: number }[]; changes: WeekChange[] } {
  const ops = z.array(WeekOp).min(1).max(12).parse(rawOps);
  const dateOf = (w: Weekday) => addDays(start, WEEKDAYS.indexOf(w));
  let cur = [...items];
  const changes: WeekChange[] = [];
  const name = (i: T) => `${BOARD_KIND_LABEL[i.kind]} „${collapseWs(i.title, 50)}“`;
  for (const op of ops) {
    if (op.op === 'move') {
      const from = dateOf(op.from), to = dateOf(op.to);
      const cands = dayItems(cur, from).filter((i) => (op.itemId ? i.id === op.itemId : op.kind ? i.kind === op.kind : i.slot === 'main'));
      const it = cands[0];
      if (!it) throw new WeekPatchError(`Am ${WEEKDAY_LABEL[op.from]} gibt es ${op.kind ? `kein(e) ${BOARD_KIND_LABEL[op.kind]}` : 'nichts'} zum Verschieben.`);
      if (from === to) continue;
      cur = moveBoardItem(cur, it.id, to);
      changes.push({ label: name(it), kind: 'text', before: WEEKDAY_LABEL[op.from], after: WEEKDAY_LABEL[op.to] });
    } else if (op.op === 'clear_day') {
      const d = dateOf(op.day);
      const list = dayItems(cur, d);
      if (!list.length) throw new WeekPatchError(`Der ${WEEKDAY_LABEL[op.day]} ist schon frei.`);
      for (const it of list) {
        cur = moveBoardItem(cur, it.id, null);
        changes.push({ label: name(it), kind: 'text', before: WEEKDAY_LABEL[op.day], after: 'ohne Tag (bleibt erhalten)' });
      }
    } else {
      const a = dateOf(op.a), b = dateOf(op.b);
      if (a === b) continue;
      const la = dayItems(cur, a), lb = dayItems(cur, b);
      if (!la.length && !lb.length) throw new WeekPatchError(`${WEEKDAY_LABEL[op.a]} und ${WEEKDAY_LABEL[op.b]} sind beide frei.`);
      for (const it of la) { cur = moveBoardItem(cur, it.id, b); changes.push({ label: name(it), kind: 'text', before: WEEKDAY_LABEL[op.a], after: WEEKDAY_LABEL[op.b] }); }
      for (const it of lb) { cur = moveBoardItem(cur, it.id, a); changes.push({ label: name(it), kind: 'text', before: WEEKDAY_LABEL[op.b], after: WEEKDAY_LABEL[op.a] }); }
    }
  }
  // review fix: the chat keeps the per-day limits of the board (like moving by hand)
  for (const d of weekDays(start)) for (const slot of BOARD_SLOTS) {
    const n = cur.filter((i) => i.date === d && i.slot === slot).length;
    if (n > MAX_ITEMS_PER_DAY[slot]) throw new WeekPatchError(`Höchstens ${MAX_ITEMS_PER_DAY[slot]} ${slot === 'main' ? 'Hauptposts' : 'Stories'} am ${WEEKDAY_LABEL[weekdayOf(d)]}.`);
  }
  const before = new Map(items.map((i) => [i.id, i]));
  const moves = cur.filter((i) => { const b = before.get(i.id)!; return b.date !== i.date || b.order !== i.order; }).map((i) => ({ id: i.id, date: i.date, order: i.order }));
  return { items: cur, moves, changes };
}

const DAY_WORDS: [RegExp, Weekday][] = [
  [/^(?:mo|montag|monday|mon)/, 'mo'], [/^(?:di|dienstag|tuesday|tue)/, 'di'], [/^(?:mi|mittwoch|wednesday|wed)/, 'mi'], [/^(?:do|donnerstag|thursday|thu)/, 'do'],
  [/^(?:fr|freitag|friday|fri)/, 'fr'], [/^(?:sa|samstag|sonnabend|saturday|sat)/, 'sa'], [/^(?:so|sonntag|sunday|sun)/, 'so'],
];
export const parseWeekday = (w: string): Weekday | null => DAY_WORDS.find(([re]) => re.test(w.toLowerCase()))?.[1] ?? null;
const DAY = '(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const KIND_WORDS: [RegExp, BoardKind][] = [[/reel|video/, 'reel'], [/karussell|carousel/, 'carousel'], [/story|stories/, 'story'], [/idee|idea/, 'idea']];

/** Deterministic mock of the chat for the board: „verschieb das Reel von Freitag auf Donnerstag“, „Mittwoch frei“, „tausch Montag und Dienstag“, „Move Friday's reel to Thursday“. */
export function mockWeekOps(message: string): { title: string; ops: WeekOp[] }[] {
  const msg = message.toLowerCase();
  const out: { title: string; ops: WeekOp[] }[] = [];
  const kindIn = (s: string) => KIND_WORDS.find(([re]) => re.test(s))?.[1] ?? null;
  const de = new RegExp(`(?:verschieb\\w*|leg\\w*|pack\\w*|move)\\s+(?:das|den|die|the)?\\s*(\\w+)?\\s*(?:von|vom|am|from)\\s+${DAY}\\s+(?:auf|nach|zu|zum|to|on)\\s+(?:den\\s+)?${DAY}`).exec(msg);
  const en = de ? null : new RegExp(`move\\s+${DAY}(?:'s|s)?\\s+(\\w+)\\s+to\\s+${DAY}`).exec(msg);
  const parts = de ? [de[1], de[2], de[3]] : en ? [en[2], en[1], en[3]] : null;
  if (parts) {
    const [kindWord, from, to] = parts;
    const f = parseWeekday(from ?? ''), t = parseWeekday(to ?? '');
    const kind = kindWord ? kindIn(kindWord) : null;
    if (f && t) out.push({ title: `${kind ? BOARD_KIND_LABEL[kind] : 'Beitrag'} von ${WEEKDAY_LABEL[f]} auf ${WEEKDAY_LABEL[t]}`, ops: [{ op: 'move', from: f, to: t, kind, itemId: null }] });
  }
  const free = new RegExp(`${DAY}\\s+(?:ist\\s+)?(?:frei|freihalten|freilassen|leer|off)`).exec(msg) ?? new RegExp(`(?:mach|halt|lass)\\w*\\s+(?:den\\s+)?${DAY}\\s+frei`).exec(msg);
  if (free) {
    const d = parseWeekday(free[1]!);
    if (d) out.push({ title: `${WEEKDAY_LABEL[d]} frei`, ops: [{ op: 'clear_day', day: d }] });
  }
  const swap = new RegExp(`(?:tausch\\w*|swap)\\s+(?:den\\s+)?${DAY}\\s+(?:und|mit|and|with)\\s+(?:dem\\s+|den\\s+)?${DAY}`).exec(msg);
  if (swap) {
    const a = parseWeekday(swap[1]!), b = parseWeekday(swap[2]!);
    if (a && b) out.push({ title: `${WEEKDAY_LABEL[a]} und ${WEEKDAY_LABEL[b]} tauschen`, ops: [{ op: 'swap_days', a, b }] });
  }
  return out;
}

// ---------- Export (list / calendar without alarms) ----------

export interface WeekExportItem { date: string; kind: BoardKind; title: string; status: BoardStatus; pillar: string | null; note: string; permalink: string | null }
/** Plain text list of the week. */
export function weekText(start: string, items: readonly WeekExportItem[]): string {
  const out = [`Wochenplan ${weekLabel(start)} (aus dem Creator Studio – nur zur Übersicht, nichts wird gepostet)`, ''];
  for (const d of weekDays(start)) {
    const list = items.filter((i) => i.date === d);
    out.push(`${WEEKDAY_LABEL[weekdayOf(d)]}, ${d}`);
    if (!list.length) out.push('  –');
    for (const i of list) out.push(`  • ${BOARD_KIND_LABEL[i.kind]}: ${i.title} (${BOARD_STATUS_LABEL[i.status]})${i.pillar ? ` · ${i.pillar}` : ''}${i.note ? ` – ${collapseWs(i.note, 200)}` : ''}${i.permalink ? ` · ${i.permalink}` : ''}`);
  }
  out.push('');
  return out.join('\n');
}

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Folds iCalendar lines at 75 octets (RFC 5545 §3.1). */
const fold = (line: string) => {
  const out: string[] = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
};
/**
 * The week as all-day calendar entries (.ics). Deliberately WITHOUT alarms (no VALARM): the studio never reminds. `stamp`
 * = the export time (UTC, `YYYYMMDDTHHMMSSZ`).
 */
export function weekIcs(items: readonly (WeekExportItem & { id: string })[], stamp: string): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AI Creator Studio//Wochenboard//DE', 'CALSCALE:GREGORIAN'];
  for (const i of items) {
    const d = i.date.replace(/-/g, '');
    lines.push('BEGIN:VEVENT', `UID:${i.id}@creator-studio.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(i.date, 1).replace(/-/g, '')}`,
      `SUMMARY:${icsEscape(`${BOARD_KIND_LABEL[i.kind]}: ${i.title}`)}`, `DESCRIPTION:${icsEscape(`${BOARD_STATUS_LABEL[i.status]}${i.pillar ? ` · ${i.pillar}` : ''}${i.note ? ` – ${i.note}` : ''}`)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
