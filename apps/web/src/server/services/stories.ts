import 'server-only';
import {
  AI_DISCLOSURE, carouselLook, costBounds, designGuidelineText, emptyIgStory, IG_MEDIA_LABEL, IG_STORY_CLIP_MAX_SEC, IG_STORY_KINDS, IG_STORY_SOURCE_LABEL, igMediaKey,
  IgStoryBody, IgStoryMedia, imageRightsProblem, layoutIgStory, reviewIgStory, ROUTING_POLICIES, routeModel, runStoryWriter,
  type IgMediaInfo, type IgMediaOption, type IgStorySourceInput, type StoryWriterInput, type StoryWriterOutput,
} from '@studio/core';
import { z } from 'zod';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type Db, type IgStoryRecord } from '../store';
import { aiContextHash, aiContextText, personalBlocks } from './aiContext';
import { routeRequestFor, runAgent, type AgentTask } from './agentRuns';
import { carouselRules, imageInfos, reelText, reviewOf, usableLibraryImages } from './carousels';
import { baseDesign } from './designSystem';
import { fontInfos } from './fonts';
import { currentStyle, currentVoice } from './style';

/**
 * Stories (Etappe 19): quick 9:16 stories from material she already has, in the look of „Meine Marke“.
 *
 * - Sources: a finished reel (its transcript; stills and clips of it), a carousel (its slides), a concept, a library photo
 *   or her note. Only her own projects (client stories would need „Anzeige“ and client approval – 409).
 * - `POST /api/projects/[id]/stories` runs ONE Story Writer call (`runAgent`: budget, routing, log) → 3–5 stories of one
 *   batch; `estimate` only returns the cost. A manual story starts empty. Every save bumps the revision (409 when stale).
 * - Media are checked against the store every time (project, rights, length): a story can only show her material.
 * - Nothing here posts anything. Rendering/export: storyRender.ts.
 */

const STALE = 'Inzwischen gibt es eine neuere Fassung dieser Story – bitte neu laden.';
const MAX_STORIES_PER_PROJECT = 200;

export const StorySourceRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('render'), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('carousel'), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('concept'), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('image'), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('note'), text: z.string().trim().min(10, 'Die Notiz ist zu kurz (mindestens 10 Zeichen).').max(4000) }).strict(),
]);
export const CreateStoriesRequest = z.object({
  source: StorySourceRequest,
  count: z.number().int().min(3).max(5).default(4),
  estimate: z.boolean().default(false),
}).strict();

