import 'server-only';
import {
  CAROUSEL_SOURCE_LABEL, CarouselBody, CarouselFormat, carouselLook, costBounds, designGuidelineText, ensureCaptionLabels, FrameworkId, IMAGE_OVERLAY_MIMES, reviewCarousel,
  ROUTING_POLICIES, routeModel, runCarouselWriter, TemplateId, TranscriptBody, type CarouselDraft, type CarouselImageInfo, type CarouselRules, type CarouselSourceInput,
  type CarouselWriterInput,
} from '@studio/core';
import { z } from 'zod';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type CarouselRecord, type CarouselVersion, type Db, type Reference } from '../store';
import { aiContextHash, aiContextText, personalBlocks } from './aiContext';
import { routeRequestFor, runAgent, type AgentTask } from './agentRuns';
import { scriptLineage } from './content';
import { baseDesign } from './designSystem';
import { fontInfos } from './fonts';
import { currentStyle, currentVoice } from './style';
import { latestTranscript, readTranscriptBody } from './transcripts';

/**
 * Karussell-Generator (Etappe 18): one idea → a carousel in the look of „Meine Marke“, in several looks.
 *
 * - Sources: a concept, a script, a finished reel (its transcript in cut order) or her own note. Only her own projects
 *   (client carousels would need ad labels and client approval – not built yet, 409).
 * - `POST /api/projects/[id]/carousels` runs ONE Carousel Writer call (`runAgent`: budget, routing, log); `estimate` only
 *   returns the cost. Every save (her edit, a variant = same texts in another layout/look, a chat change) is a NEW version
 *   that becomes active; a save on an outdated base is refused (409, nothing overwritten).
 * - Labels: the caption of a carousel with a generated image starts with the AI label (added, never removed).
 * - Nothing here posts anything. Rendering/export: carouselRender.ts.
 */

const MAX_VERSIONS = 30;
const STALE = 'Inzwischen gibt es eine neuere Version dieses Karussells – bitte neu laden.';

export const CarouselSourceRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('concept'), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('script'), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('render'), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('note'), text: z.string().trim().min(10, 'Die Notiz ist zu kurz (mindestens 10 Zeichen).').max(4000) }).strict(),
]);
export const CreateCarouselRequest = z.object({
  source: CarouselSourceRequest,
  framework: FrameworkId.default('problem_weg_ergebnis'),
  slideCount: z.number().int().min(2).max(10).nullable().default(null),
  format: CarouselFormat.default('portrait'),
  templateId: TemplateId.default('klar'),
  estimate: z.boolean().default(false),
}).strict();

