import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UgcScript } from '@studio/core';
import { FIXTURE_SENSITIVE_TERMS } from '../../../packages/core/test/fixtures/strategy';
import { passFit, seedApprovedStrategy, withPhase } from './helpers/strategy';

/**
 * Etappe 9, Part 3: the strategy gate in every approval path (API services, Model Lab), before any spend, with
 * recorded overrides with their reason (on the gate since Etappe 11). Fixtures are invented and neutral.
 */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-gate-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
});
afterAll(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const MODELS = ['openai/gpt-6-luna', 'meta/muse-spark-1.3'];
const answersAll = (answer: 'ja' | 'nein' | 'unklar', f2: 'ja' | 'nein' | 'unklar' = 'ja') => [
  { criterionId: 'werkstatt-f1', answer }, { criterionId: 'werkstatt-f2', answer: f2 },
];
const withDialogue = (body: UgcScript, i: number, dialogue: string): UgcScript => ({ ...body, scenes: body.scenes.map((s, k) => (k === i ? { ...s, dialogue } : s)) });
const runCount = async () => (await import('@/server/store')).read((db) => db.agentRuns.length);
const dbText = () => readFile(path.join(dir, 'db.json'), 'utf8');

/** A real synthetic clip (test pattern, no audio) uploaded as own footage, so a render can actually run. */
async function uploadClip(projectId: string) {
  const ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
  const out = path.join(dir, `clip-${projectId}.mp4`);
  await promisify(execFile)(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', out]);
  const footage = await import('@/server/services/footage');
  const { asset } = await footage.uploadFootage(projectId, new Blob([await readFile(out)]).stream(), { name: 'clip.mp4', origin: 'own', rightsConfirmed: true }, null);
  return asset.id;
}

/** A probed footage record (no file needed for saving and approving a plan). */
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

const waitJob = async (jobId: string) => {
  const { getJob } = await import('@/server/services/videoJobs');
  let done = await getJob(jobId);
  for (let i = 0; i < 2400 && ['queued', 'running'].includes(done.status); i++) {
    await new Promise((r) => setTimeout(r, 50));
    done = await getJob(jobId);
  }
  return done;
};

/**
 * Etappe 10 (ADR-013, Carola 19.11.: „die Gates nerven, weg damit“): personal projects have no strategy gate. No
 * approved strategy or pillar needed, no FitCheck, no boundary lint (not even as a hint), no claim checkbox.
 * Runs first, while no strategy is approved yet.
 */
describe('Etappe 10: no gates in personal projects', () => {
  it('brief without strategy or pillar; concept → script → approval without FitCheck, lint or claim checkbox', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const gate = await import('@/server/services/strategyGate');
    const evals = await import('@/server/services/eval');
    const { read, write } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Werkstatt', kind: 'PERSONAL_CONTENT' });
    expect(await read((db) => db.contextVersions.some((v) => v.kind === 'strategy' && v.status === 'approved'))).toBe(false);

    // no approved strategy, no pillar: concepts are written; an unknown pillar is treated as none
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Werkbank', lengthSeconds: 15 });
    expect(concepts.length).toBeGreaterThan(0);
    for (const c of concepts) expect(c).toMatchObject({ strategyVersionId: null, pillarId: null });
    const unknown = await content.generateConcepts({ projectId: p.id, topic: 'Werkbank', pillarId: 'gibtsnicht', lengthSeconds: 15 });
    expect(unknown.concepts[0]!.pillarId).toBeNull();

    // a boundary word in the hook (address) neither blocks nor shows up as a hint
    const c0 = concepts[0]!;
    await write((db) => void (db.concepts.find((x) => x.id === c0.id)!.body.hook = 'Was ich am Musterweg 12 bei Musterfirma GmbH über Hobel gelernt habe.'));
    const conceptView = await gate.gateView('concept', c0.id);
    expect(conceptView).toMatchObject({ projectKind: 'PERSONAL_CONTENT', blockers: [], findings: [] });
    // nothing to release, so no override either
    // the FitCheck override is gone since Etappe 11 (schema rejects it)
    await expect(gate.addOverride('concept', c0.id, { type: 'fit', key: 'no_pillar', reason: 'Ohne Prüfung freigeben' })).rejects.toThrow();

    // selecting writes the script directly (no FitCheck); the Model Lab runs the same prepare function
    const script = await content.selectConceptAndWrite(c0.id);
    expect(script).toMatchObject({ status: 'draft', pillarId: null });
    await expect(evals.runEval({ useCase: 'ugc_scriptwriting', input: { kind: 'concept', conceptId: concepts[1]!.id }, modelIds: MODELS })).resolves.toBeTruthy();

    // employer and children in the dialogue, open claims in the body, no checkbox: one click approves it
    const s2 = await content.saveScriptEdit(script.id, withDialogue(script.body, 0, 'Mein Chef bei Musterfirma GmbH und meine Kinder schauen zu.'));
    await write((db) => void (db.scripts.find((x) => x.id === s2.id)!.body.claimsToVerify = ['klinisch getestet']));
    expect(await gate.gateView('script', s2.id)).toMatchObject({ blockers: [], findings: [] });
    expect(await content.setScriptStatus(s2.id, 'approved')).toMatchObject({ status: 'approved' });
  });

  it('copy and storyboard: copy for a draft script without confirmation; a storyboard with AI media keeps it; a rejected script stops both', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const agents = await import('@/server/services/scriptAgents');
    const { write } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Storyboard', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Leim', lengthSeconds: 15 });
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    expect(script.status).toBe('draft');

    // copy for the draft script, approved without the confirmation checkbox
    const copy = await agents.runScriptAgent('copy', script.id);
    const view = await content.getContent(p.id);
    expect(view.scriptOutputs.find((o) => o.id === copy.id)!.gate).toMatchObject({ blockers: [], confirm: false, clientConsent: false });
    expect((await agents.approveScriptOutput(copy.id, {})).status).toBe('approved');

    // a medical word in an AI asset brief no longer blocks; the confirmation (step before paid jobs) stays
    const board = await agents.runScriptAgent('storyboard', script.id);
    await write((db) => {
      const b = db.scriptOutputs.find((x) => x.id === board.id)!;
      if (b.kind !== 'storyboard') throw new Error('kind');
      b.output.aiAssetBriefs = [{ sceneIndex: 0, purpose: 'Stimmung', prompt: 'Nahaufnahme: ein Medikament neben dem Hobel', disclosureLabel: 'KI-generiert', requiresApproval: true, clientApprovalRequired: false }];
    });
    await expect(agents.approveScriptOutput(board.id, {})).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Bestätigung fehlt, dass die KI-Elemente gekennzeichnet sind/) });
    expect((await agents.approveScriptOutput(board.id, { confirmed: true })).status).toBe('approved');

    // a rejected script is not processed further
    await content.setScriptStatus(script.id, 'rejected');
    await expect(agents.runScriptAgent('copy', script.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Verworfene Skripte/) });
  });

  it('free cut: free overlay text, a free hook and a boundary word in the subtitle; „Speichern → Rendern“ approves implicitly', async () => {
    const projects = await import('@/server/services/projects');
    const edit = await import('@/server/services/edit');
    const gate = await import('@/server/services/strategyGate');
    const { getMediaRecord } = await import('@/server/services/references');
    const { read } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Frei', kind: 'PERSONAL_CONTENT' });
    const assetId = await uploadClip(p.id);
    const body = {
      clips: [{ assetId, inSec: 0, outSec: 3, subtitle: 'Mein Chef schaut zu.', overlays: [{ kind: 'keyword', startSec: 0.5, endSec: 2, text: 'Frei getippt' }] }],
      hook: { source: 'free', text: 'In 3 Tagen zur Werkbank' }, loudness: 'off', subtitles: 'off',
    };
    const plan = await edit.saveEditPlan(p.id, { scriptId: null, body });
    expect(plan).toMatchObject({ status: 'draft', pillarId: null });
    // the figure in the hook is a hint, not a blocker; no claim confirmation was sent
    expect(plan.warnings.join(' ')).toMatch(/Zahlen im Hook ohne verifizierten Claim: 3/);
    expect(await gate.gateView('edit_plan', plan.id)).toMatchObject({ blockers: [], findings: [] });

    const { job, render } = await edit.startRender(plan.id, {});
    expect(render).toMatchObject({ status: 'rendering', editPlanId: plan.id });
    expect(await read((db) => db.editPlans.find((x) => x.id === plan.id))).toMatchObject({ status: 'approved', approvedAt: expect.any(String) });
    const done = await waitJob(job.id);
    expect(done).toMatchObject({ status: 'succeeded', error: null });
    // the finished render is downloadable right away; the review stays optional
    const r = await read((db) => db.renders.find((x) => x.jobId === job.id)!);
    expect(r.status).toBe('pending_review');
    expect(await getMediaRecord(r.id)).toMatchObject({ mime: 'video/mp4' });
  }, 180000);

  it('a denied label in a burned-in overlay or hook stays an error in personal projects', async () => {
    const projects = await import('@/server/services/projects');
    const edit = await import('@/server/services/edit');
    const p = await projects.createProject({ title: 'Kennzeichnung', kind: 'PERSONAL_CONTENT' });
    const assetId = await addAsset(p.id);
    const clip = (text: string) => ({ assetId, inSec: 0, outSec: 3, overlays: [{ kind: 'keyword', startSec: 0.5, endSec: 2, text }] });
    await expect(edit.saveEditPlan(p.id, { scriptId: null, body: { clips: [clip('keine Werbung')] } })).rejects.toThrow(/bestreitet eine Kennzeichnung/);
    await expect(edit.saveEditPlan(p.id, { scriptId: null, body: { clips: [clip('ganz ohne KI')] } })).rejects.toThrow(/bestreitet eine Kennzeichnung/);
    await expect(edit.saveEditPlan(p.id, { scriptId: null, body: { clips: [clip('Wolle')], hook: { source: 'free', text: 'Nicht gesponsert, ehrlich' } } })).rejects.toThrow(/Hook: Der Text im Hook bestreitet eine Kennzeichnung/);
  });
});

