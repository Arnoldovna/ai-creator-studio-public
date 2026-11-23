import 'server-only';
import {
  buildStorySentences, costBounds, IMAGE_OVERLAY_MIMES, defaultSelection, designGuidelineText, lookFit, ROUTING_POLICIES, routeModel, runEditDirector, type EditDraftBody,
  StoryError, StorySelection, storyToDraft, STORY_TARGET_SEC, type StoryApplyContext, type StoryContext, type StoryPlanBody, type TranscriptBody,
} from '@studio/core';
import { z } from 'zod';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import { probeMedia } from '../ffmpeg';
import { absolutePath } from '../media';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type Db, type Reference, type StoryPlanRecord } from '../store';
import { aiContextHash, aiContextText, currentApproved, personalBlocks } from './aiContext';
import { routeRequestFor, runAgent, type AgentTask } from './agentRuns';
import { baseDesign } from './designSystem';
import { lookPresets, pinnedStyleFor, planLook } from './edit';
import { checkBase, findDraft, ScriptKey } from './editDraft';
import { currentStyle, currentVoice } from './style';
import { latestTranscript, readTranscriptBody } from './transcripts';

/**
 * KI-Dramaturgie (Etappe 16, E8): the Edit Director's proposals for the editor's Freier Schnitt.
 *
 * - Only personal projects and the Freier Schnitt: client projects get 409 (their gates stay as they are); a scripted cut
 *   has its own dramaturgy (the script).
 * - `POST …/edit-draft/story` runs ONE `runAgent` call (budget, routing, log) on the transcript sentences of the draft's
 *   takes, her strategy/profile context, voice and design system; `?estimate=1` (or `estimate: true`) only returns what it
 *   would cost. The proposal is stored in `storyPlans` with the transcript versions it was made on.
 * - `POST …/story/[id]/apply` applies a selection (everything, single beats, one hook, single overlays/images/zooms) as a
 *   new draft revision – a normal change the editor can undo. A newer transcript makes the proposal stale (409).
 * - Nothing here renders, posts or buys anything.
 */

const MAX_PLANS_PER_DRAFT = 10;
const STALE = 'Die Transkripte haben sich seit dem Vorschlag geändert – bitte neu vorschlagen lassen.';

/** Usable library images: her own, licensed with a source, or generated (then labelled in the render). */
const usableImages = (db: Db) => db.references.filter((r): r is Reference & { usage: NonNullable<Reference['usage']> } => r.kind === 'image' && IMAGE_OVERLAY_MIMES.includes(r.mime) && !!r.usage && (r.usage.origin !== 'licensed' || r.usage.source.trim().length >= 3));

/** Aspect ratio (w/h, displayed) of library images via ffprobe, memoised by content hash. */
const aspectMemo = new Map<string, number | null>();
export async function imageAspects(refs: readonly Pick<Reference, 'id' | 'sha256' | 'storagePath'>[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of refs) {
    if (!aspectMemo.has(r.sha256)) {
      const p = await probeMedia(absolutePath(r.storagePath));
      const w = p?.displayWidth ?? p?.width, h = p?.displayHeight ?? p?.height;
      aspectMemo.set(r.sha256, w && h ? Math.min(5, Math.max(0.2, w / h)) : null);
    }
    const a = aspectMemo.get(r.sha256);
    if (a) out.set(r.id, a);
  }
  return out;
}

