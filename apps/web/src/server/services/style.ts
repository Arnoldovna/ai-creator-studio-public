import 'server-only';
import { z } from 'zod';
import {
  composeStyleBible, composeVoiceGuide, emptyStyleForm, emptyVoiceForm, joinList, runStyleDirector, runVoiceDirector, splitList, StyleBibleRules,
  splitFrontMatter, StyleFormInput, suggestPalette, unique, VOICE_MAX_TOTAL_CHARS, VOICE_MIN_CHARS, VOICE_SAMPLE_MAX, VoiceAnalysisRequest, VoiceFormInput, VoiceGuideRules,
  type StyleSuggestion, type VoiceSuggestion,
} from '@studio/core';
import { HttpError } from '../errors';
import {
  must, newId, now, PERSONAL_PROFILE_ID, read, write, type AgentRun, type DirectorSuggestion, type Db, type StyleBibleVersion, type VoiceGuideVersion,
} from '../store';
import { runAgent, type AgentResult, type AgentTask } from './agentRuns';
import { personalBlocks } from './aiContext';

export { StyleFormInput, VoiceFormInput };

type Versioned = { profileId: string; status: string; version: number };
const latest = <T extends { version: number }>(xs: T[]) => xs.reduce<T | null>((a, b) => (!a || b.version > a.version ? b : a), null);
export const nextVersion = (xs: Versioned[], profileId: string) => (latest(xs.filter((v) => v.profileId === profileId))?.version ?? 0) + 1;

/** The version content agents use: the active one (status `approved`), else the latest legacy draft (agents then warn). */
function currentVersion<T extends Versioned>(list: T[], profileId: string): T | null {
  const all = list.filter((v) => v.profileId === profileId);
  return latest(all.filter((v) => v.status === 'approved')) ?? latest(all.filter((v) => v.status === 'draft'));
}
export const currentStyle = (db: Db, profileId = PERSONAL_PROFILE_ID) => currentVersion(db.styleBibles, profileId);
export const currentVoice = (db: Db, profileId = PERSONAL_PROFILE_ID) => currentVersion(db.voiceGuides, profileId);

export const formsOf = (db: Db) => db.styleForms[PERSONAL_PROFILE_ID] ?? { style: emptyStyleForm(), voice: emptyVoiceForm() };

export function approvedObservations(db: Db) {
  const names = new Map(db.references.map((r) => [r.id, r.name]));
  return db.observations
    .filter((o) => o.decision === 'approved' && names.has(o.referenceId))
    .map((o) => ({ ...o, referenceName: names.get(o.referenceId) ?? '' }));
}

export const composeRefs = (db: Db) => db.references.map((r) => ({ id: r.id, palette: r.palette, likes: r.likes, dislikes: r.dislikes }));

export const getStyleState = () =>
  read((db) => {
    const forms = formsOf(db);
    const approved = approvedObservations(db);
    const byVersionDesc = <T extends Versioned>(xs: T[]) => xs.filter((v) => v.profileId === PERSONAL_PROFILE_ID).sort((a, b) => b.version - a.version);
    return {
      form: { ...emptyStyleForm(), ...forms.style },
      voiceForm: forms.voice,
      versions: byVersionDesc(db.styleBibles),
      voiceVersions: byVersionDesc(db.voiceGuides),
      current: currentStyle(db),
      approvedObservations: approved,
      pendingObservationCount: db.observations.filter((o) => o.decision === 'pending').length,
      suggestedPalette: suggestPalette(composeRefs(db), approved),
      likedReferenceCount: db.references.filter((r) => r.likes.length).length,
      suggestions: latestSuggestions(db, new Set(approved.map((o) => o.id))),
    };
  });

type StyleSuggestionRec = Extract<DirectorSuggestion, { kind: 'style' }>;
type VoiceSuggestionRec = Extract<DirectorSuggestion, { kind: 'voice' }>;

/**
 * Newest suggestion per kind. A style suggestion whose observations are no longer all approved
 * (rejected/reset later or reference deleted) is `outdated`: it can still be used, the UI and the save show a warning.
 */
function latestSuggestions(db: Db, approvedIds: Set<string>) {
  let style: StyleSuggestionRec | null = null, voice: VoiceSuggestionRec | null = null;
  for (let i = db.directorSuggestions.length - 1; i >= 0 && !(style && voice); i--) {
    const s = db.directorSuggestions[i]!;
    if (s.profileId !== PERSONAL_PROFILE_ID) continue;
    if (s.kind === 'style') style ??= s;
    else if (s.kind === 'voice') voice ??= s;
  }
  return {
    style: style ? { ...style, outdated: !style.observationIds.every((id) => approvedIds.has(id)) } : null,
    voice,
  };
}