describe('strategy gate (client project)', () => {
  it('no pillar or FitCheck; a sensitive term blocks until changed or overridden; generic employer words do not; the claim checkbox stays', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const gate = await import('@/server/services/strategyGate');
    // from here on a strategy with her own sensitive terms is approved (the client lint uses them)
    await seedApprovedStrategy({ terms: FIXTURE_SENSITIVE_TERMS });
    const c = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Garnladen', productClaims: [] } });
    const { concepts } = await content.generateConcepts({ projectId: c.id, topic: 'Garn', lengthSeconds: 15 });
    expect(concepts[0]).toMatchObject({ strategyVersionId: null, pillarId: null });
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const generic = await content.saveScriptEdit(script.id, withDialogue(script.body, 0, 'Mein Chef hat mir das Garn empfohlen.'));
    // client work keeps the claim confirmation (Etappe 10 removes it only for personal projects)
    await expect(content.setScriptStatus(generic.id, 'approved')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Bestätigung fehlt/) });
    expect((await content.setScriptStatus(generic.id, 'approved', { claimsReviewed: true })).status).toBe('approved');
    const term = await content.saveScriptEdit(generic.id, withDialogue(generic.body, 0, 'Ich wohne in Beispielstadt und stricke.'));
    await expect(content.setScriptStatus(term.id, 'approved', { claimsReviewed: true })).rejects.toMatchObject({ status: 422 });
    const v = await gate.gateView('script', term.id);
    expect(v.findings.length).toBeGreaterThan(0);
    for (const f of v.findings) await gate.addOverride('script', term.id, { type: 'lint', fingerprint: f.fingerprint, reason: 'Kundin wünscht den Ort ausdrücklich.' });
    expect((await content.setScriptStatus(term.id, 'approved', { claimsReviewed: true })).status).toBe('approved');
  });

  it('copy needs an approved script and the confirmation; a draft plan is not rendered without its approval', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const agents = await import('@/server/services/scriptAgents');
    const edit = await import('@/server/services/edit');
    const c = await projects.createProject({ title: 'Kunde Copy', kind: 'UGC_CLIENT', client: { clientName: 'Garnladen', productClaims: [] } });
    const { concepts } = await content.generateConcepts({ projectId: c.id, topic: 'Garn', lengthSeconds: 15 });
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    await expect(agents.runScriptAgent('copy', script.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/freigegebenes Skript/) });
    const assetId = await addAsset(c.id);
    const plan = await edit.saveEditPlan(c.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId, inSec: 0, outSec: 2 }] } });
    await expect(edit.approveEditPlan(plan.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Erst das Skript freigeben/) });
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    const copy = await agents.runScriptAgent('copy', script.id);
    await expect(agents.approveScriptOutput(copy.id, {})).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Bestätigung fehlt/) });
    // no implicit approval for client plans: rendering a draft stays 409
    await expect(edit.startRender(plan.id, {})).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Nur freigegebene Schnittpläne/) });
    expect(await edit.approveEditPlan(plan.id)).toMatchObject({ status: 'approved' });
  });
});

