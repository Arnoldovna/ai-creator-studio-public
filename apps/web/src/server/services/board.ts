import 'server-only';
import {
  BOARD_KIND_LABEL, BoardKind, BoardRefKind, BoardStatus, costBounds, dayItems, IsoDate, MAX_ITEMS_PER_DAY, moveBoardItem, Permalink, REF_KIND_OF, ROUTING_POLICIES, routeModel,
  runWeekPlanner, slotOfKind, weekDays, weekdayOf, WEEKDAY_LABEL, weekIcs, weekKey, weekLabel, weekPillarMix, weekStartOf, weekText,
  type BoardSlot, type WeekMaterial, type WeekPlannerInput, type WeekPlannerOutput,
} from '@studio/core';
import { z } from 'zod';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type BoardItem, type Db } from '../store';
import { activePillars, aiContextHash, currentApproved, personalBlocks } from './aiContext';
import { routeRequestFor, runAgent, type AgentTask } from './agentRuns';
import { addSnapshot, createPublication } from './analytics';
import { currentStyle, currentVoice } from './style';

/**
 * Wochenboard (Etappe 20): one week at a glance, in her rhythm, without pressure.
 *
 * - Items are planned posts (reel, carousel, idea, story) on a day or „ohne Tag“, linked to their material when they come
 *   from it. Status idea → in progress → ready → posted is hers; „posted“ (optional link/date) is only set by her click.
 *   There is NO endpoint that posts, schedules or reminds; empty days carry no warning, nothing is ever „missed“.
 * - „Woche füllen“ runs the Week Planner once (budget, routing, log) and stores suggestions; each becomes an item only
 *   through „Übernehmen“.
 * - Only her own projects: material of client projects never appears on the board.
 * - Rückblick: a posted item can become a publication with manually entered figures (the existing analytics records).
 */

const MAX_ITEMS = 2000;
const STALE = 'Der Eintrag wurde inzwischen geändert – bitte neu laden.';

/** Today in her calendar (the server's local date; the board is a single-user, local app). */
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const parseWeek = (raw: unknown) => weekStartOf(IsoDate.parse(typeof raw === 'string' && raw ? raw : today()));

const personalIds = (db: Db) => new Set(db.projects.filter((p) => p.kind === 'PERSONAL_CONTENT').map((p) => p.id));

/** What a ref points at (project, title, editor link, a hint on its state) – null when it no longer exists. */
function resolveRef(db: Db, ref: { kind: BoardRefKind; id: string }): { projectId: string; title: string; href: string; state: string; pillarId: string | null } | null {
  const enc = encodeURIComponent;
  switch (ref.kind) {
    case 'render': {
      const r = db.renders.find((x) => x.id === ref.id);
      if (!r) return null;
      const plan = db.editPlans.find((p) => p.id === r.editPlanId);
      return { projectId: r.projectId, title: `Reel vom ${r.createdAt.slice(0, 10)}`, href: `/video-studio?project=${enc(r.projectId)}`, state: r.status === 'approved' ? 'gerendert, freigegeben' : r.status === 'pending_review' ? 'gerendert' : r.status, pillarId: plan?.pillarId ?? null };
    }
    case 'edit_draft': {
      const d = db.editDrafts.find((x) => x.id === ref.id);
      if (!d) return null;
      const name = db.mediaAssets.find((a) => a.id === d.body.clips[0]?.assetId)?.name;
      return { projectId: d.projectId, title: `Schnitt-Entwurf${name ? ` (${name})` : ''}`, href: `/video-studio?project=${enc(d.projectId)}`, state: `${d.body.clips.length} Clip(s)`, pillarId: null };
    }
    case 'carousel': {
      const c = db.carousels.find((x) => x.id === ref.id);
      if (!c) return null;
      const v = db.carouselVersions.find((x) => x.id === c.activeVersionId);
      return { projectId: c.projectId, title: c.title, href: `/karussells?project=${enc(c.projectId)}&carousel=${enc(c.id)}`, state: `v${v?.version ?? 1}${v?.render ? ', PNGs gerendert' : ''}`, pillarId: null };
    }
    case 'story': {
      const s = db.stories.find((x) => x.id === ref.id);
      if (!s) return null;
      return { projectId: s.projectId, title: s.title, href: `/stories?project=${enc(s.projectId)}&story=${enc(s.id)}`, state: s.render ? 'gerendert' : 'Entwurf', pillarId: null };
    }
    case 'concept': {
      const c = db.concepts.find((x) => x.id === ref.id);
      if (!c) return null;
      return { projectId: c.projectId, title: c.body.title, href: `/content-lab?project=${enc(c.projectId)}`, state: c.status === 'approved' ? 'Konzept gewählt' : 'Konzept', pillarId: c.pillarId ?? null };
    }
  }
}
const initialStatus = (kind: BoardRefKind | null, db: Db, id: string | null): BoardItem['status'] => {
  if (kind === 'render') return 'ready';
  if (kind === 'carousel' || kind === 'story' || kind === 'edit_draft') return 'in_progress';
  void db; void id;
  return 'idea';
};

