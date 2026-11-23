/**
 * Context documents (Etappe 11, E1): one document per kind instead of the Etappe-9 split into `aiSafe`/`localOnly`.
 *
 * - Strategy: structured JSON is the canonical source (pillars, phase, long-term goal …); a superset of the former
 *   import format. Unknown keys are kept in `extras` (capped) instead of being dropped. Optionally the original
 *   Markdown is attached (`attachment`), with its own send switch.
 * - Profile: one Markdown document (plus the sensitive terms used by the client-project boundary lint).
 * - Source (e.g. an interview transcript): its own document kind with a send switch `always | chat_voice_only | never`.
 *
 * Everything parsed here is untrusted input: error messages are fixed texts with a path, never received values, and
 * the content only ever reaches a model as data (`untrustedContext`), never as an instruction.
 */
import { z } from 'zod';
import {
  NO_GO_CATEGORY_LABEL, PHASE_AI_LABEL, PHASE_LABEL, PillarId, ProfileAiSafe, ProfileLocalOnly, SensitiveTerm, StrategyAiSafeDraft,
  StrategyLocalOnly, StudioPhase, type ImportIssue,
} from './strategy';

const S = (max = 300) => z.string().trim().max(max);
const L = (max = 300, n = 20) => z.array(S(max).min(1)).max(n);

// ---------- Limits ----------
export const STRATEGY_JSON_MAX_CHARS = 200_000;
export const PROFILE_MAX_CHARS = 100_000;
export const SOURCE_MAX_CHARS = 200_000;
export const ATTACHMENT_MAX_CHARS = 100_000;
/** Sources longer than this default to „nur Chat und Voice-Analyse“ (an interview would bloat every request). */
export const LARGE_SOURCE_CHARS = 8_000;
export const EXTRAS_MAX_KEYS = 50;
export const EXTRAS_MAX_CHARS = 20_000;
/** Above this, the AI context text gets a size warning (cost and attention of the model). */
export const AI_CONTEXT_WARN_CHARS = 40_000;

export const SendMode = z.enum(['always', 'chat_voice_only', 'never']);
export type SendMode = z.infer<typeof SendMode>;
export const SEND_MODE_LABEL: Record<SendMode, string> = {
  always: 'Immer mitsenden', chat_voice_only: 'Nur Chat und Voice-Analyse', never: 'Nie mitsenden',
};
/** What a request is for: content agents (`agent`) or chat/voice analysis (`chat_voice`). */
export type ContextPurpose = 'agent' | 'chat_voice';
export const sendsFor = (mode: SendMode, purpose: ContextPurpose) => mode === 'always' || (mode === 'chat_voice_only' && purpose === 'chat_voice');
export const defaultSendMode = (chars: number): SendMode => (chars > LARGE_SOURCE_CHARS ? 'chat_voice_only' : 'always');

export const SourceKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, 'Schlüssel: Kleinbuchstaben, Ziffern, Bindestrich');
/** Stable key of a source from its file name (`Kontext Interview.md` → `kontext-interview`). */
export function sourceKeyFromName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return base || 'quelle';
}

// ---------- Schemas ----------
const goalDefault = () => ({ primary: '', secondary: [], success6Months: '', success12Months: '' });
const positioningDefault = () => ({ statement: '', core: '', differentiators: [], notThis: [] });
const cadenceDefault = () => ({ postsPerWeek: null, maxHoursPerWeek: null, notes: '' });
const boundariesDefault = () => ({ showFace: '', showVoice: '', noGos: [], disclosure: '' });

export const StrategyAttachment = z.object({
  name: S(200).default(''),
  markdown: z.string().max(ATTACHMENT_MAX_CHARS),
  sendMode: SendMode.default('chat_voice_only'),
}).strict();
export type StrategyAttachment = z.infer<typeof StrategyAttachment>;

const JsonValue = z.json();
const strategyShape = {
  /** The document's own number (from the file); the studio's version number is separate. */
  version: z.number().int().min(1).max(999).optional(),
  summary: S(2000).default(''),
  /** Phase now (sets pace and which functions are shown). */
  phase: StudioPhase.default('private_trial'),
  /** Long-term goal (sets the direction, e.g. reach and later brand deals). Separate from the phase. */
  longTermGoal: S(1000).default(''),
  goal: z.object({ primary: S(500).default(''), secondary: L(300, 20).default([]), success6Months: S(1000).default(''), success12Months: S(1000).default('') }).default(goalDefault),
  positioning: z.object({ statement: S(600).default(''), core: S(1000).default(''), differentiators: L(300, 20).default([]), notThis: L(300, 20).default([]) }).default(positioningDefault),
  audience: z.array(z.object({ name: S(120), situation: S(800).default(''), needs: L(300, 12).default([]), whatTheyGetFromYou: S(800).default('') })).max(6).default([]),
  pillars: z.array(z.object({
    id: PillarId, name: S(80).min(1), share: z.number().int().min(0).max(100).default(0), purpose: S(600).default(''),
    exampleTopics: L(200, 60).default([]), fitCriteria: L(300, 10).default([]),
  })).min(1).max(6),
  formats: z.array(z.object({ name: S(120), pillarIds: z.array(PillarId).max(6).default([]), notes: S(600).default('') })).max(12).default([]),
  cadence: z.object({
    postsPerWeek: z.number().min(0).max(21).nullable().default(null), maxHoursPerWeek: z.number().min(0).max(80).nullable().default(null), notes: S(600).default(''),
  }).default(cadenceDefault),
  boundaries: z.object({ showFace: S(300).default(''), showVoice: S(300).default(''), noGos: L(300, 60).default([]), disclosure: S(800).default('') }).default(boundariesDefault),
  metrics: z.array(z.object({ goal: S(200), metric: S(300), reviewAfterWeeks: z.number().int().min(1).max(104), decisionRule: S(600).default('') })).max(12).default([]),
  openQuestions: L(400, 40).default([]),
  assumptions: L(400, 40).default([]),
  contentRules: L(400, 30).default([]),
  sensitiveTerms: z.array(SensitiveTerm).max(100).default([]),
  notes: S(4000).default(''),
  attachment: StrategyAttachment.nullable().default(null),
  /** Keys the studio does not know, by path (`pillars[0].mood`), kept as data (capped). */
  extras: z.record(z.string().max(200), JsonValue).default({}),
};
/** Parsing schema: strips unknown keys (they are collected into `extras` first). */
const StrategyDocumentLoose = z.object(strategyShape);