describe('strategy gate edge cases', () => {
  it('client concept: a home address or one of her terms in the hook blocks the script until overridden in the gate', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const gate = await import('@/server/services/strategyGate');
    const { write } = await import('@/server/store');
    const c = await projects.createProject({ title: 'Kunde 2', kind: 'UGC_CLIENT', client: { clientName: 'Garnladen', productClaims: [] } });
    const { concepts } = await content.generateConcepts({ projectId: c.id, topic: 'Garn', lengthSeconds: 15 });
    const [address, term] = [concepts[0]!.id, concepts[1]!.id];
    await write((db) => {
      db.concepts.find((x) => x.id === address)!.body.hook = 'Neu im Laden am Musterweg 12: dieses Garn.';
      db.concepts.find((x) => x.id === term)!.body.hook = 'Neu im Laden in Beispielstadt: dieses Garn.';
    });
    const overrideAll = async (id: string, reason: string) => {
      const v = await gate.gateView('concept', id);
      expect(v.blockers.length).toBeGreaterThan(0);
      expect(v.blockers.every((b) => b.type === 'lint' && b.overridable)).toBe(true);
      for (const b of v.blockers) await gate.addOverride('concept', id, { type: 'lint', fingerprint: b.fingerprint!, reason });
    };

    const runs = await runCount();
    await expect(content.selectConceptAndWrite(address)).rejects.toMatchObject({ status: 422, code: 'strategy_gate', message: expect.stringMatching(/Kategorie „Wohnort“/) });
    expect(await runCount()).toBe(runs);
    await overrideAll(address, 'Die Ladenadresse steht im Kundenbriefing.');
    expect(await content.selectConceptAndWrite(address)).toMatchObject({ strategyVersionId: null, pillarId: null });

    // a term from her own list blocks the client script too, until released in the gate
    // (whether the text may then reach the AI is the privacy guard's decision, tested in strategyPrivacy.test.ts)
    await expect(content.selectConceptAndWrite(term)).rejects.toMatchObject({ status: 422, code: 'strategy_gate' });
    await overrideAll(term, 'Der Ort steht im Kundenbriefing.');
    expect((await gate.gateView('concept', term)).blockers).toEqual([]);
  });

  it('personal, with an approved strategy and her own terms: a term from her list neither blocks nor is a hint; a known pillar is kept', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const gate = await import('@/server/services/strategyGate');
    const { write } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Lint zuerst', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Hobel', pillarId: 'werkstatt', lengthSeconds: 15 });
    expect(concepts[0]!.pillarId).toBe('werkstatt');
    const id = concepts[0]!.id;
    await write((db) => {
      db.concepts.find((x) => x.id === id)!.body.hook = 'Was ich bei Musterfirma GmbH über Hobel gelernt habe.';
    });
    expect(await gate.gateView('concept', id)).toMatchObject({ blockers: [], findings: [] });
    // the FitCheck override is gone since Etappe 11 (schema rejects it)
    await expect(gate.addOverride('concept', id, { type: 'fit', key: 'no_pillar', reason: 'Ohne Prüfung freigeben' })).rejects.toThrow();
    // the script keeps the concept's pillar (no FitCheck in between)
    expect(await content.selectConceptAndWrite(id)).toMatchObject({ pillarId: 'werkstatt' });
  });

  it('an old Etappe-9 gate with „nein“ answers no longer blocks a personal concept, and nothing is left to override', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const gate = await import('@/server/services/strategyGate');
    const { write } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Wechsel', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Leim', pillarId: 'werkstatt', lengthSeconds: 15 });
    const id = concepts[0]!.id;
    await passFit(id);
    await write((db) => {
      const g = db.strategyGates.find((x) => x.subject.kind === 'concept' && x.subject.conceptId === id)!;
      Object.assign(g, { answers: answersAll('nein'), joyExpected: 'nein', withinBoundaries: 'nein', confirmedAt: null });
    });
    expect(await gate.gateView('concept', id)).toMatchObject({ blockers: [] });
    expect((await content.selectConceptAndWrite(id)).status).toBe('draft');
  });

  it('a concept from v1 writes its script after a new strategy version without any reconfirmation', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const p = await projects.createProject({ title: 'Versionen', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Routine', pillarId: 'werkstatt', lengthSeconds: 15 });
    const c = concepts[0]!;
    const { strategyVersionId: v2 } = await withPhase('public');
    expect(c.strategyVersionId).not.toBe(v2);
    const script = await content.selectConceptAndWrite(c.id);
    expect(script).toMatchObject({ status: 'draft', pillarId: 'werkstatt' });
  });

  it('publications: the script pin wins (a brief without pillar stays without), a named pillar must exist, client projects carry none', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const analytics = await import('@/server/services/analytics');
    const p = await projects.createProject({ title: 'Ohne Säule', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Pause', lengthSeconds: 15 });
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    expect(script.pillarId).toBeNull();
    // the script's „no pillar“ is final: a pillar typed into the form does not replace it
    const pub = await analytics.createPublication({ projectId: p.id, title: 'A', publishedAt: '2026-11-12', scriptVersionId: script.id, pillarId: 'alltag' });
    expect(pub).toMatchObject({ pillarId: null, strategyVersionId: script.strategyVersionId });
    // a pillar named in the form must exist in the approved strategy
    await expect(analytics.createPublication({ projectId: p.id, title: 'C', publishedAt: '2026-11-13', pillarId: 'gibtsnicht' })).rejects.toMatchObject({ status: 400 });
    expect(await analytics.createPublication({ projectId: p.id, title: 'D', publishedAt: '2026-11-13', pillarId: 'alltag' })).toMatchObject({ pillarId: 'alltag', strategyVersionId: expect.any(String) });
    // client work never carries her pillars or strategy
    const c = await projects.createProject({ title: 'Kunde 3', kind: 'UGC_CLIENT', client: { clientName: 'Garnladen', productClaims: [] } });
    expect(await analytics.createPublication({ projectId: c.id, title: 'E', publishedAt: '2026-11-13', pillarId: 'alltag' })).toMatchObject({ pillarId: null, strategyVersionId: null });
  });

  it('an override keeps its reason on the gate (Etappe 11); deleting the project removes both', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const gate = await import('@/server/services/strategyGate');
    const { read, write } = await import('@/server/store');
    // overrides exist only in client projects since Etappe 10 (the boundary lint)
    const p = await projects.createProject({ title: 'Weg damit', kind: 'UGC_CLIENT', client: { clientName: 'Garnladen', productClaims: [] } });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Feile', lengthSeconds: 15 });
    const id = concepts[0]!.id;
    await write((db) => void (db.concepts.find((x) => x.id === id)!.body.hook = 'Neu im Laden am Musterweg 12: diese Feile.'));
    const [b] = (await gate.gateView('concept', id)).blockers;
    await gate.addOverride('concept', id, { type: 'lint', fingerprint: b!.fingerprint!, reason: 'GONE-REASON-9d1b37 Probe' });
    expect((await gate.gateView('concept', id)).overrides[0]).toMatchObject({ reason: 'GONE-REASON-9d1b37 Probe' });
    expect(await dbText()).toContain('GONE-REASON-9d1b37');
    await projects.deleteProject(p.id);
    expect(await dbText()).not.toContain('GONE-REASON-9d1b37');
    expect(await read((db) => db.strategyGates.some((g) => g.projectId === p.id))).toBe(false);
  });
});