/** Her personal project (carousels are personal for now). */
function ownProject(db: Db, projectId: string) {
  const p = must(db.projects.find((x) => x.id === projectId), 'Projekt');
  if (p.kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Karussells gibt es zunächst nur für eigene Projekte – Kundenprojekte brauchen „Anzeige“ und die Freigabe der Kundin.');
  return p;
}

/** Library images she may place on a slide: PNG/JPEG/WebP with rights (own, licensed with source, generated = labelled). */
export const usableLibraryImages = (db: Db) => db.references.filter((r): r is Reference & { usage: NonNullable<Reference['usage']> } =>
  r.kind === 'image' && IMAGE_OVERLAY_MIMES.includes(r.mime) && !!r.usage && (r.usage.origin !== 'licensed' || r.usage.source.trim().length >= 3));
/** What the layout knows about every library image (rights from the store, never from the client). */
export const imageInfos = (db: Db): Map<string, CarouselImageInfo> =>
  new Map(db.references.map((r) => [r.id, { kind: r.kind, usage: r.usage ? { origin: r.usage.origin, source: r.usage.source } : null, mime: r.mime, name: r.name }]));

const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** The idea as the writer reads it (text of the source, its facts and flagged claims). */
async function resolveSource(projectId: string, src: z.infer<typeof CarouselSourceRequest>): Promise<CarouselSourceInput & { id: string | null }> {
  if (src.kind === 'note') {
    const first = src.text.split('\n')[0]!.trim();
    return { kind: 'note', id: null, label: `Notiz „${clip(first, 40)}“`, title: first.length <= 90 ? first : '', text: src.text, cta: '', facts: [], flagged: [] };
  }
  if (src.kind === 'concept') {
    return read((db) => {
      const c = must(db.concepts.find((x) => x.id === src.id && x.projectId === projectId), 'Konzept');
      const brief = db.briefs.find((b) => b.id === c.briefId);
      const flagged = [...new Set(db.scripts.filter((s) => s.conceptId === c.id).flatMap((s) => s.body.claimsToVerify))];
      const b = c.body;
      return {
        kind: 'concept' as const, id: c.id, label: `Konzept „${clip(b.title, 60)}“`, title: b.title,
        text: [b.hook, b.angle, b.rationale].filter(Boolean).join('\n'), cta: b.cta, facts: brief?.input.verifiedFacts ?? [], flagged,
      };
    });
  }
  if (src.kind === 'script') {
    return read((db) => {
      const s = must(db.scripts.find((x) => x.id === src.id && x.projectId === projectId), 'Skript');
      const l = scriptLineage(db, s.id);
      const text = s.body.scenes.flatMap((sc) => [sc.dialogue, sc.onScreenText]).filter(Boolean).join('\n');
      return { kind: 'script' as const, id: s.id, label: `Skript v${s.version} „${clip(s.body.selectedHook, 50)}“`, title: s.body.selectedHook, text, cta: s.body.cta, facts: l.brief.input.verifiedFacts, flagged: l.lineageFlagged };
    });
  }
  const { render, text } = await reelText(projectId, src.id);
  return { kind: 'render', id: render.id, label: `Reel vom ${render.createdAt.slice(0, 10)}`, title: '', text, cta: '', facts: [], flagged: [] };
}

/**
 * A finished reel of the project as text: what she says in it, in cut order (segments whose middle lies inside a clip).
 * 409 when the reel is not finished or has no transcript. Also the story source „Fertiges Reel“ (Etappe 19).
 */
export async function reelText(projectId: string, renderId: string) {
  const snap = await read((db) => {
    const r = must(db.renders.find((x) => x.id === renderId && x.projectId === projectId), 'Render');
    if (!r.storagePath || (r.status !== 'pending_review' && r.status !== 'approved')) throw new HttpError(409, 'Dieses Reel ist noch nicht fertig gerendert.');
    const plan = must(db.editPlans.find((p) => p.id === r.editPlanId), 'Schnittplan');
    return { render: r, clips: plan.body.clips.map((c) => ({ c, t: latestTranscript(db, c.assetId) })) };
  });
  const parts: string[] = [];
  for (const { c, t } of snap.clips) {
    if (!t) continue;
    const body: TranscriptBody | null = await readTranscriptBody(t).catch(() => null);
    for (const seg of body?.segments ?? []) {
      const mid = (seg.startSec + seg.endSec) / 2;
      if (mid >= c.inSec && mid <= c.outSec && seg.text.trim()) parts.push(seg.text.trim());
    }
  }
  const text = parts.join(' ').slice(0, 6000);
  if (!text) throw new HttpError(409, 'Zu diesem Reel gibt es kein Transkript – erst transkribieren (Video Studio) oder eine Notiz nutzen.');
  return { render: snap.render, text };
}

/** The agent task of a new carousel (no side effects): also the Model Lab input `carousel`. */
export async function prepareCarouselTask(projectId: string, raw: unknown) {
  const req = CreateCarouselRequest.parse(raw ?? {});
  await read((db) => ownProject(db, projectId));
  const source = await resolveSource(projectId, req.source);
  const snap = await read((db) => {
    const voice = currentVoice(db);
    const style = currentStyle(db);
    const blocks = personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'agent');
    const design = baseDesign(db).design;
    return { voice, style, blocks, design, images: usableLibraryImages(db) };
  });
  const state: Record<string, unknown> = {
    context: aiContextText(snap.blocks, 'agent') || null,
    voice: snap.voice ? { traits: snap.voice.rules.traits, avoid: snap.voice.rules.avoid, ownExamples: snap.voice.rules.ownExamples.slice(0, 3).map((x) => x.slice(0, 300)) } : null,
    brand: designGuidelineText(snap.design),
    format: `Instagram-Karussell ${req.format === 'square' ? '1:1' : '4:5'}`,
  };
  const input: CarouselWriterInput = {
    source, framework: req.framework, slideCount: req.slideCount, format: req.format, templateId: req.templateId,
    images: snap.images.map((r) => ({ id: r.id, name: r.name, origin: r.usage.origin })), state,
  };
  const inputChars = JSON.stringify(state).length + source.text.length + source.title.length + 400;
  const task: AgentTask<CarouselDraft> = {
    meta: {
      agent: 'carousel_writer', useCase: 'carousel_writing', projectId, clientData: false, inputChars,
      input: { projectId, source: { kind: source.kind, id: source.id, label: source.label }, framework: req.framework, slideCount: req.slideCount },
      styleVersionId: snap.style?.id ?? null, voiceVersionId: snap.voice?.id ?? null,
      strategyVersionId: snap.blocks.strategy?.versionId ?? null, profileVersionId: snap.blocks.profile?.versionId ?? null, aiContextHash: aiContextHash(snap.blocks, 'agent'),
    },
    run: (p) => runCarouselWriter(p, input),
  };
  return { req, source, snap, task };
}