function strategyRefine(v: z.infer<typeof StrategyDocumentLoose>, ctx: z.core.$RefinementCtx) {
  const ids = new Set(v.pillars.map((p) => p.id));
  if (ids.size !== v.pillars.length) ctx.addIssue({ code: 'custom', path: ['pillars'], message: 'Säulen-IDs sind doppelt.' });
  v.formats.forEach((f, i) => f.pillarIds.forEach((id, j) => {
    if (!ids.has(id)) ctx.addIssue({ code: 'custom', path: ['formats', i, 'pillarIds', j], message: 'Format verweist auf eine unbekannte Säule.' });
  }));
  const keys = Object.keys(v.extras);
  if (keys.length > EXTRAS_MAX_KEYS) ctx.addIssue({ code: 'custom', path: ['extras'], message: `Zu viele unbekannte Felder (höchstens ${EXTRAS_MAX_KEYS}).` });
  if (JSON.stringify(v.extras).length > EXTRAS_MAX_CHARS) ctx.addIssue({ code: 'custom', path: ['extras'], message: `Unbekannte Felder sind zu groß (höchstens ${EXTRAS_MAX_CHARS} Zeichen).` });
}
/** The stored strategy document (strict: no key outside the schema). */
export const StrategyDocument = z.object(strategyShape).strict().superRefine(strategyRefine);
export type StrategyDocument = z.infer<typeof StrategyDocument>;
export type StrategyDocumentInput = z.input<typeof StrategyDocument>;

export const ProfileDocument = z.object({
  markdown: z.string().max(PROFILE_MAX_CHARS),
  /** Names, places, companies; used by the client-project boundary lint and read by the AI as context. */
  sensitiveTerms: z.array(SensitiveTerm).max(100).default([]),
}).strict();
export type ProfileDocument = z.infer<typeof ProfileDocument>;

export const SourceDocument = z.object({
  key: SourceKey,
  title: S(200).min(1),
  markdown: z.string().min(1).max(SOURCE_MAX_CHARS),
  sendMode: SendMode,
}).strict();
export type SourceDocument = z.infer<typeof SourceDocument>;

export const ContextKind = z.enum(['strategy', 'profile', 'source']);
export type ContextKind = z.infer<typeof ContextKind>;
export const CONTEXT_KIND_LABEL: Record<ContextKind, string> = { strategy: 'Strategie', profile: 'Profil', source: 'Quelle' };

/** Pillars as the rest of the studio uses them (selection, mix). */
export const strategyPillars = (doc: Pick<StrategyDocument, 'pillars'> | null | undefined) =>
  (doc?.pillars ?? []).map((p) => ({ id: p.id, name: p.name, targetShare: p.share }));

// ---------- Issues ----------
const pathOf = (p: readonly PropertyKey[]) =>
  p.reduce<string>((acc, k) => (typeof k === 'number' ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), '');

/** Fixed German text per Zod issue code. Never includes the received value. */
export function issueText(i: z.core.$ZodIssue): string {
  switch (i.code) {
    case 'invalid_type': return `Fehlt oder falscher Typ (erwartet: ${i.expected}).`;
    case 'too_small': return i.origin === 'array' ? `Zu wenige Einträge (mindestens ${String(i.minimum)}).` : i.origin === 'string' ? `Zu kurz (mindestens ${String(i.minimum)} Zeichen).` : `Wert zu klein (mindestens ${String(i.minimum)}).`;
    case 'too_big': return i.origin === 'array' ? `Zu viele Einträge (höchstens ${String(i.maximum)}).` : i.origin === 'string' ? `Zu lang (höchstens ${String(i.maximum)} Zeichen).` : `Wert zu groß (höchstens ${String(i.maximum)}).`;
    case 'invalid_format': return 'Ungültiges Format (ID: Kleinbuchstaben, Ziffern, Bindestrich).';
    case 'invalid_value': return 'Ungültiger Wert.';
    case 'unrecognized_keys': return 'Unbekanntes Feld.';
    case 'custom': return i.message; // own refine texts, value-free
    default: return 'Ungültiger Eintrag.';
  }
}
export const zodIssues = (e: z.ZodError, max = 50): ImportIssue[] =>
  e.issues.slice(0, max).map((i) => ({ path: pathOf(i.path), message: issueText(i) }));

// ---------- Unknown keys → extras ----------
type Schemaish = z.core.$ZodType;
const defOf = (s: Schemaish) => (s as unknown as { _zod: { def: { type: string; innerType?: Schemaish; element?: Schemaish; shape?: Record<string, Schemaish>; in?: Schemaish } } })._zod.def;
function unwrap(s: Schemaish): Schemaish {
  let cur = s;
  for (let d = defOf(cur); ; d = defOf(cur)) {
    if (['default', 'optional', 'nullable', 'prefault', 'readonly', 'catch'].includes(d.type) && d.innerType) cur = d.innerType;
    else if (d.type === 'pipe' && d.in) cur = d.in;
    else return cur;
  }
}
/** Keys of `raw` the schema does not know, with their values (Zod would strip them silently). */
function collectUnknown(raw: unknown, schema: Schemaish, at: string, out: { path: string; value: unknown }[]) {
  if (out.length > EXTRAS_MAX_KEYS * 4) return;
  const d = defOf(unwrap(schema));
  if (d.type === 'array' && d.element && Array.isArray(raw)) {
    raw.forEach((x, i) => collectUnknown(x, d.element as Schemaish, `${at}[${i}]`, out));
  } else if (d.type === 'object' && d.shape && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const key = k.length > 60 ? `${k.slice(0, 60)}…` : k;
      const p = at ? `${at}.${key}` : key;
      if (!Object.hasOwn(d.shape, k)) out.push({ path: p, value: v });
      else collectUnknown(v, d.shape[k] as Schemaish, p, out);
    }
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Unknown keys as `extras`, within the caps (JSON values only). */
function extrasOf(raw: unknown, existing: Record<string, unknown>): { extras: Record<string, unknown>; kept: string[]; truncated: boolean } {
  const found: { path: string; value: unknown }[] = [];
  collectUnknown(raw, StrategyDocumentLoose, '', found);
  const extras: Record<string, unknown> = {};
  let size = 2;
  let truncated = false;
  const add = (k: string, v: unknown) => {
    const json = JSON.stringify(v ?? null);
    const cost = k.length + (json?.length ?? 4) + 4;
    if (Object.keys(extras).length >= EXTRAS_MAX_KEYS || size + cost > EXTRAS_MAX_CHARS) { truncated = true; return; }
    extras[k] = JSON.parse(json ?? 'null');
    size += cost;
  };
  for (const [k, v] of Object.entries(existing)) add(k.slice(0, 200), v);
  for (const f of found) if (!(f.path in extras)) add(f.path.slice(0, 200), f.value);
  return { extras, kept: found.map((f) => f.path).filter((p) => p in extras), truncated };
}

// ---------- Legacy (Etappe 9/10: aiSafe + localOnly) ----------
const uniqStrings = (xs: unknown[]) => {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const x of xs) {
    if (typeof x !== 'string') { out.push(x); continue; } // non-strings are repaired out below (and recorded)
    const t = x.trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
};
const rec = (x: unknown): Record<string, unknown> => (isRecord(x) ? x : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/** Key in `extras` under which every repair of old data is logged (originals included, capped). */
export const LEGACY_REPAIR_KEY = 'Repariert beim Umwandeln';
export interface LegacyRepair { path: string; what: string; original?: unknown }

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
const toJson = (v: unknown): Json => (v === undefined ? null : (JSON.parse(JSON.stringify(v) ?? 'null') as Json));

function getAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const k of path) cur = cur == null ? undefined : (cur as Record<PropertyKey, unknown>)[k];
  return cur;
}
function parentOf(root: unknown, path: readonly PropertyKey[]) {
  return { parent: getAt(root, path.slice(0, -1)) as Record<PropertyKey, unknown> | unknown[] | undefined, key: path[path.length - 1]! };
}

