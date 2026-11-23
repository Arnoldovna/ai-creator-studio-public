/** Test helpers for the strategy context (services only, no HTTP). Fixtures are invented and neutral. */
import type { SensitiveTerm, StudioPhase } from '@studio/core';
import { strategyImportFixture } from '../../../../packages/core/test/fixtures/strategy';

export const FIXTURE_SUMMARY = 'Kurze Werkstatt- und Alltagsvideos, ehrlich und ohne Perfektion.';

/** The fixture strategy as the JSON text the editor/importer would send (Etappe 11 document). */
export const fixtureStrategyJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ ...strategyImportFixture, summary: FIXTURE_SUMMARY, ...over });

/** Saves the fixture strategy as the active version (one step, like „Speichern“). */
export async function seedApprovedStrategy({ phase = 'public', terms = [] }: { phase?: StudioPhase; terms?: SensitiveTerm[] } = {}) {
  const s = await import('@/server/services/strategy');
  const { version } = await s.putDocument('strategy', { json: fixtureStrategyJson({ phase, sensitiveTerms: terms }) });
  return { strategyVersionId: version.id, pillarIds: strategyImportFixture.pillars.map((p) => p.id) };
}

/**
 * Saves the current active strategy with the given phase as a new active version (the „Bearbeiten → Speichern“ path).
 * The notes get a counter so the content always changes (unchanged content creates no version since Etappe 11).
 */
let edits = 0;
export async function withPhase(phase: StudioPhase) {
  const s = await import('@/server/services/strategy');
  const { active } = await s.getContext();
  if (!active.strategy || active.strategy.kind !== 'strategy') throw new Error('withPhase needs an active strategy (seedApprovedStrategy)');
  const { version } = await s.putDocument('strategy', { json: JSON.stringify({ ...active.strategy.document, phase, notes: `Fassung ${++edits}` }) });
  return { strategyVersionId: version.id };
}

/**
 * An Etappe-9 FitCheck gate on a concept or a free-cut root plan, as old data holds it (the FitCheck itself is gone
 * since Etappe 11). Client projects never had one: for their concepts this does nothing.
 */
export async function passFit(conceptOrRootPlanId: string, kind: 'concept' | 'edit_plan' = 'concept', pillarId = 'werkstatt') {
  const { write, newId, now } = await import('@/server/store');
  const { currentApproved } = await import('@/server/services/aiContext');
  return write((db) => {
    const projectId = kind === 'concept' ? db.concepts.find((c) => c.id === conceptOrRootPlanId)?.projectId : db.editPlans.find((p) => p.id === conceptOrRootPlanId)?.projectId;
    if (db.projects.find((p) => p.id === projectId)?.kind === 'UGC_CLIENT') return null;
    const strategy = currentApproved(db, 'strategy');
    if (!strategy || !projectId || !strategy.document.pillars.some((p) => p.id === pillarId)) throw new Error('passFit needs an active strategy with that pillar (seedApprovedStrategy)');
    const subject = kind === 'concept' ? { kind: 'concept' as const, conceptId: conceptOrRootPlanId } : { kind: 'free_cut' as const, rootPlanId: conceptOrRootPlanId };
    const gate = {
      id: newId(), projectId, subject, strategyVersionId: strategy.id, pillarId, answers: [], joyExpected: 'ja' as const, withinBoundaries: 'ja' as const,
      confirmedAt: now(), fitOverrides: [], lintOverrides: [], history: [], createdAt: now(), updatedAt: now(),
    };
    db.strategyGates = db.strategyGates.filter((g) => JSON.stringify(g.subject) !== JSON.stringify(subject));
    db.strategyGates.push(gate);
    return gate;
  });
}