/** Her material that can go on the board (own projects only; what is already on the board is marked). */
function material(db: Db): (WeekMaterial & { projectId: string; onBoard: boolean; href: string })[] {
  const own = personalIds(db);
  const onBoard = new Set(db.boardItems.filter((b) => b.ref).map((b) => `${b.ref!.kind}:${b.ref!.id}`));
  const out: (WeekMaterial & { projectId: string; onBoard: boolean; href: string })[] = [];
  const push = (kind: BoardRefKind, id: string) => {
    const r = resolveRef(db, { kind, id });
    if (!r || !own.has(r.projectId)) return;
    const ref = `${kind}:${id}`;
    out.push({ ref, kind: REF_KIND_OF[kind], title: r.title, pillarId: r.pillarId, state: r.state, projectId: r.projectId, onBoard: onBoard.has(ref), href: r.href });
  };
  for (const r of [...db.renders].filter((x) => x.storagePath && (x.status === 'pending_review' || x.status === 'approved')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)) push('render', r.id);
  for (const c of [...db.carousels].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)) push('carousel', c.id);
  for (const s of [...db.stories].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)) push('story', s.id);
  for (const d of db.editDrafts.filter((x) => x.body.clips.length).slice(0, 20)) push('edit_draft', d.id);
  for (const c of [...db.concepts].filter((x) => x.status !== 'rejected').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)) push('concept', c.id);
  return out;
}

function itemView(db: Db, i: BoardItem) {
  const r = i.ref ? resolveRef(db, i.ref) : null;
  const pillars = activePillars(db);
  return {
    ...i, weekday: i.date ? WEEKDAY_LABEL[weekdayOf(i.date)] : null, href: r?.href ?? null, refState: r?.state ?? (i.ref ? 'nicht mehr vorhanden' : null),
    pillarName: i.pillarId ? pillars.find((p) => p.id === i.pillarId)?.name ?? null : null,
    publication: i.posted?.publicationId ? (() => {
      const p = db.publications.find((x) => x.id === i.posted!.publicationId);
      if (!p) return null;
      const snaps = db.metricSnapshots.filter((s) => s.publicationId === p.id).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
      return { id: p.id, snapshots: snaps.length, latest: snaps[0] ? { window: snaps[0].window, metrics: snaps[0].metrics } : null };
    })() : null,
  };
}
export type BoardItemView = ReturnType<typeof itemView>;

