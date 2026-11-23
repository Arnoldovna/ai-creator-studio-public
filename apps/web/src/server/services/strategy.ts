import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  aiContextSizeWarning, BundleKind, describeMarkdownChanges, describeStrategyChanges, parseBundle, parseProfileMarkdown, parseStrategyDocument,
  ProfileDocument, renderStrategyMarkdown, versionAiText, sameContent, SendMode, SensitiveTerm, SourceDocument, SourceKey,
  sourceKeyFromName, StrategyDocument, CONTEXT_KIND_LABEL, ContextKind,
  type BundleFile, type BundleItem, type DocIssue, type StrategyAttachment, type UseCase,
} from '@studio/core';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type ContextVersion, type Db } from '../store';
import { confidentialBlock } from './agentRuns';
import { activePillars, activeSources, aiContextText, contextBlocks, currentApproved, currentPhase, personalBlocks, scriptTaskPins, type ContextPins } from './aiContext';

/**
 * Strategy, profile and source documents (Etappe 9, ADR-012; Etappe 10: saving = active; Etappe 11, E1: one whole
 * document per version, imported as a bundle of files or pasted text).
 * One active version (status `approved`) per (profile, kind) and per source key. Saving or importing a changed
 * document creates a new active version and archives the previous one (history stays, any version can be
 * reactivated). Unchanged content creates no version. A source's send switch (and the strategy attachment's) is a
 * setting, not content: changing it updates the active version in place.
 * Every document is untrusted input: parsed by the core schemas, error texts carry paths only, never content.
 */

export { currentApproved, currentPhase };

type Of<K extends ContextVersion['kind']> = Extract<ContextVersion, { kind: K }>;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 of what the AI reads for this version alone (lineage only). */
export const aiTextHashOf = (v: ContextVersion): string => sha(versionAiText(v));

const nextVersion = (db: Db, kind: ContextKind, sourceKey: string | null) =>
  db.contextVersions.filter((v) => v.kind === kind && v.profileId === PERSONAL_PROFILE_ID && (kind !== 'source' || v.sourceKey === sourceKey))
    .reduce((n, v) => Math.max(n, v.version), 0) + 1;

const activeOf = (db: Db, kind: ContextKind, sourceKey: string | null = null): ContextVersion | null =>
  db.contextVersions.find((v) => v.kind === kind && v.profileId === PERSONAL_PROFILE_ID && v.status === 'approved' && (kind !== 'source' || v.sourceKey === sourceKey)) ?? null;

type NewDoc =
  | { kind: 'strategy'; document: StrategyDocument }
  | { kind: 'profile'; document: ProfileDocument }
  | { kind: 'source'; document: SourceDocument };

/**
 * Inside a db write: a new active version (the previous active one of the same kind/key is archived). Returns the
 * active version unchanged when the content is the same (no empty versions).
 */
export function addActiveVersion(db: Db, input: NewDoc, source: ContextVersion['source']): { version: ContextVersion; created: boolean } {
  const sourceKey = input.kind === 'source' ? input.document.key : null;
  const prev = activeOf(db, input.kind, sourceKey);
  if (prev && sameContent(prev.document, input.document)) return { version: prev, created: false };
  if (prev) prev.status = 'archived';
  const at = now();
  const version = nextVersion(db, input.kind, sourceKey);
  const v = {
    id: newId(), profileId: PERSONAL_PROFILE_ID, version, status: 'approved', source, createdAt: at, approvedAt: at,
    kind: input.kind, sourceKey, document: input.document, aiTextHash: '',
  } as ContextVersion;
  v.aiTextHash = aiTextHashOf(v);
  db.contextVersions.push(v);
  return { version: v, created: true };
}

// ---------- Views ----------
/** What the UI shows of a version: the document plus its read view (strategy rendered from the JSON). */
export function versionView(v: ContextVersion) {
  const rendered = v.kind === 'strategy' ? renderStrategyMarkdown(v.document) : v.document.markdown;
  const label = v.kind === 'source' ? v.document.title : CONTEXT_KIND_LABEL[v.kind];
  return { ...v, label, rendered, chars: v.kind === 'strategy' ? JSON.stringify(v.document).length : v.document.markdown.length };
}
const summary = (v: ContextVersion) => ({
  id: v.id, kind: v.kind, sourceKey: v.sourceKey, version: v.version, status: v.status, source: v.source, createdAt: v.createdAt, approvedAt: v.approvedAt,
  label: v.kind === 'source' ? v.document.title : CONTEXT_KIND_LABEL[v.kind],
});