/**
 * Fixes one Zod issue in place (old data only): too long → shortened, too many → cut, unknown key → removed, anything
 * else → the offending array element is dropped, or the field is reset to its default. The original goes to the log.
 */
function repairIssue(doc: Record<string, unknown>, i: z.core.$ZodIssue, log: LegacyRepair[]): boolean {
  const path = i.path;
  const at = pathOf(path);
  if (i.code === 'unrecognized_keys') {
    const target = rec(getAt(doc, path));
    for (const k of i.keys) {
      log.push({ path: at ? `${at}.${k}` : k, what: 'unbekanntes Feld entfernt', original: toJson(target[k]) });
      delete target[k];
    }
    return true;
  }
  if (i.code === 'too_big' && (i.origin === 'string' || i.origin === 'array')) {
    const { parent, key } = parentOf(doc, path);
    const value = getAt(doc, path);
    if (parent && (typeof value === 'string' || Array.isArray(value))) {
      const max = Number(i.maximum);
      (parent as Record<PropertyKey, unknown>)[key] = value.slice(0, max);
      log.push({ path: at, what: i.origin === 'string' ? `auf ${max} Zeichen gekürzt` : `auf ${max} Einträge gekürzt`, original: toJson(i.origin === 'string' ? value : value.slice(max)) });
      return true;
    }
  }
  // drop the innermost array element that holds the problem, else reset the field to its default
  for (let n = path.length - 1; n >= 0; n--) {
    if (typeof path[n] !== 'number') continue;
    const list = getAt(doc, path.slice(0, n));
    if (Array.isArray(list)) {
      const [removed] = list.splice(path[n] as number, 1);
      log.push({ path: pathOf(path.slice(0, n + 1)), what: `Eintrag entfernt (${issueText(i)})`, original: toJson(removed) });
      return true;
    }
  }
  if (!path.length) return false;
  const { parent, key } = parentOf(doc, path);
  if (!parent || typeof parent !== 'object') return false;
  log.push({ path: at, what: `auf Standard gesetzt (${issueText(i)})`, original: toJson((parent as Record<PropertyKey, unknown>)[key]) });
  delete (parent as Record<PropertyKey, unknown>)[key];
  return true;
}

const LegacyShape = z.object(strategyShape).strict();
const placeholderPillar = () => ({ id: 'ohne-saeule', name: 'Ohne Säule', share: 100, purpose: '', exampleTopics: [], fitCriteria: [] });

/** Unique pillar ids (duplicates get `-2`, `-3`, … within the 40-character id limit) and no dangling format refs. */
function repairPillarRefs(doc: z.infer<typeof LegacyShape>, log: LegacyRepair[]) {
  const seen = new Set<string>();
  doc.pillars = doc.pillars.map((p, i) => {
    if (!seen.has(p.id)) { seen.add(p.id); return p; }
    let id = p.id;
    for (let n = 2; seen.has(id); n++) id = `${p.id.slice(0, 40 - String(n).length - 1)}-${n}`;
    seen.add(id);
    log.push({ path: `pillars[${i}].id`, what: `doppelte Säulen-ID umbenannt in „${id}“ (Konzepte, Pläne und Gates behalten die alte ID)`, original: p.id });
    return { ...p, id };
  });
  doc.formats = doc.formats.map((f, i) => {
    const dangling = f.pillarIds.filter((x) => !seen.has(x));
    if (!dangling.length) return f;
    log.push({ path: `formats[${i}].pillarIds`, what: `Verweis auf unbekannte Säule entfernt (Format „${f.name}“)`, original: dangling });
    return { ...f, pillarIds: f.pillarIds.filter((x) => seen.has(x)) };
  });
}

/** Writes the repair log into extras within the caps; what does not fit is only in the backup. */
function withRepairLog(extras: Record<string, Json>, log: LegacyRepair[]): Record<string, Json> {
  const base = { ...extras };
  const tooBig = () => Object.keys(base).length >= EXTRAS_MAX_KEYS || JSON.stringify(base).length > EXTRAS_MAX_CHARS - 2000;
  while (Object.keys(base).length && tooBig()) {
    const k = Object.keys(base).at(-1)!;
    delete base[k];
    log.push({ path: `extras.${k}`, what: 'zu groß für „Weitere Felder“ – nur im Backup' });
  }
  if (!log.length) return base;
  const entries = log.map((r) => toJson(r));
  const fits = (n: number) => JSON.stringify({ ...base, [LEGACY_REPAIR_KEY]: entries.slice(0, n) }).length <= EXTRAS_MAX_CHARS;
  let n = entries.length;
  while (n > 0 && !fits(n)) n--;
  // too large even without originals: keep path and what only
  const kept: Json[] = n === entries.length ? entries : [...entries.slice(0, n), ...log.slice(n).map((r) => ({ path: r.path, what: r.what, original: 'zu groß – nur im Backup' }))];
  let out = { ...base, [LEGACY_REPAIR_KEY]: kept };
  while (JSON.stringify(out).length > EXTRAS_MAX_CHARS && (out[LEGACY_REPAIR_KEY] as Json[]).length > 1) out = { ...out, [LEGACY_REPAIR_KEY]: (out[LEGACY_REPAIR_KEY] as Json[]).slice(0, -1) };
  return out;
}

/**
 * One strategy document from the Etappe-9/10 split (migration, old standard folder, old exports). Tolerant on purpose:
 * old data that breaks today's rules (duplicate pillar ids, dangling format refs, too long texts, unknown keys,
 * broken entries) is repaired, never rejected, and every repair is logged in `extras` under `LEGACY_REPAIR_KEY`.
 * Nothing is lost: local example topics join their pillar, no-go labels join the no-gos, a custom phase label and
 * topics of a removed pillar go to `extras`.
 */
