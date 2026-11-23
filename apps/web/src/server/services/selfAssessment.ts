import 'server-only';
import { z } from 'zod';
import { pillarMix, selfAssessmentSeries, SelfAssessmentInput, SelfAssessmentPatch } from '@studio/core';
import { HttpError } from '../errors';
import { must, newId, now, read, write, type Db, type EditPlan, type SelfAssessment } from '../store';
import { activePillars, currentApproved } from './aiContext';
import { conceptGate, findGate, rootPlanId } from './strategyGate';

/**
 * Self-assessment (Etappe 9, ADR-012, D9): joy, comfort on camera and „fertig“ per session or piece. Display only:
 * the series, the pillar mix and the review hints never change a strategy, style or voice version.
 * Since Etappe 11 the note is stored on the record (no private file any more).
 * The pillar mix counts distinct pieces of personal work: one entry per lineage (concept or free-cut root), the newest.
 */

export const REVIEW_HINT_TEXT = 'Zeit für einen Rückblick? (optional)';
const FINISHED_REQUIRED = 'Bitte angeben, ob es fertig ist.';
const DAY_MS = 86_400_000;

type Pins = { strategyVersionId: string; pillarId: string | null };
type Subject = SelfAssessment['subject'];

/** Pins of a plan, the way publications inherit them: own pins for scripted or approved plans, else the free-cut gate. */
function planPins(db: Db, plan: EditPlan): Pins | null {
  if ((plan.scriptId || plan.status === 'approved') && plan.strategyVersionId != null) return { strategyVersionId: plan.strategyVersionId, pillarId: plan.pillarId ?? null };
  if (plan.scriptId) {
    const script = db.scripts.find((s) => s.id === plan.scriptId);
    if (script?.strategyVersionId != null) return { strategyVersionId: script.strategyVersionId, pillarId: script.pillarId ?? null };
    const g = script ? conceptGate(db, script.conceptId) : null;
    return g ? { strategyVersionId: g.strategyVersionId, pillarId: g.pillarId } : null;
  }
  const g = findGate(db, { kind: 'free_cut', rootPlanId: rootPlanId(db, plan.id) });
  return g?.strategyVersionId != null ? { strategyVersionId: g.strategyVersionId, pillarId: g.pillarId } : null;
}

/** The subject's project and pins, or null when the subject no longer exists (it may be deleted after the check-in). */
function findSubject(db: Db, subject: Subject): { projectId: string | null; pins: Pins | null } | null {
  switch (subject.kind) {
    case 'session':
      return { projectId: null, pins: null };
    case 'publication': {
      const p = db.publications.find((x) => x.id === subject.id);
      return p ? { projectId: p.projectId, pins: p.strategyVersionId != null ? { strategyVersionId: p.strategyVersionId, pillarId: p.pillarId ?? null } : null } : null;
    }
    case 'edit_plan': {
      const plan = db.editPlans.find((x) => x.id === subject.id);
      return plan ? { projectId: plan.projectId, pins: planPins(db, plan) } : null;
    }
    case 'render': {
      const r = db.renders.find((x) => x.id === subject.id);
      if (!r) return null;
      const plan = db.editPlans.find((x) => x.id === r.editPlanId);
      return { projectId: r.projectId, pins: plan ? planPins(db, plan) : null };
    }
  }
}

const SUBJECT_NAME = { session: 'Session', publication: 'Veröffentlichung', edit_plan: 'Schnittplan', render: 'Render' } as const;

/** The subject's project and pins (404 when it does not exist). */
const resolveSubject = (db: Db, subject: Subject) => must(findSubject(db, subject) ?? undefined, SUBJECT_NAME[subject.kind]);

const isClientProject = (db: Db, projectId: string | null) => !!projectId && db.projects.find((p) => p.id === projectId)?.kind === 'UGC_CLIENT';

/**
 * A pillar she picks herself must exist in the approved strategy. Client projects carry none of her pillars: a pick
 * there is ignored (stored as null), so an optional field never rejects the whole check-in; the UI hides it anyway.
 */
function ownPillar(db: Db, projectId: string | null, pillarId: string | null): Pins | { strategyVersionId: null; pillarId: null } {
  const approved = currentApproved(db, 'strategy');
  if (pillarId === null || isClientProject(db, projectId)) return approved ? { strategyVersionId: approved.id, pillarId: null } : { strategyVersionId: null, pillarId: null };
  const pillars = activePillars(db);
  if (!approved || !pillars.some((p) => p.id === pillarId)) throw new HttpError(400, `Die Säule „${pillarId}“ gibt es in der freigegebenen Strategie nicht.`);
  return { strategyVersionId: approved.id, pillarId };
}

const toIso = (d: string | undefined) => (d ? new Date(d).toISOString() : now());