/** `GET /api/context`: the active documents, every version (summaries), pillars, phase and the exact AI text. */
export const getContext = () =>
  read((db) => {
    const strategy = currentApproved(db, 'strategy');
    const profile = currentApproved(db, 'profile');
    const sources = activeSources(db);
    const versions = db.contextVersions.filter((v) => v.profileId === PERSONAL_PROFILE_ID)
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.sourceKey ?? '').localeCompare(b.sourceKey ?? '') || b.version - a.version)
      .map(summary);
    // keys that have versions but no active one (removed sources) stay listed in `versions`
    const agentText = aiContextText(personalBlocks(db));
    const chatVoiceText = aiContextText(personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'chat_voice'), 'chat_voice');
    return {
      phase: currentPhase(db),
      longTermGoal: strategy?.document.longTermGoal ?? '',
      active: { strategy: strategy ? versionView(strategy) : null, profile: profile ? versionView(profile) : null },
      sources: sources.map(versionView),
      versions,
      pillars: activePillars(db),
      /** example topics of the active pillars (topic picks in the brief) */
      topicIdeas: [...new Set((strategy?.document.pillars ?? []).flatMap((p) => p.exampleTopics))].slice(0, 60),
      ai: {
        agentText, chatVoiceText,
        agentWarning: aiContextSizeWarning(agentText), chatVoiceWarning: aiContextSizeWarning(chatVoiceText),
      },
    };
  });

export const parseKind = (raw: string): ContextKind => {
  const r = ContextKind.safeParse(raw);
  if (!r.success) throw new HttpError(404, 'Unbekannte Dokumentart');
  return r.data;
};

/** One version (any status) with its read view. */
export async function getVersion(kindRaw: string, id: string) {
  const kind = parseKind(kindRaw);
  return read((db) => {
    const v = must(db.contextVersions.find((x) => x.id === id && x.kind === kind), `${CONTEXT_KIND_LABEL[kind]}-Version`);
    return versionView(v);
  });
}

// ---------- Save a whole document (PUT /api/context/[kind]) ----------
const StrategyPut = z.object({
  /** the editor text (JSON); without an `attachment` key the active attachment is kept */
  json: z.string().max(400_000).optional(),
  /** switch of the attached original Markdown (setting: in place, no new version) */
  attachmentSendMode: SendMode.optional(),
  removeAttachment: z.literal(true).optional(),
}).strict();
const ProfilePut = z.object({ markdown: z.string().max(400_000), sensitiveTerms: z.array(SensitiveTerm).max(100).optional() }).strict();
const SourcePut = z.object({
  key: SourceKey.optional(), title: z.string().trim().max(200).optional(), markdown: z.string().max(400_000).optional(), sendMode: SendMode.optional(),
}).strict();

/** 422 with the issues (paths + fixed texts), never the content. */
const invalid = (issues: DocIssue[]) =>
  new HttpError(422, `Dokument ungültig: ${issues.filter((i) => i.severity === 'error').slice(0, 5).map((i) => `${i.path || 'Wurzel'}: ${i.message}`).join(' · ')}`, 'invalid_document');

export async function putDocument(kindRaw: string, body: unknown) {
  const kind = parseKind(kindRaw);
  if (kind === 'strategy') return putStrategy(StrategyPut.parse(body));
  if (kind === 'profile') return putProfile(ProfilePut.parse(body));
  return putSource(SourcePut.parse(body));
}