/** Project, draft and everything the story context needs (one consistent snapshot). */
function snapshot(db: Db, projectId: string, scriptId: string | null) {
  const project = checkBase(db, projectId, scriptId);
  if (project.kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Die KI-Dramaturgie gibt es zunächst nur für eigene Projekte – Kundenprojekte behalten ihre Freigaben (Skript, Claims, Kennzeichnung).');
  if (scriptId) throw new HttpError(409, 'Die KI-Dramaturgie arbeitet im Freien Schnitt – ein Skript-Schnitt folgt seinem Skript.');
  const draft = findDraft(db, projectId, scriptId);
  if (!draft || !draft.body.clips.length) throw new HttpError(409, 'Noch kein Clip im Schnitt – erst Footage in den Editor legen.');
  const assetIds = [...new Set(draft.body.clips.map((c) => c.assetId))];
  const takes = assetIds.map((id) => {
    const a = must(db.mediaAssets.find((x) => x.id === id && x.projectId === projectId), 'Footage');
    return { asset: a, transcript: latestTranscript(db, id) };
  });
  const pinned = pinnedStyleFor(db, projectId, scriptId);
  const look = planLook(db, { styleBibleVersionId: pinned }, draft.body.look, draft.body);
  const presets = lookPresets(db, pinned);
  const strategy = currentApproved(db, 'strategy');
  const pillars = (strategy?.document.pillars ?? []).map((p) => ({ id: p.id, name: p.name }));
  const design = baseDesign(db).design;
  const voice = currentVoice(db);
  const blocks = personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'agent');
  const images = usableImages(db);
  return { project, draft, takes, look, presets, pillars, design, voice, blocks, images, style: currentStyle(db) };
}

async function sentencesOf(takes: ReturnType<typeof snapshot>['takes']) {
  const sources = await Promise.all(takes.map(async (t) => ({
    assetId: t.asset.id, durationSec: t.asset.probe?.durationSec ?? null,
    transcript: t.transcript ? await readTranscriptBody(t.transcript).catch((): TranscriptBody | null => null) : null,
  })));
  return buildStorySentences(sources);
}

const TargetSec = z.number().int().min(STORY_TARGET_SEC.min).max(STORY_TARGET_SEC.max);
export const StoryRequest = z.object({
  scriptId: ScriptKey.default(null),
  /** Desired length of the cut in seconds (default: about the target of her strategy/brand, else 35 s). */
  targetSec: TargetSec.optional(),
  estimate: z.boolean().default(false),
}).strict();

/** The agent task (no side effects): also the Model Lab input `story`. */
export async function prepareStoryTask(projectId: string, opts: { scriptId: string | null; targetSec?: number }) {
  const snap = await read((db) => snapshot(db, projectId, opts.scriptId));
  const sentences = await sentencesOf(snap.takes);
  if (!sentences.length) throw new HttpError(409, 'Noch kein Transkript – die Dramaturgie braucht die gesprochenen Sätze (Transkription läuft noch oder ist nicht verfügbar).');
  const ctx: StoryContext = {
    sentences, targetSec: opts.targetSec ?? STORY_TARGET_SEC.default,
    presetIds: snap.presets.presets.map((p) => p.id), defaultPresetId: snap.presets.defaultPresetId,
    pillars: snap.pillars, images: snap.images.map((r) => ({ id: r.id, name: r.name.slice(0, 80) })),
    allowedClaims: [], flaggedClaims: [], fit: lookFit(snap.look), hookSlot: snap.presets.hookSlot ?? 'upper',
  };
  const d = snap.design;
  // her context as data (untrusted): strategy/profile text, voice, design system, usable images
  const state: Record<string, unknown> = {
    strategy: { pillars: snap.pillars },
    context: aiContextText(snap.blocks, 'agent') || null,
    voice: snap.voice ? { traits: snap.voice.rules.traits, avoid: snap.voice.rules.avoid, ownExamples: snap.voice.rules.ownExamples.slice(0, 3).map((x) => x.slice(0, 300)) } : null,
    design: {
      presets: snap.presets.presets, defaultPresetId: snap.presets.defaultPresetId,
      motion: { targetCutSec: d.motion.targetCutSec, tempo: d.motion.tempo, zoom: d.motion.zoom, transitions: d.motion.transitions },
      phrases: d.phrases.map((p) => p.text).slice(0, 20), summary: designGuidelineText(d),
    },
    images: ctx.images.map((i) => ({ id: i.id, name: i.name, notes: snap.images.find((r) => r.id === i.id)?.notes.slice(0, 200) ?? '' })),
    format: '9:16 Reel',
  };
  const input = { state, ctx, tempo: d.motion.tempo };
  const inputChars = JSON.stringify(state).length + sentences.reduce((n, s) => n + s.text.length + 12, 0);
  const task: AgentTask<StoryPlanBody> = {
    meta: {
      agent: 'edit_director', useCase: 'edit_direction', projectId, clientData: false, inputChars,
      input: { projectId, draftRevision: snap.draft.revision, sentences: sentences.map((s) => s.text), targetSec: ctx.targetSec },
      styleVersionId: snap.style?.id ?? null, voiceVersionId: snap.voice?.id ?? null,
      strategyVersionId: snap.blocks.strategy?.versionId ?? null, profileVersionId: snap.blocks.profile?.versionId ?? null, aiContextHash: aiContextHash(snap.blocks, 'agent'),
    },
    run: (p) => runEditDirector(p, input),
  };
  return { snap, sentences, task };
}

