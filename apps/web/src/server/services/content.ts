import 'server-only';
import {
  allowedClaims, BriefInput, approvalBlockers, carryOverFlaggedClaims, enforceClaimAllowlist, runContentStrategist, runUgcScriptwriter,
  validateScript, type ConceptDraft, type CreativeContext, type UgcScript,
} from '@studio/core';
import { HttpError } from '../http';
import { must, newId, now, read, write, type Concept, type Db, type ScriptVersion } from '../store';
import { runAgent, type AgentTask } from './agentRuns';
import { aiContextHash, contextBlocks, type ContextPins } from './aiContext';
import { ideationGrowthHypothesis } from './insights';
import { outputsWithGates } from './scriptAgents';
import { localLintTerms, strategyBlockers, strategyGateError } from './strategyGate';
import { activePillars, scriptTaskPins } from './aiContext';
import { currentStyle, currentVoice } from './style';

/**
 * Routing metadata shared by content agents. Only client data is confidential (`clientData`: strict privacy routing,
 * the Model Lab refuses it). Since Etappe 10 her own strategy/profile context no longer makes a request confidential
 * (D8 replaced, Carola 19.11.). Lineage of style/voice and of the strategy/profile versions actually sent, with the
 * hash of their AI text.
 */
const contentMeta = (ctx: CreativeContext, extra?: unknown) => ({
  confidential: ctx.projectKind === 'UGC_CLIENT',
  clientData: ctx.projectKind === 'UGC_CLIENT',
  inputChars: JSON.stringify(ctx).length + (extra ? JSON.stringify(extra).length : 0),
  styleVersionId: ctx.style?.versionId ?? null,
  voiceVersionId: ctx.voice?.versionId ?? null,
  strategyVersionId: ctx.strategy?.versionId ?? null,
  profileVersionId: ctx.profile?.versionId ?? null,
  aiContextHash: aiContextHash({ strategy: ctx.strategy, profile: ctx.profile, sources: ctx.sources ?? [] }),
});

/**
 * `pinned`: style/voice pins (set = use exactly these, as before) and strategy/profile pins (`undefined` = current
 * approved, `null` = none, id = that version even if archived). Strategy/profile always pass the strict accessors.
 */
type Pinned = { styleId?: string | null; voiceId?: string | null } & ContextPins;
function buildContext(db: Db, brief: BriefInput, pinned?: Pinned): CreativeContext {
  const project = must(db.projects.find((p) => p.id === brief.projectId), 'Projekt');
  const style = pinned?.styleId !== undefined ? (db.styleBibles.find((v) => v.id === pinned.styleId) ?? null) : currentStyle(db, project.profileId);
  const voice = pinned?.voiceId !== undefined ? (db.voiceGuides.find((v) => v.id === pinned.voiceId) ?? null) : currentVoice(db, project.profileId);
  return {
    ...contextBlocks(db, project, { strategyId: pinned?.strategyId, profileId: pinned?.profileId }),
    brief,
    projectKind: project.kind,
    client: project.client,
    style: style ? { versionId: style.id, version: style.version, status: style.status, rules: style.rules } : null,
    voice: voice ? { versionId: voice.id, version: voice.version, status: voice.status, rules: voice.rules } : null,
    // Growth insights are test ideas for ideation only; they never modify style rules. Client data stays in its project.
    growthHypothesis: ideationGrowthHypothesis(db, project),
  };
}

/**
 * Brief check before any spend. Etappe 10: no gate any more. Personal projects need neither an approved
 * strategy nor a pillar; the pillar is an optional field, and one the current strategy does not know (or with
 * no strategy at all) is treated as „keine Säule“. Client projects are not shaped by her pillars (always null).
 */
function normalizeBrief(db: Db, brief: BriefInput): BriefInput {
  const project = must(db.projects.find((p) => p.id === brief.projectId), 'Projekt');
  if (project.kind !== 'PERSONAL_CONTENT' || !brief.pillarId) return brief;
  const pillars = activePillars(db);
  return pillars.some((p) => p.id === brief.pillarId) ? brief : { ...brief, pillarId: null };
}

/** Content Strategist task for a brief (no side effects). */
export async function prepareStrategyTask(raw: unknown) {
  const { brief, ctx } = await read((db) => {
    const brief = normalizeBrief(db, BriefInput.parse(raw));
    return { brief, ctx: buildContext(db, brief) };
  });
  const task: AgentTask<{ concepts: ConceptDraft[]; warnings: string[] }> = {
    meta: { agent: 'content_strategist', useCase: 'content_strategy', projectId: brief.projectId, input: brief, ...contentMeta(ctx) },
    run: (p) => runContentStrategist(p, ctx),
  };
  return { brief, ctx, task };
}

