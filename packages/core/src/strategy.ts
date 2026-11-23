/**
 * Strategy module basics (Etappe 9, ADR-012; Etappe 10: no gates in her own projects; Etappe 11: one document per
 * kind, see contextDoc.ts).
 *
 * The `*AiSafe*`/`*LocalOnly` schemas below are the Etappe-9/10 split of a context version. They are kept only to
 * read old data (migration of db.json schema 1, old standard-folder files, old exports): `strategyDocFromLegacy` and
 * `profileDocFromLegacy` in contextDoc.ts turn them into one document.
 */
import { z } from 'zod';

const S = (max = 300) => z.string().trim().max(max);
const L = (max = 300, n = 20) => z.array(S(max).min(1)).max(n);
export const PillarId = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'ID: Kleinbuchstaben, Ziffern, Bindestrich');

// ---------- Shared enums + legacy (Etappe 9/10) parts ----------
export const NoGoCategory = z.enum(['children', 'family_conflict', 'employer', 'medical', 'home_location', 'faked_expertise', 'custom']);
export type NoGoCategory = z.infer<typeof NoGoCategory>;
export const NO_GO_CATEGORY_LABEL: Record<NoGoCategory, string> = {
  children: 'Kinder', family_conflict: 'Familienkonflikt', employer: 'Arbeitgeber', medical: 'Gesundheit',
  home_location: 'Wohnort', faked_expertise: 'vorgetäuschte Expertise', custom: 'eigene Liste',
};
export const StudioPhase = z.enum(['private_trial', 'public']);
export type StudioPhase = z.infer<typeof StudioPhase>;
/** UI labels of the phase (D7). */
export const PHASE_LABEL: Record<StudioPhase, string> = { private_trial: 'Private Erprobung', public: 'Öffentlich (eigene Entscheidung)' };
/** Etappe-10 `aiSafe.phaseLabel` default per phase (legacy; a custom label survives in `extras`). */
export const PHASE_AI_LABEL: Record<StudioPhase, string> = { private_trial: 'Private Erprobungsphase', public: 'Öffentlich' };

/** `${pillarId}-f${n}`: own schema, because a 40-character pillar id plus the suffix exceeds `PillarId`. */
export const FitCriterionId = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}-f\d{1,2}$/, 'ID der Passungsfrage ungültig');
export const FitCriterion = z.object({ id: FitCriterionId, text: S(300).min(1) }); // ids assigned at import / in editor
const PillarFields = {
  id: PillarId, name: S(80).min(1), targetShare: z.number().int().min(0).max(100), purpose: S(600),
  exampleTopics: L(200, 20),
};
export const Pillar = z.object({ ...PillarFields, fitCriteria: z.array(FitCriterion).min(1).max(10) }).strict();
export type Pillar = z.infer<typeof Pillar>;
/** Etappe-10 pillars may lack fit criteria. */
export const PillarDraft = z.object({ ...PillarFields, fitCriteria: z.array(FitCriterion).max(10) }).strict();
export const SensitiveTerm = z.object({ term: S(80).min(2), category: NoGoCategory }).strict();
export type SensitiveTerm = z.infer<typeof SensitiveTerm>;

const strategyAiSafeFields = {
  summary: S(800),
  phase: StudioPhase,
  phaseLabel: S(120),
  formats: z.array(z.object({ name: S(120), pillarIds: z.array(PillarId).max(6), notes: S(600) }).strict()).max(12),
  contentRules: L(400, 20),
  noGoLabels: z.array(z.object({ category: NoGoCategory, label: S(120).min(1) }).strict()).max(20),
  disclosure: S(800),
};
export const StrategyAiSafe = z.object({ ...strategyAiSafeFields, pillars: z.array(Pillar).min(1).max(6) }).strict();
export type StrategyAiSafe = z.infer<typeof StrategyAiSafe>;
/** Etappe-9/10 structured part of a strategy version (legacy). */
export const StrategyAiSafeDraft = z.object({ ...strategyAiSafeFields, pillars: z.array(PillarDraft).min(1).max(6) }).strict();
export type StrategyAiSafeDraft = z.infer<typeof StrategyAiSafeDraft>;

