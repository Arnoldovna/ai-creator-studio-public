import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedApprovedStrategy } from './helpers/strategy';

/**
 * Etappe 20: the week board through the services – an empty week is neutral, items from her material (own projects only),
 * moves between days and to „ohne Tag“, status and „gepostet“ (only https links), week change, the pillar mix, „Woche
 * füllen“ (mock: only empty days, her rhythm, accept/dismiss/stale), figures into the Rückblick, the chat patch `week`
 * (board and „Allgemein“, stale base), the export without alarms – and that no endpoint posts anything.
 */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-board-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', STUDIO_DEFAULTS_DIR: 'off', VIDEO_WORKER_CONCURRENCY: '1', STUDIO_AUTO_PREPARE: 'off' });
  await seedApprovedStrategy();
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const MON = '2026-11-16', FRI = '2026-11-20', THU = '2026-11-19';

async function setup() {
  const projects = await import('@/server/services/projects');
  const content = await import('@/server/services/content');
  const carousels = await import('@/server/services/carousels');
  const project = await projects.createProject({ title: `Woche ${Math.random().toString(36).slice(2, 6)}`, kind: 'PERSONAL_CONTENT' });
  const { concepts } = await content.generateConcepts({ projectId: project.id, topic: 'Morgenstricken', verifiedFacts: [] });
  const carousel = await carousels.createCarousel(project.id, { source: { kind: 'note', text: 'Mein Morgen mit Wolle. Eine Reihe zählt schon. Das Handy bleibt im Flur.' } });
  return { project, concept: concepts[0]!, carousel: carousel.carousel };
}
const clearBoard = async () => (await import('@/server/store')).write((db) => { db.boardItems = []; db.weekPlans = []; });

