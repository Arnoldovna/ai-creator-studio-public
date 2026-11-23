import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passFit, seedApprovedStrategy, withPhase } from './helpers/strategy';

/**
 * Etappe 9, Part 4: self-assessment (joy, comfort on camera, finished; also sessions without a video), the pillar
 * mix and review hints. Display only: nothing here changes a strategy, style or voice version. Notes live on the record (Etappe 11).
 * Fixtures are invented and neutral; canaries are random tokens.
 */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-self-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock' });
});
afterAll(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const NOTE = 'CANARY-LOCAL-selfnote-4e91c2d7 lief heute gut';
const dbText = () => readFile(path.join(dir, 'db.json'), 'utf8');
const svc = () => import('@/server/services/selfAssessment');

async function addAsset(projectId: string) {
  const { write, newId, now } = await import('@/server/store');
  const id = newId();
  await write((db) => {
    db.mediaAssets.push({
      id, projectId, name: 'take.mp4', mime: 'video/mp4', size: 1, sha256: 'x', storagePath: `footage/${projectId}/${id}.mp4`, origin: 'own', rightsNote: '',
      rightsConfirmedAt: now(), status: 'probed', createdAt: now(),
      probe: { durationSec: 4, width: 640, height: 360, rotation: 0, displayWidth: 640, displayHeight: 360, orientation: 'landscape', fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' },
    });
  });
  return id;
}

describe('self-assessment', () => {
  let strategyId: string;
  let projectId: string;

  it('validates input: a session needs no subject, joy 0 → 400, a piece without „fertig“ → 422, a missing subject → 404', async () => {
    ({ strategyVersionId: strategyId } = await seedApprovedStrategy({ phase: 'private_trial' }));
    const s = await svc();
    const session = await s.createSelfAssessment({ joy: 4 });
    expect(session).toMatchObject({ subject: { kind: 'session' }, projectId: null, pillarId: null, strategyVersionId: strategyId, joy: 4, cameraComfort: null, finished: null, note: '' });

    await expect(s.createSelfAssessment({ joy: 0 })).rejects.toBeInstanceOf(ZodError);
    const { errorResponse } = await import('@/server/http');
    expect(errorResponse(await s.createSelfAssessment({ joy: 0 }).catch((e) => e)).status).toBe(400);

    const projects = await import('@/server/services/projects');
    projectId = (await projects.createProject({ title: 'Eigenes', kind: 'PERSONAL_CONTENT' })).id;
    const edit = await import('@/server/services/edit');
    const plan = await edit.saveEditPlan(projectId, { scriptId: null, body: { clips: [{ assetId: await addAsset(projectId), inSec: 0, outSec: 3 }], loudness: 'off' } });
    await expect(s.createSelfAssessment({ joy: 3, subject: { kind: 'edit_plan', id: plan.id } })).rejects.toMatchObject({ status: 422, message: 'Bitte angeben, ob es fertig ist.' });
    await expect(s.createSelfAssessment({ joy: 3, subject: { kind: 'publication', id: 'missing' }, finished: true })).rejects.toMatchObject({ status: 404 });
    await expect(s.createSelfAssessment({ joy: 3, subject: { kind: 'render', id: 'missing' }, finished: true })).rejects.toMatchObject({ status: 404 });
    await expect(s.createSelfAssessment({ joy: 3, pillarId: 'gibt-es-nicht' })).rejects.toMatchObject({ status: 400 });
    const other = await projects.createProject({ title: 'Anderes', kind: 'PERSONAL_CONTENT' });
    await expect(s.createSelfAssessment({ joy: 3, projectId: other.id, subject: { kind: 'edit_plan', id: plan.id }, finished: false })).rejects.toMatchObject({ status: 400 });

    // without a FitCheck the free cut has no pins: her own pick counts
    const own = await s.createSelfAssessment({ joy: 3, subject: { kind: 'edit_plan', id: plan.id }, finished: false, pillarId: 'alltag' });
    expect(own).toMatchObject({ projectId, pillarId: 'alltag', strategyVersionId: strategyId, finished: false });
    // after the FitCheck on the root the plan's pins win over her pick
    await passFit(plan.id, 'edit_plan', 'experimente');
    expect(await s.createSelfAssessment({ joy: 5, subject: { kind: 'edit_plan', id: plan.id }, finished: true, pillarId: 'alltag' })).toMatchObject({ pillarId: 'experimente', strategyVersionId: strategyId });
    await expect(s.updateSelfAssessment(own.id, { pillarId: 'werkstatt' })).rejects.toMatchObject({ status: 409 });
    await expect(s.updateSelfAssessment(own.id, { finished: null })).rejects.toMatchObject({ status: 422 });
    expect(await s.updateSelfAssessment(own.id, { joy: 2, cameraComfort: 3 })).toMatchObject({ joy: 2, cameraComfort: 3, pillarId: 'alltag' });
  });

  it('copies the pins of a publication from its script', async () => {
    const s = await svc();
    const content = await import('@/server/services/content');
    const analytics = await import('@/server/services/analytics');
    const { concepts } = await content.generateConcepts({ projectId, topic: 'Holz ölen', pillarId: 'werkstatt' });
    await passFit(concepts[0]!.id, 'concept', 'werkstatt');
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const pub = await analytics.createPublication({ projectId, title: 'Reel 1', publishedAt: '2026-11-10', scriptVersionId: script.id });
    expect(pub).toMatchObject({ pillarId: 'werkstatt', strategyVersionId: strategyId });
    const rec = await s.createSelfAssessment({ joy: 4, subject: { kind: 'publication', id: pub.id }, finished: true, pillarId: 'alltag' });
    expect(rec).toMatchObject({ projectId, pillarId: 'werkstatt', strategyVersionId: strategyId, finished: true });
  });

  it('Etappe 11: the note is stored on the record (no private file); patch, delete and project delete keep it in step', async () => {
    const s = await svc();
    const rec = await s.createSelfAssessment({ joy: 5, cameraComfort: 4, note: NOTE });
    expect(rec.note).toBe(NOTE);
    expect(await dbText()).toContain(NOTE);
    await expect(stat(path.join(dir, 'private', 'context-local.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const listed = await s.listSelfAssessments(12);
    expect(listed.entries.find((e) => e.id === rec.id)?.note).toBe(NOTE);

    expect(await s.updateSelfAssessment(rec.id, { note: '' })).toMatchObject({ note: '' });
    expect(await dbText()).not.toContain(NOTE);
    await s.updateSelfAssessment(rec.id, { note: NOTE });
    expect(await dbText()).toContain(NOTE);
    await s.deleteSelfAssessment(rec.id);
    expect(await dbText()).not.toContain(NOTE);
    expect((await s.listSelfAssessments(12)).entries.some((e) => e.id === rec.id)).toBe(false);

    // deleting the project removes its entries and their notes
    const projects = await import('@/server/services/projects');
    const p = await projects.createProject({ title: 'Weg damit', kind: 'PERSONAL_CONTENT' });
    const tied = await s.createSelfAssessment({ joy: 3, projectId: p.id, note: `${NOTE} Projekt` });
    await projects.deleteProject(p.id);
    expect((await s.listSelfAssessments(12)).entries.some((e) => e.id === tied.id)).toBe(false);
    expect(await dbText()).not.toContain(NOTE);
  });

  it('series, mix and review hints are read only: db.json stays byte-identical', async () => {
    const s = await svc();
    const before = await dbText();
    const list = await s.listSelfAssessments(4);
    const mix = await s.selfAssessmentMix(12);
    await s.reviewHints();
    expect(await dbText()).toBe(before);

    expect(list.series).toHaveLength(4);
    expect(list.series.at(-1)!.sessions).toBeGreaterThanOrEqual(1);
    expect(list.pillars.map((p) => p.id)).toEqual(['werkstatt', 'alltag', 'experimente']);
    expect(mix.rows.map((r) => [r.name, r.count, r.targetShare])).toEqual([
      ['Werkstatt', 1, 45], ['Alltag & Routinen', 0, 45], ['Experimente', 1, 10], ['ohne Säule', 0, null],
    ]);
  });

  it('review hint after the planned weeks only (display only, no metric text)', async () => {
    const s = await svc();
    expect(await s.reviewHints()).toEqual([]);
    const later = await s.reviewHints(new Date(Date.now() + 9 * 7 * 86_400_000));
    expect(later).toEqual([{ id: expect.stringContaining(':8'), text: 'Zeit für einen Rückblick? (optional)', detail: expect.stringContaining('nach 8 Wochen') }]);
    expect(JSON.stringify(later)).not.toContain('Freude 1–5 nach jeder Session'); // the metric text is local-only
  });

  it('the mix counts pieces, not check-ins: plan, render and publication of one cut count once; sessions and client work never', async () => {
    const s = await svc();
    const { write, newId, now } = await import('@/server/store');
    const projects = await import('@/server/services/projects');
    const edit = await import('@/server/services/edit');
    const analytics = await import('@/server/services/analytics');
    const total = async () => (await s.selfAssessmentMix(12)).finishedTotal;
    const before = await total();

    const p = await projects.createProject({ title: 'Ein Stück', kind: 'PERSONAL_CONTENT' });
    const plan = await edit.saveEditPlan(p.id, { scriptId: null, body: { clips: [{ assetId: await addAsset(p.id), inSec: 0, outSec: 3 }], loudness: 'off' } });
    const renderId = newId();
    await write((db) => {
      db.renders.push({ id: renderId, projectId: p.id, editPlanId: plan.id, jobId: 'j', status: 'pending_review', storagePath: 'renders/x.mp4', size: 1, sha256: null, durationSec: 3, loudness: null, disclosures: [], error: null, reviewNote: '', createdAt: now(), finishedAt: now(), reviewedAt: null } as (typeof db.renders)[number]);
    });
    const pub = await analytics.createPublication({ projectId: p.id, title: 'Reel Stück', publishedAt: '2026-11-12', editPlanId: plan.id });
    await s.createSelfAssessment({ joy: 4, subject: { kind: 'edit_plan', id: plan.id }, finished: true, pillarId: 'alltag' });
    await s.createSelfAssessment({ joy: 4, subject: { kind: 'render', id: renderId }, finished: true, pillarId: 'alltag' });
    await s.createSelfAssessment({ joy: 5, subject: { kind: 'publication', id: pub.id }, finished: true, pillarId: 'alltag' });
    await s.createSelfAssessment({ joy: 5, subject: { kind: 'publication', id: pub.id }, finished: true, pillarId: 'alltag' });
    expect(await total()).toBe(before + 1);

    // a session is never „fertig“, whatever the request says
    const session = await s.createSelfAssessment({ joy: 3, finished: true });
    expect(session.finished).toBeNull();
    expect((await s.updateSelfAssessment(session.id, { finished: true })).finished).toBeNull();
    expect(await total()).toBe(before + 1);

    // client work: the pillar pick is ignored (no 400), and it is not part of her mix
    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT' });
    const clientPub = await analytics.createPublication({ projectId: client.id, title: 'Kunden-Reel', publishedAt: '2026-11-12' });
    expect(await s.createSelfAssessment({ joy: 3, projectId: client.id, pillarId: 'werkstatt' })).toMatchObject({ projectId: client.id, pillarId: null });
    expect(await s.createSelfAssessment({ joy: 3, subject: { kind: 'publication', id: clientPub.id }, finished: true, pillarId: 'werkstatt' })).toMatchObject({ pillarId: null });
    expect(await total()).toBe(before + 1);

    // the form gets the inherited pillar and the client flag per subject
    const subjects = (await s.listSelfAssessments(12)).subjects;
    expect(subjects.find((x) => x.id === clientPub.id)).toMatchObject({ client: true, pinned: false });
    expect(subjects.find((x) => x.id === plan.id)).toMatchObject({ client: false, pinned: false, pillarId: null });
  });

  it('the pillar of an entry whose piece was deleted can still be changed', async () => {
    const s = await svc();
    const projects = await import('@/server/services/projects');
    const analytics = await import('@/server/services/analytics');
    const p = await projects.createProject({ title: 'Gelöscht', kind: 'PERSONAL_CONTENT' });
    const pub = await analytics.createPublication({ projectId: p.id, title: 'Reel weg', publishedAt: '2026-11-12' });
    const rec = await s.createSelfAssessment({ joy: 3, subject: { kind: 'publication', id: pub.id }, finished: true, pillarId: 'alltag' });
    await analytics.deletePublication(pub.id);
    expect(await s.updateSelfAssessment(rec.id, { pillarId: 'werkstatt' })).toMatchObject({ pillarId: 'werkstatt' });
    expect(await s.updateSelfAssessment(rec.id, { pillarId: null })).toMatchObject({ pillarId: null });
    expect((await s.listSelfAssessments(12)).entries.find((e) => e.id === rec.id)?.subjectLabel).toBe('Veröffentlichung: (gelöscht)');
  });

  it('a failed delete keeps the entry and its note together', async () => {
    const s = await svc();
    const note = 'CANARY-LOCAL-deletenote-8b20f1 kurz notiert';
    const rec = await s.createSelfAssessment({ joy: 2, note });
    await chmod(dir, 0o500); // db.json cannot be written
    try {
      await expect(s.deleteSelfAssessment(rec.id)).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
    expect((await s.listSelfAssessments(12)).entries.find((e) => e.id === rec.id)?.note).toBe(note);
    await s.deleteSelfAssessment(rec.id);
    expect(await dbText()).not.toContain(note);
  });

  it('approving strategy v2 changes no style or voice version, no self-check and no gate', async () => {
    const style = await import('@/server/services/style');
    await style.saveForms({ voice: { traits: 'direkt', avoid: '', example: 'Ich probier das einfach mal aus und zeig dir, was passiert.' } });
    const { read } = await import('@/server/store');
    const snap = () => read((db) => JSON.stringify({ s: db.styleBibles, v: db.voiceGuides, f: db.styleForms, a: db.selfAssessments, g: db.strategyGates }));
    const before = await snap();
    expect(before).toContain('"traits":"direkt"');
    await withPhase('public');
    expect(await snap()).toBe(before);
  });
});
