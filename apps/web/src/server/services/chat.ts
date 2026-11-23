import 'server-only';
import {
  ALLOWED_PATCHES, applyCarouselPatch, applyWeekPatch, carouselOfScope, IsoDate, WeekPatchError, weekKey, weekStartOf, weekDays, type CarouselBody, applyDesignPatch, applyEditDraftPatch, applyStoryPatch, BEAT_ROLE_LABEL, defaultSelection, StoryError, storyToDraft, type StoryApplyContext, applyProfilePatch, applyStrategyPatch, applyVoicePatch, CHAT_CONTEXT_LABEL, CHAT_MESSAGE_MAX,
  buildTimeline, ChatPatch, ChatPatchError, ChatScope, chatSentences, checkEligibility, normalizeChatProposals, sourceToOutputNearest, claimRanges, contextOfScope, costBounds, designGuidelineText, lookFit,
  MAX_CHAT_IMAGES, MODEL_REGISTRY, ProfileDocument, projectOfScope, ROUTING_POLICIES, routeModel, runStudioChat,
  type ChatChange, type ChatContextKind, type ConversationTurn, type DesignSystem, type EditDraftBody, type EditPatchContext, type ImageInput, type PacingInput, type PatchKind,
  type ProviderConfig, type StrategyDocument, type StudioChatInput, type TranscriptBody, type VoiceGuideRules,
} from '@studio/core';
import { z } from 'zod';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import {
  must, newId, now, PERSONAL_PROFILE_ID, read, write, type StoryPlanRecord, type ChatMessage, type ChatProposal, type ChatProposalBase, type ChatThread, type Db, type VoiceGuideVersion,
} from '../store';
import { aiContextHash, aiContextText, currentApproved, personalBlocks } from './aiContext';
import { routeRequestFor, runAgent, type AgentTask } from './agentRuns';
import { protectedClaims } from './cuts';
import { allowedFonts, baseDesign, saveDesignIn } from './designSystem';
import { lookPresets, pinnedStyleFor, planLook } from './edit';
import { checkBase, findDraft } from './editDraft';
import { applyContextFor } from './editDirection';
import { applyChatVersion } from './carousels';
import { applyWeekMoves, today, weekTarget } from './board';
import { imageForLlm } from './references';
import { addActiveVersion } from './strategy';
import { approvedObservations, currentStyle, currentVoice, nextVersion, pushActive } from './style';
import { latestSilenceScan, latestTranscript, readTranscriptBody } from './transcripts';

/**
 * Studio-Chat (Etappe 15, E5): „Ein Satz an Claude“ on every page – as proposals, never as a change.
 *
 * - One thread history per page scope (`brand`, `strategy`, `general`, `editor:<projectId>`).
 * - Every message is ONE `runAgent` call (budget, routing, log, cost). Her messages are the conversation (instructions);
 *   the page's state (design system, strategy/profile/sources incl. „nur Chat und Voice-Analyse“, voice, references,
 *   draft and transcript excerpt) goes in as untrusted data.
 * - Proposals are validated by a dry run against the state the model saw and stored with that base. „Übernehmen“
 *   applies a proposal only while its base is still the active version / draft revision (else 409 „neu vorschlagen“).
 * - There is no path from here to renders, paid jobs, exports or posting.
 * - Client projects (editor of a UGC_CLIENT project): no personal context, `clientData` → confidential routing.
 */

const HISTORY_MESSAGES = 12;
const MAX_THREADS_PER_SCOPE = 30;
const MAX_MESSAGES_PER_THREAD = 200;
const STALE = 'Inzwischen ist eine andere Version aktiv oder der Entwurf wurde geändert – bitte neu vorschlagen lassen.';

// ---------- Targets: what a page's chat can see and change ----------

interface DraftTarget { draftId: string; projectId: string; scriptId: string | null; revision: number; body: EditDraftBody; ctx: EditPatchContext }
/** Etappe 16: the latest dramaturgy proposal of the editor's draft (not stale), for `story` patches. */
interface StoryTarget { record: StoryPlanRecord; apply: StoryApplyContext }
interface Targets {
  scope: string;
  context: ChatContextKind;
  allowed: readonly PatchKind[];
  projectId: string | null;
  clientData: boolean;
  design: { versionId: string | null; design: DesignSystem; fonts: string[] };
  voice: { versionId: string | null; rules: VoiceGuideRules } | null;
  strategy: { versionId: string; document: StrategyDocument } | null;
  profile: { versionId: string | null; document: ProfileDocument };
  draft: DraftTarget | null;
  story: StoryTarget | null;
  /** Etappe 18: the open carousel (its active version). */
  carousel: { id: string; projectId: string; versionId: string; body: CarouselBody } | null;
  /** Etappe 20: the week of the board (or the current week from „Allgemein“). */
  week: ReturnType<typeof weekTarget> | null;
  state: Record<string, unknown>;
  lineage: { styleVersionId: string | null; voiceVersionId: string | null; strategyVersionId?: string | null; profileVersionId?: string | null; aiContextHash?: string | null };
  sentencesCount: number;
}

