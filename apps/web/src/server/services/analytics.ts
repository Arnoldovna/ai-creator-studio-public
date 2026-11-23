import 'server-only';
import { computeRates, deriveGrowthInsight, MetricSnapshotInput, PublicationInput, type InsightPost } from '@studio/core';
import { HttpError } from '../http';
import { must, newId, now, read, write, type Db, type MetricSnapshot, type Publication } from '../store';
import { currentApproved } from './aiContext';
import { conceptGate, findGate, rootPlanId } from './strategyGate';

/** „Säule „X“ · Strategie vN“, or the plain label when the publication has no strategy lineage. */
function strategyLabel(db: Db, p: Publication): string {
  if (!p.pillarId && !p.strategyVersionId) return 'ohne Säule / ohne Strategie-Bezug';
  const found = p.strategyVersionId ? db.contextVersions.find((x) => x.id === p.strategyVersionId) : null;
  const v = found?.kind === 'strategy' ? found : null;
  const pillars = (v ?? currentApproved(db, 'strategy'))?.document.pillars ?? [];
  const pillar = p.pillarId ? `Säule „${pillars.find((x) => x.id === p.pillarId)?.name ?? p.pillarId}“` : 'ohne Säule';
  return `${pillar} · ${v ? `Strategie v${v.version}` : 'ohne Strategie-Bezug'}`;
}

/** Human-readable lineage labels shared by the analytics page and the Growth Analyst table. */
export function publicationLineage(db: Db, p: Publication) {
  const style = p.styleBibleVersionId ? db.styleBibles.find((v) => v.id === p.styleBibleVersionId) : null;
  const voice = p.voiceGuideVersionId ? db.voiceGuides.find((v) => v.id === p.voiceGuideVersionId) : null;
  return {
    concept: p.conceptId ? (db.concepts.find((c) => c.id === p.conceptId)?.body.title ?? null) : null,
    styleVersion: style ? `${style.rules.name} v${style.version}` : null,
    voiceVersion: voice ? `v${voice.version}` : null,
    strategy: strategyLabel(db, p),
  };
}

/** Growth reports are evidence snapshots: removed with their publication, demoted to draft when a snapshot changes. */
function invalidateGrowthReports(db: Db, publicationId: string, mode: 'remove' | 'demote') {
  const hit = (r: Db['growthReports'][number]) => r.publicationIds.includes(publicationId);
  if (mode === 'remove') db.growthReports = db.growthReports.filter((r) => !hit(r));
  else for (const r of db.growthReports) if (hit(r) && r.status === 'approved') Object.assign(r, { status: 'draft', approvedAt: null });
}

export function insightPosts(db: Db): InsightPost[] {
  return db.metricSnapshots.flatMap((s) => {
    const p = db.publications.find((x) => x.id === s.publicationId);
    return p ? [{ publicationId: p.id, title: p.title, hook: p.hook, window: s.window, metrics: s.metrics, observedAt: s.observedAt }] : [];
  });
}

export const getAnalytics = () =>
  read((db) => ({
    publications: db.publications
      .map((p) => {
        const script = p.scriptVersionId ? db.scripts.find((s) => s.id === p.scriptVersionId) : null;
        return {
          ...p,
          lineage: {
            project: db.projects.find((x) => x.id === p.projectId)?.title ?? null,
            scriptVersion: script?.version ?? null,
            ...publicationLineage(db, p),
          },
          snapshots: db.metricSnapshots
            .filter((s) => s.publicationId === p.id)
            .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
            .map((s) => ({ ...s, rates: computeRates(s.metrics) })),
        };
      })
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    insight: deriveGrowthInsight(insightPosts(db)),
    linkableScripts: db.scripts
      .filter((s) => s.status === 'approved' || s.status === 'draft')
      .map((s) => ({
        id: s.id, version: s.version, status: s.status, projectId: s.projectId, conceptId: s.conceptId,
        conceptTitle: db.concepts.find((c) => c.id === s.conceptId)?.body.title ?? '', hook: s.body.selectedHook,
      })),
  }));

/**
 * Creates a publication record; lineage (concept, hook, style/voice version, strategy and pillar) is inherited from
 * the script version or the edit plan. Publications are only logged, never refused because of the strategy (D5).
 *
 * Pillar precedence: the pin of the script or plan itself (an explicit null, „Keine Säule (bewusst)“, is final), then
 * for records from before the pins existed the answered FitCheck of the piece, and only then the pillar she names in
 * the form, which must exist in the approved strategy. Client projects never carry her pillars.
 */