export function strategyDocFromLegacyRaw(aiRaw: unknown, localRaw: unknown): { document: StrategyDocument; repairs: LegacyRepair[] } {
  const ai = rec(aiRaw);
  const local = rec(localRaw);
  const extras: Record<string, Json> = {};
  const phase = StudioPhase.safeParse(ai.phase).success ? (ai.phase as StudioPhase) : 'private_trial';
  if (str(ai.phaseLabel) && ai.phaseLabel !== PHASE_AI_LABEL[phase]) extras.phaseLabel = str(ai.phaseLabel);
  const pillarsRaw = arr(ai.pillars).map(rec);
  const ids = new Set(pillarsRaw.map((p) => p.id));
  const localTopics = arr(local.localExampleTopics).map(rec);
  const orphanTopics = localTopics.filter((t) => !ids.has(t.pillarId));
  if (orphanTopics.length) extras['Themen ohne Säule'] = toJson(orphanTopics.map((t) => t.topic));
  const boundaries = rec(local.boundaries);
  const candidate: Record<string, unknown> = {
    summary: str(ai.summary), phase, longTermGoal: '',
    goal: local.goal ?? goalDefault(), positioning: local.positioning ?? positioningDefault(), audience: local.audience ?? [],
    pillars: pillarsRaw.map((p) => ({
      id: p.id, name: p.name, share: p.targetShare ?? p.share ?? 0, purpose: p.purpose ?? '',
      exampleTopics: uniqStrings([...arr(p.exampleTopics), ...localTopics.filter((t) => t.pillarId === p.id).map((t) => t.topic)]),
      fitCriteria: arr(p.fitCriteria).map((c) => (isRecord(c) ? c.text : c)),
    })),
    formats: ai.formats ?? [], cadence: local.cadence ?? cadenceDefault(),
    boundaries: {
      showFace: boundaries.showFace ?? '', showVoice: boundaries.showVoice ?? '',
      noGos: uniqStrings([...arr(boundaries.noGos), ...arr(ai.noGoLabels).map((n) => rec(n).label)]), disclosure: ai.disclosure ?? '',
    },
    metrics: local.metrics ?? [], openQuestions: local.openQuestions ?? [], assumptions: local.assumptions ?? [],
    contentRules: ai.contentRules ?? [], sensitiveTerms: local.sensitiveTerms ?? [], notes: local.notes ?? '',
    attachment: null, extras: {},
  };
  // unknown keys of the old parts are kept, not dropped
  for (const [k, v] of Object.entries(ai)) if (!['summary', 'phase', 'phaseLabel', 'pillars', 'formats', 'contentRules', 'noGoLabels', 'disclosure'].includes(k)) extras[`aiSafe.${k}`] = toJson(v);
  for (const [k, v] of Object.entries(local)) if (!['goal', 'positioning', 'audience', 'cadence', 'boundaries', 'metrics', 'openQuestions', 'assumptions', 'localExampleTopics', 'sensitiveTerms', 'notes'].includes(k)) extras[`localOnly.${k}`] = toJson(v);
  // nested unknown keys (Zod would strip them silently) are kept in extras as well
  const nested: { path: string; value: unknown }[] = [];
  collectUnknown(candidate, StrategyDocumentLoose, '', nested);
  for (const n of nested) extras[n.path.slice(0, 200)] = toJson(n.value);
  const log: LegacyRepair[] = [];
  let parsed: z.infer<typeof LegacyShape> | null = null;
  for (let round = 0; round < 500 && !parsed; round++) {
    const r = LegacyShape.safeParse(candidate);
    if (r.success) { parsed = r.data; break; }
    const issue = r.error.issues.find((i) => !(i.path[0] === 'pillars' && i.path.length === 1 && i.code === 'too_small'));
    if (!issue) {
      // no pillar left: a placeholder keeps the document valid
      candidate.pillars = [placeholderPillar()];
      log.push({ path: 'pillars', what: 'keine gültige Säule – Platzhalter „Ohne Säule“ angelegt' });
      continue;
    }
    if (!repairIssue(candidate, issue, log)) break;
  }
  if (!parsed) throw new Error('legacy strategy could not be repaired');
  repairPillarRefs(parsed, log);
  const document = StrategyDocument.parse({ ...parsed, extras: withRepairLog(extras, log) });
  return { document, repairs: log };
}

/** Typed wrapper (old data already shaped like the Etappe-9/10 schemas). */
export const strategyDocFromLegacy = (aiSafe: StrategyAiSafeDraft, local: StrategyLocalOnly | null): StrategyDocument =>
  strategyDocFromLegacyRaw(aiSafe, local).document;

const PROFILE_SECTIONS: [keyof ProfileAiSafe, string][] = [
  ['who', 'Wer ich bin'], ['now', 'Was gerade ist'], ['thread', 'Roter Faden'], ['aiStance', 'Haltung zu KI'],
  ['recurringThemes', 'Wiederkehrende Themen'], ['tone', 'Ton'], ['boundariesGeneral', 'Allgemeine Grenzen'],
];
const bullets = (xs: readonly unknown[]) => xs.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n');

/**
 * One profile Markdown from the Etappe-9/10 form fields and the former local part. Tolerant: any value becomes text,
 * unknown fields get their own section, invalid sensitive terms are listed as text instead of being dropped.
 */
export function profileDocFromLegacyRaw(aiRaw: unknown, localRaw: unknown): ProfileDocument {
  const ai = rec(aiRaw);
  const local = rec(localRaw);
  const section = (title: string, v: unknown) => {
    const body = Array.isArray(v) ? bullets(v) : typeof v === 'string' ? v.trim() : v == null ? '' : JSON.stringify(v);
    return body ? `## ${title}\n\n${body}` : null;
  };
  const known = new Set<string>(PROFILE_SECTIONS.map(([k]) => k));
  const parts: (string | null)[] = ['# Profil', ...PROFILE_SECTIONS.map(([k, t]) => section(t, ai[k]))];
  for (const [k, v] of Object.entries(ai)) if (!known.has(k)) parts.push(section(k, v));
  parts.push(section('Notizen', local.notes), section('Themenideen', local.topicIdeas));
  const terms = arr(local.sensitiveTerms);
  const valid = terms.flatMap((t) => { const r = SensitiveTerm.safeParse(t); return r.success ? [r.data] : []; }).slice(0, 100);
  const invalid = terms.filter((t) => !SensitiveTerm.safeParse(t).success);
  if (invalid.length) parts.push(section('Weitere sensible Begriffe', invalid));
  for (const [k, v] of Object.entries(local)) if (!['notes', 'topicIdeas', 'sensitiveTerms'].includes(k)) parts.push(section(k, v));
  const markdown = `${parts.filter(Boolean).join('\n\n')}\n`.slice(0, PROFILE_MAX_CHARS);
  return ProfileDocument.parse({ markdown, sensitiveTerms: valid });
}
export const profileDocFromLegacy = (aiSafe: ProfileAiSafe, local: ProfileLocalOnly | null): ProfileDocument => profileDocFromLegacyRaw(aiSafe, local);