describe('week board: neutral week, items, moves, status', () => {
  it('an empty week is neutral: seven days Mo–So, her rhythm as information, no warning of any kind', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    const b = await board.getBoard(THU);
    expect(b.weekStart).toBe(MON);
    expect(b.days.map((d) => d.weekday)).toEqual(['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']);
    expect(b.days.every((d) => d.items.length === 0)).toBe(true);
    expect(b.rhythm).toMatchObject({ postsPerWeek: 2, planned: 0 });
    expect(b.mix.rows.map((r) => [r.pillarId, r.targetShare, r.count])).toEqual([['werkstatt', 45, 0], ['alltag', 45, 0], ['experimente', 10, 0]]);
    expect(JSON.stringify({ days: b.days, rhythm: b.rhythm, mix: b.mix })).not.toMatch(/verpasst|missed|streak|serie|erinner|remind|warn|overdue|überfällig/i);
    // week change
    expect(b.prev).toBe('2026-11-09');
    expect(b.next).toBe('2026-11-23');
    expect((await board.getBoard('2026-11-29')).weekStart).toBe('2026-11-23');
  });

  it('items from her material carry their kind, slot, status and editor link; client material is refused', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    const { project, concept, carousel } = await setup();
    const c = await board.createItem({ date: FRI, ref: { kind: 'carousel', id: carousel.id } });
    expect(c).toMatchObject({ kind: 'carousel', slot: 'main', status: 'in_progress', projectId: project.id, href: `/karussells?project=${project.id}&carousel=${carousel.id}` });
    const i = await board.createItem({ date: FRI, ref: { kind: 'concept', id: concept.id } });
    expect(i).toMatchObject({ kind: 'idea', status: 'idea', href: `/content-lab?project=${project.id}` });
    const own = await board.createItem({ date: null, kind: 'reel', title: 'Reel: Lochkarten', pillarId: 'werkstatt' });
    expect(own).toMatchObject({ kind: 'reel', date: null, pillarName: 'Werkstatt', href: null });
    await expect(board.createItem({ date: FRI, kind: 'idea', title: 'x', pillarId: 'erfunden' })).rejects.toMatchObject({ status: 400 });
    await expect(board.createItem({ date: FRI, kind: 'idea', title: 'Dritter Hauptpost' })).resolves.toBeTruthy();
    await expect(board.createItem({ date: FRI, kind: 'idea', title: 'Vierter Hauptpost' })).rejects.toMatchObject({ status: 409 });
    const projects = await import('@/server/services/projects');
    const carousels = await import('@/server/services/carousels');
    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Garn GmbH' } });
    const { write, newId, now } = await import('@/server/store');
    const foreign = newId();
    await write((db) => { db.carousels.push({ id: foreign, projectId: client.id, title: 'Kunde', source: { kind: 'note', id: null, label: 'x', text: '' }, activeVersionId: '', createdAt: now(), updatedAt: now() }); });
    await expect(board.createItem({ date: FRI, ref: { kind: 'carousel', id: foreign } })).rejects.toMatchObject({ status: 409 });
    expect((await board.getBoard(FRI)).material.some((m) => m.ref === `carousel:${foreign}`)).toBe(false);
    void carousels;
  });

  it('moves between days and to „ohne Tag“; status; „gepostet“ only with an https link; stale edits refused; mix counts', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    const a = await board.createItem({ date: FRI, kind: 'reel', title: 'Reel A', pillarId: 'werkstatt' });
    const s = await board.createItem({ date: FRI, kind: 'story', title: 'Story A' });
    expect(s.slot).toBe('story');
    const moved = await board.updateItem(a.id, { date: THU });
    expect(moved).toMatchObject({ date: THU, order: 0, weekday: 'Donnerstag' });
    await expect(board.updateItem(a.id, { baseUpdatedAt: a.updatedAt, status: 'ready' })).rejects.toMatchObject({ status: 409, code: 'stale_item' });
    expect(await board.updateItem(a.id, { status: 'ready' })).toMatchObject({ status: 'ready', posted: null });
    await expect(board.updateItem(a.id, { posted: { permalink: 'javascript:alert(1)' } })).rejects.toThrow();
    const posted = await board.updateItem(a.id, { posted: { at: '2026-11-19', permalink: 'https://www.instagram.com/reel/abc/' } });
    expect(posted).toMatchObject({ status: 'posted', posted: { at: '2026-11-19', permalink: 'https://www.instagram.com/reel/abc/', publicationId: null } });
    expect((await board.updateItem(a.id, { status: 'ready' })).posted).toBeNull(); // back: link/date go
    expect((await board.updateItem(s.id, { date: null })).date).toBeNull();
    const b = await board.getBoard(MON);
    expect(b.unscheduled.map((x) => x.id)).toEqual([s.id]);
    expect(b.mix.rows.find((r) => r.pillarId === 'werkstatt')).toMatchObject({ count: 1, share: 100 });
    expect(b.rhythm.planned).toBe(1);
  });
});