export const OUTDATED_SUGGESTION_WARNING = 'Der Vorschlag beruht auf Beobachtungen, die nicht mehr alle bestätigt sind – prüfe die übernommenen Regeln.';

/**
 * Lineage link to the suggestion the form was based on (same kind and profile). Etappe 10: an outdated style
 * suggestion no longer blocks the save, it only adds a warning.
 */
function checkSuggestion(db: Db, suggestionId: string | null | undefined, kind: DirectorSuggestion['kind']): { id: string | null; warnings: string[] } {
  if (!suggestionId) return { id: null, warnings: [] };
  const s = must(db.directorSuggestions.find((x) => x.id === suggestionId && x.kind === kind && x.profileId === PERSONAL_PROFILE_ID), 'Director-Vorschlag');
  if (s.kind === 'style') {
    const approved = new Set(approvedObservations(db).map((o) => o.id));
    if (!s.observationIds.every((id) => approved.has(id))) return { id: s.id, warnings: [OUTDATED_SUGGESTION_WARNING] };
  }
  return { id: s.id, warnings: [] };
}

const StyleRulesRequest = z.object({ rules: StyleBibleRules, suggestionId: z.string().nullish() }).strict();
const StyleFormRequest = StyleFormInput.extend({ suggestionId: z.string().nullish() });
const VoiceRulesRequest = z.object({ rules: VoiceGuideRules, suggestionId: z.string().nullish() }).strict();
const VoiceFormRequest = VoiceFormInput.extend({ suggestionId: z.string().nullish() });
/** A body with `rules` is a direct edit of the rules (invalid rules → 400, never a silent fallback to the form). */
const hasRules = (raw: unknown) => !!raw && typeof raw === 'object' && 'rules' in raw;
const parseStyleRequest = (raw: unknown) => (hasRules(raw) ? StyleRulesRequest.parse(raw) : StyleFormRequest.parse(raw));
const parseVoiceRequest = (raw: unknown) => (hasRules(raw) ? VoiceRulesRequest.parse(raw) : VoiceFormRequest.parse(raw));

/** The editor form that shows these rules (lists one per line). */
const styleFormOf = (r: StyleBibleRules): z.infer<typeof StyleFormInput> => StyleFormInput.parse({
  name: r.name, traits: joinList(r.visual.traits, 2000), typography: r.visual.typography, lighting: r.visual.lighting,
  composition: r.visual.composition, textures: r.visual.textures, motion: r.motion.pacing,
  transitions: joinList(r.motion.transitions, 600), avoid: joinList(r.visual.avoid, 2000), palette: r.visual.palette.join(', '),
});

/** Saves a new version and makes it active: the previously active one is archived (history stays). */
export function pushActive<T extends StyleBibleVersion | VoiceGuideVersion>(list: T[], v: T) {
  for (const other of list) if (other.profileId === v.profileId && other.status === 'approved') other.status = 'archived';
  list.push(v);
}

export async function saveForms(raw: unknown) {
  const body = z.object({ style: StyleFormInput.optional(), voice: VoiceFormInput.optional() }).parse(raw);
  return write((db) => {
    const cur = formsOf(db);
    return (db.styleForms[PERSONAL_PROFILE_ID] = { style: body.style ?? cur.style, voice: body.voice ?? cur.voice });
  });
}

/**
 * New Style Bible version, active at once (Etappe 10). From the form: composed with liked references and the
 * CONFIRMED observations (her selection). From `rules`: her direct edit of the active version (chips, palette);
 * reference/observation ids are kept only while they still exist. Returns the version plus `warnings`.
 */