// ---------- Front matter (standard folder files, re-imports) ----------
/** `---` block at the very start with simple `key: value` lines (max 20). Values are data, never instructions. */
export function splitFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n((?:[A-Za-z][\w-]{0,30}:[^\n]*\r?\n){0,20})---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}
export function withFrontMatter(meta: Record<string, string | null | undefined>, body: string): string {
  const lines = Object.entries(meta).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${String(v).replace(/\r?\n/g, ' ')}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n${body}` : body;
}

// ---------- Parsing ----------
export interface DocIssue extends ImportIssue { severity: 'error' | 'warning' }
export interface StrategyParseResult { ok: boolean; document: StrategyDocument | null; issues: DocIssue[]; extrasKeys: string[]; legacy: boolean }

const errorsOf = (xs: ImportIssue[]): DocIssue[] => xs.map((x) => ({ ...x, severity: 'error' as const }));
const warn = (path: string, message: string): DocIssue => ({ path, message, severity: 'warning' });

/** Non-blocking hints for a valid strategy document. */
export function strategyHints(doc: StrategyDocument, raw?: Record<string, unknown>): DocIssue[] {
  const out: DocIssue[] = [];
  const sum = doc.pillars.reduce((n, p) => n + p.share, 0);
  if (sum !== 100) out.push(warn('pillars', `Anteile der Säulen ergeben ${sum} %, nicht 100 %.`));
  if (!doc.summary.trim()) out.push(warn('summary', 'Keine Kurzfassung – die KI liest dann direkt die Einzelteile.'));
  if (!doc.longTermGoal.trim()) out.push(warn('longTermGoal', 'Kein Fernziel angegeben (z. B. Reichweite, später Brand Deals).'));
  if (raw && !('phase' in raw)) out.push(warn('phase', 'Keine Phase angegeben – „Private Erprobung“ ist voreingestellt.'));
  return out;
}

/**
 * Parses a strategy JSON (the import format, the full document, or an Etappe-10 standard file with aiSafe/localOnly).
 * Unknown keys go to `extras`. Issues name a path and a fixed message, never received text.
 */
export function parseStrategyDocument(text: string): StrategyParseResult {
  const fail = (issues: ImportIssue[], legacy = false): StrategyParseResult => ({ ok: false, document: null, issues: errorsOf(issues), extrasKeys: [], legacy });
  if (typeof text !== 'string' || !text.trim()) return fail([{ path: '', message: 'Kein JSON vorhanden.' }]);
  if (text.length > STRATEGY_JSON_MAX_CHARS) return fail([{ path: '', message: `Die Strategie ist zu groß (höchstens ${STRATEGY_JSON_MAX_CHARS.toLocaleString('de-DE')} Zeichen).` }]);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // Node's message quotes part of the input, so only a numeric position is taken from it.
    const m = /position (\d+)/.exec(err instanceof Error ? err.message : '');
    return fail([{ path: '', message: m ? `Kein gültiges JSON (Position ${m[1]}).` : 'Kein gültiges JSON.' }]);
  }
  if (!isRecord(raw)) return fail([{ path: '', message: 'Erwartet ein JSON-Objekt.' }]);
  if (raw.kind === 'strategy' && isRecord(raw.aiSafe)) return parseLegacyStrategy(raw);
  const { extras, kept, truncated } = extrasOf(raw, isRecord(raw.extras) ? raw.extras : {});
  const r = StrategyDocument.safeParse({ ...stripUnknown(raw), extras });
  if (!r.success) return fail(zodIssues(r.error));
  const issues = strategyHints(r.data, raw);
  if (kept.length) issues.push(warn('extras', `${kept.length} unbekannte(s) Feld(er) unter „Weitere Felder“ übernommen.`));
  if (truncated) issues.push(warn('extras', `Nicht alle unbekannten Felder passen (höchstens ${EXTRAS_MAX_KEYS} bzw. ${EXTRAS_MAX_CHARS} Zeichen) – der Rest wurde nicht übernommen.`));
  return { ok: true, document: r.data, issues, extrasKeys: kept, legacy: false };
}

/** Top-level copy without the keys that went to extras (the strict schema would reject them). */
function stripUnknown(raw: Record<string, unknown>): Record<string, unknown> {
  const strip = (v: unknown, schema: Schemaish): unknown => {
    const d = defOf(unwrap(schema));
    if (d.type === 'array' && d.element && Array.isArray(v)) return v.map((x) => strip(x, d.element as Schemaish));
    if (d.type === 'object' && d.shape && isRecord(v))
      return Object.fromEntries(Object.entries(v).filter(([k]) => Object.hasOwn(d.shape!, k)).map(([k, x]) => [k, strip(x, d.shape![k] as Schemaish)]));
    return v;
  };
  return strip(raw, StrategyDocumentLoose) as Record<string, unknown>;
}

function parseLegacyStrategy(raw: Record<string, unknown>): StrategyParseResult {
  try {
    const { document, repairs } = strategyDocFromLegacyRaw(raw.aiSafe, raw.localOnly);
    const issues = [warn('', 'Altes Format (Etappe 10, getrennte Teile) – in ein Dokument zusammengeführt.'), ...strategyHints(document)];
    if (repairs.length) issues.push(warn('extras', `${repairs.length} Stelle(n) im alten Format repariert – siehe „${LEGACY_REPAIR_KEY}“ unter „Weitere Felder“.`));
    return { ok: true, document, issues, extrasKeys: [], legacy: true };
  } catch {
    return { ok: false, document: null, issues: errorsOf([{ path: '', message: 'Altes Format konnte nicht übernommen werden.' }]), extrasKeys: [], legacy: true };
  }
}

/** Etappe-10 profile file (`{ kind: 'profile', aiSafe, localOnly }`) → profile document, or null when it is not one. */
export function parseLegacyProfile(raw: unknown): { ok: boolean; document: ProfileDocument | null; issues: DocIssue[] } | null {
  if (!isRecord(raw) || raw.kind !== 'profile' || !isRecord(raw.aiSafe)) return null;
  return { ok: true, document: profileDocFromLegacyRaw(raw.aiSafe, raw.localOnly), issues: [warn('', 'Altes Format (Etappe 10) – in ein Markdown-Dokument umgewandelt.')] };
}

const SENSITIVE_TERMS_META = z.array(SensitiveTerm).max(100);
/** Profile Markdown (optionally with front matter `sensitiveTerms: [...]`). */
export function parseProfileMarkdown(text: string): { ok: boolean; document: ProfileDocument | null; issues: DocIssue[] } {
  const { meta, body } = splitFrontMatter(text);
  if (!body.trim()) return { ok: false, document: null, issues: errorsOf([{ path: '', message: 'Das Profil ist leer.' }]) };
  if (body.length > PROFILE_MAX_CHARS) return { ok: false, document: null, issues: errorsOf([{ path: '', message: `Das Profil ist zu lang (höchstens ${PROFILE_MAX_CHARS.toLocaleString('de-DE')} Zeichen).` }]) };
  const issues: DocIssue[] = [];
  let sensitiveTerms: SensitiveTerm[] = [];
  if (meta.sensitiveTerms) {
    try {
      sensitiveTerms = SENSITIVE_TERMS_META.parse(JSON.parse(meta.sensitiveTerms));
    } catch {
      issues.push(warn('sensitiveTerms', 'Die sensiblen Begriffe im Kopf der Datei sind ungültig und wurden nicht übernommen.'));
    }
  }
  return { ok: true, document: { markdown: body, sensitiveTerms }, issues };
}

export function parseSourceMarkdown(text: string, name: string, sendMode?: SendMode): { ok: boolean; document: SourceDocument | null; issues: DocIssue[] } {
  const { meta, body } = splitFrontMatter(text);
  if (!body.trim()) return { ok: false, document: null, issues: errorsOf([{ path: '', message: 'Die Quelle ist leer.' }]) };
  if (body.length > SOURCE_MAX_CHARS) return { ok: false, document: null, issues: errorsOf([{ path: '', message: `Die Quelle ist zu lang (höchstens ${SOURCE_MAX_CHARS.toLocaleString('de-DE')} Zeichen).` }]) };
  const metaMode = SendMode.safeParse(meta.sendMode);
  const key = SourceKey.safeParse(meta.key).success ? meta.key! : sourceKeyFromName(name);
  const heading = /^#{1,3}\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = (meta.title || heading || name.replace(/\.[a-z0-9]{1,5}$/i, '') || 'Quelle').slice(0, 200);
  const mode = sendMode ?? (metaMode.success ? metaMode.data : defaultSendMode(body.length));
  const issues: DocIssue[] = [];
  if (mode === 'chat_voice_only' && !sendMode && !metaMode.success)
    issues.push(warn('sendMode', `Groß (${body.length.toLocaleString('de-DE')} Zeichen): geht nur in Chat und Voice-Analyse, nicht in jede Anfrage.`));
  return { ok: true, document: { key, title, markdown: body, sendMode: mode }, issues };
}

// ---------- Bundle ----------
export const BundleKind = z.enum(['strategy_json', 'strategy_md', 'profile_md', 'source']);
export type BundleKind = z.infer<typeof BundleKind>;
export const BUNDLE_KIND_LABEL: Record<BundleKind, string> = {
  strategy_json: 'Strategie (JSON)', strategy_md: 'Strategie (Markdown-Anhang)', profile_md: 'Profil (Markdown)', source: 'Quelle',
};
export interface BundleFile { name: string; text: string; kind?: BundleKind; sendMode?: SendMode }
export type BundleItem = {
  index: number; name: string; kind: BundleKind; detectedBy: 'choice' | 'header' | 'name' | 'content';
  ok: boolean; issues: DocIssue[]; chars: number;
} & (
  | { kind: 'strategy_json'; document: StrategyDocument | null }
  | { kind: 'strategy_md'; document: StrategyAttachment | null }
  | { kind: 'profile_md'; document: ProfileDocument | null }
  | { kind: 'source'; document: SourceDocument | null }
);
export interface BundleResult { items: BundleItem[]; problems: string[]; ok: boolean }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const HEADER_KIND: Record<string, BundleKind> = { strategie: 'strategy_json', 'strategie-anhang': 'strategy_md', profil: 'profile_md', quelle: 'source' };

/** Which document a file is: explicit choice, front matter, file name, then content. */
export function detectKind(name: string, text: string, choice?: BundleKind): { kind: BundleKind; detectedBy: BundleItem['detectedBy'] } {
  if (choice) return { kind: choice, detectedBy: 'choice' };
  const n = norm(name);
  const trimmed = text.trimStart();
  if (/\.json$/.test(n) || (!/\.(md|txt)$/.test(n) && trimmed.startsWith('{'))) {
    try {
      const raw = JSON.parse(text) as unknown;
      if (isRecord(raw) && raw.kind === 'profile' && isRecord(raw.aiSafe)) return { kind: 'profile_md', detectedBy: 'content' };
    } catch { /* reported by the strategy parser */ }
    return { kind: 'strategy_json', detectedBy: /\.json$/.test(n) ? 'name' : 'content' };
  }
  const header = HEADER_KIND[splitFrontMatter(text).meta.studio ?? ''];
  if (header && header !== 'strategy_json') return { kind: header, detectedBy: 'header' };
  if (/interview|transkript|transcript|quelle|notiz/.test(n)) return { kind: 'source', detectedBy: 'name' };
  if (/strateg/.test(n)) return { kind: 'strategy_md', detectedBy: 'name' };
  if (/profil|profile|ueber-mich|uber-mich|about/.test(n)) return { kind: 'profile_md', detectedBy: 'name' };
  const firstHeading = norm(/^#\s+(.+)$/m.exec(splitFrontMatter(text).body)?.[1] ?? '');
  if (/strategie|strategy/.test(firstHeading)) return { kind: 'strategy_md', detectedBy: 'content' };
  if (/profil|profile|uber mich/.test(firstHeading)) return { kind: 'profile_md', detectedBy: 'content' };
  return { kind: 'source', detectedBy: 'content' };
}

/**
 * Recognises and parses several files at once (drop zone or pasted text). Stores nothing. A bundle holds at most one
 * strategy JSON, one strategy Markdown and one profile; sources get unique keys.
 */
export function parseBundle(files: readonly BundleFile[]): BundleResult {
  const items: BundleItem[] = files.map((f, index) => {
    const { kind, detectedBy } = detectKind(f.name, f.text, f.kind);
    const base = { index, name: f.name, detectedBy, chars: f.text.length };
    switch (kind) {
      case 'strategy_json': {
        const r = parseStrategyDocument(f.text);
        return { ...base, kind, ok: r.ok, issues: r.issues, document: r.document };
      }
      case 'strategy_md': {
        const { body } = splitFrontMatter(f.text);
        if (!body.trim()) return { ...base, kind, ok: false, issues: errorsOf([{ path: '', message: 'Die Datei ist leer.' }]), document: null };
        if (body.length > ATTACHMENT_MAX_CHARS) return { ...base, kind, ok: false, issues: errorsOf([{ path: '', message: `Zu lang für einen Anhang (höchstens ${ATTACHMENT_MAX_CHARS.toLocaleString('de-DE')} Zeichen).` }]), document: null };
        return { ...base, kind, ok: true, issues: [], document: { name: f.name.slice(0, 200), markdown: body, sendMode: f.sendMode ?? 'chat_voice_only' } };
      }
      case 'profile_md': {
        let legacy: ReturnType<typeof parseLegacyProfile> = null;
        try { legacy = parseLegacyProfile(JSON.parse(f.text)); } catch { /* not JSON: Markdown */ }
        const r = legacy ?? parseProfileMarkdown(f.text);
        return { ...base, kind, ok: r.ok, issues: r.issues, document: r.document };
      }
      case 'source': {
        const r = parseSourceMarkdown(f.text, f.name, f.sendMode);
        return { ...base, kind, ok: r.ok, issues: r.issues, document: r.document };
      }
    }
  });
  const problems: string[] = [];
  for (const k of ['strategy_json', 'strategy_md', 'profile_md'] as const)
    if (items.filter((i) => i.kind === k).length > 1) problems.push(`Mehr als eine Datei der Art „${BUNDLE_KIND_LABEL[k]}“ – bitte eine davon als andere Art markieren oder entfernen.`);
  const seen = new Set<string>();
  for (const i of items) {
    if (i.kind !== 'source' || !i.document) continue;
    let key = i.document.key;
    for (let n = 2; seen.has(key); n++) key = `${i.document.key.slice(0, 56)}-${n}`;
    seen.add(key);
    i.document = { ...i.document, key };
  }
  if (!items.length) problems.push('Keine Datei und kein Text.');
  const ok = !problems.length && items.every((i) => i.ok);
  return { items, problems, ok };
}

// ---------- Change overview ----------
const canonical = (x: unknown): string => {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
};
export const sameContent = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export const STRATEGY_FIELD_LABEL: Partial<Record<keyof StrategyDocument, string>> = {
  summary: 'Kurzfassung', goal: 'Ziel', positioning: 'Positionierung', audience: 'Zielgruppe', formats: 'Formate', cadence: 'Rhythmus',
  boundaries: 'Grenzen', metrics: 'Messgrößen', openQuestions: 'Offene Fragen', assumptions: 'Annahmen', contentRules: 'Inhaltsregeln',
  sensitiveTerms: 'Sensible Begriffe', notes: 'Notizen', attachment: 'Anhang', extras: 'Weitere Felder', version: 'Dokument-Nummer',
};

/** Human-readable differences between the active strategy and a new one (German, names from her document). */
export function describeStrategyChanges(prev: StrategyDocument | null, next: StrategyDocument): string[] {
  if (!prev) return [`Neue Strategie mit ${next.pillars.length} Säule(n).`];
  if (sameContent(prev, next)) return ['Unverändert.'];
  const out: string[] = [];
  if (prev.phase !== next.phase) out.push(`Phase: ${PHASE_LABEL[prev.phase]} → ${PHASE_LABEL[next.phase]}`);
  if (prev.longTermGoal !== next.longTermGoal) out.push(next.longTermGoal ? (prev.longTermGoal ? 'Fernziel geändert.' : 'Fernziel neu.') : 'Fernziel entfernt.');
  const before = new Map(prev.pillars.map((p) => [p.id, p]));
  const after = new Map(next.pillars.map((p) => [p.id, p]));
  for (const p of next.pillars) {
    const old = before.get(p.id);
    if (!old) out.push(`Säule neu: ${p.name}`);
    else if (!sameContent(old, p)) out.push(`Säule geändert: ${p.name}${old.share !== p.share ? ` (${old.share} % → ${p.share} %)` : ''}`);
  }
  for (const p of prev.pillars) if (!after.has(p.id)) out.push(`Säule entfernt: ${p.name}`);
  const changed = (Object.keys(STRATEGY_FIELD_LABEL) as (keyof StrategyDocument)[]).filter((k) => !sameContent(prev[k], next[k])).map((k) => STRATEGY_FIELD_LABEL[k]!);
  if (changed.length) out.push(`Geändert: ${changed.join(', ')}`);
  return out.length ? out : ['Kleine Änderungen.'];
}

const headings = (md: string) => [...md.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1]!.trim());
/** Differences between two Markdown texts: size and sections. */
export function describeMarkdownChanges(prev: string | null, next: string): string[] {
  if (prev == null) return [`Neu (${next.length.toLocaleString('de-DE')} Zeichen, ${headings(next).length} Abschnitt(e)).`];
  if (prev === next) return ['Unverändert.'];
  const a = new Set(headings(prev));
  const b = new Set(headings(next));
  const out = [`${prev.length.toLocaleString('de-DE')} → ${next.length.toLocaleString('de-DE')} Zeichen`];
  const added = [...b].filter((h) => !a.has(h));
  const removed = [...a].filter((h) => !b.has(h));
  if (added.length) out.push(`Abschnitte neu: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ' …' : ''}`);
  if (removed.length) out.push(`Abschnitte entfernt: ${removed.slice(0, 8).join(', ')}${removed.length > 8 ? ' …' : ''}`);
  return out;
}

// ---------- Read view ----------
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const list = (xs: readonly string[]) => xs.map((x) => `- ${x.replace(/\r?\n/g, ' ')}`).join('\n');
const para = (s: string) => s.trim();

/** The read view of a strategy, rendered from the JSON so the two never drift apart. Deterministic. */
export function renderStrategyMarkdown(doc: StrategyDocument): string {
  const out: string[] = [];
  const section = (title: string, ...body: (string | false | null | undefined)[]) => {
    const parts = body.filter((b): b is string => !!b && !!b.trim());
    if (parts.length) out.push(`## ${title}\n\n${parts.join('\n\n')}`);
  };
  out.push(`# Strategie${doc.version ? ` (Dokument v${doc.version})` : ''}`);
  out.push([`**Phase (jetzt):** ${PHASE_LABEL[doc.phase]}`, doc.longTermGoal ? `**Fernziel:** ${doc.longTermGoal}` : '**Fernziel:** noch nicht festgelegt'].join('  \n'));
  section('Kurzfassung', para(doc.summary));
  const g = doc.goal;
  section('Ziel',
    g.primary && `**Hauptziel:** ${g.primary}`,
    g.secondary.length > 0 && `**Weitere Ziele:**\n\n${list(g.secondary)}`,
    g.success6Months && `**Erfolg nach 6 Monaten:** ${g.success6Months}`,
    g.success12Months && `**Erfolg nach 12 Monaten:** ${g.success12Months}`);
  const pos = doc.positioning;
  section('Positionierung', para(pos.statement), para(pos.core),
    pos.differentiators.length > 0 && `**Was mich unterscheidet:**\n\n${list(pos.differentiators)}`,
    pos.notThis.length > 0 && `**Was ich nicht bin:**\n\n${list(pos.notThis)}`);
  if (doc.audience.length)
    section('Zielgruppe', ...doc.audience.map((a) => [
      `### ${a.name}`, para(a.situation), a.needs.length ? `**Braucht:**\n\n${list(a.needs)}` : '', a.whatTheyGetFromYou ? `**Bekommt von mir:** ${a.whatTheyGetFromYou}` : '',
    ].filter(Boolean).join('\n\n')));
  section('Säulen',
    ['| Säule | ID | Anteil | Zweck |', '|---|---|---:|---|', ...doc.pillars.map((p) => `| ${cell(p.name)} | \`${p.id}\` | ${p.share} % | ${cell(p.purpose)} |`)].join('\n'),
    ...doc.pillars.map((p) => [
      `### ${p.name} · ${p.share} %`, para(p.purpose),
      p.exampleTopics.length ? `**Beispielthemen:**\n\n${list(p.exampleTopics)}` : '',
      p.fitCriteria.length ? `**Passt, wenn:**\n\n${list(p.fitCriteria)}` : '',
    ].filter(Boolean).join('\n\n')));
  const pillarName = (id: string) => doc.pillars.find((p) => p.id === id)?.name ?? id;
  section('Formate', list(doc.formats.map((f) => `**${f.name}**${f.pillarIds.length ? ` (${f.pillarIds.map(pillarName).join(', ')})` : ''}${f.notes ? ` – ${f.notes}` : ''}`)));
  const c = doc.cadence;
  section('Rhythmus', list([
    c.postsPerWeek != null ? `Posts pro Woche: ${c.postsPerWeek}` : '',
    c.maxHoursPerWeek != null ? `Höchstens ${c.maxHoursPerWeek} Stunden pro Woche` : '',
    c.notes,
  ].filter(Boolean)));
  const b = doc.boundaries;
  section('Grenzen',
    list([b.showFace ? `Gesicht: ${b.showFace}` : '', b.showVoice ? `Stimme: ${b.showVoice}` : ''].filter(Boolean)),
    b.noGos.length > 0 && `**No-gos:**\n\n${list(b.noGos)}`,
    b.disclosure && `**Kennzeichnung:** ${b.disclosure}`);
  section('Inhaltsregeln', list(doc.contentRules));
  if (doc.metrics.length)
    section('Messgrößen', ['| Ziel | Messgröße | Rückblick nach | Entscheidungsregel |', '|---|---|---:|---|',
      ...doc.metrics.map((m) => `| ${cell(m.goal)} | ${cell(m.metric)} | ${m.reviewAfterWeeks} Wochen | ${cell(m.decisionRule) || '–'} |`)].join('\n'));
  section('Offene Fragen', list(doc.openQuestions));
  section('Annahmen', list(doc.assumptions));
  section('Sensible Begriffe', list(doc.sensitiveTerms.map((t) => `${t.term} (${NO_GO_CATEGORY_LABEL[t.category]})`)));
  section('Notizen', para(doc.notes));
  if (Object.keys(doc.extras).length) section('Weitere Felder', `\`\`\`json\n${JSON.stringify(doc.extras, null, 2).replace(/```/g, '`​``')}\n\`\`\``);
  if (doc.attachment) section('Anhang', `Original-Markdown „${doc.attachment.name || 'ohne Namen'}“ (${doc.attachment.markdown.length.toLocaleString('de-DE')} Zeichen) · ${SEND_MODE_LABEL[doc.attachment.sendMode]}`);
  return `${out.join('\n\n')}\n`;
}