async function putStrategy(input: z.infer<typeof StrategyPut>) {
  let parsed: StrategyDocument | null = null;
  let explicitAttachment = false;
  let issues: DocIssue[] = [];
  if (input.json !== undefined) {
    const r = parseStrategyDocument(input.json);
    if (!r.ok || !r.document) throw invalid(r.issues);
    parsed = r.document;
    issues = r.issues;
    try {
      explicitAttachment = Object.hasOwn(JSON.parse(input.json) as object, 'attachment');
    } catch { /* parsed above */ }
  }
  return write((db) => {
    const active = currentApproved(db, 'strategy');
    if (!parsed) {
      // settings only: the attachment switch or its removal
      if (!active) throw new HttpError(409, 'Es gibt noch keine aktive Strategie.');
      if (input.removeAttachment) return { ...addActiveVersion(db, { kind: 'strategy', document: { ...active.document, attachment: null } }, 'manual'), issues };
      if (input.attachmentSendMode && active.document.attachment) {
        active.document = { ...active.document, attachment: { ...active.document.attachment, sendMode: input.attachmentSendMode } };
        active.aiTextHash = aiTextHashOf(active);
      }
      return { version: active as ContextVersion, created: false, issues };
    }
    const attachment: StrategyAttachment | null = explicitAttachment ? parsed.attachment : input.removeAttachment ? null : active?.document.attachment ?? null;
    const document = StrategyDocument.parse({ ...parsed, attachment });
    return { ...addActiveVersion(db, { kind: 'strategy', document }, 'manual'), issues };
  }).then(({ version, created, issues: hints }) => ({ version: versionView(version), created, issues: hints }));
}

async function putProfile(input: z.infer<typeof ProfilePut>) {
  const r = parseProfileMarkdown(input.markdown);
  if (!r.ok || !r.document) throw invalid(r.issues);
  const parsedDoc = r.document;
  return write((db) => {
    const active = currentApproved(db, 'profile');
    // terms come from the request, else from the file header, else stay as they were
    const sensitiveTerms = input.sensitiveTerms ?? (parsedDoc.sensitiveTerms.length ? parsedDoc.sensitiveTerms : active?.document.sensitiveTerms ?? []);
    return addActiveVersion(db, { kind: 'profile', document: ProfileDocument.parse({ markdown: parsedDoc.markdown, sensitiveTerms }) }, 'manual');
  }).then(({ version, created }) => ({ version: versionView(version), created, issues: r.issues }));
}

async function putSource(input: z.infer<typeof SourcePut>) {
  return write((db) => {
    const key = input.key ?? (input.title ? sourceKeyFromName(input.title) : null);
    if (!key) throw new HttpError(400, 'Schlüssel oder Titel der Quelle fehlt.');
    const active = activeOf(db, 'source', key) as Of<'source'> | null;
    const merged = {
      key, title: input.title ?? active?.document.title ?? '', markdown: input.markdown ?? active?.document.markdown ?? '',
      sendMode: input.sendMode ?? active?.document.sendMode ?? 'chat_voice_only',
    };
    const r = SourceDocument.safeParse(merged);
    if (!r.success) throw new HttpError(422, 'Quelle ungültig: Titel und Text sind Pflicht, der Text höchstens 200 000 Zeichen.', 'invalid_document');
    // only the switch changed: a setting, updated in place
    if (active && active.document.title === r.data.title && active.document.markdown === r.data.markdown) {
      if (active.document.sendMode !== r.data.sendMode) {
        active.document = r.data;
        active.aiTextHash = aiTextHashOf(active);
      }
      return { version: active as ContextVersion, created: false };
    }
    return addActiveVersion(db, { kind: 'source', document: r.data }, 'manual');
  }).then(({ version, created }) => ({ version: versionView(version), created, issues: [] as DocIssue[] }));
}

/** Removes a source from the AI context: its active version is archived (history stays, reactivating brings it back). */
export async function archiveSource(keyRaw: string | null) {
  const key = SourceKey.parse(keyRaw ?? '');
  return write((db) => {
    const active = must(activeOf(db, 'source', key), 'Aktive Quelle');
    active.status = 'archived';
    return { archived: active.id };
  });
}

/** Makes a version active (reactivate an archived one, or a legacy draft); the previously active one is archived. */
export async function activateVersion(kindRaw: string, id: string) {
  const kind = parseKind(kindRaw);
  return write((db) => {
    const v = must(db.contextVersions.find((x) => x.id === id && x.kind === kind), `${CONTEXT_KIND_LABEL[kind]}-Version`);
    if (v.status !== 'approved') {
      for (const other of db.contextVersions)
        if (other.id !== v.id && other.kind === v.kind && other.profileId === v.profileId && other.sourceKey === v.sourceKey && other.status === 'approved') other.status = 'archived';
      v.status = 'approved';
      v.approvedAt = now();
    }
    return versionView(v);
  });
}

// ---------- Bundle import ----------
export const ImportChoice = z.object({ index: z.number().int().min(0).max(19), kind: BundleKind.optional(), sendMode: SendMode.optional(), skip: z.boolean().optional() }).strict();
export type ImportChoice = z.infer<typeof ImportChoice>;
export interface ImportInput { files: { name: string; text: string }[]; choices: ImportChoice[] }