describe('„Woche füllen“, Rückblick, chat, export', () => {
  it('suggests only for empty days within her rhythm, reuses material first; accept/dismiss; stale when the day is taken', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    const { read } = await import('@/server/store');
    const { carousel } = await setup();
    const runs = await read((db) => db.agentRuns.filter((r) => r.useCase === 'week_planning').length);
    const est = await board.estimatePlan({ week: MON, estimate: true });
    expect(est).toMatchObject({ estimate: { mode: 'mock', estCostUsd: 0 } });
    expect(await read((db) => db.agentRuns.filter((r) => r.useCase === 'week_planning').length)).toBe(runs);
    await board.createItem({ date: MON, kind: 'idea', title: 'Schon geplant' });
    const plan = await board.planWeek({ week: MON });
    expect(plan.mock).toBe(true);
    const main = plan.suggestions.filter((x) => x.slot === 'main');
    expect(main).toHaveLength(1); // rhythm 2, one planned
    expect(main[0]!.date).toBe('2026-11-17');
    expect(main[0]!.ref).toBe(`carousel:${carousel.id}`); // reuse first
    expect(await read((db) => db.boardItems.length)).toBe(1); // nothing lands on the board by itself
    const item = await board.acceptSuggestion(main[0]!.id);
    expect(item).toMatchObject({ date: '2026-11-17', kind: 'carousel', origin: 'planner', ref: { kind: 'carousel', id: carousel.id } });
    await expect(board.acceptSuggestion(main[0]!.id)).rejects.toMatchObject({ status: 409 });
    // a new run replaces the open ones; a suggestion whose day got taken is stale
    await board.deleteItem(item.id);
    const plan2 = await board.planWeek({ week: MON });
    const s2 = plan2.suggestions.find((x) => x.slot === 'main')!;
    await board.createItem({ date: s2.date, kind: 'idea', title: 'Selbst eingetragen' });
    await expect(board.acceptSuggestion(s2.id)).rejects.toMatchObject({ status: 409, code: 'stale_suggestion' });
    await board.dismissSuggestion(s2.id);
    expect((await board.getBoard(MON)).plan?.suggestions.some((x) => x.id === s2.id)).toBe(false);
  });

  it('figures of a posted entry go into the Rückblick by hand (no Instagram API)', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    const analytics = await import('@/server/services/analytics');
    const { carousel, project } = await setup();
    const it0 = await board.createItem({ date: FRI, ref: { kind: 'carousel', id: carousel.id } });
    await expect(board.addItemMetrics(it0.id, { window: '7d', reach: 1, views: 1, saves: 0, shares: 0 })).rejects.toMatchObject({ status: 409 });
    await board.updateItem(it0.id, { posted: { at: FRI, permalink: 'https://www.instagram.com/p/x/' } });
    const r = await board.addItemMetrics(it0.id, { window: '7d', reach: 1200, views: 2000, saves: 40, shares: 6 });
    expect(r.item.publication).toMatchObject({ snapshots: 1, latest: { window: '7d', metrics: { reach: 1200 } } });
    const pubs = (await analytics.getAnalytics()).publications.filter((p) => p.id === r.publicationId);
    expect(pubs[0]).toMatchObject({ projectId: project.id, format: 'carousel', permalink: 'https://www.instagram.com/p/x/', title: carousel.title });
    await board.addItemMetrics(it0.id, { window: '30d', reach: 2000, views: 3000, saves: 50, shares: 8 });
    expect((await analytics.getAnalytics()).publications.find((p) => p.id === r.publicationId)!.snapshots).toHaveLength(2);
  });

  it('chat patch `week`: „verschieb das Reel von Freitag auf Donnerstag“ on the board and from „Allgemein“; stale after another move', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    const chat = await import('@/server/services/chat');
    const reel = await board.createItem({ date: FRI, kind: 'reel', title: 'Freitagsreel' });
    const t = await chat.createThread({ scope: 'week' });
    const { assistant } = await chat.sendMessage(t.id, { text: 'Verschieb das Reel von Freitag auf Donnerstag', weekStart: MON });
    expect(assistant.mock).toBe(true);
    const p = assistant.proposals[0]!;
    expect(p).toMatchObject({ kind: 'week', patch: { kind: 'week', ops: [{ op: 'move', from: 'fr', to: 'do', kind: 'reel' }] }, changes: [{ before: 'Freitag', after: 'Donnerstag' }] });
    // nothing moves before „Übernehmen“
    expect((await board.getBoard(MON)).days[4]!.items.map((x) => x.id)).toEqual([reel.id]);
    await chat.applyProposal(p.id);
    expect((await board.getBoard(MON)).days[3]!.items.map((x) => x.id)).toEqual([reel.id]);
    // „Mittwoch frei“ from the general page (current week) – a stale proposal after another move is refused
    const g = await chat.createThread({ scope: 'general' });
    const thisWeek = board.parseWeek(null);
    const mid = await board.createItem({ date: (await import('@studio/core')).addDays(thisWeek, 2), kind: 'idea', title: 'Mittwochsidee' });
    const free = (await chat.sendMessage(g.id, { text: 'Mittwoch frei' })).assistant.proposals.find((x) => x.kind === 'week')!;
    expect(free.changes[0]).toMatchObject({ label: 'Idee „Mittwochsidee“', after: 'ohne Tag (bleibt erhalten)' });
    await board.updateItem(mid.id, { title: 'Umbenannt', index: 0 });
    await board.createItem({ date: (await import('@studio/core')).addDays(thisWeek, 2), kind: 'idea', title: 'Noch eine' });
    await expect(chat.applyProposal(free.id)).rejects.toMatchObject({ status: 409, code: 'stale_base' });
    expect((await board.getBoard(thisWeek)).days[2]!.items).toHaveLength(2); // nothing deleted
  });

  it('export: text list and calendar entries without alarms', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    await board.createItem({ date: FRI, kind: 'reel', title: 'Reel, mit Komma', pillarId: 'alltag', note: 'Licht am Fenster' });
    const txt = await board.exportWeek(MON, 'txt');
    expect(txt).toMatchObject({ filename: 'woche-2026-11-16.txt', type: 'text/plain; charset=utf-8' });
    expect(txt.body).toContain('• Reel: Reel, mit Komma (Idee) · Alltag & Routinen – Licht am Fenster');
    const ics = await board.exportWeek(MON, 'ics');
    expect(ics.body).toContain('DTSTART;VALUE=DATE:20261120');
    expect(ics.body).not.toMatch(/VALARM|TRIGGER/);
  });
});