/** What a run costs before she clicks (router choice, her pin or the fixed provider; mock = free). */
export async function carouselEstimate(inputChars?: number) {
  const env = providerFromEnv();
  const policy = ROUTING_POLICIES.carousel_writing;
  const size = inputChars ? { inputTokens: Math.ceil(inputChars / 3) } : undefined;
  return read((db) => {
    const pinned = db.routerPreferences.carousel_writing ?? null;
    if (env.config.active === 'mock') return { mode: 'mock' as const, label: 'MOCK · kein LLM', model: env.provider.model, estCostUsd: 0, worstCaseUsd: 0, pinned };
    if (env.config.active !== 'openrouter') {
      const b = env.provider.pricing ? costBounds(env.provider.pricing, policy, size) : null;
      return { mode: 'direct' as const, label: `${env.config.active} · ${env.config.model}`, model: env.config.model, estCostUsd: b?.est ?? null, worstCaseUsd: b?.worstCase ?? null, pinned };
    }
    const d = routeModel(routeRequestFor(db, env.config, 'carousel_writing', { confidential: false, size }));
    return { mode: 'routed' as const, label: d.chosen ? d.chosen.label : 'kein zulässiges Modell', model: d.chosen?.id ?? null, estCostUsd: d.chosen?.estCostUsd ?? null, worstCaseUsd: d.chosen?.worstCaseCostUsd ?? null, pinned };
  });
}

const activeOf = (db: Db, c: CarouselRecord) => must(db.carouselVersions.find((v) => v.id === c.activeVersionId), 'Karussell-Version');
const findCarousel = (db: Db, projectId: string, id: string) => must(db.carousels.find((c) => c.id === id && c.projectId === projectId), 'Karussell');

/** The rules a carousel is checked against: her source text and facts (figures there are hers), flagged claims. */
export function carouselRules(db: Db, c: { source: { kind: string; id: string | null; text: string } }): CarouselRules {
  let flagged: string[] = [];
  const sources = [c.source.text];
  if (c.source.kind === 'script' && c.source.id && db.scripts.some((s) => s.id === c.source.id)) {
    const l = scriptLineage(db, c.source.id);
    flagged = l.lineageFlagged;
    sources.push(...l.brief.input.verifiedFacts);
  }
  if (c.source.kind === 'concept' && c.source.id) {
    const concept = db.concepts.find((x) => x.id === c.source.id);
    const brief = concept ? db.briefs.find((b) => b.id === concept.briefId) : null;
    sources.push(...(brief?.input.verifiedFacts ?? []));
    flagged = [...new Set(db.scripts.filter((s) => s.conceptId === c.source.id).flatMap((s) => s.body.claimsToVerify))];
  }
  return { sources, flagged };
}