function ownProject(db: Db, projectId: string) {
  const p = must(db.projects.find((x) => x.id === projectId), 'Projekt');
  if (p.kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Stories gibt es zunächst nur für eigene Projekte – Kundenprojekte brauchen „Anzeige“ und die Freigabe der Kundin.');
  return p;
}
const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const finishedRender = (r: Db['renders'][number]) => !!r.storagePath && (r.status === 'pending_review' || r.status === 'approved');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The story's media as the layout and the render know it (project, rights, length checked against the store). */
export function mediaInfo(db: Db, projectId: string, m: IgStoryMedia): IgMediaInfo | null {
  switch (m.kind) {
    case 'none': return null;
    case 'image': {
      const r = db.references.find((x) => x.id === m.imageId);
      const info = r ? { kind: r.kind, usage: r.usage ? { origin: r.usage.origin, source: r.usage.source } : null, mime: r.mime } : undefined;
      return { problem: imageRightsProblem(info), ai: r?.usage?.origin === 'generated', aspect: 0.8, label: r?.name ?? 'Bild' };
    }
    case 'carousel_slide': {
      const c = db.carousels.find((x) => x.id === m.carouselId && x.projectId === projectId);
      if (!c) return { problem: 'Das Karussell gibt es in diesem Projekt nicht (mehr).', ai: false };
      const v = db.carouselVersions.find((x) => x.id === c.activeVersionId);
      if (!v || m.n > v.body.slides.length) return { problem: `Slide ${m.n} gibt es im Karussell nicht (mehr).`, ai: false };
      const { review } = reviewOf(db, c, v.body);
      return { problem: null, ai: review.aiSlides.includes(m.n), aspect: v.body.format === 'square' ? 1 : 0.8, label: `${c.title} · Slide ${m.n}` };
    }
    case 'frame':
    case 'clip': {
      if (m.kind === 'clip' && m.source === 'footage') {
        const a = db.mediaAssets.find((x) => x.id === m.id && x.projectId === projectId);
        if (!a || !a.mime.startsWith('video/')) return { problem: 'Das Video gibt es in diesem Projekt nicht (mehr).', ai: false };
        if (a.generation && a.generation.review !== 'approved') return { problem: 'Dieser KI-Clip ist noch nicht freigegeben.', ai: true };
        const dur = a.probe?.durationSec ?? null;
        if (dur != null && m.startSec + m.durationSec > dur + 0.05) return { problem: `Der Ausschnitt reicht über das Ende des Videos (${round2(dur)} s).`, ai: a.origin === 'generated' };
        return { problem: null, ai: a.origin === 'generated', aspect: 9 / 16, label: a.name };
      }
      const id = m.kind === 'frame' ? m.renderId : m.id;
      const r = db.renders.find((x) => x.id === id && x.projectId === projectId);
      if (!r || !finishedRender(r)) return { problem: 'Das Reel gibt es in diesem Projekt nicht (mehr) oder es ist nicht fertig gerendert.', ai: false };
      const end = m.kind === 'frame' ? m.atSec : m.startSec + m.durationSec;
      if (r.durationSec != null && end > r.durationSec + 0.05) return { problem: `Die Stelle liegt hinter dem Ende des Reels (${round2(r.durationSec)} s).`, ai: r.disclosures.includes(AI_DISCLOSURE) };
      // a reel with generated clips: the story carries the label for its whole length (the excerpt may show one)
      return { problem: null, ai: r.disclosures.includes(AI_DISCLOSURE), aspect: 9 / 16, label: `Reel vom ${r.createdAt.slice(0, 10)}` };
    }
  }
}

/** Media she may put on a story of this project: her usable photos, slides of her carousels, stills/clips of finished reels, draft footage. */
export function mediaOptions(db: Db, projectId: string, focus?: { kind: string; id: string | null }): IgMediaOption[] {
  const out: IgMediaOption[] = [];
  const add = (media: IgStoryMedia, label: string) => {
    const info = mediaInfo(db, projectId, media);
    if (!info || info.problem) return;
    out.push({ key: igMediaKey(media)!, media, label, kind: media.kind, ai: info.ai });
  };
  const renders = db.renders.filter((r) => r.projectId === projectId && finishedRender(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const carousels = db.carousels.filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // the source first (the writer picks from the top of the list)
  const firstRender = focus?.kind === 'render' ? renders.find((r) => r.id === focus.id) : undefined;
  const firstCarousel = focus?.kind === 'carousel' ? carousels.find((c) => c.id === focus.id) : undefined;
  const reel = (r: Db['renders'][number]) => {
    const label = `Reel vom ${r.createdAt.slice(0, 10)}`;
    add({ kind: 'frame', renderId: r.id, atSec: Math.min(1, Math.max(0, (r.durationSec ?? 1) / 2)) }, `${label} · Standbild`);
    add({ kind: 'clip', source: 'render', id: r.id, startSec: 0, durationSec: round2(Math.max(1, Math.min(IG_STORY_CLIP_MAX_SEC, r.durationSec ?? IG_STORY_CLIP_MAX_SEC))) }, `${label} · Clip (Anfang)`);
  };
  const slides = (c: Db['carousels'][number], n: number) => {
    const v = db.carouselVersions.find((x) => x.id === c.activeVersionId);
    for (let i = 1; i <= Math.min(n, v?.body.slides.length ?? 0); i++) add({ kind: 'carousel_slide', carouselId: c.id, n: i }, `${c.title} · Slide ${i}`);
  };
  if (firstCarousel) slides(firstCarousel, 10);
  if (firstRender) reel(firstRender);
  if (focus?.kind === 'image' && focus.id) add({ kind: 'image', imageId: focus.id }, db.references.find((r) => r.id === focus.id)?.name ?? 'Foto');
  for (const r of renders.filter((x) => x !== firstRender).slice(0, 3)) reel(r);
  for (const c of carousels.filter((x) => x !== firstCarousel).slice(0, 3)) slides(c, 1);
  // footage of her working draft (Freier Schnitt): the first clips as short clips
  const draft = db.editDrafts.find((d) => d.projectId === projectId && d.scriptId == null);
  for (const c of (draft?.body.clips ?? []).slice(0, 3)) {
    const a = db.mediaAssets.find((x) => x.id === c.assetId);
    if (a) add({ kind: 'clip', source: 'footage', id: a.id, startSec: round2(c.inSec), durationSec: round2(Math.max(1, Math.min(IG_STORY_CLIP_MAX_SEC, c.outSec - c.inSec))) }, `Entwurf · ${a.name}`);
  }
  for (const r of usableLibraryImages(db).slice(0, 8)) if (r.id !== focus?.id) add({ kind: 'image', imageId: r.id }, r.name);
  return out.slice(0, 40);
}

/** The material as the writer reads it. */
async function resolveSource(projectId: string, src: z.infer<typeof StorySourceRequest>): Promise<IgStorySourceInput & { id: string | null }> {
  if (src.kind === 'note') {
    const first = src.text.split('\n')[0]!.trim();
    return { kind: 'note', id: null, label: `Notiz „${clip(first, 40)}“`, title: first.length <= 90 ? first : '', text: src.text, cta: '', facts: [], flagged: [] };
  }
  if (src.kind === 'render') {
    const { render, text } = await reelText(projectId, src.id);
    return { kind: 'render', id: render.id, label: `Reel vom ${render.createdAt.slice(0, 10)}`, title: '', text, cta: '', facts: [], flagged: [] };
  }
  return read((db) => {
    if (src.kind === 'carousel') {
      const c = must(db.carousels.find((x) => x.id === src.id && x.projectId === projectId), 'Karussell');
      const v = must(db.carouselVersions.find((x) => x.id === c.activeVersionId), 'Karussell-Version');
      const text = v.body.slides.flatMap((s) => [s.title, s.body, ...s.items]).filter(Boolean).join('\n');
      const rules = carouselRules(db, c);
      return { kind: 'carousel' as const, id: c.id, label: `Karussell „${clip(c.title, 60)}“`, title: c.title, text: [text, c.source.text].filter(Boolean).join('\n').slice(0, 6000), cta: '', facts: rules.sources.slice(1), flagged: [...rules.flagged] };
    }
    if (src.kind === 'image') {
      const r = must(db.references.find((x) => x.id === src.id && x.kind === 'image'), 'Bild');
      return { kind: 'image' as const, id: r.id, label: `Foto „${clip(r.name, 50)}“`, title: '', text: [r.notes, r.tags.join(', ')].filter(Boolean).join('\n') || r.name, cta: '', facts: [], flagged: [] };
    }
    const c = must(db.concepts.find((x) => x.id === src.id && x.projectId === projectId), 'Konzept');
    const brief = db.briefs.find((b) => b.id === c.briefId);
    const flagged = [...new Set(db.scripts.filter((s) => s.conceptId === c.id).flatMap((s) => s.body.claimsToVerify))];
    return { kind: 'concept' as const, id: c.id, label: `Konzept „${clip(c.body.title, 60)}“`, title: c.body.title, text: [c.body.hook, c.body.angle, c.body.rationale].filter(Boolean).join('\n'), cta: c.body.cta, facts: brief?.input.verifiedFacts ?? [], flagged };
  });
}

/** The agent task of a new batch (no side effects): also the Model Lab input `ig_story`. */
export async function prepareStoryTask(projectId: string, raw: unknown) {
  const req = CreateStoriesRequest.parse(raw ?? {});
  await read((db) => ownProject(db, projectId));
  const source = await resolveSource(projectId, req.source);
  const snap = await read((db) => ({
    voice: currentVoice(db), style: currentStyle(db), blocks: personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'agent'), design: baseDesign(db).design,
    media: mediaOptions(db, projectId, { kind: source.kind, id: source.id }),
  }));
  const state: Record<string, unknown> = {
    context: aiContextText(snap.blocks, 'agent') || null,
    voice: snap.voice ? { traits: snap.voice.rules.traits, avoid: snap.voice.rules.avoid, ownExamples: snap.voice.rules.ownExamples.slice(0, 3).map((x) => x.slice(0, 300)) } : null,
    brand: designGuidelineText(snap.design),
    format: 'Instagram-Story 9:16 (1080 × 1920), Text nur im sicheren Bereich',
  };
  const input: StoryWriterInput = { source, count: req.count, media: snap.media, state };
  const inputChars = JSON.stringify(state).length + source.text.length + source.title.length + JSON.stringify(snap.media).length + 300;
  const task: AgentTask<StoryWriterOutput> = {
    meta: {
      agent: 'story_writer', useCase: 'story_writing', projectId, clientData: false, inputChars,
      input: { projectId, source: { kind: source.kind, id: source.id, label: source.label }, count: req.count },
      styleVersionId: snap.style?.id ?? null, voiceVersionId: snap.voice?.id ?? null,
      strategyVersionId: snap.blocks.strategy?.versionId ?? null, profileVersionId: snap.blocks.profile?.versionId ?? null, aiContextHash: aiContextHash(snap.blocks, 'agent'),
    },
    run: (p) => runStoryWriter(p, input),
  };
  return { req, source, snap, task };
}

/** What a run costs before she clicks (mock = free). */
export async function storyEstimate(inputChars?: number) {
  const env = providerFromEnv();
  const policy = ROUTING_POLICIES.story_writing;
  const size = inputChars ? { inputTokens: Math.ceil(inputChars / 3) } : undefined;
  return read((db) => {
    const pinned = db.routerPreferences.story_writing ?? null;
    if (env.config.active === 'mock') return { mode: 'mock' as const, label: 'MOCK · kein LLM', model: env.provider.model, estCostUsd: 0, worstCaseUsd: 0, pinned };
    if (env.config.active !== 'openrouter') {
      const b = env.provider.pricing ? costBounds(env.provider.pricing, policy, size) : null;
      return { mode: 'direct' as const, label: `${env.config.active} · ${env.config.model}`, model: env.config.model, estCostUsd: b?.est ?? null, worstCaseUsd: b?.worstCase ?? null, pinned };
    }
    const d = routeModel(routeRequestFor(db, env.config, 'story_writing', { confidential: false, size }));
    return { mode: 'routed' as const, label: d.chosen ? d.chosen.label : 'kein zulässiges Modell', model: d.chosen?.id ?? null, estCostUsd: d.chosen?.estCostUsd ?? null, worstCaseUsd: d.chosen?.worstCaseCostUsd ?? null, pinned };
  });
}

export async function estimateStories(projectId: string, raw: unknown) {
  const { task, source } = await prepareStoryTask(projectId, raw);
  return { estimate: await storyEstimate(task.meta.inputChars), source: { kind: source.kind, label: source.label } };
}

const findStory = (db: Db, projectId: string, id: string) => must(db.stories.find((s) => s.id === id && s.projectId === projectId), 'Story');
const room = (db: Db, projectId: string, n: number) => {
  if (db.stories.filter((s) => s.projectId === projectId).length + n > MAX_STORIES_PER_PROJECT) throw new HttpError(409, `Höchstens ${MAX_STORIES_PER_PROJECT} Stories pro Projekt – bitte alte löschen.`);
};

/** `POST …/stories`: one Story Writer run → 3–5 stories of one batch. */
export async function createStories(projectId: string, raw: unknown) {
  const { source, task, snap } = await prepareStoryTask(projectId, raw);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  const ids = await write((db) => {
    ownProject(db, projectId);
    room(db, projectId, result.output.stories.length);
    const at = now();
    const batchId = newId();
    const warnings = [...result.output.warnings, ...(result.output.notes ? [result.output.notes] : [])].slice(0, 40);
    return result.output.stories.map((d, i) => {
      const rec: IgStoryRecord = {
        id: newId(), projectId, batchId, title: d.title.slice(0, 120) || source.label, source: { kind: source.kind, id: source.id, label: source.label, text: source.text.slice(0, 8000) },
        revision: 1, body: d.body, origin: 'agent', agentRunId: run.id, promptVersion: result.promptVersion, mock, provider: run.provider, model: run.model,
        costUsd: i === 0 ? run.costEstimateUsd : 0, costSource: run.costSource ?? null, warnings: i === 0 ? warnings : [],
        styleBibleVersionId: snap.style?.id ?? null, voiceGuideVersionId: snap.voice?.id ?? null, strategyVersionId: snap.blocks.strategy?.versionId ?? null, profileVersionId: snap.blocks.profile?.versionId ?? null,
        render: null, createdAt: at, updatedAt: at,
      };
      db.stories.push(rec);
      return rec.id;
    });
  });
  return { ids, warnings: result.output.warnings, notes: result.output.notes, mock, stories: await read((db) => ids.map((id) => summary(db, findStory(db, projectId, id)))) };
}

export const ManualStoryRequest = z.object({ kind: z.enum(IG_STORY_KINDS).default('bts'), media: IgStoryMedia.default({ kind: 'none' }), title: z.string().trim().max(120).default('') }).strict();
/** `POST …/stories/manual`: an empty story of a kind (optionally with a medium) – no agent. */
export async function createManualStory(projectId: string, raw: unknown) {
  const req = ManualStoryRequest.parse(raw ?? {});
  const id = await write((db) => {
    ownProject(db, projectId);
    room(db, projectId, 1);
    const at = now();
    const style = currentStyle(db), voice = currentVoice(db), blocks = personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'agent');
    const rec: IgStoryRecord = {
      id: newId(), projectId, batchId: newId(), title: req.title || 'Neue Story', source: { kind: 'note', id: null, label: 'Eigene Story', text: '' },
      revision: 1, body: emptyIgStory(req.kind, req.media), origin: 'manual', agentRunId: null, promptVersion: null, mock: false, provider: null, model: null, costUsd: null, costSource: null, warnings: [],
      styleBibleVersionId: style?.id ?? null, voiceGuideVersionId: voice?.id ?? null, strategyVersionId: blocks.strategy?.versionId ?? null, profileVersionId: blocks.profile?.versionId ?? null,
      render: null, createdAt: at, updatedAt: at,
    };
    db.stories.push(rec);
    return rec.id;
  });
  return getStory(projectId, id);
}

const summary = (db: Db, s: IgStoryRecord) => ({
  id: s.id, batchId: s.batchId, title: s.title, kind: s.body.kind, media: s.body.media.kind, mode: s.body.media.kind === 'clip' ? 'clip' as const : 'still' as const,
  source: { kind: s.source.kind, id: s.source.id, label: s.source.label }, revision: s.revision, mock: s.mock, origin: s.origin, updatedAt: s.updatedAt, createdAt: s.createdAt,
  onBoard: db.boardItems.some((b) => b.ref?.kind === 'story' && b.ref.id === s.id),
});

/** Look, media info, rules, layout and review of a body (one consistent snapshot). */
export function storyReviewOf(db: Db, s: Pick<IgStoryRecord, 'projectId' | 'source'>, body: IgStoryBody) {
  const { look, warnings } = carouselLook(baseDesign(db).design, fontInfos(db));
  const media = mediaInfo(db, s.projectId, body.media);
  const layout = layoutIgStory(body, look, media);
  const rules = carouselRules(db, s);
  return { look, lookWarnings: warnings, media, layout, rules, review: reviewIgStory(body, layout, rules) };
}

/** `GET /api/projects/[id]/stories`: her stories (newest first), the sources she can pick and the cost estimate. */
export async function listStories(projectId: string) {
  const base = await read((db) => {
    const p = must(db.projects.find((x) => x.id === projectId), 'Projekt');
    const available = p.kind === 'PERSONAL_CONTENT';
    return {
      available, reason: available ? null : 'Stories gibt es zunächst nur für eigene Projekte.',
      stories: db.stories.filter((s) => s.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).map((s) => summary(db, s)),
      sources: {
        renders: db.renders.filter((r) => r.projectId === projectId && finishedRender(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map((r) => ({ id: r.id, label: `Reel vom ${r.createdAt.slice(0, 16).replace('T', ' ')}` })),
        carousels: db.carousels.filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map((c) => ({ id: c.id, label: c.title })),
        concepts: db.concepts.filter((c) => c.projectId === projectId && c.status !== 'rejected').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((c) => ({ id: c.id, label: c.body.title })),
        images: usableLibraryImages(db).slice(0, 40).map((r) => ({ id: r.id, label: r.name })),
      },
      sourceLabels: IG_STORY_SOURCE_LABEL,
    };
  });
  return { ...base, estimate: await storyEstimate() };
}

/** `GET …/stories/[sid]`: record, layout inputs (look, media info), review, the media she can choose. */
export const getStory = (projectId: string, id: string) => read((db) => {
  const s = findStory(db, projectId, id);
  const { look, lookWarnings, media, review, rules } = storyReviewOf(db, s, s.body);
  return {
    story: s, look, lookWarnings, media, review, rules,
    options: mediaOptions(db, projectId).map((o) => ({ ...o, label: `${IG_MEDIA_LABEL[o.kind]}: ${o.label}`, info: mediaInfo(db, projectId, o.media)! })),
    images: [...imageInfos(db).entries()].map(([rid, i]) => ({ id: rid, ...i })),
    onBoard: db.boardItems.some((b) => b.ref?.kind === 'story' && b.ref.id === s.id),
  };
});

/** Media info for her unsaved edit (the editor previews a body before saving). */
export const previewMediaInfo = (projectId: string, raw: unknown) => read((db) => mediaInfo(db, projectId, IgStoryMedia.parse(raw)));

export const SaveStoryRequest = z.object({ baseRevision: z.number().int().min(1), body: IgStoryBody, title: z.string().trim().min(1).max(120).optional() }).strict();
/** `PUT …/stories/[sid]`: her edit → the next revision (409 when another save came first). */
export async function saveStory(projectId: string, id: string, raw: unknown) {
  const req = SaveStoryRequest.parse(raw);
  await write((db) => {
    ownProject(db, projectId);
    const s = findStory(db, projectId, id);
    if (s.revision !== req.baseRevision) throw new HttpError(409, STALE, 'stale_revision');
    if (req.title) s.title = req.title;
    Object.assign(s, { body: req.body, revision: s.revision + 1, updatedAt: now() });
  });
  return getStory(projectId, id);
}

/** `DELETE …/stories/[sid]`: the story; a board entry keeps its title but loses the link. Files: storyRender. */
export async function deleteStoryRecord(projectId: string, id: string) {
  return write((db) => {
    findStory(db, projectId, id);
    db.stories = db.stories.filter((s) => s.id !== id);
    for (const b of db.boardItems) if (b.ref?.kind === 'story' && b.ref.id === id) Object.assign(b, { ref: null, updatedAt: now() });
    return { deleted: id };
  });
}

/** Model Lab input `ig_story`: the source of her latest generated batch (nothing is stored or changed). */
export async function prepareStoryWriterEvalTask() {
  const pick = await read((db) => {
    const personal = new Set(db.projects.filter((p) => p.kind === 'PERSONAL_CONTENT').map((p) => p.id));
    return [...db.stories].filter((s) => s.origin === 'agent' && personal.has(s.projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  });
  if (!pick) throw new HttpError(400, 'Noch keine Stories – erstelle zuerst welche unter „Stories“.');
  const source = pick.source.kind === 'note' ? { kind: 'note' as const, text: pick.source.text.slice(0, 4000) } : { kind: pick.source.kind, id: pick.source.id ?? '' };
  const { task } = await prepareStoryTask(pick.projectId, { source });
  return { task, label: `Letzte Stories („${pick.source.label.slice(0, 50)}“)`, projectIds: [pick.projectId] };
}
