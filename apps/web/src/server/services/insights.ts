import 'server-only';
import { z } from 'zod';
import { deriveGrowthInsight, growthFacts, growthReportToHypothesis, ResearchRequest, unique, runGrowthAnalyst, runResearchAnalyst, type GrowthPost, type GrowthReport, type ResearchReport } from '@studio/core';
import { HttpError } from '../errors';
import { must, newId, now, read, write, type Db, type GrowthReportRecord, type ResearchReportRecord } from '../store';
import { runAgent, type AgentTask } from './agentRuns';
import { currentPhase } from './aiContext';
import { publicationLineage } from './analytics';

const MAX_GROWTH_REPORTS = 20;
const MAX_RESEARCH_PER_PROJECT = 10;

/** Measured posts with lineage. Client projects are excluded unless explicitly included (confidential routing then). */
export function growthPosts(db: Db, includeClient: boolean): { posts: GrowthPost[]; projectIds: string[]; includesClientData: boolean } {
  const projects = new Map(db.projects.map((p) => [p.id, p]));
  const pubs = new Map(db.publications.filter((p) => includeClient || projects.get(p.projectId)?.kind !== 'UGC_CLIENT').map((p) => [p.id, p]));
  const posts = db.metricSnapshots.flatMap((s): GrowthPost[] => {
    const p = pubs.get(s.publicationId);
    if (!p) return [];
    return [{ publicationId: p.id, title: p.title, hook: p.hook, window: s.window, metrics: s.metrics, observedAt: s.observedAt, format: p.format, ...publicationLineage(db, p) }];
  });
  const projectIds = [...new Set(posts.map((p) => pubs.get(p.publicationId)!.projectId))];
  return { posts, projectIds, includesClientData: projectIds.some((id) => projects.get(id)?.kind === 'UGC_CLIENT') };
}

export const PHASE_PAUSED_MESSAGE = 'Growth-Analyse ist in der privaten Erprobungsphase pausiert.';

/**
 * Growth Analyst task (no side effects). Paused while the approved strategy's phase is „Private Erprobung“ (D7):
 * this covers the route and the Model Lab, which both prepare through here.
 */
export async function prepareGrowthTask(raw: unknown) {
  const { includeClient } = z.object({ includeClient: z.boolean().default(false) }).parse(raw ?? {});
  const { facts, projectIds, includesClientData } = await read((db) => {
    if (currentPhase(db) === 'private_trial') throw new HttpError(409, PHASE_PAUSED_MESSAGE, 'phase_private_trial');
    const g = growthPosts(db, includeClient);
    return { ...g, facts: growthFacts(g.posts) };
  });
  if (!facts.rows.length) throw new HttpError(400, 'Noch keine Messwerte mit Reichweite > 0 – erst Veröffentlichungen und Snapshots erfassen.');
  const task: AgentTask<{ value: GrowthReport; warnings: string[] }> = {
    meta: { agent: 'growth_analyst', useCase: 'growth_analysis', projectId: null, input: facts, confidential: includesClientData, clientData: includesClientData },
    run: (p) => runGrowthAnalyst(p, facts),
  };
  return { task, projectIds, publicationIds: unique(facts.rows.map((r) => r.publicationId)), includesClientData };
}

export async function analyzeGrowth(raw: unknown) {
  const { task, projectIds, publicationIds, includesClientData } = await prepareGrowthTask(raw);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  return write((db) => {
    // The model ran on a snapshot; data deleted meanwhile must not survive in a report.
    if (projectIds.some((id) => !db.projects.some((p) => p.id === id)) || publicationIds.some((id) => !db.publications.some((p) => p.id === id)))
      throw new HttpError(409, 'Analysierte Daten wurden inzwischen gelöscht – bitte Analyse neu starten.');
    const rec: GrowthReportRecord = {
      id: newId(), agentRunId: run.id, promptVersion: result.promptVersion, output: result.output.value, warnings: result.output.warnings, mock,
      projectIds, publicationIds, includesClientData, status: 'draft', approvedAt: null, createdAt: now(),
    };
    db.growthReports.push(rec);
    // Keep the approved one plus the newest drafts.
    const drafts = db.growthReports.filter((r) => r.status === 'draft');
    const drop = new Set(drafts.slice(0, Math.max(0, drafts.length - MAX_GROWTH_REPORTS)).map((r) => r.id));
    db.growthReports = db.growthReports.filter((r) => !drop.has(r.id));
    return rec;
  });
}