/** Look, image infos, rules and review of a body (one consistent snapshot). */
export function reviewOf(db: Db, c: CarouselRecord, body: CarouselBody) {
  const { look, warnings } = carouselLook(baseDesign(db).design, fontInfos(db));
  const images = imageInfos(db);
  return { look, lookWarnings: warnings, images, review: reviewCarousel(body, look, images, carouselRules(db, c)) };
}

/** A new active version (the previous one is archived); keeps the newest MAX_VERSIONS. */
function pushVersion(db: Db, c: CarouselRecord, v: Omit<CarouselVersion, 'id' | 'version' | 'status' | 'createdAt' | 'carouselId' | 'projectId'>): CarouselVersion {
  const versions = db.carouselVersions.filter((x) => x.carouselId === c.id);
  for (const x of versions) x.status = 'archived';
  const rec: CarouselVersion = { ...v, id: newId(), carouselId: c.id, projectId: c.projectId, version: Math.max(0, ...versions.map((x) => x.version)) + 1, status: 'active', createdAt: now() };
  db.carouselVersions.push(rec);
  c.activeVersionId = rec.id;
  c.updatedAt = rec.createdAt;
  const old = db.carouselVersions.filter((x) => x.carouselId === c.id).sort((a, b) => b.version - a.version).slice(MAX_VERSIONS).map((x) => x.id);
  if (old.length) db.carouselVersions = db.carouselVersions.filter((x) => !old.includes(x.id));
  return rec;
}

/** The caption with its labels (a generated image on a slide → AI label first). */
function labelled(db: Db, c: CarouselRecord, body: CarouselBody): CarouselBody {
  const { review } = reviewOf(db, c, body);
  return review.requiredLabels.length ? { ...body, caption: ensureCaptionLabels(body.caption, review.requiredLabels) } : body;
}

/** `POST …/carousels { estimate: true }`: what the run would cost – nothing runs. */
export async function estimateCarousel(projectId: string, raw: unknown) {
  const { task, source } = await prepareCarouselTask(projectId, raw);
  return { estimate: await carouselEstimate(task.meta.inputChars), source: { kind: source.kind, label: source.label } };
}

/** `POST …/carousels`: one Carousel Writer run → a new carousel with version 1. */
export async function createCarousel(projectId: string, raw: unknown) {
  const { source, task, snap } = await prepareCarouselTask(projectId, raw);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  const id = await write((db) => {
    ownProject(db, projectId);
    const at = now();
    const c: CarouselRecord = {
      id: newId(), projectId, title: result.output.title.slice(0, 120) || source.label, activeVersionId: '',
      source: { kind: source.kind, id: source.id, label: source.label, text: source.text.slice(0, 8000) }, createdAt: at, updatedAt: at,
    };
    db.carousels.push(c);
    pushVersion(db, c, {
      parentId: null, origin: 'agent', body: labelled(db, c, result.output.body), agentRunId: run.id, promptVersion: result.promptVersion, mock,
      provider: run.provider, model: run.model, costUsd: run.costEstimateUsd, costSource: run.costSource ?? null,
      warnings: [...result.output.warnings, ...(result.output.notes ? [result.output.notes] : [])].slice(0, 40),
      styleBibleVersionId: snap.style?.id ?? null, voiceGuideVersionId: snap.voice?.id ?? null,
      strategyVersionId: snap.blocks.strategy?.versionId ?? null, profileVersionId: snap.blocks.profile?.versionId ?? null, render: null,
    });
    return c.id;
  });
  return getCarousel(projectId, id);
}