describe('pre-Etappe-9 data (D10)', () => {
  it('approved records stay approved and labelled; a legacy draft and its copy approve without any FitCheck (Etappe 10)', async () => {
    const { write, newId, now } = await import('@/server/store');
    const content = await import('@/server/services/content');
    const agents = await import('@/server/services/scriptAgents');
    const gate = await import('@/server/services/strategyGate');
    const edit = await import('@/server/services/edit');
    const projects = await import('@/server/services/projects');
    const { BriefInput } = await import('@studio/core');
    // a fresh concept/script pair from the mock, then stripped of every Etappe 9 field (as stored before)
    const p = await projects.createProject({ title: 'Alt', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Alt', pillarId: 'werkstatt', lengthSeconds: 15 });
    const fresh = await content.selectConceptAndWrite(concepts[0]!.id);
    const ids = { brief: newId(), concept: newId(), approved: newId(), draft: newId(), plan: newId() };
    const assetId = await addAsset(p.id);
    await write((db) => {
      const at = now();
      db.briefs.push({ id: ids.brief, projectId: p.id, input: BriefInput.parse({ projectId: p.id, topic: 'Alt', lengthSeconds: 15 }), createdAt: at });
      db.concepts.push({ id: ids.concept, projectId: p.id, briefId: ids.brief, agentRunId: 'old', index: 0, body: concepts[0]!.body, status: 'approved', styleBibleVersionId: null, voiceGuideVersionId: null, mock: true, createdAt: at });
      const base = { projectId: p.id, conceptId: ids.concept, parentId: null, source: 'agent' as const, agentRunId: null, promptVersion: null, body: fresh.body, styleBibleVersionId: null, voiceGuideVersionId: null, mock: true, createdAt: at };
      db.scripts.push({ ...base, id: ids.approved, version: 1, status: 'approved', approvedAt: at });
      db.scripts.push({ ...base, id: ids.draft, version: 2, status: 'draft', approvedAt: null });
      db.editPlans.push({ id: ids.plan, projectId: p.id, scriptId: ids.approved, version: 1, parentId: null, status: 'approved', body: { clips: [{ sceneIndex: 0, assetId, inSec: 0, outSec: 2 }] } as never, durationSec: 2, disclosures: [], warnings: [], clientConsentNote: null, styleBibleVersionId: null, voiceGuideVersionId: null, createdAt: at, approvedAt: at });
    });
    // approved ones stay approved and are labelled as legacy
    expect((await edit.approveEditPlan(ids.plan)).status).toBe('approved');
    expect(await gate.gateView('script', ids.approved)).toMatchObject({ legacy: true, blockers: [] });
    expect(await gate.gateView('edit_plan', ids.plan)).toMatchObject({ legacy: true });
    // the copy of the legacy-approved script: no gate, no confirmation (personal)
    const copy = await agents.runScriptAgent('copy', ids.approved);
    expect((await gate.gateView('copy', copy.id)).blockers).toEqual([]);
    expect((await agents.approveScriptOutput(copy.id, {})).status).toBe('approved');
    // the legacy draft no longer needs a FitCheck on its concept
    expect(await gate.gateView('concept', ids.concept)).toMatchObject({ legacy: true, blockers: [] });
    expect((await content.setScriptStatus(ids.draft, 'approved')).status).toBe('approved');
  });

  it('unknown gate kinds are 404', async () => {
    const gate = await import('@/server/services/strategyGate');
    await expect(gate.gateView('render', 'x')).rejects.toMatchObject({ status: 404 });
  });
});

describe('review fixes (Etappe 9)', () => {
  it('the project kind is fixed once the project has content, so a kind switch cannot skip the gate', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const p = await projects.createProject({ title: 'Typwechsel', kind: 'PERSONAL_CONTENT' });
    // an empty project may still change its kind (and back)
    expect(await projects.updateProject(p.id, { kind: 'UGC_CLIENT' })).toMatchObject({ kind: 'UGC_CLIENT', kindLocked: false });
    expect(await projects.updateProject(p.id, { kind: 'PERSONAL_CONTENT' })).toMatchObject({ kind: 'PERSONAL_CONTENT', kindLocked: false });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Hobel', pillarId: 'werkstatt', lengthSeconds: 15 });
    await expect(projects.updateProject(p.id, { kind: 'UGC_CLIENT' }))
      .rejects.toMatchObject({ status: 409, code: 'project_kind_locked', message: expect.stringMatching(/Projekttyp lässt sich nicht mehr ändern/) });
    // the same kind (the form always sends it) and other fields still save
    expect(await projects.updateProject(p.id, { kind: 'PERSONAL_CONTENT', title: 'Typwechsel (neu)' })).toMatchObject({ title: 'Typwechsel (neu)', kindLocked: true });
    expect((await projects.listProjects()).find((x) => x.id === p.id)).toMatchObject({ kind: 'PERSONAL_CONTENT', kindLocked: true });
    // still a personal project: no gate (Etappe 10), the script is written
    expect((await content.selectConceptAndWrite(concepts[0]!.id)).projectId).toBe(p.id);
    // a client project with content cannot become personal either (its pieces never had a FitCheck)
    const c = await projects.createProject({ title: 'Kunde Typ', kind: 'UGC_CLIENT', client: { clientName: 'Garnladen', productClaims: [] } });
    await content.generateConcepts({ projectId: c.id, topic: 'Garn', lengthSeconds: 15 });
    await expect(projects.updateProject(c.id, { kind: 'PERSONAL_CONTENT' })).rejects.toMatchObject({ status: 409, code: 'project_kind_locked' });
  });

  it('approvals keep the pins a piece was written with (no FitCheck re-pin any more); publications and self-checks follow', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const agents = await import('@/server/services/scriptAgents');
    const edit = await import('@/server/services/edit');
    const analytics = await import('@/server/services/analytics');
    const selfAssessment = await import('@/server/services/selfAssessment');
    const { read } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Gepinnt', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Schraubzwinge', pillarId: 'werkstatt', lengthSeconds: 15 });
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const vA = script.strategyVersionId;
    expect(vA).toEqual(expect.any(String));
    expect(script.pillarId).toBe('werkstatt');

    // a new strategy version: approving needs no reconfirmation and keeps the written pins
    const { strategyVersionId: vB } = await withPhase('public');
    expect(vB).not.toBe(vA);
    expect(await content.setScriptStatus(script.id, 'approved')).toMatchObject({ status: 'approved', strategyVersionId: vA, pillarId: 'werkstatt' });
    expect(await analytics.createPublication({ projectId: p.id, title: 'Skript', publishedAt: '2026-11-14', scriptVersionId: script.id })).toMatchObject({ strategyVersionId: vA, pillarId: 'werkstatt' });
    const copy = await agents.runScriptAgent('copy', script.id);
    expect((await agents.approveScriptOutput(copy.id, {})).status).toBe('approved');
    expect(await read((db) => db.scripts.find((x) => x.id === script.id))).toMatchObject({ strategyVersionId: vA, pillarId: 'werkstatt' });

    // a scripted plan carries the script's pins through its approval
    const assetId = await addAsset(p.id);
    const plan = await edit.saveEditPlan(p.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId, inSec: 0, outSec: 2 }] } });
    expect(await edit.approveEditPlan(plan.id)).toMatchObject({ status: 'approved', strategyVersionId: vA, pillarId: 'werkstatt' });
    expect(await analytics.createPublication({ projectId: p.id, title: 'Plan', publishedAt: '2026-11-16', editPlanId: plan.id })).toMatchObject({ strategyVersionId: vA, pillarId: 'werkstatt' });
    expect(await selfAssessment.createSelfAssessment({ subject: { kind: 'edit_plan', id: plan.id }, joy: 4, cameraComfort: 3, finished: true })).toMatchObject({ strategyVersionId: vA, pillarId: 'werkstatt' });
  });

  it('personal scripted plan: no approved script needed for approval and render; a rejected script stops it', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const edit = await import('@/server/services/edit');
    const p = await projects.createProject({ title: 'Skript-Schnitt', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Hobel', lengthSeconds: 15 });
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const assetId = await addAsset(p.id);
    const save = () => edit.saveEditPlan(p.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId, inSec: 0, outSec: 2, overlays: [{ kind: 'keyword', startSec: 0.5, endSec: 1.5, text: 'Nicht im Skript' }] }] } });
    const plan = await save();
    expect(await edit.approveEditPlan(plan.id)).toMatchObject({ status: 'approved' });
    await content.setScriptStatus(script.id, 'rejected');
    const next = await save();
    await expect(edit.approveEditPlan(next.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/verworfen/) });
    await expect(edit.startRender(plan.id, {})).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/verworfen/) });
  });

  it('Higgsfield: a newer strategy no longer blocks quote or credit approval (no FitCheck); credit approval and the job stay', async () => {
    process.env.HIGGSFIELD = 'mock';
    process.env.HIGGSFIELD_MONTHLY_CREDITS = '2000';
    const hf = await import('@/server/higgsfield');
    hf.setHiggsfieldAdapter(hf.mockAdapter({ pollMs: 20 }));
    try {
      const projects = await import('@/server/services/projects');
      const content = await import('@/server/services/content');
      const agents = await import('@/server/services/scriptAgents');
      const g = await import('@/server/services/generations');
      const { getJob } = await import('@/server/services/videoJobs');
      const { read, write } = await import('@/server/store');
      const p = await projects.createProject({ title: 'B-Roll Gate', kind: 'PERSONAL_CONTENT' });
      const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Späne', pillarId: 'werkstatt', lengthSeconds: 15 });
      const script = await content.selectConceptAndWrite(concepts[0]!.id);
      await write((db) => void (db.scripts.find((x) => x.id === script.id)!.body.scenes[0]!.shotType = 'b_roll'));
      // paid B-roll still needs an approved script (one click, no checkbox, in personal projects)
      await content.setScriptStatus(script.id, 'approved');
      const board = await agents.runScriptAgent('storyboard', script.id);
      await write((db) => {
        const b = db.scriptOutputs.find((o) => o.id === board.id)!;
        if (b.kind !== 'storyboard') throw new Error('kind');
        b.output.aiAssetBriefs = [{ sceneIndex: 0, purpose: 'Stimmung', prompt: 'Holzspäne im Gegenlicht über der Werkbank', disclosureLabel: 'KI-generierte Bildelemente', requiresApproval: true as const, clientApprovalRequired: false }];
      });
      expect((await agents.approveScriptOutput(board.id, { confirmed: true })).status).toBe('approved');
      await g.setAiBroll(p.id, { enabled: true, creditBudget: 100 });
      const quote = () => g.quoteGeneration(p.id, { storyboardId: board.id, briefIndex: 0, model: 'seedance_2_5', durationSec: 5 });

      // a quote made under the old strategy, then a new strategy is approved: nothing to reconfirm
      const q = await quote();
      await withPhase('public');
      expect((await g.getAiBrollState(p.id)).briefs[0]!.blocked).toBeNull();
      const q2 = await quote();
      expect(q2.quotedCredits).toBe(q.quotedCredits);
      // the credit approval per clip is still required and goes through (the submit runs the same `briefOf` check)
      const { job } = await g.approveGeneration(q2.id, { approvedMaxCredits: q2.quotedCredits });
      let j = await getJob(job.id);
      for (let i = 0; i < 600 && (j.status === 'queued' || j.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 50));
        j = await getJob(job.id);
      }
      expect(j.status).toBe('succeeded');
      expect(await read((db) => db.generations.find((x) => x.id === q2.id)!.submittedAt)).not.toBeNull();
    } finally {
      hf.setHiggsfieldAdapter(null);
      delete process.env.HIGGSFIELD;
      delete process.env.HIGGSFIELD_MONTHLY_CREDITS;
    }
  }, 60_000);
});