export async function createStyleVersion(raw: unknown) {
  const body = parseStyleRequest(raw);
  return write((db) => {
    let rules: StyleBibleRules;
    if ('rules' in body) {
      const refIds = new Set(db.references.map((r) => r.id));
      const obsIds = new Set(approvedObservations(db).map((o) => o.id));
      rules = {
        ...body.rules,
        approvedReferenceIds: body.rules.approvedReferenceIds.filter((id) => refIds.has(id)),
        approvedObservationIds: body.rules.approvedObservationIds.filter((id) => obsIds.has(id)),
      };
      // „Meine Marke“ is edited only on its own page: a rules edit always keeps the ACTIVE design, never one the
      // client echoed from an older loaded version (Etappe 14, review fix)
      const active = currentStyle(db)?.rules.design;
      if (active) rules.design = active;
      else delete rules.design;
      db.styleForms[PERSONAL_PROFILE_ID] = { style: styleFormOf(rules), voice: formsOf(db).voice };
    } else {
      const { suggestionId: _s, ...form } = body;
      void _s;
      db.styleForms[PERSONAL_PROFILE_ID] = { style: form, voice: formsOf(db).voice };
      rules = StyleBibleRules.parse(composeStyleBible({ form, references: composeRefs(db), approvedObservations: approvedObservations(db) }));
      const design = currentStyle(db)?.rules.design;
      if (design) rules.design = design;
    }
    const suggestion = checkSuggestion(db, body.suggestionId, 'style');
    const v: StyleBibleVersion = {
      id: newId(), profileId: PERSONAL_PROFILE_ID, version: nextVersion(db.styleBibles, PERSONAL_PROFILE_ID), status: 'approved', rules, createdAt: now(), approvedAt: now(),
      suggestionId: suggestion.id,
    };
    pushActive(db.styleBibles, v);
    return { ...v, warnings: suggestion.warnings };
  });
}

/** New Voice Guide version, active at once: from the form (merged with the current examples) or from edited `rules`. */
export async function createVoiceVersion(raw: unknown) {
  const body = parseVoiceRequest(raw);
  return write((db) => {
    let rules: VoiceGuideRules;
    if ('rules' in body) {
      rules = body.rules;
      const cur = formsOf(db).voice;
      db.styleForms[PERSONAL_PROFILE_ID] = { style: formsOf(db).style, voice: { ...cur, traits: joinList(rules.traits, 1500), avoid: joinList(rules.avoid, 1500) } };
    } else {
      const { suggestionId: _s, ...form } = body;
      void _s;
      db.styleForms[PERSONAL_PROFILE_ID] = { style: formsOf(db).style, voice: form };
      rules = VoiceGuideRules.parse(composeVoiceGuide(form, currentVoice(db)?.rules));
    }
    const suggestion = checkSuggestion(db, body.suggestionId, 'voice');
    const v: VoiceGuideVersion = {
      id: newId(), profileId: PERSONAL_PROFILE_ID, version: nextVersion(db.voiceGuides, PERSONAL_PROFILE_ID), status: 'approved', rules, createdAt: now(), approvedAt: now(),
      suggestionId: suggestion.id,
    };
    pushActive(db.voiceGuides, v);
    return { ...v, warnings: suggestion.warnings };
  });
}

/** Reactivates an older (archived) or legacy draft version; the active one is archived. */
export async function approveVersion(kind: 'style' | 'voice', id: string) {
  return write((db) => {
    const list: (StyleBibleVersion | VoiceGuideVersion)[] = kind === 'style' ? db.styleBibles : db.voiceGuides;
    const v = must(list.find((x) => x.id === id), kind === 'style' ? 'Style-Bible-Version' : 'Voice-Guide-Version');
    for (const other of list) if (other.profileId === v.profileId && other.status === 'approved' && other.id !== id) other.status = 'archived';
    v.status = 'approved';
    v.approvedAt = now();
    return v;
  });
}

export const getStyleVersion = (id: string) =>
  read((db) => {
    const v = must(db.styleBibles.find((x) => x.id === id), 'Style-Bible-Version');
    return { version: v, voice: currentVoice(db) };
  });

/** Kept per kind; older suggestions survive only while a version references them (lineage). */
const MAX_SUGGESTIONS_PER_KIND = 20;

