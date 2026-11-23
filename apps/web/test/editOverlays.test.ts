import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

/** Etappe 8, part 3: text hook, graphic overlays and the look, through the service gates. */
const run = promisify(execFile);
let dir: string;
let ff: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-overlays-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
  await seedApprovedStrategy();
  ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 240000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A personal project with one 4 s take and (optionally) a transcript of her words. */
async function setup(transcript?: string) {
  const projects = await import('@/server/services/projects');
  const footage = await import('@/server/services/footage');
  const { write, newId, now } = await import('@/server/store');
  const project = await projects.createProject({ title: 'Overlays', kind: 'PERSONAL_CONTENT' });
  const file = path.join(dir, `take-${project.id}.mp4`);
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file]);
  const clip = await footage.uploadFootage(project.id, new Blob([await readFile(file)]).stream(), { name: 'take.mp4', origin: 'own', rightsConfirmed: true }, null);
  const assetId = clip.asset.id;
  await write((db) => {
    const x = db.mediaAssets.find((m) => m.id === assetId)!;
    x.probe ??= { durationSec: 4, width: null, height: null, rotation: 0, displayWidth: null, displayHeight: null, orientation: null, fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' };
    x.status = 'probed';
  });
  if (transcript) {
    const id = newId();
    const storagePath = `transcripts/${project.id}/${id}.json`;
    await mkdir(path.join(dir, path.dirname(storagePath)), { recursive: true });
    await writeFile(path.join(dir, storagePath), JSON.stringify({ language: 'de', segments: [{ startSec: 0, endSec: 4, text: transcript, words: [] }] }));
    await write((db) => { db.transcripts.push({ id, projectId: project.id, assetId, version: 1, parentId: null, source: 'whisper', model: 'test', language: 'de', storagePath, segmentCount: 1, createdAt: now(), fillerPrompt: true }); });
  }
  return { project, assetId };
}