/** `GET /api/board?week=`: the week (Mo–So) with its items, „ohne Tag“, her rhythm, the pillar mix (info), material, open suggestions. */
export async function getBoard(rawWeek: unknown) {
  const start = parseWeek(rawWeek);
  const base = await read((db) => {
    const days = weekDays(start);
    const inWeek = db.boardItems.filter((i) => i.date && days.includes(i.date));
    const strategy = currentApproved(db, 'strategy')?.document ?? null;
    const plan = [...db.weekPlans].filter((p) => p.weekStart === start).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    return {
      weekStart: start, label: weekLabel(start), today: today(), prev: days[0] ? weekStartOf(new Date(Date.parse(`${start}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10)) : start,
      next: weekStartOf(new Date(Date.parse(`${start}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10)),
      days: days.map((date) => ({ date, weekday: WEEKDAY_LABEL[weekdayOf(date)], items: dayItems(db.boardItems, date).map((i) => itemView(db, i)) })),
      unscheduled: dayItems(db.boardItems, null).map((i) => itemView(db, i)),
      rhythm: { postsPerWeek: strategy?.cadence.postsPerWeek ?? null, notes: strategy?.cadence.notes ?? '', planned: inWeek.filter((i) => i.slot === 'main').length },
      mix: weekPillarMix(inWeek, activePillars(db)),
      material: material(db),
      plan: plan ? { ...plan, suggestions: plan.suggestions.filter((s) => s.status === 'open') } : null,
      key: weekKey(inWeek),
      projects: db.projects.filter((p) => p.kind === 'PERSONAL_CONTENT').map((p) => ({ id: p.id, title: p.title })),
    };
  });
  return { ...base, estimate: await plannerEstimate() };
}

// ---------- Items ----------

const RefInput = z.object({ kind: BoardRefKind, id: z.string().min(1).max(100) }).strict();
export const CreateItemRequest = z.object({
  date: IsoDate.nullable().default(null),
  ref: RefInput.nullable().default(null),
  kind: BoardKind.optional(),
  title: z.string().trim().max(140).default(''),
  note: z.string().trim().max(1000).default(''),
  pillarId: z.string().max(40).nullable().default(null),
  projectId: z.string().max(100).nullable().default(null),
}).strict();

function checkPillar(db: Db, pillarId: string | null) {
  if (pillarId && !activePillars(db).some((p) => p.id === pillarId)) throw new HttpError(400, `Die Säule „${pillarId}“ gibt es in deiner Strategie nicht.`);
}
function checkRoom(db: Db, date: string | null, slot: BoardSlot, ignore?: string) {
  if (db.boardItems.length >= MAX_ITEMS && !ignore) throw new HttpError(409, `Höchstens ${MAX_ITEMS} Einträge auf dem Board.`);
  if (date && db.boardItems.filter((i) => i.date === date && i.slot === slot && i.id !== ignore).length >= MAX_ITEMS_PER_DAY[slot])
    throw new HttpError(409, `Höchstens ${MAX_ITEMS_PER_DAY[slot]} ${slot === 'main' ? 'Hauptposts' : 'Stories'} pro Tag.`);
}

/** Inside a write: a new item (from material, a suggestion or her own idea). */
function addItem(db: Db, req: z.infer<typeof CreateItemRequest>, origin: BoardItem['origin'], planId: string | null): BoardItem {
  let projectId = req.projectId;
  let title = req.title;
  let kind: BoardKind = req.kind ?? 'idea';
  let pillarId = req.pillarId;
  if (req.ref) {
    const r = resolveRef(db, req.ref);
    if (!r) throw new HttpError(404, 'Das Material gibt es nicht (mehr).');
    if (!personalIds(db).has(r.projectId)) throw new HttpError(409, 'Auf das Board kommen nur eigene Projekte.');
    projectId = r.projectId;
    title = title || r.title;
    kind = REF_KIND_OF[req.ref.kind];
    pillarId = pillarId ?? r.pillarId;
  } else if (projectId) {
    const p = must(db.projects.find((x) => x.id === projectId), 'Projekt');
    if (p.kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Auf das Board kommen nur eigene Projekte.');
  }
  if (!title) throw new HttpError(400, 'Titel fehlt.');
  checkPillar(db, pillarId);
  const slot = slotOfKind(kind);
  checkRoom(db, req.date, slot);
  const at = now();
  const item: BoardItem = {
    id: newId(), projectId, date: req.date, slot, kind, order: db.boardItems.filter((i) => i.date === req.date && i.slot === slot).length,
    title: title.slice(0, 140), note: req.note, pillarId, status: initialStatus(req.ref?.kind ?? null, db, req.ref?.id ?? null), ref: req.ref,
    posted: null, origin, planId, createdAt: at, updatedAt: at,
  };
  db.boardItems.push(item);
  return item;
}

export async function createItem(raw: unknown) {
  const req = CreateItemRequest.parse(raw ?? {});
  return write((db) => itemView(db, addItem(db, req, 'manual', null)));
}

export const UpdateItemRequest = z.object({
  /** The item's `updatedAt` she edited (409 when someone else – the chat, another tab – changed it meanwhile). */
  baseUpdatedAt: z.string().max(40).optional(),
  date: IsoDate.nullable().optional(),
  /** Position within the day's slot (0 = first). */
  index: z.number().int().min(0).max(50).optional(),
  status: BoardStatus.optional(),
  title: z.string().trim().min(1).max(140).optional(),
  note: z.string().trim().max(1000).optional(),
  pillarId: z.string().max(40).nullable().optional(),
  /** „gepostet“: optional date and link; only her click sets it. */
  posted: z.object({ at: IsoDate.optional(), permalink: Permalink.default('') }).strict().optional(),
}).strict();

/** `PATCH /api/board/items/[id]`: move (drag & drop, keyboard, menu), status, texts, pillar, „gepostet“ with link/date. */
export async function updateItem(id: string, raw: unknown) {
  const req = UpdateItemRequest.parse(raw ?? {});
  return write((db) => {
    const it = must(db.boardItems.find((x) => x.id === id), 'Eintrag');
    if (req.baseUpdatedAt && req.baseUpdatedAt !== it.updatedAt) throw new HttpError(409, STALE, 'stale_item');
    if (req.date !== undefined || req.index !== undefined) {
      const date = req.date === undefined ? it.date : req.date;
      if (date !== it.date) checkRoom(db, date, it.slot, it.id);
      const moved = moveBoardItem(db.boardItems, id, date, req.index);
      db.boardItems = moved;
    }
    const cur = db.boardItems.find((x) => x.id === id)!;
    if (req.title) cur.title = req.title;
    if (req.note !== undefined) cur.note = req.note;
    if (req.pillarId !== undefined) { checkPillar(db, req.pillarId); cur.pillarId = req.pillarId; }
    if (req.posted) {
      cur.status = 'posted';
      cur.posted = { at: req.posted.at ?? cur.date ?? today(), permalink: req.posted.permalink, publicationId: cur.posted?.publicationId ?? null };
    } else if (req.status) {
      cur.status = req.status;
      if (req.status === 'posted' && !cur.posted) cur.posted = { at: cur.date ?? today(), permalink: '', publicationId: null };
      // back from „posted“: the link/date go, a Rückblick record she made stays in the Rückblick
      if (req.status !== 'posted') cur.posted = null;
    }
    cur.updatedAt = now();
    return itemView(db, cur);
  });
}

/** `DELETE /api/board/items/[id]`: off the board (the material itself stays). */
export async function deleteItem(id: string) {
  return write((db) => {
    must(db.boardItems.find((x) => x.id === id), 'Eintrag');
    db.boardItems = db.boardItems.filter((x) => x.id !== id);
    for (const p of db.weekPlans) for (const s of p.suggestions) if (s.itemId === id) Object.assign(s, { itemId: null });
    return { deleted: id };
  });
}

export const MetricsRequest = z.object({
  window: z.enum(['24h', '7d', '30d']),
  reach: z.number().int().min(0).max(1e9), views: z.number().int().min(0).max(1e9), saves: z.number().int().min(0).max(1e9), shares: z.number().int().min(0).max(1e9),
  likes: z.number().int().min(0).max(1e9).nullable().default(null), comments: z.number().int().min(0).max(1e9).nullable().default(null),
  follows: z.number().int().min(0).max(1e9).nullable().default(null),
  projectId: z.string().max(100).nullable().default(null),
}).strict();

/**
 * `POST /api/board/items/[id]/metrics`: her figures of a posted item, typed in by hand (no Instagram API). The first time a
 * publication (Rückblick) is created from the item; every call adds a snapshot there.
 */
export async function addItemMetrics(id: string, raw: unknown) {
  const req = MetricsRequest.parse(raw ?? {});
  const it = await read((db) => must(db.boardItems.find((x) => x.id === id), 'Eintrag'));
  if (it.status !== 'posted' || !it.posted) throw new HttpError(409, 'Kennzahlen gibt es erst, wenn der Eintrag als gepostet markiert ist.');
  let publicationId = it.posted.publicationId;
  if (!publicationId || !(await read((db) => db.publications.some((p) => p.id === publicationId)))) {
    const projectId = it.projectId ?? req.projectId;
    if (!projectId) throw new HttpError(400, 'Für den Rückblick bitte ein Projekt wählen.');
    // review fix: the board's Rückblick records belong to her own projects only
    const kind = await read((db) => must(db.projects.find((p) => p.id === projectId), 'Projekt').kind);
    if (kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Der Rückblick vom Board geht nur in eigene Projekte.');
    // review fix: posted again after „zurück“ – the same post keeps its Rückblick record (no second publication)
    const existing = await read((db) => db.publications.find((p) => p.projectId === projectId && p.title === it.title && p.publishedAt.slice(0, 10) === it.posted!.at)?.id ?? null);
    publicationId = existing;
    if (existing) {
      await write((db) => { const cur = db.boardItems.find((x) => x.id === id); if (cur?.posted) { cur.posted.publicationId = existing; cur.projectId = cur.projectId ?? projectId; cur.updatedAt = now(); } });
    }
  }
  if (!publicationId) {
    const projectId = (it.projectId ?? req.projectId)!;
    const format = it.kind === 'idea' ? 'photo' : it.kind;
    // a finished reel carries its cut as lineage (style/voice/strategy pins come from it)
    const editPlanId = it.ref?.kind === 'render' ? await read((db) => db.renders.find((r) => r.id === it.ref!.id && r.projectId === projectId)?.editPlanId ?? null) : null;
    const pub = await createPublication({ projectId, title: it.title, format, publishedAt: it.posted.at, permalink: it.posted.permalink, pillarId: it.pillarId, editPlanId });
    publicationId = pub.id;
    await write((db) => {
      const cur = db.boardItems.find((x) => x.id === id);
      if (cur?.posted) { cur.posted.publicationId = pub.id; cur.projectId = cur.projectId ?? projectId; cur.updatedAt = now(); }
    });
  }
  const metrics: Record<string, number | null> = { reach: req.reach, views: req.views, saves: req.saves, shares: req.shares, likes: req.likes, comments: req.comments };
  if (req.follows != null) metrics.follows = req.follows;
  const snapshot = await addSnapshot({ publicationId, window: req.window, metrics });
  return { publicationId, snapshot, item: await read((db) => itemView(db, must(db.boardItems.find((x) => x.id === id), 'Eintrag'))) };
}

// ---------- „Woche füllen“ ----------

export const PlanRequest = z.object({ week: IsoDate, estimate: z.boolean().default(false) }).strict();

/** The planner task of a week (no side effects): also the Model Lab input `week`. */
export async function preparePlanTask(rawWeek: string) {
  const start = parseWeek(rawWeek);
  const snap = await read((db) => {
    const days = weekDays(start);
    const strategy = currentApproved(db, 'strategy')?.document ?? null;
    const pillarsDoc = strategy?.pillars ?? [];
    const onBoard = material(db).filter((m) => !m.onBoard);
    return {
      days: days.map((date) => {
        const list = dayItems(db.boardItems, date);
        return { date, main: list.filter((i) => i.slot === 'main').map((i) => ({ kind: i.kind, title: i.title })), stories: list.filter((i) => i.slot === 'story').length };
      }),
      postsPerWeek: strategy?.cadence.postsPerWeek ?? null,
      pillars: pillarsDoc.map((p) => ({ id: p.id, name: p.name, targetShare: p.share, topics: p.exampleTopics.slice(0, 12) })),
      material: onBoard.map(({ ref, kind, title, pillarId, state }) => ({ ref, kind, title, pillarId, state })),
      goals: strategy ? { phase: strategy.phase, longTermGoal: strategy.longTermGoal, goal: strategy.goal.primary, cadenceNotes: strategy.cadence.notes } : null,
      voice: currentVoice(db), style: currentStyle(db), blocks: personalBlocks(db, PERSONAL_PROFILE_ID, {}, 'agent'),
    };
  });
  const input: WeekPlannerInput = { weekStart: start, days: snap.days, postsPerWeek: snap.postsPerWeek, pillars: snap.pillars, material: snap.material, state: { goals: snap.goals } };
  const inputChars = JSON.stringify(input).length + 300;
  const task: AgentTask<WeekPlannerOutput> = {
    meta: {
      agent: 'week_planner', useCase: 'week_planning', projectId: null, clientData: false, inputChars,
      input: { weekStart: start, empty: snap.days.filter((d) => !d.main.length).length, material: snap.material.length },
      styleVersionId: snap.style?.id ?? null, voiceVersionId: snap.voice?.id ?? null,
      strategyVersionId: snap.blocks.strategy?.versionId ?? null, profileVersionId: snap.blocks.profile?.versionId ?? null, aiContextHash: aiContextHash(snap.blocks, 'agent'),
    },
    run: (p) => runWeekPlanner(p, input),
  };
  return { start, input, task };
}

export async function plannerEstimate(inputChars?: number) {
  const env = providerFromEnv();
  const policy = ROUTING_POLICIES.week_planning;
  const size = inputChars ? { inputTokens: Math.ceil(inputChars / 3) } : undefined;
  return read((db) => {
    const pinned = db.routerPreferences.week_planning ?? null;
    if (env.config.active === 'mock') return { mode: 'mock' as const, label: 'MOCK · kein LLM', model: env.provider.model, estCostUsd: 0, worstCaseUsd: 0, pinned };
    if (env.config.active !== 'openrouter') {
      const b = env.provider.pricing ? costBounds(env.provider.pricing, policy, size) : null;
      return { mode: 'direct' as const, label: `${env.config.active} · ${env.config.model}`, model: env.config.model, estCostUsd: b?.est ?? null, worstCaseUsd: b?.worstCase ?? null, pinned };
    }
    const d = routeModel(routeRequestFor(db, env.config, 'week_planning', { confidential: false, size }));
    return { mode: 'routed' as const, label: d.chosen ? d.chosen.label : 'kein zulässiges Modell', model: d.chosen?.id ?? null, estCostUsd: d.chosen?.estCostUsd ?? null, worstCaseUsd: d.chosen?.worstCaseCostUsd ?? null, pinned };
  });
}

/** `POST /api/board/plan { week, estimate: true }`: what „Woche füllen“ would cost – nothing runs. */
export async function estimatePlan(raw: unknown) {
  const req = PlanRequest.parse(raw ?? {});
  const { task } = await preparePlanTask(req.week);
  return { estimate: await plannerEstimate(task.meta.inputChars) };
}

/** `POST /api/board/plan { week }`: one Week Planner run → stored suggestions (nothing lands on the board yet). */
export async function planWeek(raw: unknown) {
  const req = PlanRequest.parse(raw ?? {});
  const { start, task } = await preparePlanTask(req.week);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  return write((db) => {
    const rec = {
      id: newId(), weekStart: start,
      suggestions: result.output.suggestions.map((s) => ({ ...s, id: newId(), status: 'open' as const, itemId: null })),
      agentRunId: run.id, promptVersion: result.promptVersion, mock, provider: run.provider, model: run.model, costUsd: run.costEstimateUsd, costSource: run.costSource ?? null,
      warnings: result.output.warnings.slice(0, 40), notes: result.output.notes, createdAt: now(),
    };
    // older runs of the same week: their open suggestions are replaced by the new run
    for (const p of db.weekPlans) if (p.weekStart === start) for (const s of p.suggestions) if (s.status === 'open') s.status = 'dismissed';
    db.weekPlans.push(rec);
    db.weekPlans = db.weekPlans.slice(-100);
    return rec;
  });
}

function findSuggestion(db: Db, id: string) {
  for (const plan of db.weekPlans) {
    const s = plan.suggestions.find((x) => x.id === id);
    if (s) return { plan, s };
  }
  throw new HttpError(404, 'Vorschlag nicht gefunden');
}

/** `POST /api/board/suggestions/[id]/accept`: the suggestion becomes a board item (its day must still be free for a main post). */
export async function acceptSuggestion(id: string) {
  return write((db) => {
    const { plan, s } = findSuggestion(db, id);
    if (s.status !== 'open') throw new HttpError(409, s.status === 'accepted' ? 'Schon übernommen.' : 'Dieser Vorschlag wurde verworfen.');
    if (s.slot === 'main' && db.boardItems.some((i) => i.date === s.date && i.slot === 'main'))
      throw new HttpError(409, `Der ${WEEKDAY_LABEL[weekdayOf(s.date)]} ist inzwischen belegt – Vorschlag passt nicht mehr.`, 'stale_suggestion');
    const [refKind, refId] = s.ref ? [s.ref.slice(0, s.ref.indexOf(':')), s.ref.slice(s.ref.indexOf(':') + 1)] : [null, null];
    const ref = refKind && BoardRefKind.safeParse(refKind).success && refId ? { kind: refKind as BoardRefKind, id: refId } : null;
    if (ref && db.boardItems.some((i) => i.ref?.kind === ref.kind && i.ref.id === ref.id)) throw new HttpError(409, 'Dieses Material ist inzwischen schon auf dem Board.', 'stale_suggestion');
    const pillar = s.pillarId && activePillars(db).some((p) => p.id === s.pillarId) ? s.pillarId : null;
    const item = addItem(db, { date: s.date, ref, kind: s.kind, title: s.title, note: s.reason, pillarId: pillar, projectId: null }, 'planner', plan.id);
    Object.assign(s, { status: 'accepted', itemId: item.id });
    return itemView(db, item);
  });
}

export async function dismissSuggestion(id: string) {
  return write((db) => {
    const { s } = findSuggestion(db, id);
    if (s.status === 'accepted') throw new HttpError(409, 'Ein übernommener Vorschlag lässt sich nicht verwerfen – den Eintrag kannst du vom Board nehmen.');
    s.status = 'dismissed';
    return { dismissed: id };
  });
}

// ---------- Chat (Etappe 15 patch `week`) ----------

/** The week as the chat sees and changes it (items of that week; ids short for the model). */
export function weekTarget(db: Db, start: string) {
  const days = weekDays(start);
  const items = db.boardItems.filter((i) => i.date && days.includes(i.date));
  return {
    start, items, key: weekKey(items),
    state: {
      label: weekLabel(start), postsPerWeek: currentApproved(db, 'strategy')?.document.cadence.postsPerWeek ?? null,
      days: days.map((d) => ({ day: weekdayOf(d), date: d, items: dayItems(items, d).map((i) => ({ itemId: i.id, kind: i.kind, title: i.title.slice(0, 80), status: i.status })) })),
    },
  };
}

/** Inside the chat's write: the moves of an applied week patch (base checked by the caller). */
export function applyWeekMoves(db: Db, moves: readonly { id: string; date: string | null; order: number }[]) {
  const at = now();
  for (const m of moves) {
    const it = db.boardItems.find((x) => x.id === m.id);
    if (it) Object.assign(it, { date: m.date, order: m.order, updatedAt: at });
  }
}

// ---------- Export ----------

/** `GET /api/board/export?week=&format=txt|ics`: the week as a list or as calendar entries WITHOUT alarms. */
export async function exportWeek(rawWeek: unknown, format: 'txt' | 'ics') {
  const start = parseWeek(rawWeek);
  return read((db) => {
    const days = weekDays(start);
    const pillars = activePillars(db);
    const items = db.boardItems.filter((i) => i.date && days.includes(i.date)).sort((a, b) => a.date!.localeCompare(b.date!) || (a.slot === b.slot ? a.order - b.order : a.slot === 'main' ? -1 : 1))
      .map((i) => ({ id: i.id, date: i.date!, kind: i.kind, title: i.title, status: i.status, pillar: pillars.find((p) => p.id === i.pillarId)?.name ?? null, note: i.note, permalink: i.posted?.permalink || null }));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return format === 'ics'
      ? { body: weekIcs(items, stamp), filename: `woche-${start}.ics`, type: 'text/calendar; charset=utf-8' }
      : { body: weekText(start, items), filename: `woche-${start}.txt`, type: 'text/plain; charset=utf-8' };
  });
}

/** Model Lab input `week`: the current week (nothing is stored or changed). */
export async function prepareWeekEvalTask() {
  const { task, start } = await preparePlanTask(today());
  return { task, label: `Aktuelle Woche (ab ${start}, ${BOARD_KIND_LABEL.reel}/${BOARD_KIND_LABEL.carousel}/${BOARD_KIND_LABEL.story})`, projectIds: [] as string[] };
}

/** The Overview tile (Etappe 20): this week in one line – planned and posted, nothing „missed“. */
export const weekSummary = () => read((db) => {
  const start = weekStartOf(today());
  const days = weekDays(start);
  const items = db.boardItems.filter((i) => i.date && days.includes(i.date));
  return { label: weekLabel(start), planned: items.filter((i) => i.slot === 'main').length, stories: items.filter((i) => i.slot === 'story').length, posted: items.filter((i) => i.status === 'posted').length, postsPerWeek: currentApproved(db, 'strategy')?.document.cadence.postsPerWeek ?? null };
});
