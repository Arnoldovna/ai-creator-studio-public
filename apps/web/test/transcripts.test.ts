import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtures } from '../../../scripts/make-video-fixtures.mjs';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

let dir: string;
let landscape: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-transcripts-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', TRANSCRIPTION: 'mock' });
  await seedApprovedStrategy();
  const ff = await import('@/server/ffmpeg');
  landscape = makeFixtures(path.join(dir, 'fx'), (await ff.ffmpegPath())!).find((f) => f.endsWith('landscape.mp4'))!;
}, 120_000);
afterAll(async () => {
  delete process.env.TRANSCRIPTION;
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) => access(p).then(() => true, () => false);
async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 60000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Transcripts, corrections and take suggestions (Release 3, Etappe 5)', () => {
  it('transcribes in the background (labelled mock), versions corrections, suggests takes and cascades on delete', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const footage = await import('@/server/services/footage');
    const tr = await import('@/server/services/transcripts');
    const edit = await import('@/server/services/edit');
    const { getJob } = await import('@/server/services/videoJobs');
    const { ffmpegStatus } = await import('@/server/ffmpeg');
    const { read, write } = await import('@/server/store');

    const p = await projects.createProject({ title: 'Färben', kind: 'PERSONAL_CONTENT' });
    const { asset } = await footage.uploadFootage(p.id, new Blob([await readFile(landscape)]).stream(), { name: 'take.mp4', origin: 'own', rightsConfirmed: true }, null);
    await write((db) => {
      const a = db.mediaAssets.find((x) => x.id === asset.id)!;
      a.probe ??= { durationSec: 3, width: 640, height: 360, rotation: 0, displayWidth: 640, displayHeight: 360, orientation: 'landscape', fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' };
    });

    const { job } = await tr.startTranscription(asset.id);
    await expect(tr.startTranscription(asset.id)).rejects.toMatchObject({ status: 409 }); // one job per clip at a time
    expect((await until(() => getJob(job.id), (j) => j.status !== 'queued' && j.status !== 'running')).status).toBe('succeeded');
    const t1 = (await tr.getTranscript(asset.id))!;
    expect(t1).toMatchObject({ version: 1, source: 'mock', model: null });
    expect(t1.body.segments[0]!.text).toMatch(/^MOCK-Transkript/);
    expect((await footage.listFootage(p.id)).items[0]).toMatchObject({ transcribing: false, transcript: { version: 1 } });
    // the store keeps a reference only; the text lives in the transcripts folder
    expect(JSON.stringify(await read((db) => db.transcripts))).not.toContain('MOCK-Transkript');

    // the user corrects the transcript with what was actually said
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: p.id, topic: 'Wolle färben', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const dialogue = script.body.scenes[0]!.dialogue;
    expect(dialogue.length).toBeGreaterThan(5);
    const texts = t1.body.segments.map((s, i) => (i === 0 ? dialogue : s.text));
    const t2 = await tr.saveTranscriptEdit(t1.id, { texts });
    expect(t2).toMatchObject({ version: 2, parentId: t1.id, source: 'mock' }); // a corrected mock stays labelled as mock
    expect(t2.body.segments[0]).toMatchObject({ text: dialogue.replace(/\s+/g, ' ').trim(), words: [] });
    await expect(tr.saveTranscriptEdit(t1.id, { texts })).rejects.toMatchObject({ status: 409 }); // stale base version
    await expect(tr.saveTranscriptEdit(t2.id, { texts: ['nur eins', 'zu', 'viele', 'x', 'y', 'z', 'w'] })).rejects.toThrow();

    // take suggestions: scene 1 is found in the corrected transcript (text match only)
    const s = await tr.suggestTakes(p.id, script.id);
    expect(s).toMatchObject({ transcribedClips: 1, mock: true });
    expect(s.scenes[0]!.candidates[0]).toMatchObject({ assetId: asset.id, inSec: 0 });
    expect(s.scenes[0]!.candidates[0]!.score).toBeGreaterThan(0.9);
    expect(s.scenes[0]!.candidates[0]!.outSec).toBeLessThanOrEqual(3);

    // subtitles: burning needs libass; without it the render is refused with a clear reason
    const plan = await edit.saveEditPlan(p.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, ...s.scenes[0]!.candidates[0]!, subtitle: '' }], subtitles: 'burn', loudness: 'off' } });
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    await edit.approveEditPlan(plan.id);
    if (!(await ffmpegStatus()).subtitles) {
      await expect(edit.startRender(plan.id, {})).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/libass/) });
    } else {
      const r = await edit.startRender(plan.id, {});
      expect((await until(() => getJob(r.job.id), (j) => j.status !== 'queued' && j.status !== 'running')).status).toBe('succeeded');
    }

    // deleting the footage is blocked by the approved plan; deleting the project removes transcripts and files
    await expect(footage.deleteFootage(asset.id)).rejects.toMatchObject({ status: 409 });
    const files = await read((db) => db.transcripts.map((t) => path.join(dir, t.storagePath)));
    expect(await Promise.all(files.map(exists))).toEqual([true, true]);
    await projects.deleteProject(p.id);
    expect(await read((db) => db.transcripts.length)).toBe(0);
    expect(await Promise.all(files.map(exists))).toEqual([false, false]);
  });

  it('deleting footage removes its transcripts', async () => {
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const tr = await import('@/server/services/transcripts');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Kurz', kind: 'PERSONAL_CONTENT' });
    const { asset } = await footage.uploadFootage(p.id, new Blob([await readFile(landscape)]).stream(), { name: 'b.mp4', origin: 'own', rightsConfirmed: true }, null);
    const { job } = await tr.startTranscription(asset.id);
    await until(() => getJob(job.id), (j) => j.status === 'succeeded');
    const file = await read((db) => path.join(dir, db.transcripts.find((t) => t.assetId === asset.id)!.storagePath));
    expect(await exists(file)).toBe(true);
    await footage.deleteFootage(asset.id);
    expect(await exists(file)).toBe(false);
    expect(await read((db) => db.transcripts.filter((t) => t.assetId === asset.id))).toEqual([]);
    await expect(tr.getTranscript(asset.id)).rejects.toMatchObject({ status: 404 });
  });
});