/** What a proposal costs before she clicks (router choice, her pin or the fixed provider; mock = free). */
async function estimate(inputChars?: number) {
  const env = providerFromEnv();
  const policy = ROUTING_POLICIES.edit_direction;
  const size = inputChars ? { inputTokens: Math.ceil(inputChars / 3) } : undefined;
  return read((db) => {
    const pinned = db.routerPreferences.edit_direction ?? null;
    if (env.config.active === 'mock') return { mode: 'mock' as const, label: 'MOCK · kein LLM', model: env.provider.model, estCostUsd: 0, worstCaseUsd: 0, pinned };
    if (env.config.active !== 'openrouter') {
      const b = env.provider.pricing ? costBounds(env.provider.pricing, policy, size) : null;
      return { mode: 'direct' as const, label: `${env.config.active} · ${env.config.model}`, model: env.config.model, estCostUsd: b?.est ?? null, worstCaseUsd: b?.worstCase ?? null, pinned };
    }
    const req = routeRequestFor(db, env.config, 'edit_direction', { confidential: false, size });
    const d = routeModel(req);
    return { mode: 'routed' as const, label: d.chosen ? d.chosen.label : 'kein zulässiges Modell', model: d.chosen?.id ?? null, estCostUsd: d.chosen?.estCostUsd ?? null, worstCaseUsd: d.chosen?.worstCaseCostUsd ?? null, pinned };
  });
}

const view = (p: StoryPlanRecord, db: Db) => {
  const draft = findDraft(db, p.projectId, p.scriptId);
  const stale = p.sources.some((s) => latestTranscript(db, s.assetId)?.id !== s.transcriptId);
  return { ...p, stale, draftChanged: !draft || draft.id !== p.draftId || draft.revision !== p.draftRevision, defaultSelection: defaultSelection(p.body) };
};