export async function createSelfAssessment(raw: unknown): Promise<SelfAssessment> {
  const input = SelfAssessmentInput.parse(raw);
  if (input.subject.kind !== 'session' && input.finished === null) throw new HttpError(422, FINISHED_REQUIRED);
  // a session is not a piece: „fertig“ does not apply, so it can never count in the pillar mix
  const finished = input.subject.kind === 'session' ? null : input.finished;
  const note = input.note.trim();
  return write((db) => {
    if (input.projectId) must(db.projects.find((p) => p.id === input.projectId), 'Projekt');
    const { projectId: subjectProject, pins } = resolveSubject(db, input.subject);
    if (input.projectId && subjectProject && input.projectId !== subjectProject) throw new HttpError(400, 'Das gewählte Stück gehört zu einem anderen Projekt.');
    const projectId = input.projectId ?? subjectProject;
    const lineage = pins ?? ownPillar(db, projectId, input.pillarId);
    const rec: SelfAssessment = {
      id: newId(), projectId, subject: input.subject, pillarId: lineage.pillarId, strategyVersionId: lineage.strategyVersionId,
      joy: input.joy, cameraComfort: input.cameraComfort, finished, note,
      assessedAt: toIso(input.assessedAt), createdAt: now(),
    };
    db.selfAssessments.push(rec);
    return rec;
  });
}

export async function updateSelfAssessment(id: string, raw: unknown): Promise<SelfAssessment> {
  const patch = SelfAssessmentPatch.parse(raw ?? {});
  const existing = await read((db) => must(db.selfAssessments.find((x) => x.id === id), 'Selbstcheck'));
  if (existing.subject.kind !== 'session' && patch.finished === null) throw new HttpError(422, FINISHED_REQUIRED);
  const note = patch.note?.trim();
  return write((db) => {
    const rec = must(db.selfAssessments.find((x) => x.id === id), 'Selbstcheck');
    if (patch.pillarId !== undefined) {
      // a deleted subject has no live pins any more: it behaves like an unpinned one
      const pins = findSubject(db, rec.subject)?.pins ?? null;
      if (pins) throw new HttpError(409, 'Die Säule kommt aus dem verknüpften Stück und lässt sich hier nicht ändern.');
      Object.assign(rec, ownPillar(db, rec.projectId, patch.pillarId));
    }
    for (const k of ['joy', 'cameraComfort'] as const) if (patch[k] !== undefined) Object.assign(rec, { [k]: patch[k] });
    if (patch.finished !== undefined) rec.finished = rec.subject.kind === 'session' ? null : patch.finished;
    if (patch.assessedAt !== undefined) rec.assessedAt = toIso(patch.assessedAt);
    if (note !== undefined) rec.note = note;
    return rec;
  });
}

export async function deleteSelfAssessment(id: string) {
  await write((db) => {
    must(db.selfAssessments.find((x) => x.id === id), 'Selbstcheck');
    db.selfAssessments = db.selfAssessments.filter((x) => x.id !== id);
  });
  return { deleted: id };
}

// ---------- Views (read only) ----------
const Weeks = z.coerce.number().int().min(1).max(104);
export const parseWeeks = (raw: string | null | undefined, fallback: number) => (raw == null || raw === '' ? fallback : Weeks.parse(raw));

function subjectLabel(db: Db, s: Subject): string {
  const planLabel = (plan: EditPlan | undefined) => {
    if (!plan) return 'Schnittplan (gelöscht)';
    const script = plan.scriptId ? db.scripts.find((x) => x.id === plan.scriptId) : null;
    const title = script ? db.concepts.find((c) => c.id === script.conceptId)?.body.title : null;
    return `${title ?? 'Freier Schnitt'} · Schnittplan v${plan.version}`;
  };
  switch (s.kind) {
    case 'session': return 'Session ohne Video';
    case 'publication': return `Veröffentlichung: ${db.publications.find((p) => p.id === s.id)?.title ?? '(gelöscht)'}`;
    case 'edit_plan': return planLabel(db.editPlans.find((p) => p.id === s.id));
    case 'render': {
      const r = db.renders.find((x) => x.id === s.id);
      return r ? `Render vom ${r.createdAt.slice(0, 10)} · ${planLabel(db.editPlans.find((p) => p.id === r.editPlanId))}` : 'Render (gelöscht)';
    }
  }
}