const compactDesign = (d: DesignSystem) => ({
  colors: Object.fromEntries(Object.entries(d.colors).map(([k, v]) => [k, v.hex])),
  typography: Object.fromEntries(Object.entries(d.typography).map(([k, v]) => [k, { font: v.font, weight: v.weight, size: v.size, textCase: v.textCase }])),
  presets: d.presets.map((p) => ({ id: p.id, name: p.name, hook: p.hook.shape, lowerThird: p.lowerThird.shape, keyword: p.keyword.shape, animation: p.animation, hookSlot: p.hookSlot, overlaySlot: p.overlaySlot })),
  defaultPresetId: d.defaultPresetId,
  motion: { targetCutSec: d.motion.targetCutSec, tempo: d.motion.tempo, zoom: d.motion.zoom, transitions: d.motion.transitions },
  imagery: { keywords: d.imagery.keywords, light: d.imagery.light, temperature: d.imagery.temperature },
  phrases: d.phrases.map((p) => p.text),
  guidelines: d.guidelines,
  summary: designGuidelineText(d),
});

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Loads everything the chat of a scope can read and change (one consistent snapshot plus transcript files). */
async function loadTargets(scope: string, scriptId: string | null, weekStart: string | null = null): Promise<Targets> {
  const context = contextOfScope(ChatScope.parse(scope));
  const projectId = projectOfScope(scope);
  const carouselId = carouselOfScope(scope);
  const snap = await read((db) => {
    const project = projectId ? checkBase(db, projectId, scriptId) : null;
    const clientData = project?.kind === 'UGC_CLIENT';
    // Etappe 18: the carousel page sees its carousel's active version (personal projects only)
    let carousel: Targets['carousel'] = null;
    if (carouselId) {
      const c = must(db.carousels.find((x) => x.id === carouselId), 'Karussell');
      const v = must(db.carouselVersions.find((x) => x.id === c.activeVersionId), 'Karussell-Version');
      carousel = { id: c.id, projectId: c.projectId, versionId: v.id, body: v.body };
    }
    const style = currentStyle(db);
    const design = baseDesign(db).design;
    const voice = currentVoice(db);
    const strategyV = currentApproved(db, 'strategy');
    const profileV = currentApproved(db, 'profile');
    const fonts = allowedFonts(db);
    let draft: (Omit<DraftTarget, 'ctx'> & { assets: { id: string; name: string; transcript: Parameters<typeof readTranscriptBody>[0] | null; silences: { startSec: number; endSec: number }[] | null }[]; presetIds: string[]; fit: ReturnType<typeof lookFit>; claims: string[] }) | null = null;
    if (project && projectId) {
      const d = findDraft(db, projectId, scriptId);
      if (!d) throw new HttpError(409, 'Noch kein Arbeitsentwurf – öffne zuerst den Editor.');
      const pinned = pinnedStyleFor(db, projectId, scriptId);
      const assets = [...new Set(d.body.clips.map((c) => c.assetId))].map((id) => {
        const a = db.mediaAssets.find((x) => x.id === id);
        return { id, name: a?.name ?? id, transcript: a ? latestTranscript(db, a.id) : null, silences: a ? latestSilenceScan(db, a.id)?.ranges ?? null : null };
      });
      draft = {
        draftId: d.id, projectId, scriptId, revision: d.revision, body: d.body, assets,
        presetIds: lookPresets(db, pinned).presets.map((p) => p.id),
        fit: lookFit(planLook(db, { styleBibleVersionId: pinned }, d.body.look, d.body)),
        claims: clientData ? protectedClaims(db, projectId, scriptId) : [],
      };
    }
    // personal context only outside client projects; sources set to „nur Chat und Voice-Analyse“ go along here
    const blocks = clientData ? null : personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'chat_voice');
    const personal = blocks ? (JSON.parse(aiContextText(blocks, 'chat_voice') || '{}') as Record<string, unknown>) : {};
    const voiceState = voice ? { traits: voice.rules.traits, avoid: voice.rules.avoid, ownExamples: voice.rules.ownExamples.slice(0, 5).map((x) => x.slice(0, 400)) } : null;
    const state: Record<string, unknown> = { page: CHAT_CONTEXT_LABEL[context] };
    if (context !== 'strategy') state.design = compactDesign(design);
    if (context === 'brand' || context === 'general') {
      state.fonts = fonts.map((f) => ({ ref: f.ref, label: f.label }));
      state.observations = approvedObservations(db).slice(0, 20).map((o) => ({ dimension: o.dimension, statement: o.statement.slice(0, 300), colors: o.colors }));
      state.references = db.references.slice(0, 30).map((r) => ({ id: r.id, name: r.name, kind: r.kind, notes: r.notes.slice(0, 300), tags: r.tags, likes: r.likes, palette: r.palette }));
    }
    if (!clientData) state.voice = voiceState;
    if (carousel) {
      const b = carousel.body;
      state.carousel = {
        title: db.carousels.find((x) => x.id === carousel!.id)?.title ?? '', format: b.format, templateId: b.templateId, framework: b.framework,
        slides: b.slides.map((x, i) => ({ n: i + 1, kind: x.kind, title: x.title, body: x.body, items: x.items, attribution: x.attribution, tone: x.tone, image: x.imageId ? true : false })),
        caption: b.caption.slice(0, 2200),
      };
    }
    // Etappe 20: the week board (its week, or the current week from any other page)
    const week = ALLOWED_PATCHES[context].includes('week') ? weekTarget(db, weekStartOf(weekStart ?? today())) : null;
    if (week) state.week = week.state;
    if (context === 'strategy' || context === 'general') {
      Object.assign(state, personal);
      state.profileHeadings = [...(profileV?.document.markdown ?? '').matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.trim()).slice(0, 60);
    }
    return {
      clientData, style, design, voice, strategyV, profileV, fonts: fonts.map((f) => f.ref), draft, state, blocks, carousel, week,
      kind: project?.kind ?? null,
    };
  });

  let draft: DraftTarget | null = null;
  if (snap.draft) {
    const d = snap.draft;
    const bodies = new Map<string, TranscriptBody>();
    for (const a of d.assets) if (a.transcript) bodies.set(a.id, await readTranscriptBody(a.transcript).catch(() => ({ language: 'de', segments: [] })));
    const sentences = chatSentences(d.body, d.body.clips.map((c) => bodies.get(c.assetId) ?? null));
    const pacing = new Map<string, PacingInput>();
    for (const a of d.assets) {
      const t = bodies.get(a.id) ?? null;
      pacing.set(a.id, { transcript: t, silences: a.silences, protectedRanges: t && d.claims.length ? claimRanges(t, d.claims) : [] });
    }
    draft = { draftId: d.draftId, projectId: d.projectId, scriptId: d.scriptId, revision: d.revision, body: d.body, ctx: { scriptless: d.scriptId == null, sentences, pacing, presetIds: d.presetIds, fit: d.fit } };
    // the draft as the model reads it: output times, overlay refs „Clip:Index“, numbered sentences
    const tl = buildTimeline(d.body.clips);
    snap.state.draft = {
      scriptless: d.scriptId == null, projectKind: snap.kind, durationSec: r2(tl.durationSec), subtitles: d.body.subtitles, subtitleY: d.body.subtitleY ?? null,
      hook: d.body.hook ? { text: d.body.hook.text, endSec: d.body.hook.endSec, source: d.body.hook.source } : null,
      clips: d.body.clips.map((c, i) => ({ index: i, asset: d.assets.find((a) => a.id === c.assetId)?.name ?? c.assetId, outStart: r2(tl.clips[i]?.outStart ?? 0), outEnd: r2(tl.clips[i]?.outEnd ?? 0) })),
      overlays: d.body.clips.flatMap((c, i) => c.overlays.map((o, k) => ({
        ref: `${i}:${k}`, kind: o.kind, text: o.text, startSec: r2(sourceToOutputNearest(tl, i, o.startSec) ?? 0), endSec: r2(sourceToOutputNearest(tl, i, o.endSec) ?? 0),
        slot: o.slot, size: o.size ?? null, presetId: o.presetId ?? null,
      }))),
      presets: d.presetIds,
    };
    snap.state.sentences = sentences;
  }
  // Etappe 16: the latest dramaturgy proposal of this draft (personal Freier Schnitt, transcripts unchanged)
  let story: StoryTarget | null = null;
  if (draft && !snap.clientData && draft.scriptId == null) {
    const record = await read((db) => [...db.storyPlans].filter((p) => p.projectId === draft!.projectId && p.scriptId === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null);
    const fresh = record ? await read((db) => record.sources.every((x) => latestTranscript(db, x.assetId)?.id === x.transcriptId)) : false;
    if (record && fresh) {
      // a draft the story cannot use right now (no clip yet …) simply has no story target; the chat itself goes on
      const apply = await applyContextFor(draft.projectId, record).catch((e: unknown) => { if (e instanceof HttpError) return null; throw e; });
      if (apply) story = { record, apply };
    }
    if (story && record) {
      const sel = story.record.lastSelection ?? defaultSelection(story.record.body);
      snap.state.story = {
        id: record.id,
        beats: record.body.beats.map((b, i) => ({ n: i + 1, role: BEAT_ROLE_LABEL[b.role], sentences: `${b.from}–${b.to}`, selected: sel.beats ? sel.beats.includes(b.id) : true })),
        hooks: record.body.hooks.map((h, i) => ({ n: i + 1, text: h.text, source: h.source })),
      };
    }
  }
  return {
    scope, context, allowed: ALLOWED_PATCHES[context], projectId: projectId ?? snap.carousel?.projectId ?? null, clientData: snap.clientData,
    design: { versionId: snap.style?.id ?? null, design: snap.design, fonts: snap.fonts },
    voice: snap.voice ? { versionId: snap.voice.id, rules: snap.voice.rules } : null,
    strategy: snap.strategyV ? { versionId: snap.strategyV.id, document: snap.strategyV.document } : null,
    profile: { versionId: snap.profileV?.id ?? null, document: snap.profileV?.document ?? ProfileDocument.parse({ markdown: '' }) },
    draft, story, carousel: snap.carousel, week: snap.week, state: snap.state,
    lineage: {
      styleVersionId: snap.style?.id ?? null, voiceVersionId: snap.voice?.id ?? null,
      ...(snap.blocks ? { strategyVersionId: snap.blocks.strategy?.versionId ?? null, profileVersionId: snap.blocks.profile?.versionId ?? null, aiContextHash: aiContextHash(snap.blocks, 'chat_voice') } : {}),
    },
    sentencesCount: draft?.ctx.sentences.length ?? 0,
  };
}