/** Human gate "approve use": the approved report becomes the test idea for ideation (only one at a time); `false` withdraws it. */
export async function setGrowthReportUse(id: string, raw: unknown) {
  const { use } = z.object({ use: z.boolean() }).parse(raw);
  return write((db) => {
    const r = must(db.growthReports.find((x) => x.id === id), 'Growth-Bericht');
    if (use && r.includesClientData) throw new HttpError(409, 'Berichte mit Kundendaten fließen nicht in die eigene Ideation ein.');
    if (use && r.output.unverifiedNumbers.length) throw new HttpError(409, 'Bericht enthält Zahlen ohne Beleg in den Daten und kann nicht für Ideation verwendet werden.');
    if (use) for (const x of db.growthReports) if (x.status === 'approved') Object.assign(x, { status: 'draft', approvedAt: null });
    Object.assign(r, use ? { status: 'approved', approvedAt: now() } : { status: 'draft', approvedAt: null });
    return r;
  });
}

export const approvedGrowthReport = (db: Db) => db.growthReports.find((r) => r.status === 'approved') ?? null;

/**
 * Growth input for the Content Strategist, separated by project kind: personal projects get the approved report
 * (human gate) or the rule-based insight from personal data only; a client project only sees its own posts.
 * In the phase „Private Erprobung“ personal projects get none (D7); client work is unaffected.
 */
export function ideationGrowthHypothesis(db: Db, project: { id: string; kind: string }): string | null {
  const isClient = project.kind === 'UGC_CLIENT';
  if (!isClient && currentPhase(db) === 'private_trial') return null;
  const approved = isClient ? null : approvedGrowthReport(db);
  if (approved) return `${approved.mock ? '[MOCK] ' : ''}Freigegebene Growth-Analyse: ${growthReportToHypothesis(approved.output)}`;
  const own = new Set(db.publications.filter((p) => p.projectId === project.id).map((p) => p.id));
  const posts = isClient ? growthPosts(db, true).posts.filter((p) => own.has(p.publicationId)) : growthPosts(db, false).posts;
  const insight = deriveGrowthInsight(posts);
  return insight ? `${insight.hypothesis} (${insight.caveat})` : null;
}

/** Research Analyst task (no side effects). Sources are the user's own paste; URLs are labels and never fetched. */
export async function prepareResearchTask(raw: unknown) {
  const req = ResearchRequest.parse(raw);
  const project = await read((db) => must(db.projects.find((p) => p.id === req.projectId), 'Projekt'));
  const task: AgentTask<{ value: ResearchReport; warnings: string[] }> = {
    meta: { agent: 'research_analyst', useCase: 'content_research', projectId: req.projectId, input: req, confidential: project.kind === 'UGC_CLIENT', clientData: project.kind === 'UGC_CLIENT' },
    run: (p) => runResearchAnalyst(p, req),
  };
  return { req, task };
}

export async function runResearch(raw: unknown) {
  const { req, task } = await prepareResearchTask(raw);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  return write((db) => {
    must(db.projects.find((p) => p.id === req.projectId), 'Projekt');
    const rec: ResearchReportRecord = {
      id: newId(), projectId: req.projectId, agentRunId: run.id, promptVersion: result.promptVersion, topic: req.topic, audience: req.audience, sources: req.sources,
      output: result.output.value, warnings: result.output.warnings, mock, createdAt: now(),
    };
    db.researchReports.push(rec);
    const mine = db.researchReports.filter((r) => r.projectId === req.projectId);
    const drop = new Set(mine.slice(0, Math.max(0, mine.length - MAX_RESEARCH_PER_PROJECT)).map((r) => r.id));
    db.researchReports = db.researchReports.filter((r) => !drop.has(r.id));
    return rec;
  });
}

export const growthReports = () => read((db) => [...db.growthReports].reverse());
