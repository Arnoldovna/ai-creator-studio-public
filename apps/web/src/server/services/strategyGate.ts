import 'server-only';
import { z } from 'zod';
import {
  conceptLintParts, copyLintParts, EditPlanBody, editPlanLintParts, lintBoundaries, OverrideRequest, scriptLintParts,
  storyboardLintParts, type LintFinding, type LintPart, type SensitiveTerm,
} from '@studio/core';
import { HttpError } from '../errors';
import { must, newId, now, read, write, type Concept, type Db, type Project, type ScriptVersion, type StrategyGate } from '../store';
import { lintTermsOf } from './aiContext';

/**
 * Strategy gate (Etappe 9, ADR-012, D5/D6/D10). One gate per piece: on the concept, or for a free cut on the plan
 * lineage root. Scripts, copy, storyboards and edit plans inherit its FitCheck; the boundary lint runs on each
 * object's own text, and lint overrides carry over within the gate by sentence fingerprint.
 * Every approve/prepare function calls `strategyBlockers` (empty = may proceed). Publications are never gated.
 *
 * Etappe 10 (ADR-013, Carola 19.11.: „die Gates nerven, weg damit“): in PERSONAL_CONTENT projects the gate is off.
 * No FitCheck, no boundary lint (not even as a hint), no „Strategie fehlt“ block: every blocker list is empty.
 * UGC_CLIENT projects keep the boundary lint exactly as before (they never had the FitCheck).
 * Etappe 11: the FitCheck is gone (old answers stay as stored data, read only); an override's reason is stored on
 * the gate (no private file any more); the lint terms are the sensitive terms of her strategy/profile documents.
 */

export const GateKind = z.enum(['concept', 'script', 'copy', 'storyboard', 'edit_plan']);
export type GateKind = z.infer<typeof GateKind>;
export type GateSubject = StrategyGate['subject'];

interface Piece {
  kind: GateKind;
  project: Project;
  subject: GateSubject;
  parts: LintPart[];
  /** The script this object depends on (the script itself for kind `script`). */
  script: ScriptVersion | null;
  concept: Concept | null;
  /** Created before Etappe 9 (no strategy pins on the record). */
  legacy: boolean;
}