type Applied =
  | { kind: 'story'; body: EditDraftBody; selection: ReturnType<typeof applyStoryPatch>['selection'] }
  | { kind: 'design'; design: DesignSystem }
  | { kind: 'strategy'; document: StrategyDocument }
  | { kind: 'profile'; document: ProfileDocument }
  | { kind: 'voice'; rules: VoiceGuideRules }
  | { kind: 'edit_draft'; body: EditDraftBody }
  | { kind: 'carousel'; body: CarouselBody }
  | { kind: 'week'; moves: { id: string; date: string | null; order: number }[] };

/** Applies a patch to the loaded targets without storing anything (the dry run of a proposal and the first step of „Übernehmen“). */
function applyTo(t: Targets, patch: ChatPatch): { applied: Applied; changes: ChatChange[]; warnings: string[] } {
  switch (patch.kind) {
    case 'design': {
      const r = applyDesignPatch(t.design.design, patch.ops, { fonts: t.design.fonts });
      return { applied: { kind: 'design', design: r.design }, changes: r.changes, warnings: r.warnings };
    }
    case 'strategy': {
      if (!t.strategy) throw new ChatPatchError('Es gibt noch keine aktive Strategie – lege sie zuerst unter „Strategie“ an.');
      const r = applyStrategyPatch(t.strategy.document, patch.mergeJson);
      return { applied: { kind: 'strategy', document: r.document }, changes: r.changes, warnings: [] };
    }
    case 'profile': {
      const r = applyProfilePatch(t.profile.document, patch);
      return { applied: { kind: 'profile', document: r.document }, changes: r.changes, warnings: [] };
    }
    case 'voice': {
      const r = applyVoicePatch(t.voice?.rules ?? { traits: [], avoid: [], ownExamples: [] }, patch);
      return { applied: { kind: 'voice', rules: r.rules }, changes: r.changes, warnings: [] };
    }
    case 'edit_draft': {
      if (!t.draft) throw new ChatPatchError('Hier gibt es keinen Schnitt-Entwurf.');
      const r = applyEditDraftPatch(t.draft.body, patch.ops, t.draft.ctx);
      return { applied: { kind: 'edit_draft', body: r.body }, changes: r.changes, warnings: [] };
    }
    case 'carousel': {
      if (!t.carousel) throw new ChatPatchError('Hier ist kein Karussell geöffnet.');
      const r = applyCarouselPatch(t.carousel.body, patch.ops);
      return { applied: { kind: 'carousel', body: r.body }, changes: r.changes, warnings: r.warnings };
    }
    case 'week': {
      if (!t.week) throw new ChatPatchError('Hier ist keine Woche geladen.');
      try {
        const r = applyWeekPatch(t.week.start, t.week.items, patch.ops);
        return { applied: { kind: 'week', moves: r.moves }, changes: r.changes, warnings: [] };
      } catch (e) {
        if (e instanceof WeekPatchError) throw new ChatPatchError(e.message);
        throw e;
      }
    }
    case 'story': {
      if (!t.draft || !t.story) throw new ChatPatchError('Es gibt noch keinen (aktuellen) Dramaturgie-Vorschlag – erst „Dramaturgie vorschlagen“.');
      const base = t.story.record.lastSelection ?? defaultSelection(t.story.record.body);
      const p = applyStoryPatch(t.story.record.body, base, patch.ops);
      try {
        const r = storyToDraft(t.draft.body, t.story.record.body, p.selection, t.story.apply);
        return { applied: { kind: 'story', body: r.body, selection: p.selection }, changes: [...p.changes, ...r.changes.map((c) => ({ ...c, kind: 'text' as const }))], warnings: r.warnings };
      } catch (e) {
        if (e instanceof StoryError) throw new ChatPatchError(e.message);
        throw e;
      }
    }
  }
}