const summary = (db: Db, c: CarouselRecord) => {
  const v = activeOf(db, c);
  return { id: c.id, title: c.title, source: { kind: c.source.kind, id: c.source.id, label: c.source.label }, version: v.version, slides: v.body.slides.length, templateId: v.body.templateId, mock: v.mock, updatedAt: c.updatedAt, createdAt: c.createdAt };
};

/** `GET /api/projects/[id]/carousels`: her carousels of the project, the sources she can pick, images, the cost estimate. */
export async function listCarousels(projectId: string) {
  const base = await read((db) => {
    const p = must(db.projects.find((x) => x.id === projectId), 'Projekt');
    const available = p.kind === 'PERSONAL_CONTENT';
    return {
      available, reason: available ? null : 'Karussells gibt es zunächst nur für eigene Projekte.',
      carousels: db.carousels.filter((c) => c.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => summary(db, c)),
      sources: {
        concepts: db.concepts.filter((c) => c.projectId === projectId && c.status !== 'rejected').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((c) => ({ id: c.id, label: c.body.title, mock: c.mock })),
        scripts: db.scripts.filter((s) => s.projectId === projectId && s.status !== 'rejected').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((s) => ({ id: s.id, label: `v${s.version} · ${clip(s.body.selectedHook, 60)}` })),
        renders: db.renders.filter((r) => r.projectId === projectId && r.storagePath && (r.status === 'pending_review' || r.status === 'approved')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20).map((r) => ({ id: r.id, label: `Reel vom ${r.createdAt.slice(0, 16).replace('T', ' ')}` })),
      },
      sourceLabels: CAROUSEL_SOURCE_LABEL,
    };
  });
  return { ...base, estimate: await carouselEstimate() };
}

/** `GET …/carousels/[cid]`: record, active version (body), versions, review, look and library images for the preview. */
export const getCarousel = (projectId: string, id: string) => read((db) => {
  const c = findCarousel(db, projectId, id);
  const v = activeOf(db, c);
  const { look, lookWarnings, review } = reviewOf(db, c, v.body);
  return {
    carousel: c, version: v,
    versions: db.carouselVersions.filter((x) => x.carouselId === c.id).sort((a, b) => b.version - a.version).map((x) => ({ id: x.id, version: x.version, origin: x.origin, status: x.status, mock: x.mock, createdAt: x.createdAt, templateId: x.body.templateId })),
    look, lookWarnings, review,
    images: db.references.filter((r) => r.kind === 'image').map((r) => ({ id: r.id, name: r.name, mime: r.mime, usage: r.usage ? { origin: r.usage.origin, source: r.usage.source } : null, usable: usableLibraryImages(db).some((u) => u.id === r.id) })),
    rules: carouselRules(db, c),
  };
});

export const SaveCarouselRequest = z.object({ baseVersionId: z.string().min(1).max(100), body: CarouselBody, title: z.string().trim().min(1).max(120).optional() }).strict();

/** `PUT …/carousels/[cid]`: her edit → a new active version (409 when another version became active meanwhile). */
export async function saveCarousel(projectId: string, id: string, raw: unknown, origin: CarouselVersion['origin'] = 'user_edit') {
  const req = SaveCarouselRequest.parse(raw);
  await write((db) => {
    ownProject(db, projectId);
    const c = findCarousel(db, projectId, id);
    const cur = activeOf(db, c);
    if (cur.id !== req.baseVersionId) throw new HttpError(409, STALE, 'stale_version');
    if (req.title) c.title = req.title;
    pushVersion(db, c, {
      parentId: cur.id, origin, body: labelled(db, c, req.body), agentRunId: null, promptVersion: null, mock: cur.mock, provider: null, model: null, costUsd: null, costSource: null, warnings: [],
      styleBibleVersionId: cur.styleBibleVersionId, voiceGuideVersionId: cur.voiceGuideVersionId, strategyVersionId: cur.strategyVersionId, profileVersionId: cur.profileVersionId, render: null,
    });
  });
  return getCarousel(projectId, id);
}