/** Briefing → Style Bible laden → drei Konzepte. */
export async function generateConcepts(raw: unknown) {
  const { brief, ctx, task } = await prepareStrategyTask(raw);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  return write((db) => {
    const briefId = newId();
    db.briefs.push({ id: briefId, projectId: brief.projectId, input: brief, createdAt: now() });
    const concepts: Concept[] = result.output.concepts.map((body, index) => ({
      id: newId(), projectId: brief.projectId, briefId, agentRunId: run.id, index, body, status: 'draft',
      styleBibleVersionId: ctx.style?.versionId ?? null, voiceGuideVersionId: ctx.voice?.versionId ?? null, mock, createdAt: now(),
      strategyVersionId: ctx.strategy?.versionId ?? null, profileVersionId: ctx.profile?.versionId ?? null,
      pillarId: ctx.projectKind === 'PERSONAL_CONTENT' ? brief.pillarId : null,
    }));
    db.concepts.push(...concepts);
    return { briefId, concepts, warnings: result.output.warnings, mock, context: summary(ctx) };
  });
}

const summary = (ctx: CreativeContext) => ({
  style: ctx.style ? { version: ctx.style.version, status: ctx.style.status, name: ctx.style.rules.name } : null,
  voice: ctx.voice ? { version: ctx.voice.version, status: ctx.voice.status } : null,
  growthHypothesis: ctx.growthHypothesis,
});

/** A script version with the creative context it was written in (current style/voice) and the claims ever flagged in its concept lineage. */
/** A script, its project and brief, and every claim ever flagged in its concept lineage (cheap: no style/analytics). */
export function scriptLineage(db: Db, scriptId: string) {
  const script = must(db.scripts.find((s) => s.id === scriptId), 'Skript');
  const concept = must(db.concepts.find((c) => c.id === script.conceptId), 'Konzept');
  const brief = must(db.briefs.find((b) => b.id === concept.briefId), 'Briefing');
  const project = must(db.projects.find((p) => p.id === script.projectId), 'Projekt');
  const lineage = db.scripts.filter((x) => x.conceptId === script.conceptId);
  return { script, brief, project, lineage, lineageFlagged: [...new Set(lineage.flatMap((x) => x.body.claimsToVerify))] };
}

/** scriptLineage + the creative context with the style/voice versions the script was written with. */
export function scriptContext(db: Db, scriptId: string) {
  const l = scriptLineage(db, scriptId);
  return {
    ...l,
    ctx: buildContext(db, l.brief.input, {
      styleId: l.script.styleBibleVersionId, voiceId: l.script.voiceGuideVersionId,
      strategyId: l.script.strategyVersionId, profileId: l.script.profileVersionId,
    }),
  };
}

/** Approvals of copy/storyboard depend on their script being approved – they fall back to draft with it. */
function demoteScriptOutputs(db: Db, scriptIds: Set<string>) {
  for (const o of db.scriptOutputs) if (scriptIds.has(o.scriptId) && o.status === 'approved') Object.assign(o, { status: 'draft', approvedAt: null });
}

/** Routing metadata for agents working on an existing script. */
export const scriptMeta = (ctx: CreativeContext, script: ScriptVersion) => ({ projectId: script.projectId, input: { scriptId: script.id, body: script.body }, ...contentMeta(ctx, script.body) });

/**
 * UGC Scriptwriter task for a concept (no side effects). Selecting a concept approves it: the strategy gate
 * (FitCheck + lint) is checked here, before `runAgent`, so the Model Lab cannot bypass it either.
 */
export async function prepareScriptTask(conceptId: string) {
  const terms = await localLintTerms();
  const { concept, ctx, pillarId } = await read((db) => {
    const concept = must(db.concepts.find((c) => c.id === conceptId), 'Konzept');
    const blockers = strategyBlockers(db, 'concept', concept, terms);
    if (blockers.length) throw strategyGateError(blockers);
    const brief = must(db.briefs.find((b) => b.id === concept.briefId), 'Briefing');
    const project = must(db.projects.find((p) => p.id === concept.projectId), 'Projekt');
    // shared with the concept preview, so the preview shows exactly what this request carries
    const { pins, pillarId } = scriptTaskPins(db, concept, project);
    return { concept, ctx: buildContext(db, { ...brief.input, pillarId }, pins), pillarId };
  });
  const task: AgentTask<UgcScript> = {
    meta: { agent: 'ugc_scriptwriter', useCase: 'ugc_scriptwriting', projectId: concept.projectId, input: { conceptId, brief: ctx.brief }, ...contentMeta(ctx, concept.body) },
    run: (p) => runUgcScriptwriter(p, ctx, concept.body),
  };
  return { concept, ctx, task, pillarId };
}