function baseOf(t: Targets, kind: PatchKind): ChatProposalBase {
  switch (kind) {
    case 'design': return { kind, versionId: t.design.versionId };
    case 'voice': return { kind, versionId: t.voice?.versionId ?? null };
    case 'strategy': return { kind, versionId: t.strategy?.versionId ?? null };
    case 'profile': return { kind, versionId: t.profile.versionId };
    case 'edit_draft': return { kind, projectId: t.draft!.projectId, scriptId: t.draft!.scriptId, draftId: t.draft!.draftId, revision: t.draft!.revision };
    case 'story': return { kind, projectId: t.draft!.projectId, scriptId: t.draft!.scriptId, draftId: t.draft!.draftId, revision: t.draft!.revision, storyId: t.story!.record.id };
    case 'carousel': return { kind, carouselId: t.carousel!.id, versionId: t.carousel!.versionId };
    case 'week': return { kind, weekStart: t.week!.start, key: t.week!.key };
  }
}

/** Whether a proposal's base is still the current state (inside read or write). */
function isCurrent(db: Db, base: ChatProposalBase): boolean {
  switch (base.kind) {
    case 'design': return (currentStyle(db)?.id ?? null) === base.versionId;
    case 'voice': return (currentVoice(db)?.id ?? null) === base.versionId;
    case 'strategy': return (currentApproved(db, 'strategy')?.id ?? null) === base.versionId;
    case 'profile': return (currentApproved(db, 'profile')?.id ?? null) === base.versionId;
    case 'edit_draft': {
      const d = findDraft(db, base.projectId, base.scriptId);
      return !!d && d.id === base.draftId && d.revision === base.revision;
    }
    case 'carousel': return db.carousels.find((c) => c.id === base.carouselId)?.activeVersionId === base.versionId;
    case 'week': {
      const days = weekDays(base.weekStart);
      return weekKey(db.boardItems.filter((i) => i.date && days.includes(i.date))) === base.key;
    }
    case 'story': {
      const d = findDraft(db, base.projectId, base.scriptId);
      const s = db.storyPlans.find((x) => x.id === base.storyId);
      return !!d && d.id === base.draftId && d.revision === base.revision && !!s && s.sources.every((x) => latestTranscript(db, x.assetId)?.id === x.transcriptId);
    }
  }
}