export async function createPublication(raw: unknown) {
  const input = PublicationInput.parse(raw);
  return write((db) => {
    const project = must(db.projects.find((p) => p.id === input.projectId), 'Projekt');
    const personal = project.kind === 'PERSONAL_CONTENT';
    const pub: Publication = { id: newId(), ...input, publishedAt: new Date(input.publishedAt).toISOString(), createdAt: now(), strategyVersionId: null, pillarId: null };
    const plan = input.editPlanId ? must(db.editPlans.find((x) => x.id === input.editPlanId), 'Schnittplan') : null;
    if (plan && plan.projectId !== input.projectId) throw new HttpError(400, 'Schnittplan gehört zu einem anderen Projekt');
    /** Pins of the source: `undefined` = none recorded (legacy or unanswered), otherwise final (pillar may be null). */
    let pins: { strategyVersionId: string | null; pillarId: string | null } | undefined;
    const fromGate = (g: Db['strategyGates'][number] | null) => (g ? { strategyVersionId: g.strategyVersionId, pillarId: g.pillarId } : undefined);
    if (input.scriptVersionId) {
      const s = must(db.scripts.find((x) => x.id === input.scriptVersionId), 'Skriptversion');
      if (s.projectId !== input.projectId) throw new HttpError(400, 'Skriptversion gehört zu einem anderen Projekt');
      pub.conceptId = s.conceptId;
      pub.hook = input.hook || s.body.selectedHook;
      pub.styleBibleVersionId = s.styleBibleVersionId;
      pub.voiceGuideVersionId = s.voiceGuideVersionId;
      pins = s.strategyVersionId !== undefined ? { strategyVersionId: s.strategyVersionId, pillarId: s.pillarId ?? null } : fromGate(conceptGate(db, s.conceptId));
    } else if (plan) {
      if (plan.scriptId || plan.status === 'approved') {
        if (plan.strategyVersionId !== undefined) pins = { strategyVersionId: plan.strategyVersionId, pillarId: plan.pillarId ?? null };
      }
      if (!pins && !plan.scriptId) pins = fromGate(findGate(db, { kind: 'free_cut', rootPlanId: rootPlanId(db, plan.id) }));
      if (pins && pins.strategyVersionId === null) pins = undefined;
    } else if (input.conceptId) {
      must(db.concepts.find((c) => c.id === input.conceptId), 'Konzept');
    }
    if (!personal) {
      // client work: the script's own (null) pins at most, never a pillar of hers
      pub.strategyVersionId = pins?.strategyVersionId ?? null;
      pub.pillarId = null;
    } else if (pins) {
      Object.assign(pub, pins);
    } else if (input.pillarId) {
      // a pillar she names herself must exist in the strategy approved now, and refers to it
      const approved = currentApproved(db, 'strategy');
      const pillars = approved?.document.pillars ?? [];
      if (!approved || !pillars.some((x) => x.id === input.pillarId))
        throw new HttpError(400, `Die Säule „${input.pillarId}“ gibt es in der freigegebenen Strategie nicht.`);
      pub.pillarId = input.pillarId;
      pub.strategyVersionId = approved.id;
    }
    db.publications.push(pub);
    return pub;
  });
}

export async function deletePublication(id: string) {
  return write((db) => {
    must(db.publications.find((p) => p.id === id), 'Veröffentlichung');
    db.publications = db.publications.filter((p) => p.id !== id);
    db.metricSnapshots = db.metricSnapshots.filter((s) => s.publicationId !== id);
    invalidateGrowthReports(db, id, 'remove');
    db.evalRuns = db.evalRuns.filter((r) => !r.publicationIds?.includes(id));
    return { deleted: id };
  });
}

export async function addSnapshot(raw: unknown) {
  const input = MetricSnapshotInput.parse(raw);
  return write((db) => {
    must(db.publications.find((p) => p.id === input.publicationId), 'Veröffentlichung');
    const observedAt = input.observedAt ? new Date(input.observedAt).toISOString() : now();
    if (db.metricSnapshots.some((s) => s.publicationId === input.publicationId && s.observedAt === observedAt && s.source === input.source))
      throw new HttpError(409, 'Snapshot mit diesem Zeitpunkt existiert bereits');
    const snap: MetricSnapshot = { id: newId(), ...input, observedAt, createdAt: now() };
    db.metricSnapshots.push(snap);
    return { ...snap, rates: computeRates(snap.metrics) };
  });
}

export async function deleteSnapshot(id: string) {
  return write((db) => {
    const snap = must(db.metricSnapshots.find((s) => s.id === id), 'Snapshot');
    db.metricSnapshots = db.metricSnapshots.filter((s) => s.id !== id);
    invalidateGrowthReports(db, snap.publicationId, 'demote');
    return { deleted: id };
  });
}