/** `GET …/edit-draft/story?scriptId=`: availability, the latest proposals (newest first) and the cost estimate. */
export async function listStories(projectId: string, rawScriptId: unknown) {
  const scriptId = ScriptKey.parse(rawScriptId || null);
  const base = await read((db) => {
    const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
    const available = project.kind === 'PERSONAL_CONTENT' && scriptId == null;
    const plans = db.storyPlans.filter((p) => p.projectId === projectId && p.scriptId === scriptId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map((p) => view(p, db));
    const motion = baseDesign(db).design.motion;
    return {
      available, reason: available ? null : project.kind !== 'PERSONAL_CONTENT' ? 'Kundenprojekte: zunächst ohne KI-Dramaturgie (Freigaben bleiben).' : 'Nur im Freien Schnitt.',
      plans, pillars: (currentApproved(db, 'strategy')?.document.pillars ?? []).map((p) => ({ id: p.id, name: p.name })),
      motion: { targetCutSec: motion.targetCutSec, tempo: motion.tempo },
      images: usableImages(db).map((r) => ({ id: r.id, name: r.name, origin: r.usage.origin })),
    };
  });
  return { ...base, estimate: await estimate() };
}

/** `POST …/edit-draft/story?estimate=1` (or `estimate: true`): what the run would cost – nothing runs. */
export async function estimateStory(projectId: string, raw: unknown) {
  const req = StoryRequest.parse(raw ?? {});
  const { sentences, task } = await prepareStoryTask(projectId, { scriptId: req.scriptId, targetSec: req.targetSec });
  return { estimate: await estimate(task.meta.inputChars), sentences: sentences.length };
}

/** `POST …/edit-draft/story`: one Edit Director run → a stored proposal. */
export async function proposeStory(projectId: string, raw: unknown) {
  const req = StoryRequest.parse(raw ?? {});
  const { snap, task } = await prepareStoryTask(projectId, { scriptId: req.scriptId, targetSec: req.targetSec });
  const { result, run, mock } = await runAgent(task.meta, task.run);
  const plan: StoryPlanRecord = {
    id: newId(), projectId, scriptId: req.scriptId, draftId: snap.draft.id, draftRevision: snap.draft.revision,
    sources: snap.takes.flatMap((t) => (t.transcript ? [{ assetId: t.asset.id, transcriptId: t.transcript.id }] : [])),
    agentRunId: run.id, promptVersion: result.promptVersion, mock, provider: run.provider, model: run.model, costUsd: run.costEstimateUsd, costSource: run.costSource ?? null,
    body: result.output, lastSelection: null, applied: [], createdAt: now(),
  };
  return write((db) => {
    must(db.projects.find((p) => p.id === projectId), 'Projekt');
    db.storyPlans.push(plan);
    // keep the newest proposals per draft
    const old = db.storyPlans.filter((p) => p.projectId === projectId && p.scriptId === req.scriptId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(MAX_PLANS_PER_DRAFT).map((p) => p.id);
    if (old.length) db.storyPlans = db.storyPlans.filter((p) => !old.includes(p.id));
    return view(plan, db);
  });
}

/** The apply context of a draft (durations, image aspects, slots, fit). */
async function applyContext(projectId: string, scriptId: string | null, story: StoryPlanRecord): Promise<StoryApplyContext> {
  const snap = await read((db) => {
    const s = snapshot(db, projectId, scriptId);
    const durations = new Map(db.mediaAssets.filter((a) => a.projectId === projectId).map((a) => [a.id, a.probe?.durationSec ?? null] as const));
    const refs = s.images.filter((r) => story.body.images.some((i) => i.referenceId === r.id));
    return { durations, refs, fit: lookFit(s.look), hookSlot: s.presets.hookSlot ?? 'upper', overlaySlot: s.presets.overlaySlot ?? 'center' };
  });
  return { durations: snap.durations, imageAspects: await imageAspects(snap.refs), scriptless: scriptId == null, fit: snap.fit, hookSlot: snap.hookSlot, overlaySlot: snap.overlaySlot };
}

export const applyContextFor = (projectId: string, story: StoryPlanRecord) => applyContext(projectId, story.scriptId, story);

/** Applies a selection of a story to a draft body (no storing): the hook still, the chat's dry run and „Übernehmen“. */
export function applyStoryTo(body: EditDraftBody, story: StoryPlanRecord, selection: StorySelection, ctx: StoryApplyContext) {
  try {
    return storyToDraft(body, story.body, selection, ctx);
  } catch (e) {
    if (e instanceof StoryError || e instanceof z.ZodError) throw new HttpError(409, e instanceof z.ZodError ? 'Auswahl ungültig.' : e.message);
    throw e;
  }
}

export const ApplyRequest = z.object({
  scriptId: ScriptKey.default(null),
  /** The draft revision she sees (after the editor flushed); a different stored revision is a conflict. */
  revision: z.number().int().min(1),
  /** Absent = everything as proposed. */
  selection: StorySelection.optional(),
}).strict();

/** `POST …/story/[storyId]/apply`: the selection as a new draft revision (undo in the editor). */
export async function applyStory(projectId: string, storyId: string, raw: unknown) {
  const req = ApplyRequest.parse(raw ?? {});
  const story = await read((db) => {
    const s = must(db.storyPlans.find((x) => x.id === storyId && x.projectId === projectId), 'Dramaturgie-Vorschlag');
    if (s.sources.some((x) => latestTranscript(db, x.assetId)?.id !== x.transcriptId)) throw new HttpError(409, STALE, 'stale_story');
    return s;
  });
  const ctx = await applyContext(projectId, req.scriptId, story);
  const selection = req.selection ?? defaultSelection(story.body);
  return write((db) => {
    const draft = findDraft(db, projectId, req.scriptId);
    if (!draft) throw new HttpError(404, 'Kein Entwurf vorhanden.');
    if (draft.revision !== req.revision) throw new HttpError(409, `Der Entwurf wurde inzwischen geändert (Stand ${draft.revision}, hier ${req.revision}) – neu laden.`, 'draft_conflict');
    // review fix: the transcripts are checked again in the same write (a re-transcription during the apply is caught)
    const current = db.storyPlans.find((x) => x.id === storyId);
    if (!current || current.sources.some((x) => latestTranscript(db, x.assetId)?.id !== x.transcriptId)) throw new HttpError(409, STALE, 'stale_story');
    const r = applyStoryTo(draft.body, story, selection, ctx);
    Object.assign(draft, { body: r.body, revision: draft.revision + 1, updatedAt: now() });
    const s = db.storyPlans.find((x) => x.id === storyId)!;
    // „Beat 2 raus“ in the chat starts from her last beats (and zooms); a hook-only apply keeps the beats she had
    const last = s.lastSelection;
    s.lastSelection = selection.beats ? selection : last ? { ...last, hookId: selection.hookId ?? last.hookId } : { ...selection, beats: null };
    s.applied = [...s.applied, { at: now(), revision: draft.revision, selection }].slice(-10);
    return { revision: draft.revision, changes: r.changes, warnings: r.warnings };
  });
}

/** The draft with a story's beats and one hook option – the body of the hook still (never stored). */
export function storyVariant(db: Db, projectId: string, storyId: string, hookId: string | null, body: EditDraftBody): EditDraftBody {
  const story = must(db.storyPlans.find((x) => x.id === storyId && x.projectId === projectId), 'Dramaturgie-Vorschlag');
  const durations = new Map(db.mediaAssets.filter((a) => a.projectId === projectId).map((a) => [a.id, a.probe?.durationSec ?? null] as const));
  const presets = lookPresets(db, pinnedStyleFor(db, projectId, null));
  const sel = defaultSelection(story.body);
  try {
    // beats as proposed (so the still shows the first frame of the proposed cut), only this hook, no overlays/images
    return storyToDraft(body, story.body, { ...sel, hookId, overlayIds: [], imageIds: [], zoomBeatIds: sel.zoomBeatIds }, {
      durations, imageAspects: new Map(), scriptless: true, fit: lookFit(planLook(db, { styleBibleVersionId: pinnedStyleFor(db, projectId, null) }, body.look, body)),
      hookSlot: presets.hookSlot ?? 'upper', overlaySlot: presets.overlaySlot ?? 'center',
    }).body;
  } catch (e) {
    if (e instanceof StoryError) throw new HttpError(409, e.message);
    throw e;
  }
}

/** Model Lab input `story`: the latest proposal's personal draft, re-run with the same inputs (nothing is stored). */
export async function prepareStoryEvalTask() {
  const pick = await read((db) => {
    const personal = new Set(db.projects.filter((p) => p.kind === 'PERSONAL_CONTENT').map((p) => p.id));
    return [...db.storyPlans].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((p) => personal.has(p.projectId)) ?? null;
  });
  if (!pick) throw new HttpError(400, 'Noch kein Dramaturgie-Vorschlag – zuerst im Editor „Dramaturgie vorschlagen“.');
  const { task } = await prepareStoryTask(pick.projectId, { scriptId: pick.scriptId, targetSec: pick.body.targetSec });
  return { task, label: `Dramaturgie (${pick.body.sentences.length} Sätze, Ziel ${pick.body.targetSec} s)`, projectIds: [pick.projectId] };
}