// ---------- Model chip ----------

/** What the next message will cost and which model answers (router choice, her pin, or the fixed provider). */
function modelInfo(db: Db, env: { provider: { name: string; model: string; pricing: { inputPerMTok: number; outputPerMTok: number } | null }; config: ProviderConfig }, confidential: boolean) {
  const { provider, config } = env;
  const pinned = db.routerPreferences.studio_chat ?? null;
  const policy = ROUTING_POLICIES.studio_chat;
  if (config.active === 'mock') return { mode: 'mock' as const, label: 'MOCK · kein LLM', model: provider.model, estCostUsd: 0, worstCaseUsd: 0, pinned, options: [] as { id: string; label: string; estCostUsd: number }[], reason: config.reason };
  if (config.active !== 'openrouter') {
    const b = provider.pricing ? costBounds(provider.pricing, policy) : null;
    return { mode: 'direct' as const, label: `${config.active} · ${config.model}`, model: config.model, estCostUsd: b?.est ?? null, worstCaseUsd: b?.worstCase ?? null, pinned, options: [], reason: null };
  }
  const req = routeRequestFor(db, config, 'studio_chat', { confidential });
  const d = routeModel(req);
  const options = MODEL_REGISTRY.filter((m) => !checkEligibility(m, req)).map((m) => ({ id: m.id, label: m.label, estCostUsd: costBounds(m.pricing, policy).est }));
  return {
    mode: 'routed' as const, label: d.chosen ? d.chosen.label : 'kein zulässiges Modell', model: d.chosen?.id ?? null,
    estCostUsd: d.chosen?.estCostUsd ?? null, worstCaseUsd: d.chosen?.worstCaseCostUsd ?? null, pinned, options, reason: d.reasons[0] ?? null,
  };
}

// ---------- Threads ----------

const ThreadQuery = z.object({ scope: ChatScope });

const threadSummary = (db: Db, t: ChatThread) => ({ ...t, messages: db.chatMessages.filter((m) => m.threadId === t.id).length });