export const StrategyLocalOnly = z.object({
  goal: z.object({ primary: S(500), secondary: L(300, 10).default([]), success6Months: S(1000).default(''), success12Months: S(1000).default('') }),
  positioning: z.object({ statement: S(600), core: S(1000).default(''), differentiators: L(300, 12).default([]), notThis: L(300, 12).default([]) }),
  audience: z.array(z.object({ name: S(120), situation: S(800).default(''), needs: L(300, 12).default([]), whatTheyGetFromYou: S(800).default('') })).max(6).default([]),
  cadence: z.object({ postsPerWeek: z.number().min(0).max(21), maxHoursPerWeek: z.number().min(0).max(80).nullable().default(null), notes: S(600).default('') }),
  boundaries: z.object({ showFace: S(300), showVoice: S(300), noGos: L(300, 40) }).strict(),
  metrics: z.array(z.object({ goal: S(200), metric: S(300), reviewAfterWeeks: z.number().int().min(1).max(104), decisionRule: S(600).default('') })).max(12).default([]),
  openQuestions: L(400, 30),
  assumptions: L(400, 30),
  /** example topics the user marked „nur lokal“ in the editor */
  localExampleTopics: z.array(z.object({ pillarId: PillarId, topic: S(200).min(1) }).strict()).max(60),
  sensitiveTerms: z.array(SensitiveTerm).max(100),
  notes: S(4000),
}).strict();
export type StrategyLocalOnly = z.infer<typeof StrategyLocalOnly>;

export const ProfileAiSafe = z.object({
  who: S(400), now: S(400), thread: S(400), aiStance: S(400),
  recurringThemes: L(200, 12), tone: S(400), boundariesGeneral: S(400),
}).strict();
export type ProfileAiSafe = z.infer<typeof ProfileAiSafe>;
export const ProfileLocalOnly = z.object({
  notes: L(1000, 40),
  /** ideas only; never guarded; go to AI only when the user puts one into a brief */
  topicIdeas: L(200, 60),
  sensitiveTerms: z.array(SensitiveTerm).max(100),
}).strict();
export type ProfileLocalOnly = z.infer<typeof ProfileLocalOnly>;

// ---------- Lint overrides (client projects) ----------
/** Answer values of the Etappe-9 FitCheck (kept: old gates in db.json still carry them). */
export const FitAnswerValue = z.enum(['ja', 'nein', 'unklar']);
export type FitAnswerValue = z.infer<typeof FitAnswerValue>;
/** Deliberate release of a boundary-lint finding in a client project (the reason is stored on the gate since Etappe 11). */
export const OverrideRequest = z.object({
  type: z.literal('lint'), fingerprint: z.string().regex(/^[0-9a-f]{8}$/), reason: S(500).min(10, 'Begründung (mind. 10 Zeichen) fehlt'),
});
export type OverrideRequest = z.infer<typeof OverrideRequest>;
export interface LintFinding {
  ruleId: string; category: NoGoCategory; field: string; // e.g. 'hook', 'scenes[2].dialogue', 'overlays[1]', 'aiAssetBriefs[0].prompt'
  fingerprint: string; // fnv1a32 hex of `${category}|${normalized sentence}`
  excerpt: string; // ±30 chars; for `custom` the term is replaced by „[Begriff aus deiner Liste]“
  start: number; end: number; // offsets of the match inside the field text (UI highlights locally)
  message: string; // German, generic, never contains a custom term
}

// ---------- Self-assessment ----------
/** `finished` must be a boolean for non-session subjects; the service answers that with a 422 (Part 4). */
export const SelfAssessmentInput = z.object({
  projectId: z.string().min(1).nullable().default(null),
  subject: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session') }),
    z.object({ kind: z.literal('publication'), id: z.string().min(1) }),
    z.object({ kind: z.literal('edit_plan'), id: z.string().min(1) }),
    z.object({ kind: z.literal('render'), id: z.string().min(1) }),
  ]).default({ kind: 'session' }),
  pillarId: PillarId.nullable().default(null),
  joy: z.number().int().min(1).max(5),
  cameraComfort: z.number().int().min(1).max(5).nullable().default(null), // null = nicht vor der Kamera
  finished: z.boolean().nullable().default(null),
  note: S(1000).default(''), // stored on the record since Etappe 11
  assessedAt: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
});
export type SelfAssessmentInput = z.infer<typeof SelfAssessmentInput>;
/** Changes to an entry. Subject and project are fixed; `pillarId` only when the subject carries no pins. No defaults. */
export const SelfAssessmentPatch = z.object({
  pillarId: PillarId.nullable().optional(),
  joy: z.number().int().min(1).max(5).optional(),
  cameraComfort: z.number().int().min(1).max(5).nullable().optional(),
  finished: z.boolean().nullable().optional(),
  note: S(1000).optional(),
  assessedAt: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
}).strict();
export type SelfAssessmentPatch = z.infer<typeof SelfAssessmentPatch>;