/** Walks `parentId` to the first version of a scriptless plan (cycle-safe). */
export function rootPlanId(db: Db, planId: string): string {
  let cur = must(db.editPlans.find((p) => p.id === planId), 'Schnittplan');
  const seen = new Set<string>([cur.id]);
  while (cur.parentId) {
    const parent = db.editPlans.find((p) => p.id === cur.parentId && p.projectId === cur.projectId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return cur.id;
}

/** Maps an API kind + id to its piece: concept/script → concept gate, copy/storyboard → their script's concept gate, plan → script's concept gate or free-cut root. */
function resolvePiece(db: Db, kind: GateKind, id: string): Piece {
  const projectOf = (projectId: string) => must(db.projects.find((p) => p.id === projectId), 'Projekt');
  const scriptPiece = (script: ScriptVersion) => {
    const concept = must(db.concepts.find((c) => c.id === script.conceptId), 'Konzept');
    return { concept, subject: { kind: 'concept', conceptId: concept.id } as GateSubject };
  };
  switch (kind) {
    case 'concept': {
      const concept = must(db.concepts.find((c) => c.id === id), 'Konzept');
      return {
        kind, project: projectOf(concept.projectId), subject: { kind: 'concept', conceptId: concept.id },
        parts: conceptLintParts(concept.body), script: null, concept, legacy: concept.strategyVersionId === undefined,
      };
    }
    case 'script': {
      const script = must(db.scripts.find((s) => s.id === id), 'Skript');
      return { kind, project: projectOf(script.projectId), ...scriptPiece(script), parts: scriptLintParts(script.body), script, legacy: script.strategyVersionId === undefined };
    }
    case 'copy':
    case 'storyboard': {
      const o = must(db.scriptOutputs.find((x) => x.id === id && x.kind === kind), kind === 'copy' ? 'Instagram-Copy' : 'Storyboard');
      const script = must(db.scripts.find((s) => s.id === o.scriptId), 'Skript');
      const parts = o.kind === 'copy' ? copyLintParts(o.output) : o.kind === 'storyboard' ? storyboardLintParts(o.output) : [];
      return { kind, project: projectOf(o.projectId), ...scriptPiece(script), parts, script, legacy: script.strategyVersionId === undefined };
    }
    case 'edit_plan': {
      const plan = must(db.editPlans.find((p) => p.id === id), 'Schnittplan');
      const parsed = EditPlanBody.safeParse(plan.body);
      const parts = parsed.success ? editPlanLintParts(parsed.data) : [];
      const project = projectOf(plan.projectId);
      if (plan.scriptId) {
        const script = must(db.scripts.find((s) => s.id === plan.scriptId), 'Skript');
        return { kind, project, ...scriptPiece(script), parts, script, legacy: plan.strategyVersionId === undefined };
      }
      return { kind, project, subject: { kind: 'free_cut', rootPlanId: rootPlanId(db, plan.id) }, parts, script: null, concept: null, legacy: plan.strategyVersionId === undefined };
    }
  }
}

const sameSubject = (a: GateSubject, b: GateSubject) =>
  a.kind === 'concept' ? b.kind === 'concept' && a.conceptId === b.conceptId : b.kind === 'free_cut' && a.rootPlanId === b.rootPlanId;
export const findGate = (db: Db, subject: GateSubject) => db.strategyGates.find((g) => sameSubject(g.subject, subject)) ?? null;

/** A concept's answered FitCheck (scripts pin its strategy version and pillar), or null when none was answered. */
export function conceptGate(db: Db, conceptId: string): (StrategyGate & { strategyVersionId: string }) | null {
  const g = findGate(db, { kind: 'concept', conceptId });
  return g?.strategyVersionId != null ? (g as StrategyGate & { strategyVersionId: string }) : null;
}

/** Etappe 10: personal projects have no gate at all (see the module comment). */
const gateOff = (piece: Piece) => piece.project.kind === 'PERSONAL_CONTENT';

const findingsOf = (piece: Piece, terms: readonly SensitiveTerm[]): LintFinding[] =>
  gateOff(piece) ? [] : lintBoundaries(piece.parts, { projectKind: piece.project.kind, terms });

export interface GateBlocker { type: 'lint'; key: string; message: string; overridable: boolean; fingerprint: string }

/** Every lint finding of the object without an override (one per sentence). */
export function strategyBlockerList(db: Db, kind: GateKind, obj: { id: string }, terms: readonly SensitiveTerm[]): GateBlocker[] {
  const piece = resolvePiece(db, kind, obj.id);
  const gate = findGate(db, piece.subject);
  const seen = new Set<string>();
  const lint: GateBlocker[] = [];
  for (const f of findingsOf(piece, terms)) {
    if (seen.has(f.fingerprint) || gate?.lintOverrides.some((o) => o.fingerprint === f.fingerprint)) continue;
    seen.add(f.fingerprint);
    lint.push({ type: 'lint', key: f.fingerprint, fingerprint: f.fingerprint, message: f.message, overridable: true });
  }
  return lint;
}

/** Used by every approve and prepare function (empty = may proceed). */
export const strategyBlockers = (db: Db, kind: GateKind, obj: { id: string }, terms: readonly SensitiveTerm[]): string[] =>
  strategyBlockerList(db, kind, obj, terms).map((b) => b.message);

/** The error for a blocked gate (422 `strategy_gate`). */
export function strategyGateError(blockers: readonly string[], extra: readonly string[] = []): HttpError {
  return new HttpError(422, `Freigabe blockiert: ${[...extra, ...blockers].join(' ')}`, 'strategy_gate');
}

/** Union of the sensitive terms of every strategy/profile version (all statuses): the client-project lint list. */
export const localLintTerms = (): Promise<SensitiveTerm[]> => read(lintTermsOf);

// ---------- View ----------
export async function gateView(kindRaw: string, id: string) {
  const kind = parseKind(kindRaw);
  return read((db) => {
    const terms = lintTermsOf(db);
    const piece = resolvePiece(db, kind, id);
    const gate = findGate(db, piece.subject);
    const overridden = new Set(gate?.lintOverrides.map((o) => o.fingerprint) ?? []);
    return {
      kind, id, projectKind: piece.project.kind, subject: piece.subject, legacy: piece.legacy,
      blockers: strategyBlockerList(db, kind, { id }, terms),
      findings: findingsOf(piece, terms).map((f): LintFinding & { overridden: boolean } => ({ ...f, overridden: overridden.has(f.fingerprint) })),
      overrides: (gate?.lintOverrides ?? []).map((o) => ({ type: 'lint' as const, id: o.id, key: o.fingerprint, category: o.category, at: o.at, reason: o.reason })),
    };
  });
}

function parseKind(kind: string): GateKind {
  const r = GateKind.safeParse(kind);
  if (!r.success) throw new HttpError(404, 'Unbekannte Art');
  return r.data;
}

const emptyGate = (projectId: string, subject: GateSubject): StrategyGate => ({
  id: newId(), projectId, subject, strategyVersionId: null, pillarId: null, answers: [], joyExpected: null, withinBoundaries: null,
  confirmedAt: null, fitOverrides: [], lintOverrides: [], history: [], createdAt: now(), updatedAt: now(),
});

// ---------- Overrides ----------
/**
 * Deliberate release of one lint finding (client projects) with a reason (≥ 10 characters). The finding must currently
 * block. Since Etappe 11 the reason is stored on the gate with the override.
 */
export async function addOverride(kindRaw: string, id: string, raw: unknown) {
  const kind = parseKind(kindRaw);
  const req = OverrideRequest.parse(raw);
  await write((db) => {
    const terms = lintTermsOf(db);
    const piece = resolvePiece(db, kind, id);
    const hit = strategyBlockerList(db, kind, { id }, terms).find((b) => b.fingerprint === req.fingerprint);
    if (!hit) throw new HttpError(409, 'Dieser Punkt blockiert gerade nicht oder kann nicht bewusst freigegeben werden.');
    let gate = findGate(db, piece.subject);
    if (!gate) {
      gate = emptyGate(piece.project.id, piece.subject);
      db.strategyGates.push(gate);
    }
    const at = now();
    const f = findingsOf(piece, terms).find((x) => x.fingerprint === req.fingerprint)!;
    gate.lintOverrides.push({ id: newId(), key: req.fingerprint, fingerprint: req.fingerprint, category: f.category, at, reason: req.reason });
    gate.updatedAt = at;
  });
  return gateView(kind, id);
}

/** Lineage label for objects created before Etappe 9. */
export const LEGACY_LABEL = 'ohne Strategie-Bezug (vor Etappe 9)';