/** `GET /api/chat/threads?scope=`: the page's threads (newest first) and the model chip. */
export async function listThreads(rawScope: unknown) {
  const { scope } = ThreadQuery.parse({ scope: rawScope });
  const env = providerFromEnv();
  return read((db) => {
    const cid = carouselOfScope(scope);
    const pid = projectOfScope(scope) ?? (cid ? must(db.carousels.find((c) => c.id === cid), 'Karussell').projectId : null);
    const project = pid ? must(db.projects.find((p) => p.id === pid), 'Projekt') : null;
    const threads = db.chatThreads.filter((t) => t.scope === scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((t) => threadSummary(db, t));
    return { scope, threads, model: modelInfo(db, env, project?.kind === 'UGC_CLIENT'), confidential: project?.kind === 'UGC_CLIENT' };
  });
}

/** `POST /api/chat/threads { scope }`: a new, empty history for the page (old ones stay; the oldest beyond 30 go). */
export async function createThread(raw: unknown) {
  const { scope } = ThreadQuery.parse(raw);
  return write((db) => {
    // a carousel thread belongs to the carousel's project (deleted with it, Etappe 18)
    const cid = carouselOfScope(scope);
    const projectId = projectOfScope(scope) ?? (cid ? must(db.carousels.find((c) => c.id === cid), 'Karussell').projectId : null);
    if (projectId) must(db.projects.find((p) => p.id === projectId), 'Projekt');
    const at = now();
    const t: ChatThread = { id: newId(), scope, projectId, title: `${CHAT_CONTEXT_LABEL[contextOfScope(scope)]} · ${at.slice(0, 16).replace('T', ' ')}`, createdAt: at, updatedAt: at };
    db.chatThreads.push(t);
    const old = db.chatThreads.filter((x) => x.scope === scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(MAX_THREADS_PER_SCOPE).map((x) => x.id);
    if (old.length) {
      const drop = new Set(old);
      db.chatThreads = db.chatThreads.filter((x) => !drop.has(x.id));
      db.chatMessages = db.chatMessages.filter((m) => !drop.has(m.threadId));
    }
    return t;
  });
}

function messageView(db: Db, m: ChatMessage) {
  return { ...m, proposals: m.proposals.map((p) => ({ ...p, stale: p.status === 'open' && !isCurrent(db, p.base) })) };
}

/** `GET /api/chat/threads/[id]/messages`. */
export const getThread = (id: string) => read((db) => {
  const thread = must(db.chatThreads.find((t) => t.id === id), 'Chat-Verlauf');
  return { thread, messages: db.chatMessages.filter((m) => m.threadId === id).map((m) => messageView(db, m)) };
});

// ---------- Messages ----------

const SendInput = z.object({
  text: z.string().trim().min(1, 'Nachricht fehlt').max(CHAT_MESSAGE_MAX),
  /** Up to four reference images of her library (ids). */
  imageIds: z.array(z.string().min(1).max(100)).max(MAX_CHAT_IMAGES).default([]).transform((ids) => [...new Set(ids)]),
  /** Editor: the base of the draft she is looking at (null = Freier Schnitt). */
  scriptId: z.string().min(1).max(100).nullable().default(null),
  /** Etappe 20: the week she is looking at on the board (null = the current week). */
  weekStart: IsoDate.nullable().default(null),
}).strict();

/** An earlier answer as the model sees it again: the reply plus what became of its proposals. */
const assistantTurn = (m: ChatMessage) =>
  [m.text, ...m.proposals.map((p) => `(Vorschlag „${p.title}“: ${p.status === 'applied' ? 'übernommen' : p.status === 'dismissed' ? 'verworfen' : 'offen'})`)].join('\n');

/** The agent task of one message (no side effects): also used by the Model Lab. */
export async function prepareChatTask(scope: string, conversation: ConversationTurn[], opts: { scriptId: string | null; imageIds: string[]; weekStart?: string | null }) {
  const t = await loadTargets(scope, opts.scriptId, opts.weekStart ?? null);
  const refs = await read((db) => opts.imageIds.map((id) => {
    const r = db.references.find((x) => x.id === id);
    if (!r || r.kind !== 'image') throw new HttpError(400, 'Angehängt werden können nur Bilder aus deiner Referenz-Bibliothek.');
    return r;
  }));
  // review fix: the label is a fixed text (it travels outside <untrusted_data>); the file name goes in as data
  const images: ImageInput[] = await Promise.all(refs.map(async (r, i) => ({ ...(await imageForLlm(r)), label: `Angehängtes Referenzbild ${i + 1} (nur Daten):` })));
  const state = refs.length ? { ...t.state, attachedImages: refs.map((r, i) => ({ n: i + 1, name: r.name.slice(0, 120), notes: r.notes.slice(0, 300) })) } : t.state;
  const input: StudioChatInput = {
    context: t.context, allowed: t.allowed, state, conversation, images,
    mockHints: {
      colors: Object.fromEntries(Object.entries(t.design.design.colors).map(([k, v]) => [k, v.hex])), subtitleY: t.draft?.body.subtitleY, sentences: t.sentencesCount,
      story: t.story ? { beats: t.story.record.body.beats.length, hooks: t.story.record.body.hooks.length } : null,
      carousel: t.carousel ? { slides: t.carousel.body.slides.map((x) => ({ title: x.title, body: x.body, items: x.items })) } : null,
      week: !!t.week,
    },
  };
  const inputChars = JSON.stringify(state).length + conversation.reduce((n, c) => n + c.text.length, 0);
  const task: AgentTask<Awaited<ReturnType<typeof runStudioChat>>['output']> = {
    meta: {
      agent: 'studio_chat', useCase: 'studio_chat', projectId: t.projectId, clientData: t.clientData, inputChars, images: images.length,
      input: { scope, state, conversation, imageIds: opts.imageIds }, ...t.lineage,
    },
    run: (p) => runStudioChat(p, input),
  };
  return { targets: t, task };
}

/**
 * `POST /api/chat/threads/[id]/messages`: stores her message, runs the agent once (budget/routing/log), validates the
 * proposals against the state the model saw and stores the answer. A refused run (budget 402, no model 409, provider
 * error) stores no answer – her message stays and can be sent again.
 */
export async function sendMessage(threadId: string, raw: unknown) {
  const req = SendInput.parse(raw);
  const { thread, history } = await read((db) => {
    const th = must(db.chatThreads.find((t) => t.id === threadId), 'Chat-Verlauf');
    const msgs = db.chatMessages.filter((m) => m.threadId === threadId);
    if (msgs.length >= MAX_MESSAGES_PER_THREAD) throw new HttpError(409, 'Dieser Verlauf ist voll – bitte einen neuen Verlauf beginnen.');
    return { thread: th, history: msgs.slice(-HISTORY_MESSAGES) };
  });
  const conversation: ConversationTurn[] = [...history.map((m) => ({ role: m.role, text: m.role === 'assistant' ? assistantTurn(m) : m.text })), { role: 'user', text: req.text }];
  // prepared before her message is stored: a missing draft or a bad image id is a 4xx without side effects
  const { targets, task } = await prepareChatTask(thread.scope, conversation, { scriptId: req.scriptId, imageIds: req.imageIds, weekStart: req.weekStart });
  const user = await write((db) => {
    const m: ChatMessage = {
      id: newId(), threadId, role: 'user', text: req.text, createdAt: now(), imageIds: req.imageIds, agentRunId: null, mock: false, provider: null, model: null,
      costUsd: null, costSource: null, proposals: [], warnings: [], lint: [],
    };
    db.chatMessages.push(m);
    const th = db.chatThreads.find((t) => t.id === threadId);
    if (th) {
      th.updatedAt = m.createdAt;
      if (!db.chatMessages.some((x) => x.threadId === threadId && x.id !== m.id)) th.title = req.text.slice(0, 80);
    }
    return m;
  });
  let ran: Awaited<ReturnType<typeof runAgent<Awaited<ReturnType<typeof runStudioChat>>['output']>>>;
  let normalized: ReturnType<typeof normalizeChatProposals>;
  try {
    ran = await runAgent(task.meta, task.run);
    normalized = normalizeChatProposals(ran.result.output.wire, targets.allowed, (patch) => applyTo(targets, patch));
  } catch (e) {
    // review fix: a refused or failed run leaves no orphaned message – the panel puts the text back for a retry,
    // which would otherwise send her request twice
    await write((db) => void (db.chatMessages = db.chatMessages.filter((m) => m.id !== user.id))).catch(() => undefined);
    throw e;
  }
  const { result, run, mock } = ran;
  const { proposals, warnings } = normalized;
  const assistant = await write((db) => {
    const m: ChatMessage = {
      id: newId(), threadId, role: 'assistant', text: result.output.reply || (proposals.length ? 'Vorschlag:' : '…'), createdAt: now(), imageIds: [],
      agentRunId: run.id, mock, provider: run.provider, model: run.model, costUsd: run.costEstimateUsd, costSource: run.costSource ?? null,
      proposals: proposals.map((p): ChatProposal => ({
        id: newId(), kind: p.patch.kind, title: p.title, patch: p.patch, changes: p.changes, warnings: p.warnings, lint: p.lint,
        base: baseOf(targets, p.patch.kind), status: 'open', decidedAt: null, result: null,
      })),
      warnings, lint: result.output.lint,
    };
    // the thread may have been replaced meanwhile („Neuer Verlauf“ pruned it): the answer is then dropped
    if (!db.chatThreads.some((t) => t.id === threadId)) throw new HttpError(409, 'Der Chat-Verlauf wurde inzwischen entfernt.');
    db.chatMessages.push(m);
    db.chatThreads.find((t) => t.id === threadId)!.updatedAt = m.createdAt;
    return messageView(db, m);
  });
  return { user, assistant };
}

// ---------- Apply / dismiss ----------

function findProposal(db: Db, id: string): { message: ChatMessage; proposal: ChatProposal; thread: ChatThread } {
  for (const message of db.chatMessages) {
    const proposal = message.proposals.find((p) => p.id === id);
    if (proposal) return { message, proposal, thread: must(db.chatThreads.find((t) => t.id === message.threadId), 'Chat-Verlauf') };
  }
  throw new HttpError(404, 'Vorschlag nicht gefunden');
}

/**
 * `POST /api/chat/proposals/[id]/apply`: applies the stored (re-validated) patch to the CURRENT state, only while the
 * base it was made on is still current; design/strategy/profile/voice become a new active version (the previous one
 * stays in the history = undo), the draft gets a new revision (undo in the editor).
 */
export async function applyProposal(id: string) {
  const { proposal, thread } = await read((db) => {
    const f = findProposal(db, id);
    if (f.proposal.status !== 'open') throw new HttpError(409, f.proposal.status === 'applied' ? 'Dieser Vorschlag ist schon übernommen.' : 'Dieser Vorschlag wurde verworfen.');
    if (!isCurrent(db, f.proposal.base)) throw new HttpError(409, STALE, 'stale_base');
    return f;
  });
  const patch = ChatPatch.parse(proposal.patch);
  const targets = await loadTargets(thread.scope, proposal.base.kind === 'edit_draft' || proposal.base.kind === 'story' ? proposal.base.scriptId : null, proposal.base.kind === 'week' ? proposal.base.weekStart : null);
  let out: ReturnType<typeof applyTo>;
  try {
    out = applyTo(targets, patch);
  } catch (e) {
    if (e instanceof ChatPatchError || e instanceof z.ZodError) throw new HttpError(409, `Der Vorschlag passt nicht mehr: ${e instanceof z.ZodError ? 'ungültige Werte' : e.message} – bitte neu vorschlagen lassen.`, 'stale_base');
    throw e;
  }
  // review fix: the click applies exactly what the card shows. Sentence numbers and pacing depend on transcripts and pause
  // scans that can change without a new draft revision (re-transcription): a different result is a stale proposal.
  if (JSON.stringify(out.changes) !== JSON.stringify(proposal.changes))
    throw new HttpError(409, `${STALE.replace(' – bitte neu vorschlagen lassen.', '')} (Transkript oder Stand weicht von der Karte ab) – bitte neu vorschlagen lassen.`, 'stale_base');
  return write((db) => {
    const f = findProposal(db, id);
    if (f.proposal.status !== 'open') throw new HttpError(409, 'Dieser Vorschlag ist schon entschieden.');
    if (!isCurrent(db, f.proposal.base)) throw new HttpError(409, STALE, 'stale_base');
    const a = out.applied;
    let result: NonNullable<ChatProposal['result']>;
    if (a.kind === 'design') {
      const v = saveDesignIn(db, a.design, (f.proposal.base as { versionId: string | null }).versionId);
      result = { versionId: v.id, version: v.version };
    } else if (a.kind === 'voice') {
      const v: VoiceGuideVersion = {
        id: newId(), profileId: PERSONAL_PROFILE_ID, version: nextVersion(db.voiceGuides, PERSONAL_PROFILE_ID), status: 'approved', rules: a.rules, createdAt: now(), approvedAt: now(), suggestionId: null,
      };
      pushActive(db.voiceGuides, v);
      result = { versionId: v.id, version: v.version };
    } else if (a.kind === 'strategy' || a.kind === 'profile') {
      const { version } = a.kind === 'strategy' ? addActiveVersion(db, { kind: 'strategy', document: a.document }, 'chat') : addActiveVersion(db, { kind: 'profile', document: a.document }, 'chat');
      result = { versionId: version.id, version: version.version };
    } else if (a.kind === 'week') {
      // Etappe 20: moves on the board (nothing is deleted or posted)
      applyWeekMoves(db, a.moves);
      result = {};
    } else if (a.kind === 'carousel') {
      const base = f.proposal.base as Extract<ChatProposalBase, { kind: 'carousel' }>;
      const v = applyChatVersion(db, base.carouselId, base.versionId, a.body);
      result = { versionId: v.id, version: v.version };
    } else {
      const base = f.proposal.base as Extract<ChatProposalBase, { kind: 'edit_draft' | 'story' }>;
      const d = findDraft(db, base.projectId, base.scriptId)!;
      Object.assign(d, { body: a.body, revision: d.revision + 1, updatedAt: now() });
      result = { revision: d.revision };
      // Etappe 16: the story remembers her selection (the next „Beat 3 raus“ starts from it)
      if (a.kind === 'story' && base.kind === 'story') {
        const s = db.storyPlans.find((x) => x.id === base.storyId);
        if (s) {
          s.lastSelection = a.selection.beats ? a.selection : { ...(s.lastSelection ?? defaultSelection(s.body)), hookId: a.selection.hookId ?? s.lastSelection?.hookId ?? null };
          s.applied = [...s.applied, { at: now(), revision: d.revision, selection: a.selection }].slice(-10);
        }
      }
    }
    Object.assign(f.proposal, { status: 'applied', decidedAt: now(), result });
    return { proposal: f.proposal, kind: a.kind, result, scope: f.thread.scope };
  });
}

/** `POST /api/chat/proposals/[id]/dismiss`: marks it as discarded (nothing changes). */
export async function dismissProposal(id: string) {
  return write((db) => {
    const { proposal } = findProposal(db, id);
    if (proposal.status === 'applied') throw new HttpError(409, 'Ein übernommener Vorschlag lässt sich nicht verwerfen – die Vorversion bleibt in der Historie.');
    Object.assign(proposal, { status: 'dismissed', decidedAt: now() });
    return { proposal };
  });
}

// ---------- Model Lab ----------

/** Model Lab input `chat`: her latest message in a personal chat (client-project editor threads excluded), with its history. */
export async function prepareChatEvalTask() {
  const pick = await read((db) => {
    const client = new Set(db.projects.filter((p) => p.kind === 'UGC_CLIENT').map((p) => p.id));
    const msgs = db.chatMessages.filter((m) => m.role === 'user').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const m of msgs) {
      const t = db.chatThreads.find((x) => x.id === m.threadId);
      if (!t || (t.projectId && client.has(t.projectId))) continue;
      const before = db.chatMessages.filter((x) => x.threadId === t.id && x.createdAt <= m.createdAt);
      const idx = before.findIndex((x) => x.id === m.id);
      const hist = before.slice(0, idx >= 0 ? idx : before.length).slice(-HISTORY_MESSAGES);
      const scriptId = t.projectId ? db.editDrafts.find((d) => d.projectId === t.projectId)?.scriptId ?? null : null;
      return { thread: t, message: m, conversation: [...hist.map((x) => ({ role: x.role, text: x.role === 'assistant' ? assistantTurn(x) : x.text })), { role: 'user' as const, text: m.text }], scriptId };
    }
    return null;
  });
  if (!pick) throw new HttpError(400, 'Noch keine Chat-Nachricht – schreib zuerst im Studio-Chat.');
  const { task } = await prepareChatTask(pick.thread.scope, pick.conversation, { scriptId: pick.scriptId, imageIds: pick.message.imageIds.slice(0, MAX_CHAT_IMAGES) });
  return { task, label: `Letzte Chat-Nachricht („${pick.message.text.slice(0, 50)}“)`, projectIds: pick.thread.projectId ? [pick.thread.projectId] : [] };
}