/** Entries (newest first, with their note), the weekly series and the pickable subjects. */
export async function listSelfAssessments(weeks = 12) {
  return read((db) => {
    const entries = [...db.selfAssessments]
      .sort((a, b) => b.assessedAt.localeCompare(a.assessedAt))
      .map((x) => ({ ...x, note: x.note ?? '', subjectLabel: subjectLabel(db, x.subject) }));
    const subjectSource = (kind: Exclude<Subject['kind'], 'session'>, id: string, projectId: string) => {
      const pins = findSubject(db, { kind, id })?.pins ?? null;
      // pinned: the pillar comes from the piece (read only in the form); client: no pillar at all
      return { kind, id, projectId, label: subjectLabel(db, { kind, id }), pinned: !!pins, pillarId: pins?.pillarId ?? null, client: isClientProject(db, projectId) };
    };
    return {
      entries,
      series: selfAssessmentSeries(db.selfAssessments, weeks, new Date()),
      pillars: activePillars(db).map((p) => ({ id: p.id, name: p.name })),
      subjects: [
        ...db.publications.map((p) => subjectSource('publication', p.id, p.projectId)),
        ...db.editPlans.map((p) => subjectSource('edit_plan', p.id, p.projectId)),
        ...db.renders.filter((r) => r.status !== 'failed' && r.status !== 'cancelled').map((r) => subjectSource('render', r.id, r.projectId)),
      ],
    };
  });
}

/** Lineage of a plan: its script's concept, else the free-cut root. Null when the plan is gone. */
function planPiece(db: Db, planId: string): string | null {
  const plan = db.editPlans.find((x) => x.id === planId);
  if (!plan) return null;
  const conceptId = plan.scriptId ? db.scripts.find((x) => x.id === plan.scriptId)?.conceptId : undefined;
  return conceptId ? `concept:${conceptId}` : `plan:${rootPlanId(db, plan.id)}`;
}

/**
 * One key per piece, so a plan, its render and its publication count once: concept (scripted work) or free-cut root
 * plan. A deleted subject falls back to its own id; a session is never a piece.
 */
function pieceKey(db: Db, s: SelfAssessment): string | null {
  const subject = s.subject;
  switch (subject.kind) {
    case 'session':
      return null;
    case 'edit_plan':
      return planPiece(db, subject.id) ?? `edit_plan:${subject.id}`;
    case 'render': {
      const r = db.renders.find((x) => x.id === subject.id);
      return (r && planPiece(db, r.editPlanId)) ?? `render:${subject.id}`;
    }
    case 'publication': {
      const p = db.publications.find((x) => x.id === subject.id);
      if (!p) return `publication:${subject.id}`;
      const fromPlan = p.editPlanId ? planPiece(db, p.editPlanId) : null;
      if (fromPlan) return fromPlan;
      const conceptId = (p.scriptVersionId ? db.scripts.find((x) => x.id === p.scriptVersionId)?.conceptId : null) ?? p.conceptId;
      return conceptId ? `concept:${conceptId}` : `publication:${p.id}`;
    }
  }
}

/** The newest check-in per finished-or-not piece of personal work (client projects are not part of her mix). */
function mixEntries(db: Db): SelfAssessment[] {
  const newest = new Map<string, SelfAssessment>();
  for (const e of db.selfAssessments) {
    if (isClientProject(db, e.projectId)) continue;
    const key = pieceKey(db, e);
    if (key == null) continue;
    const prev = newest.get(key);
    if (!prev || e.assessedAt > prev.assessedAt || (e.assessedAt === prev.assessedAt && e.createdAt > prev.createdAt)) newest.set(key, e);
  }
  return [...newest.values()];
}

/** Plain counts of finished pieces per pillar over the last `weeks` weeks; display only (D9). */
export const selfAssessmentMix = (weeks = 12) =>
  read((db) => {
    const approved = currentApproved(db, 'strategy');
    const to = new Date();
    const from = new Date(to.getTime() - weeks * 7 * DAY_MS);
    const rows = pillarMix(mixEntries(db), activePillars(db), { from: from.toISOString(), to: to.toISOString() });
    return { weeks, from: from.toISOString(), to: to.toISOString(), strategyVersion: approved?.version ?? null, rows, finishedTotal: rows.reduce((n, r) => n + r.count, 0) };
  });

/**
 * „Zeit für einen Rückblick? (optional)“ once the review interval of a metric in the active strategy has passed
 * since it became active. Only the number of weeks is used; the metric texts are not shown here.
 */
export async function reviewHints(today = new Date()) {
  const approved = await read((db) => currentApproved(db, 'strategy'));
  if (!approved?.approvedAt) return [];
  const elapsedWeeks = Math.floor((today.getTime() - Date.parse(approved.approvedAt)) / (7 * DAY_MS));
  const due = approved.document.metrics.map((m) => m.reviewAfterWeeks).filter((w) => w <= elapsedWeeks);
  if (!due.length) return [];
  const weeks = Math.max(...due);
  return [{
    id: `${approved.id}:${weeks}`, text: REVIEW_HINT_TEXT,
    detail: `Strategie v${approved.version} ist seit ${elapsedWeeks} Wochen freigegeben. Geplant war ein Rückblick nach ${weeks} Wochen. Nichts ändert sich automatisch.`,
  }];
}