type SuggestionOut<S> = { suggestion: S; warnings: string[] };
/** Runs a director task and stores its suggestion (plus the form it was based on) in one write. */
export async function runDirector<S>(
  task: AgentTask<SuggestionOut<S>>,
  forms: Partial<{ style: z.infer<typeof StyleFormInput>; voice: z.infer<typeof VoiceFormInput> }>,
  build: (base: Omit<DirectorSuggestion, 'kind' | 'output' | 'observationIds' | 'sampleCount'>, result: AgentResult<SuggestionOut<S>>, run: AgentRun) => DirectorSuggestion,
) {
  const { result, run, mock } = await runAgent(task.meta, task.run);
  return write((db) => {
    db.styleForms[PERSONAL_PROFILE_ID] = { ...formsOf(db), ...forms };
    const rec = build(
      { id: newId(), profileId: PERSONAL_PROFILE_ID, agentRunId: run.id, promptVersion: result.promptVersion, warnings: result.output.warnings, mock, createdAt: now() },
      result,
      run,
    );
    db.directorSuggestions.push(rec);
    const linked = new Set([...db.styleBibles, ...db.voiceGuides].map((v) => v.suggestionId).filter(Boolean));
    const keep = new Set(db.directorSuggestions.filter((x) => x.kind === rec.kind).slice(-MAX_SUGGESTIONS_PER_KIND).map((x) => x.id));
    db.directorSuggestions = db.directorSuggestions.filter((x) => x.kind !== rec.kind || keep.has(x.id) || linked.has(x.id));
    return rec;
  });
}

/** Style Director task (no side effects): the current form + APPROVED observations + likes/dislikes. */
export async function prepareStyleSynthesisTask(raw: unknown) {
  const { style } = z.object({ style: StyleFormInput.optional() }).parse(raw ?? {});
  const input = await read((db) => {
    const obs = approvedObservations(db);
    if (!obs.length) throw new HttpError(400, 'Keine bestätigten KI-Beobachtungen – bestätige zuerst Beobachtungen im Review.');
    return {
      form: style ?? formsOf(db).style,
      approvedObservations: obs.map((o) => ({ id: o.id, referenceName: o.referenceName, dimension: o.dimension, kind: o.kind, statement: o.statement, confidence: o.confidence })),
      likes: unique(db.references.flatMap((r) => r.likes)).slice(0, 60),
      dislikes: unique(db.references.flatMap((r) => r.dislikes)).slice(0, 60),
    };
  });
  const task: AgentTask<SuggestionOut<StyleSuggestion>> = {
    meta: { agent: 'style_director', useCase: 'style_synthesis', projectId: null, input },
    run: (p) => runStyleDirector(p, input),
  };
  return { input, style, task };
}

/** Style Director (KI): a suggestion stored for lineage and shown next to the form – it never creates a version. */
export async function synthesizeStyle(raw?: unknown) {
  const { input, style, task } = await prepareStyleSynthesisTask(raw);
  return runDirector(task, style ? { style } : {}, (base, result): StyleSuggestionRec => ({
    ...base, kind: 'style', output: result.output.suggestion, observationIds: input.approvedObservations.map((o) => o.id),
  }));
}

/** New samples first, then texts already stored as own examples, within the analysis cap. */
function voiceSamples(fresh: string[], stored: string[]) {
  const freshTotal = fresh.reduce((n, x) => n + x.length, 0);
  if (freshTotal > VOICE_MAX_TOTAL_CHARS) throw new HttpError(400, `Max. ${VOICE_MAX_TOTAL_CHARS} Zeichen neue Textproben pro Analyse (aktuell ${freshTotal}).`);
  const samples: string[] = [];
  let total = 0, skipped = 0;
  for (const x of unique([...fresh, ...stored.map((t) => t.trim())])) {
    if (total + x.length > VOICE_MAX_TOTAL_CHARS) { skipped++; continue; }
    samples.push(x);
    total += x.length;
  }
  return { samples, skipped };
}

/** Voice Director task (no side effects): the user's own texts; her form entries are passed as her rules. */
export async function prepareVoiceAnalysisTask(raw: unknown) {
  const { samples: fresh, voice } = VoiceAnalysisRequest.extend({ voice: VoiceFormInput.optional() }).parse(raw);
  const { input, skipped } = await read((db) => {
    const form = voice ?? formsOf(db).voice;
    const { samples, skipped } = voiceSamples(fresh, [form.example, ...(currentVoice(db)?.rules.ownExamples ?? [])].filter(Boolean));
    return { input: { samples, userTraits: splitList(form.traits, 30), userAvoid: splitList(form.avoid, 30) }, skipped };
  });
  const task: AgentTask<SuggestionOut<VoiceSuggestion>> = {
    meta: { agent: 'voice_director', useCase: 'voice_analysis', projectId: null, input },
    run: (p) => runVoiceDirector(p, input),
  };
  return { input, voice, skipped, task };
}