function bundleOf(input: ImportInput) {
  const choice = (i: number) => input.choices.find((c) => c.index === i);
  const kept = input.files.map((f, index) => ({ f, index })).filter(({ index }) => !choice(index)?.skip);
  const files: BundleFile[] = kept.map(({ f, index }) => ({ name: f.name, text: f.text, kind: choice(index)?.kind, sendMode: choice(index)?.sendMode }));
  const bundle = parseBundle(files);
  // report the caller's indices, not the indices within the kept files
  for (const item of bundle.items) item.index = kept[item.index]!.index;
  return bundle;
}

function itemMeta(item: BundleItem) {
  const d = item.document;
  switch (item.kind) {
    case 'strategy_json': {
      const s = d as StrategyDocument | null;
      return s ? { pillars: s.pillars.map((p) => p.name), phase: s.phase, longTermGoal: s.longTermGoal, extras: Object.keys(s.extras).length } : {};
    }
    case 'source': {
      const s = d as SourceDocument | null;
      return s ? { sourceKey: s.key, title: s.title, sendMode: s.sendMode } : {};
    }
    case 'strategy_md': {
      const s = d as StrategyAttachment | null;
      return s ? { sendMode: s.sendMode } : {};
    }
    default:
      return {};
  }
}

/** The new documents of a bundle against the active state (inside read or write). */
function plan(db: Db, items: BundleItem[]) {
  const strategyItem = items.find((i) => i.kind === 'strategy_json')?.document as StrategyDocument | null | undefined;
  const mdItem = items.find((i) => i.kind === 'strategy_md')?.document as StrategyAttachment | null | undefined;
  const active = currentApproved(db, 'strategy');
  const problems: string[] = [];
  let strategy: StrategyDocument | null = null;
  if (strategyItem || mdItem) {
    const base = strategyItem ?? active?.document ?? null;
    if (!base) problems.push('Ein Strategie-Markdown wird an eine Strategie (JSON) gehängt – lege sie im selben Zug ab oder aktiviere zuerst eine.');
    else strategy = StrategyDocument.parse({ ...base, attachment: mdItem ?? (strategyItem && strategyItem.attachment) ?? active?.document.attachment ?? null });
  }
  const changes = new Map<number, string[]>();
  for (const i of items) {
    if (!i.document) continue;
    if (i.kind === 'strategy_json' && strategy) changes.set(i.index, describeStrategyChanges(active?.document ?? null, { ...strategy, attachment: active?.document.attachment ?? null }));
    if (i.kind === 'strategy_md' && mdItem) changes.set(i.index, describeMarkdownChanges(active?.document.attachment?.markdown ?? null, mdItem.markdown));
    if (i.kind === 'profile_md') changes.set(i.index, describeMarkdownChanges(currentApproved(db, 'profile')?.document.markdown ?? null, (i.document as ProfileDocument).markdown));
    if (i.kind === 'source') {
      const s = i.document as SourceDocument;
      const prev = activeOf(db, 'source', s.key) as Of<'source'> | null;
      const c = describeMarkdownChanges(prev?.document.markdown ?? null, s.markdown);
      if (prev && prev.document.sendMode !== s.sendMode) c.push('Schalter geändert.');
      changes.set(i.index, c);
    }
  }
  const docs: NewDoc[] = [];
  if (strategy) docs.push({ kind: 'strategy', document: strategy });
  for (const i of items) {
    if (i.kind === 'profile_md' && i.document) {
      const p = i.document as ProfileDocument;
      // a profile without terms in its file header keeps the terms of the active profile
      docs.push({ kind: 'profile', document: { ...p, sensitiveTerms: p.sensitiveTerms.length ? p.sensitiveTerms : currentApproved(db, 'profile')?.document.sensitiveTerms ?? [] } });
    }
    if (i.kind === 'source' && i.document) docs.push({ kind: 'source', document: i.document as SourceDocument });
  }
  return { docs, changes, problems };
}