export const VariantRequest = z.object({ baseVersionId: z.string().min(1).max(100), templateId: TemplateId, format: CarouselFormat.optional() }).strict();
/** `POST …/carousels/[cid]/variant`: the same texts in another layout/look (and format) → a new active version. */
export async function chooseVariant(projectId: string, id: string, raw: unknown) {
  const req = VariantRequest.parse(raw);
  const body = await read((db) => activeOf(db, findCarousel(db, projectId, id)).body);
  return saveCarousel(projectId, id, { baseVersionId: req.baseVersionId, body: { ...body, templateId: req.templateId, ...(req.format ? { format: req.format } : {}) } }, 'variant');
}

/** Chat (Etappe 15): a carousel patch applied as a new version, inside the caller's write. */
export function applyChatVersion(db: Db, carouselId: string, baseVersionId: string, body: CarouselBody): CarouselVersion {
  const c = must(db.carousels.find((x) => x.id === carouselId), 'Karussell');
  const cur = activeOf(db, c);
  if (cur.id !== baseVersionId) throw new HttpError(409, STALE, 'stale_base');
  return pushVersion(db, c, {
    parentId: cur.id, origin: 'chat', body: labelled(db, c, body), agentRunId: null, promptVersion: null, mock: cur.mock, provider: null, model: null, costUsd: null, costSource: null, warnings: [],
    styleBibleVersionId: cur.styleBibleVersionId, voiceGuideVersionId: cur.voiceGuideVersionId, strategyVersionId: cur.strategyVersionId, profileVersionId: cur.profileVersionId, render: null,
  });
}

/** `DELETE …/carousels/[cid]`: the carousel, its versions, its chat history; the PNG folder goes too (carouselRender). */
export async function deleteCarouselRecord(projectId: string, id: string) {
  return write((db) => {
    findCarousel(db, projectId, id);
    db.carousels = db.carousels.filter((c) => c.id !== id);
    db.carouselVersions = db.carouselVersions.filter((v) => v.carouselId !== id);
    // Etappe 20: a board entry keeps its title but loses the link
    for (const b of db.boardItems) if (b.ref?.kind === 'carousel' && b.ref.id === id) Object.assign(b, { ref: null, updatedAt: now() });
    const threads = new Set(db.chatThreads.filter((t) => t.scope === `carousel:${id}`).map((t) => t.id));
    db.chatMessages = db.chatMessages.filter((m) => !threads.has(m.threadId));
    db.chatThreads = db.chatThreads.filter((t) => !threads.has(t.id));
    return { deleted: id };
  });
}

/** Model Lab input `carousel`: the source and settings of her latest written carousel (nothing is stored or changed). */
export async function prepareCarouselEvalTask() {
  const pick = await read((db) => {
    const personal = new Set(db.projects.filter((p) => p.kind === 'PERSONAL_CONTENT').map((p) => p.id));
    const v = [...db.carouselVersions].filter((x) => x.origin === 'agent' && personal.has(x.projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const c = v ? db.carousels.find((x) => x.id === v.carouselId) : null;
    return v && c ? { v, c } : null;
  });
  if (!pick) throw new HttpError(400, 'Noch kein Karussell – erstelle zuerst eins unter „Karussells“.');
  const { c, v } = pick;
  const source = c.source.kind === 'note' ? { kind: 'note' as const, text: c.source.text.slice(0, 4000) } : { kind: c.source.kind, id: c.source.id ?? '' };
  const { task } = await prepareCarouselTask(c.projectId, { source, framework: v.body.framework, slideCount: v.body.slides.length, format: v.body.format, templateId: v.body.templateId });
  return { task, label: `Letztes Karussell („${c.title.slice(0, 50)}“)`, projectIds: [c.projectId] };
}