// ---------- What the AI reads ----------
function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep((v as Record<string, unknown>)[k])]));
  return v;
}

export interface AiContextInput {
  strategy?: { version: number; document: StrategyDocument } | null;
  profile?: { version: number; document: ProfileDocument } | null;
  sources?: readonly { version: number; document: SourceDocument }[];
}

/** The strategy block as the model reads it: the whole document; the attachment only when its switch allows it. */
function strategyBlock(s: NonNullable<AiContextInput['strategy']>, purpose: ContextPurpose) {
  const { attachment, version: documentVersion, ...rest } = s.document;
  return {
    ...rest, version: s.version, ...(documentVersion ? { documentVersion } : {}),
    ...(attachment && sendsFor(attachment.sendMode, purpose) ? { originalMarkdown: attachment.markdown } : {}),
  };
}

/**
 * The single projection of what reaches a model: deterministic JSON (sorted keys, 2-space indent). Used by the
 * „Das liest die KI“ view, the lineage hash and `untrustedCreativeContext`. `purpose` decides which sources (and the
 * strategy attachment) go along: `always` for every request, `chat_voice_only` only for chat and voice analysis.
 */
export function renderAiContextText(ctx: AiContextInput, purpose: ContextPurpose = 'agent'): string {
  const out: Record<string, unknown> = {};
  if (ctx.strategy) out.strategy = strategyBlock(ctx.strategy, purpose);
  if (ctx.profile) out.profile = { version: ctx.profile.version, ...ctx.profile.document };
  const sources = (ctx.sources ?? []).filter((s) => sendsFor(s.document.sendMode, purpose))
    .map((s) => ({ key: s.document.key, title: s.document.title, version: s.version, markdown: s.document.markdown }));
  if (sources.length) out.sources = sources;
  return Object.keys(out).length ? JSON.stringify(sortKeysDeep(out), null, 2) : '';
}

/** Size hint for the context text (never blocks). */
export function aiContextSizeWarning(text: string): string | null {
  return text.length > AI_CONTEXT_WARN_CHARS
    ? `Der Kontext ist groß (${text.length.toLocaleString('de-DE')} Zeichen): jede Anfrage wird teurer. Große Quellen besser auf „${SEND_MODE_LABEL.chat_voice_only}“ stellen.`
    : null;
}

/** What the AI can read of one version alone (all switches open): the base of a version's lineage hash. */
export function versionAiText(v:
  | { kind: 'strategy'; version: number; document: StrategyDocument }
  | { kind: 'profile'; version: number; document: ProfileDocument }
  | { kind: 'source'; version: number; document: SourceDocument }): string {
  const entry = { version: v.version, document: v.document };
  if (v.kind === 'strategy') return renderAiContextText({ strategy: entry as { version: number; document: StrategyDocument } }, 'chat_voice');
  if (v.kind === 'profile') return renderAiContextText({ profile: entry as { version: number; document: ProfileDocument } });
  return renderAiContextText({ sources: [{ version: v.version, document: { ...(v.document as SourceDocument), sendMode: 'always' } }] });
}