/** `POST /api/context/import`: recognises every file and shows what would change. Stores nothing. */
export async function previewImport(input: ImportInput) {
  const bundle = bundleOf(input);
  return read((db) => {
    const { changes, problems } = plan(db, bundle.items);
    const allProblems = [...bundle.problems, ...problems];
    return {
      items: bundle.items.map((i) => ({
        index: i.index, name: i.name, kind: i.kind, detectedBy: i.detectedBy, ok: i.ok, chars: i.chars, issues: i.issues,
        changes: changes.get(i.index) ?? [], ...itemMeta(i),
      })),
      skipped: input.choices.filter((c) => c.skip).map((c) => c.index),
      problems: allProblems,
      canApply: bundle.ok && !allProblems.length,
    };
  });
}

/** `POST /api/context/import/apply`: the same files and choices again → new active versions (unchanged ones are skipped). */
export async function applyImport(input: ImportInput) {
  const bundle = bundleOf(input);
  return write((db) => {
    const { docs, problems } = plan(db, bundle.items);
    if (!bundle.ok || problems.length || bundle.problems.length)
      throw new HttpError(422, `Import nicht möglich: ${[...bundle.problems, ...problems, ...bundle.items.filter((i) => !i.ok).map((i) => `${i.name}: ${i.issues.find((x) => x.severity === 'error')?.message ?? 'ungültig'}`)].join(' ')}`, 'invalid_bundle');
    const results = docs.map((d) => addActiveVersion(db, d, 'import_bundle'));
    return results.map(({ version, created }) => ({ ...summary(version), created }));
  }).then((applied) => ({ applied }));
}

// ---------- „Was an die KI geht“ ----------
const PreviewInput = z.union([
  z.object({ scriptId: z.string().min(1) }),
  z.object({ conceptId: z.string().min(1) }),
  z.object({ projectId: z.string().min(1) }),
]);

const versionLabel = (kind: 'strategy' | 'profile', b: { versionId: string; version: number } | null, db: Db) => {
  if (!b) return null;
  const status = db.contextVersions.find((v) => v.id === b.versionId)?.status;
  return `${kind === 'strategy' ? 'Strategie' : 'Profil'} v${b.version}${status === 'archived' ? ' (archiviert, an diesem Inhalt gepinnt)' : ''}`;
};

/**
 * The context text the agents for this subject receive: current active versions for a project, the pinned ones for
 * a script, and for a concept those of `scriptTaskPins`. Same projection and resolution as the agent request.
 */
export async function aiPreview(raw: unknown) {
  const input = PreviewInput.parse(raw);
  const env = providerFromEnv();
  const mock = env.config.active === 'mock';
  const useCases: UseCase[] = 'scriptId' in input
    ? ['content_quality_assurance', 'instagram_copywriting', 'cinematic_direction']
    : 'conceptId' in input ? ['ugc_scriptwriting'] : ['content_strategy'];
  return read((db) => {
    let projectId: string;
    let pins: ContextPins = {};
    if ('scriptId' in input) {
      const sc = must(db.scripts.find((x) => x.id === input.scriptId), 'Skript');
      projectId = sc.projectId;
      pins = { strategyId: sc.strategyVersionId, profileId: sc.profileVersionId };
    } else if ('conceptId' in input) {
      const c = must(db.concepts.find((x) => x.id === input.conceptId), 'Konzept');
      projectId = c.projectId;
      pins = scriptTaskPins(db, c, must(db.projects.find((p) => p.id === c.projectId), 'Projekt')).pins;
    } else projectId = input.projectId;
    const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
    const client = project.kind === 'UGC_CLIENT';
    const blocks = contextBlocks(db, project, pins);
    const text = aiContextText(blocks);
    const blocked = client ? useCases.map((u) => confidentialBlock(db, env, u)).find((r) => r != null) ?? null : null;
    return {
      text,
      strategyVersionId: blocks.strategy?.versionId ?? null,
      profileVersionId: blocks.profile?.versionId ?? null,
      labels: {
        strategy: versionLabel('strategy', blocks.strategy, db), profile: versionLabel('profile', blocks.profile, db),
        sources: blocks.sources.length ? `${blocks.sources.length} Quelle(n)` : null,
      },
      sizeWarning: aiContextSizeWarning(text),
      confidentialRouting: client,
      /** Set when no model may receive this confidential context right now: agent calls will be refused (nothing is sent). */
      confidentialBlocked: blocked,
      mock,
      note: client
        ? 'Kundenprojekt: Strategie und Profil gehen hier nicht an die KI.'
        : text ? null : 'Keine aktive Strategie, kein Profil und keine Quelle „immer mitsenden“ – es geht kein persönlicher Kontext an die KI.',
    };
  });
}