export interface ImportIssue { path: string; message: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive, NFC, Unicode word-bounded match of `term` (inner whitespace flexible). */
export function termRegex(term: string, flags = 'iu'): RegExp {
  const body = term.normalize('NFC').trim().split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
}
export const containsTerm = (text: string, term: string) => term.trim().length > 0 && termRegex(term).test(text.normalize('NFC'));

/** Every string leaf of a value (keys excluded). */
export function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringLeaves(x, out));
  return out;
}

// ---------- Pillar mix + self-assessment series (display only, never changes anything) ----------
export interface MixEntry { pillarId: string | null; finished: boolean | null; assessedAt: string }
export interface PillarMixRow { pillarId: string | null; name: string; targetShare: number | null; count: number; actualShare: number }

/** Plain counts of finished self-assessed pieces per pillar in [from, to], plus an „ohne Säule“ row. */
export function pillarMix(entries: readonly MixEntry[], pillars: readonly Pick<Pillar, 'id' | 'name' | 'targetShare'>[], window: { from: string; to: string }): PillarMixRow[] {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const inWindow = entries.filter((e) => {
    const t = Date.parse(e.assessedAt);
    return e.finished === true && t >= from && t <= to;
  });
  const known = new Set(pillars.map((p) => p.id));
  const total = inWindow.length;
  const share = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const rows: PillarMixRow[] = pillars.map((p) => {
    const count = inWindow.filter((e) => e.pillarId === p.id).length;
    return { pillarId: p.id, name: p.name, targetShare: p.targetShare, count, actualShare: share(count) };
  });
  const none = inWindow.filter((e) => e.pillarId == null || !known.has(e.pillarId)).length;
  rows.push({ pillarId: null, name: 'ohne Säule', targetShare: null, count: none, actualShare: share(none) });
  return rows;
}

export interface SeriesEntry { joy: number; cameraComfort: number | null; finished: boolean | null; assessedAt: string; subject?: { kind: string } }
export interface SeriesWeek { week: string; start: string; count: number; sessions: number; finished: number; joyAvg: number | null; comfortAvg: number | null }

/** Monday (UTC) of the ISO week of `d`, and the ISO week label `YYYY-Www`. */
function isoWeek(d: Date): { start: Date; label: string } {
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const thursday = new Date(start.getTime() + 3 * 86_400_000);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - yearStart) / (7 * 86_400_000)) + 1;
  return { start, label: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}` };
}
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/** ISO-week buckets of the last `weeks` weeks up to `today` (oldest first). */
export function selfAssessmentSeries(entries: readonly SeriesEntry[], weeks: number, today: string | Date): SeriesWeek[] {
  const cur = isoWeek(new Date(today)).start;
  const out: SeriesWeek[] = [];
  for (let w = Math.max(1, Math.floor(weeks)) - 1; w >= 0; w--) {
    const start = new Date(cur.getTime() - w * 7 * 86_400_000);
    const end = start.getTime() + 7 * 86_400_000;
    const inWeek = entries.filter((e) => {
      const t = Date.parse(e.assessedAt);
      return t >= start.getTime() && t < end;
    });
    out.push({
      week: isoWeek(start).label, start: start.toISOString().slice(0, 10), count: inWeek.length,
      sessions: inWeek.filter((e) => (e.subject?.kind ?? 'session') === 'session').length,
      finished: inWeek.filter((e) => e.finished === true).length,
      joyAvg: avg(inWeek.map((e) => e.joy)),
      comfortAvg: avg(inWeek.flatMap((e) => (e.cameraComfort == null ? [] : [e.cameraComfort]))),
    });
  }
  return out;
}