describe('review fixes', () => {
  it('chat moves respect the per-day limit; metrics never go into a client project; re-posting reuses the Rückblick record', async () => {
    await clearBoard();
    const board = await import('@/server/services/board');
    const chat = await import('@/server/services/chat');
    for (const t of ['A', 'B', 'C']) await board.createItem({ date: THU, kind: 'idea', title: `Do ${t}` });
    await board.createItem({ date: FRI, kind: 'reel', title: 'Freitagsreel' });
    const th = await chat.createThread({ scope: 'week' });
    const { assistant } = await chat.sendMessage(th.id, { text: 'Verschieb das Reel von Freitag auf Donnerstag', weekStart: MON });
    expect(assistant.proposals).toEqual([]);
    expect(assistant.warnings.join(' ')).toMatch(/Höchstens 3/);
    // metrics: a client project is refused
    const projects = await import('@/server/services/projects');
    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Garn GmbH' } });
    const own = await board.createItem({ date: MON, kind: 'idea', title: 'Ohne Projekt' });
    await board.updateItem(own.id, { posted: { at: MON } });
    await expect(board.addItemMetrics(own.id, { window: '7d', reach: 1, views: 1, saves: 0, shares: 0, projectId: client.id })).rejects.toMatchObject({ status: 409 });
    const { project } = await setup();
    const r1 = await board.addItemMetrics(own.id, { window: '7d', reach: 5, views: 5, saves: 0, shares: 0, projectId: project.id });
    await board.updateItem(own.id, { status: 'ready' });
    await board.updateItem(own.id, { posted: { at: MON } });
    const r2 = await board.addItemMetrics(own.id, { window: '30d', reach: 9, views: 9, saves: 0, shares: 0, projectId: project.id });
    expect(r2.publicationId).toBe(r1.publicationId);
  });
});

describe('nothing posts', () => {
  const API = path.join(__dirname, '..', 'src', 'app', 'api');
  async function routes(d: string, rel = ''): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...(await routes(path.join(d, e.name), `${rel}/${e.name}`)));
      else if (e.name === 'route.ts') out.push(rel || '/');
    }
    return out;
  }
  it('there is no endpoint that posts, publishes, schedules or reminds; the board API is exactly the planning one', async () => {
    const all = await routes(API);
    expect(all.filter((r) => /(^|\/)(post|posten|publish|schedule|reminders?|instagram|graph|share)(\/|$)/i.test(r))).toEqual([]);
    expect(all.filter((r) => r.startsWith('/board')).sort()).toEqual([
      '/board', '/board/export', '/board/items', '/board/items/[itemId]', '/board/items/[itemId]/metrics', '/board/plan',
      '/board/suggestions/[sid]/accept', '/board/suggestions/[sid]/dismiss',
    ]);
    const svc = await import('@/server/services/board');
    expect(Object.keys(svc).filter((k) => /post(?!ed)|publish|schedule|remind/i.test(k))).toEqual([]);
    expect((await import('@studio/core')).PATCH_KINDS).not.toContain('post');
  });
});
