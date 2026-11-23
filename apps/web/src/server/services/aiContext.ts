import 'server-only';
import { createHash } from 'node:crypto';
import {
  ProfileDocument, renderAiContextText, SourceDocument, StrategyDocument,
  type ContextPurpose, type CreativeContext, type ProjectKind, type SensitiveTerm, type StudioPhase,
} from '@studio/core';
import { HttpError } from '../errors';
import { PERSONAL_PROFILE_ID, type Concept, type ContextVersion, type Db } from '../store';

/**
 * Which strategy/profile/source documents an agent request carries (ADR-012, Etappe 11). Shared by `buildContext`
 * (content agents), the voice derivation and the „Was an die KI geht“ preview, so all show the same versions.
 * A block carries the whole document, validated by the strict core schema (an unexpected key throws, value-free).
 */

type Of<K extends ContextVersion['kind']> = Extract<ContextVersion, { kind: K }>;

export function currentApproved<K extends 'strategy' | 'profile'>(db: Db, kind: K, profileId = PERSONAL_PROFILE_ID): Of<K> | null {
  return (db.contextVersions.find((v) => v.kind === kind && v.profileId === profileId && v.status === 'approved') as Of<K> | undefined) ?? null;
}

/** The active version of every source (one per key), sorted by key for a stable order. */
export const activeSources = (db: Db, profileId = PERSONAL_PROFILE_ID): Of<'source'>[] =>
  (db.contextVersions.filter((v) => v.kind === 'source' && v.profileId === profileId && v.status === 'approved') as Of<'source'>[])
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));

/** The studio phase comes only from the active strategy (D7); without one it is `private_trial`. */
export const currentPhase = (db: Db): StudioPhase => currentApproved(db, 'strategy')?.document.phase ?? 'private_trial';

/** Pillars of the active strategy (selection, mix). */
export const activePillars = (db: Db) => (currentApproved(db, 'strategy')?.document.pillars ?? []).map((p) => ({ id: p.id, name: p.name, targetShare: p.share }));

/**
 * Sensitive terms of every strategy and profile version (all statuses, as before): the client-project boundary lint.
 * In her own projects the terms are only context for the AI.
 */
export function lintTermsOf(db: Db): SensitiveTerm[] {
  const out: SensitiveTerm[] = [];
  for (const v of db.contextVersions) if (v.kind !== 'source') out.push(...v.document.sensitiveTerms);
  return out;
}

/** `undefined` = not pinned (current active version); `null` = pinned to „none“; a string = that version (may be archived). */
export interface ContextPins { strategyId?: string | null; profileId?: string | null }

export type ContextBlocks = Pick<CreativeContext, 'strategy' | 'profile'> & { sources: NonNullable<CreativeContext['sources']> };

function resolve<K extends 'strategy' | 'profile'>(db: Db, kind: K, profileId: string, pin: string | null | undefined): Of<K> | null {
  if (pin === undefined) return currentApproved(db, kind, profileId);
  if (pin === null) return null;
  const v = db.contextVersions.find((x) => x.id === pin);
  if (!v || v.kind !== kind) throw new HttpError(409, `Die gepinnte ${kind === 'strategy' ? 'Strategie' : 'Profil'}-Version fehlt.`);
  // Only versions that were active at some point reach a model; a draft (legacy, before Etappe 10) is unfinished text.
  if (v.status === 'draft') throw new HttpError(409, 'Ein Entwurf kann nicht an die KI gehen – aktiviere die Version zuerst.');
  return v as Of<K>;
}

/** Strict parse of a stored document; never echoes its content. */
function strict<T>(schema: { parse: (x: unknown) => T }, doc: unknown): T {
  try {
    return schema.parse(doc);
  } catch {
    throw new HttpError(500, 'Ein gespeichertes Strategie-, Profil- oder Quellen-Dokument ist beschädigt.');
  }
}

/**
 * Blocks for one project. Client projects never carry personal context. `purpose` decides which sources go along:
 * `agent` = only sources set to „immer mitsenden“, `chat_voice` = also those set to „nur Chat und Voice-Analyse“.
 */
export function contextBlocks(db: Db, project: { kind: ProjectKind; profileId: string }, pins: ContextPins = {}, purpose: ContextPurpose = 'agent'): ContextBlocks {
  if (project.kind === 'UGC_CLIENT') return { strategy: null, profile: null, sources: [] };
  return personalBlocks(db, project.profileId, pins, purpose);
}

export function personalBlocks(db: Db, profileId = PERSONAL_PROFILE_ID, pins: ContextPins = {}, purpose: ContextPurpose = 'agent'): ContextBlocks {
  const s = resolve(db, 'strategy', profileId, pins.strategyId);
  const p = resolve(db, 'profile', profileId, pins.profileId);
  const sources = activeSources(db, profileId)
    .filter((v) => v.document.sendMode === 'always' || (purpose === 'chat_voice' && v.document.sendMode === 'chat_voice_only'))
    .map((v) => ({ versionId: v.id, version: v.version, document: strict(SourceDocument, v.document) }));
  return {
    strategy: s ? { versionId: s.id, version: s.version, document: strict(StrategyDocument, s.document) } : null,
    profile: p ? { versionId: p.id, version: p.version, document: strict(ProfileDocument, p.document) } : null,
    sources,
  };
}

/** The exact context text the agents receive (empty when no block is used). */
export function aiContextText(b: ContextBlocks, purpose: ContextPurpose = 'agent'): string {
  return renderAiContextText({ strategy: b.strategy, profile: b.profile, sources: b.sources }, purpose);
}

/** sha256 of `aiContextText` for lineage on AgentRun (no enforcement); null without blocks. */
export function aiContextHash(b: ContextBlocks, purpose: ContextPurpose = 'agent'): string | null {
  const text = aiContextText(b, purpose);
  return text ? createHash('sha256').update(text, 'utf8').digest('hex') : null;
}

/**
 * The one version resolution for the UGC Scriptwriter of a concept, used by `prepareScriptTask` and by the
 * „Was an die KI geht“ preview of the concept, so the preview always shows what the request carries.
 * Personal project (no FitCheck since Etappe 10): the currently active strategy and profile (`undefined` pins) and
 * the concept's own pillar; a pillar the active strategy does not know counts as „keine Säule“. Client: the concept's pins.
 */
export function scriptTaskPins(db: Db, concept: Concept, project: { kind: ProjectKind }): { pins: ContextPins; pillarId: string | null } {
  if (project.kind === 'PERSONAL_CONTENT') {
    const pillars = activePillars(db);
    const pillarId = concept.pillarId && pillars.some((p) => p.id === concept.pillarId) ? concept.pillarId : null;
    return { pins: {}, pillarId };
  }
  // `undefined` pins on concepts from before Etappe 9 → current approved
  return { pins: { strategyId: concept.strategyVersionId, profileId: concept.profileVersionId }, pillarId: null };
}