describe('hook, overlays and look through the service', () => {
  it('Etappe 10: a free hook and free overlay text without a checkbox; claims are hints, a denied label stays an error', async () => {
    const edit = await import('@/server/services/edit');
    const { project, assetId } = await setup('Ähm, heute färbe ich Wolle mit Zwiebelschalen.');
    const body = (x: Record<string, unknown>) => ({ clips: [{ assetId, inSec: 0, outSec: 4, ...x }] });
    const figures = await edit.saveEditPlan(project.id, { scriptId: null, body: { ...body({}), hook: { source: 'free', text: 'In 3 Tagen 50 % mehr Follower' } } });
    expect(figures.warnings.join(' ')).toMatch(/Zahlen im Hook ohne verifizierten Claim/);
    expect((await edit.saveEditPlan(project.id, { scriptId: null, body: { ...body({}), hook: { source: 'free', text: 'So färbe ich Wolle' } } })).body.hook).toMatchObject({ text: 'So färbe ich Wolle', slot: 'upper' });
    // overlay text that is not in the transcript (and a take without any transcript) is saved
    const free = await edit.saveEditPlan(project.id, { scriptId: null, body: body({ overlays: [{ kind: 'lower_third', startSec: 0.5, endSec: 2, text: 'Das beste Färbemittel' }] }) });
    expect(free.body.clips[0]!.overlays[0]).toMatchObject({ text: 'Das beste Färbemittel' });
    await expect(edit.saveEditPlan(project.id, { scriptId: null, body: body({ overlays: [{ kind: 'keyword', startSec: 0.5, endSec: 2, text: 'keine Werbung' }] }) }))
      .rejects.toThrow(/bestreitet eine Kennzeichnung/);
    const ok = await edit.saveEditPlan(project.id, { scriptId: null, body: { ...body({ overlays: [{ kind: 'lower_third', startSec: 0.5, endSec: 2, text: 'Wolle mit Zwiebelschalen', slot: 'lower' }] }), hook: { source: 'free', text: 'So färbe ich Wolle', claimsReviewed: true, slot: 'upper' }, look: { font: 'Futura' } } });
    expect(ok.body.hook).toMatchObject({ source: 'free', text: 'So färbe ich Wolle' });
    expect(ok.body.look.font).toBe('Futura');
    // an unknown font is refused: only the allow-list of system fonts
    await expect(edit.saveEditPlan(project.id, { scriptId: null, body: { ...body({}), look: { font: 'Comic Sans MS' } } })).rejects.toThrow();
    // a flagged claim of any script in the project is a hint on a free hook
    const { write } = await import('@/server/store');
    await write((db) => { db.scripts.push({ id: 'flagged-script', projectId: project.id, body: { claimsToVerify: ['färbt in 5 Minuten'], verifiedClaims: [], scenes: [], hookVariants: [], selectedHook: '', cta: '' } } as never); });
    const flagged = await edit.saveEditPlan(project.id, { scriptId: null, body: { ...body({}), hook: { source: 'free', text: 'Wolle färbt in 5 Minuten' } } });
    expect(flagged.warnings.join(' ')).toMatch(/Ungeprüfte Claims im Hook/);
    await write((db) => { db.scripts = db.scripts.filter((s) => s.id !== 'flagged-script'); });
  });

  it('takes a scripted hook only as an exact reference to the script; personal overlays are free text', async () => {
    const edit = await import('@/server/services/edit');
    const content = await import('@/server/services/content');
    const { project, assetId } = await setup();
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Wolle färben', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const clip = { sceneIndex: 0, assetId, inSec: 0, outSec: 4 };
    await expect(edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [clip], hook: { source: 'free', text: 'Eigener Text', claimsReviewed: true } } })).rejects.toThrow(/Hook aus dem Skript/);
    const plan = await edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [clip], hook: { source: 'selected', text: 'manipuliert' } } });
    expect(plan.body.hook!.text).toBe(script.body.selectedHook.replace(/\s+/g, ' ').trim());
    const words = script.body.scenes[0]!.dialogue.split(/\s+/).slice(0, 2).join(' ');
    const withQuote = await edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ ...clip, overlays: [{ kind: 'keyword', startSec: 1, endSec: 2, text: words.slice(0, 30) }] }] } });
    expect(withQuote.body.clips[0]!.overlays).toHaveLength(1);
    // Etappe 10: personal: text that is not in the script is fine (client projects keep the quote rule, core overlays.test.ts)
    const own = await edit.saveEditPlan(project.id, { scriptId: script.id, body: { clips: [{ ...clip, overlays: [{ kind: 'keyword', startSec: 1, endSec: 2, text: 'Mein eigener Text' }] }] } });
    expect(own.body.clips[0]!.overlays[0]).toMatchObject({ text: 'Mein eigener Text' });
  });

  it('resolves the look from the PINNED Style Bible version, also after a newer one is approved, and lists it in the state', async () => {
    const edit = await import('@/server/services/edit');
    const { write } = await import('@/server/store');
    const { project, assetId } = await setup('Heute färbe ich Wolle.');
    const rules = (palette: string[]) => ({ visual: { palette } }) as never;
    await write((db) => {
      db.styleBibles.push({ id: 'sb-old', profileId: project.profileId, version: 1, status: 'approved', rules: rules(['#C8553D', '#20302A']), createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
    });
    const plan = await edit.saveEditPlan(project.id, { scriptId: null, body: { clips: [{ assetId, inSec: 0, outSec: 4, overlays: [{ kind: 'arrow', startSec: 1, endSec: 2 }] }] } });
    expect(plan.styleBibleVersionId).toBe('sb-old');
    await write((db) => {
      const old = db.styleBibles.find((x) => x.id === 'sb-old')!;
      old.status = 'archived'; // still once approved: its colours stay valid for plans that pinned it
      db.styleBibles.push({ id: 'sb-new', profileId: project.profileId, version: 2, status: 'approved', rules: rules(['#00FF00']), createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
      db.styleBibles.push({ id: 'sb-draft', profileId: project.profileId, version: 3, status: 'draft', rules: rules(['#0000FF']), createdAt: new Date().toISOString(), approvedAt: null });
    });
    const state = await edit.getEditState(project.id);
    expect(state.plans.find((p) => p.id === plan.id)!.look).toMatchObject({ source: 'style_bible', styleBibleVersionId: 'sb-old', accent: '#C8553D' });
    expect(state.freeLook).toMatchObject({ source: 'style_bible', styleBibleVersionId: 'sb-new' }); // drafts are never used
    expect(typeof state.capabilities.overlays).toBe('boolean');
    await write((db) => { db.styleBibles = db.styleBibles.filter((x) => !x.id.startsWith('sb-')); });
    expect((await edit.getEditState(project.id)).plans.find((p) => p.id === plan.id)!.look).toMatchObject({ source: 'placeholder' });
  });

  it('gates the render on libass: 409 with a clear reason without it; with it renders and snapshots the look', async () => {
    const edit = await import('@/server/services/edit');
    const { ffmpegStatus } = await import('@/server/ffmpeg');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const { project, assetId } = await setup('Heute färbe ich Wolle mit Zwiebelschalen.');
    const plan = await edit.saveEditPlan(project.id, { scriptId: null, body: {
      clips: [{ assetId, inSec: 0, outSec: 4, cuts: [{ startSec: 1, endSec: 1.4 }], overlays: [{ kind: 'keyword', startSec: 0.5, endSec: 3, text: 'Zwiebelschalen', slot: 'lower' }, { kind: 'frame', startSec: 2, endSec: 4 }] }],
      hook: { source: 'free', text: 'So färbe ich Wolle', claimsReviewed: true, slot: 'upper' }, loudness: 'off',
    } });
    await passFit(plan.id, 'edit_plan');
    await edit.approveEditPlan(plan.id);
    if (!(await ffmpegStatus()).subtitles) {
      console.log('[libass] FFmpeg without the subtitles filter (libass): the hook/overlay render is skipped, only the 409 gate is checked');
      await expect(edit.startRender(plan.id, {})).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Text-Hook und Grafik-Overlays.*libass/) });
      return;
    }
    const { job, render } = await edit.startRender(plan.id, {});
    expect(render!.look).toMatchObject({ source: 'placeholder', font: 'Avenir Next' });
    const done = await until(() => getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running');
    expect(done.error).toBeNull();
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    console.log(`[libass] hook/overlay render done; font warnings: ${JSON.stringify(r.look?.warnings ?? [])}`);
    expect(r.status).toBe('pending_review');
    // real libass: the bold hook in Avenir Next must not come out in the italic face (CoreText picked BoldItalic)
    expect(r.look?.warnings ?? []).not.toContainEqual(expect.stringMatching(/kursiv/));
    expect((await edit.reviewRender(r.id, { decision: 'approve' })).render.status).toBe('approved');
  });

  it('refuses render approval when the look changed since the render', async () => {
    const edit = await import('@/server/services/edit');
    const { write, newId, now } = await import('@/server/store');
    const { project, assetId } = await setup();
    const plan = await edit.saveEditPlan(project.id, { scriptId: null, body: { clips: [{ assetId, inSec: 0, outSec: 4, overlays: [{ kind: 'arrow', startSec: 1, endSec: 2 }] }] } });
    await passFit(plan.id, 'edit_plan');
    await edit.approveEditPlan(plan.id);
    // a finished render whose snapshot shows other colours than the plan resolves to now
    const id = newId();
    await write((db) => {
      db.renders.push({ id, projectId: project.id, editPlanId: plan.id, jobId: 'j', status: 'pending_review', storagePath: 'renders/x.mp4', size: 1, sha256: null, durationSec: 4, loudness: null, disclosures: [], error: null, reviewNote: '', createdAt: now(), finishedAt: now(), reviewedAt: null,
        look: { source: 'style_bible', styleBibleVersionId: 'gone', version: 1, label: 'x', font: 'Avenir Next', accent: '#FF0000', box: '#000000', text: '#FFFFFF', warnings: [] } });
    });
    await expect(edit.reviewRender(id, { decision: 'approve' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Look/) });
  });
});