/** Voice Director (KI): analyses ONLY the user's own texts; the result fills the voice form on request. */
export async function analyzeVoice(raw: unknown) {
  const { input, voice, skipped, task } = await prepareVoiceAnalysisTask(raw);
  return runDirector(task, voice ? { voice } : {}, (base, result): VoiceSuggestionRec => ({
    ...base, kind: 'voice', output: result.output.suggestion, sampleCount: input.samples.length,
    warnings: skipped ? [...base.warnings, `${skipped} gespeicherte(s) eigene(s) Beispiel(e) wegen der Längengrenze nicht analysiert.`] : base.warnings,
  }));
}

// ---------- Voice from profile and sources (Etappe 11) ----------
/** Interview questions (not her words): „Frage 3:“, „F:“, „Interviewerin:“, „I:“ at the start of a paragraph. */
const QUESTION_LINE = /^(\*\*)?\s*(frage|f|interviewer(in)?|i|q)\b[^:\n]{0,20}:/i;

/** Paragraphs of a Markdown text as voice samples: no front matter, headings, tables or interview questions. */
export function voiceParagraphs(markdown: string): { paragraphs: string[]; questions: number } {
  let questions = 0;
  const paragraphs = splitFrontMatter(markdown).body.split(/\n\s*\n/)
    .map((p) => p.split('\n').filter((l) => !/^\s*(#{1,6}\s|\||---|```)/.test(l)).join('\n').trim())
    .filter((p) => {
      if (QUESTION_LINE.test(p)) { questions++; return false; }
      return p.length >= 20;
    })
    .flatMap((p) => (p.length <= VOICE_SAMPLE_MAX ? [p] : p.match(new RegExp(`[\\s\\S]{1,${VOICE_SAMPLE_MAX}}`, 'g')) ?? []));
  return { paragraphs, questions };
}

/**
 * Voice Director task from her active profile and the sources whose switch allows voice analysis (`always` or
 * `chat_voice_only`), within the analysis cap. No side effects; the result is a suggestion she saves herself.
 */
export async function prepareVoiceFromContextTask() {
  const { input, notes } = await read((db) => {
    const blocks = personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'chat_voice');
    const docs = [
      ...(blocks.profile ? [{ label: 'Profil', markdown: blocks.profile.document.markdown }] : []),
      ...blocks.sources.map((s) => ({ label: `Quelle „${s.document.title}“`, markdown: s.document.markdown })),
    ];
    if (!docs.length) throw new HttpError(400, 'Kein aktives Profil und keine Quelle für die Voice-Analyse – lege zuerst Profil oder Quellen ab.');
    const samples: string[] = [];
    let total = 0, skipped = 0, questions = 0;
    for (const d of docs) {
      const r = voiceParagraphs(d.markdown);
      questions += r.questions;
      for (const p of r.paragraphs) {
        if (samples.length >= 40 || total + p.length > VOICE_MAX_TOTAL_CHARS) { skipped++; continue; }
        samples.push(p);
        total += p.length;
      }
    }
    const form = formsOf(db).voice;
    const notes: string[] = [`Gelesen: ${docs.map((d) => d.label).join(', ')}.`];
    if (questions) notes.push(`${questions} Interviewfrage(n) ausgelassen (nicht deine Worte).`);
    if (skipped) notes.push(`${skipped} Absatz/Absätze wegen der Längengrenze (${VOICE_MAX_TOTAL_CHARS} Zeichen) nicht analysiert.`);
    return { input: { samples, userTraits: splitList(form.traits, 30), userAvoid: splitList(form.avoid, 30) }, notes };
  });
  if (input.samples.reduce((n, x) => n + x.length, 0) < VOICE_MIN_CHARS)
    throw new HttpError(400, `Zu wenig eigener Text in Profil und Quellen (mindestens ${VOICE_MIN_CHARS} Zeichen).`);
  const task: AgentTask<SuggestionOut<VoiceSuggestion>> = {
    meta: { agent: 'voice_director', useCase: 'voice_analysis', projectId: null, input },
    run: (p) => runVoiceDirector(p, input),
  };
  return { input, notes, task };
}

/** „Voice Guide aus Profil und Quellen ableiten“: a Voice Director run (budget, mock labelled); only a suggestion. */
export async function deriveVoiceFromContext() {
  const { input, notes, task } = await prepareVoiceFromContextTask();
  return runDirector(task, {}, (base, result): VoiceSuggestionRec => ({
    ...base, kind: 'voice', output: result.output.suggestion, sampleCount: input.samples.length,
    warnings: [...notes, ...base.warnings],
  }));
}