/**
 * Review fix (Etappe 10): an old Etappe-9 FitCheck gate (answered against an older strategy) must never pull a
 * personal record back to that strategy version or pillar on approval, and a script is written with the active context.
 */
describe('review fixes (Etappe 10): old gates never re-pin personal records', () => {
  const oldGate = (projectId: string, subject: { kind: 'concept'; conceptId: string } | { kind: 'free_cut'; rootPlanId: string }, strategyVersionId: string, pillarId: string) => {
    const at = new Date().toISOString();
    return {
      id: `old-gate-${Math.random().toString(36).slice(2)}`, projectId, subject, strategyVersionId, pillarId,
      answers: [{ criterionId: 'werkstatt-f1', answer: 'ja' as const }], joyExpected: 'ja' as const, withinBoundaries: 'ja' as const, confirmedAt: at,
      fitOverrides: [], lintOverrides: [], history: [], createdAt: at, updatedAt: at,
    };
  };

  it('free cut with an old gate (v2), strategy v3 active: rendering approves the plan and it stays on v3', async () => {
    const projects = await import('@/server/services/projects');
    const edit = await import('@/server/services/edit');
    const { read, write } = await import('@/server/store');
    const { strategyVersionId: v2 } = await withPhase('public');
    const { strategyVersionId: v3 } = await withPhase('public');
    const p = await projects.createProject({ title: 'Frei mit altem Gate', kind: 'PERSONAL_CONTENT' });
    const assetId = await uploadClip(p.id);
    const plan = await edit.saveEditPlan(p.id, { scriptId: null, body: { clips: [{ assetId, inSec: 0, outSec: 2 }], loudness: 'off', subtitles: 'off' } });
    expect(plan).toMatchObject({ strategyVersionId: v3, pillarId: null });
    await write((db) => void db.strategyGates.push(oldGate(p.id, { kind: 'free_cut', rootPlanId: plan.id }, v2, 'alltag')));

    const { job } = await edit.startRender(plan.id, {});
    expect(await read((db) => db.editPlans.find((x) => x.id === plan.id))).toMatchObject({ status: 'approved', strategyVersionId: v3, pillarId: null });
    expect(await waitJob(job.id)).toMatchObject({ status: 'succeeded' });
  }, 180000);

  it('script from a concept with an old gate: active strategy, the concept\'s pillar; approvals of script, copy and plan keep them', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const agents = await import('@/server/services/scriptAgents');
    const edit = await import('@/server/services/edit');
    const s = await import('@/server/services/strategy');
    const { read, write } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Konzept mit altem Gate', kind: 'PERSONAL_CONTENT' });
    const { strategyVersionId: v2 } = await withPhase('public');
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Hobelbank', pillarId: 'werkstatt', lengthSeconds: 15 });
    const c0 = concepts[0]!;
    expect(c0).toMatchObject({ strategyVersionId: v2, pillarId: 'werkstatt' });
    await write((db) => void db.strategyGates.push(oldGate(p.id, { kind: 'concept', conceptId: c0.id }, v2, 'alltag')));
    const { strategyVersionId: v3 } = await withPhase('public');

    // the preview shows what the request carries: the active strategy v3, not the gate's v2
    const preview = await s.aiPreview({ conceptId: c0.id });
    const v3Number = await read((db) => db.contextVersions.find((v) => v.id === v3)!.version);
    expect(JSON.parse(preview.text).strategy.version).toBe(v3Number);

    const script = await content.selectConceptAndWrite(c0.id);
    expect(script).toMatchObject({ strategyVersionId: v3, pillarId: 'werkstatt' });
    const run = await read((db) => db.agentRuns.find((r) => r.id === script.agentRunId)!);
    expect(run.strategyVersionId).toBe(v3);

    expect(await content.setScriptStatus(script.id, 'approved')).toMatchObject({ status: 'approved', strategyVersionId: v3, pillarId: 'werkstatt' });
    const copy = await agents.runScriptAgent('copy', script.id);
    await agents.approveScriptOutput(copy.id, {});
    expect(await read((db) => db.scripts.find((x) => x.id === script.id))).toMatchObject({ strategyVersionId: v3, pillarId: 'werkstatt' });
    const assetId = await addAsset(p.id);
    const plan = await edit.saveEditPlan(p.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId, inSec: 0, outSec: 2 }] } });
    expect(await edit.approveEditPlan(plan.id)).toMatchObject({ status: 'approved', strategyVersionId: v3, pillarId: 'werkstatt' });
  });

  it('a concept pillar the active strategy no longer knows is written as „keine Säule“', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const { write } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Verschwundene Säule', kind: 'PERSONAL_CONTENT' });
    const { concepts } = await content.generateConcepts({ projectId: p.id, topic: 'Leim', pillarId: 'werkstatt', lengthSeconds: 15 });
    await write((db) => void (db.concepts.find((x) => x.id === concepts[0]!.id)!.pillarId = 'gibtsnicht-mehr'));
    expect(await content.selectConceptAndWrite(concepts[0]!.id)).toMatchObject({ pillarId: null });
  });
});