/** Konzept auswählen → UGC-Skript v1 generieren. */
export async function selectConceptAndWrite(conceptId: string) {
  const { concept, ctx, task, pillarId } = await prepareScriptTask(conceptId);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  return write((db) => {
    for (const c of db.concepts) if (c.briefId === concept.briefId && c.status === 'approved' && c.id !== conceptId) c.status = 'draft';
    must(db.concepts.find((c) => c.id === conceptId), 'Konzept').status = 'approved';
    const version = Math.max(0, ...db.scripts.filter((s) => s.conceptId === conceptId).map((s) => s.version)) + 1;
    const script: ScriptVersion = {
      id: newId(), projectId: concept.projectId, conceptId, version, parentId: null, source: 'agent', agentRunId: run.id,
      promptVersion: result.promptVersion, body: result.output, status: 'draft',
      styleBibleVersionId: ctx.style?.versionId ?? null, voiceGuideVersionId: ctx.voice?.versionId ?? null, mock, createdAt: now(), approvedAt: null,
      strategyVersionId: ctx.strategy?.versionId ?? null, profileVersionId: ctx.profile?.versionId ?? null,
      // the concept's pillar (personal; null if the current strategy does not know it), null in client projects
      pillarId,
    };
    db.scripts.push(script);
    return script;
  });
}

/** Edits never overwrite: every save creates a new version (validated + claim-checked). */
export async function saveScriptEdit(scriptId: string, raw: unknown) {
  return write((db) => {
    const prev = must(db.scripts.find((s) => s.id === scriptId), 'Skript');
    const concept = must(db.concepts.find((c) => c.id === prev.conceptId), 'Konzept');
    const brief = must(db.briefs.find((b) => b.id === concept.briefId), 'Briefing');
    const project = must(db.projects.find((p) => p.id === prev.projectId), 'Projekt');
    const body = enforceClaimAllowlist(
      carryOverFlaggedClaims(prev.body.claimsToVerify, validateScript(raw, brief.input.lengthSeconds)),
      allowedClaims({ brief: brief.input, client: project.client }),
    );
    const version = Math.max(...db.scripts.filter((s) => s.conceptId === prev.conceptId).map((s) => s.version)) + 1;
    const next: ScriptVersion = {
      ...prev, id: newId(), version, parentId: prev.id, source: 'user_edit', agentRunId: null, body, status: 'draft', createdAt: now(), approvedAt: null,
    };
    db.scripts.push(next);
    return next;
  });
}

export async function setScriptStatus(scriptId: string, status: 'approved' | 'rejected' | 'draft', opts: { claimsReviewed?: boolean } = {}) {
  const terms = status === 'approved' ? await localLintTerms() : [];
  return write((db) => {
    const { script: s, lineage, lineageFlagged } = scriptLineage(db, scriptId);
    const demoted = new Set<string>();
    if (status === 'approved') {
      // Etappe 10: personal scripts approve with one click; open claims stay a hint (shown in the editor), not a blocker
      const personal = must(db.projects.find((p) => p.id === s.projectId), 'Projekt').kind === 'PERSONAL_CONTENT';
      const blockers = personal ? [] : approvalBlockers({ script: s.body, lineageFlagged, claimsReviewed: opts.claimsReviewed === true });
      const strategy = strategyBlockers(db, 'script', s, terms);
      if (strategy.length) throw strategyGateError(strategy, blockers);
      if (blockers.length) throw new HttpError(409, `Freigabe blockiert: ${blockers.join(' ')}`);
      // the script keeps the pins it was written with (no FitCheck since Etappe 10; an old gate never overrides them)
      for (const o of lineage) if (o.status === 'approved' && o.id !== s.id) { o.status = 'draft'; demoted.add(o.id); }
    } else if (s.status === 'approved') demoted.add(s.id);
    demoteScriptOutputs(db, demoted);
    s.status = status;
    // An approved client script always carries the user's claim confirmation (approval is impossible without it).
    s.approvedAt = status === 'approved' ? now() : null;
    return s;
  });
}

export const getContent = async (projectId: string) => {
  const terms = await localLintTerms();
  return read((db) => {
    must(db.projects.find((p) => p.id === projectId), 'Projekt');
    const briefs = db.briefs.filter((b) => b.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      briefs,
      concepts: db.concepts.filter((c) => c.projectId === projectId),
      scripts: db.scripts.filter((s) => s.projectId === projectId).sort((a, b) => a.version - b.version),
      scriptOutputs: outputsWithGates(db, projectId, terms),
      researchReports: db.researchReports.filter((r) => r.projectId === projectId).reverse(),
      styleVersions: Object.fromEntries(db.styleBibles.map((v) => [v.id, { version: v.version, status: v.status, name: v.rules.name }])),
      context: summary(buildContext(db, briefs[0]?.input ?? BriefInput.parse({ projectId, topic: '-' }))),
    };
  });
};

export const getScript = (id: string) =>
  read((db) => {
    const s = must(db.scripts.find((x) => x.id === id), 'Skript');
    const concept = db.concepts.find((c) => c.id === s.conceptId);
    return { script: s, concept };
  });
