import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtures } from '../../../scripts/make-video-fixtures.mjs';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

const run = promisify(execFile);
let dir: string;
let fixtures: Record<string, string> = {};
let probeBin: string | null = null;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-probe-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock' });
  await seedApprovedStrategy();
  const ff = await import('@/server/ffmpeg');
  probeBin = await ff.ffprobePath();
  if (!probeBin) return;
  const files = makeFixtures(path.join(dir, 'fx'), (await ff.ffmpegPath())!);
  fixtures = Object.fromEntries(files.map((f) => [path.basename(f), f]));
}, 120_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

const upload = async (projectId: string, file: string) => {
  const footage = await import('@/server/services/footage');
  return footage.uploadFootage(projectId, new Blob([await readFile(fixtures[file]!)]).stream(), { name: file, origin: 'own', rightsConfirmed: true }, null);
};

/** Needs a system ffprobe (Homebrew); skipped where none is installed. */
describe.skipIf(!process.env.FFPROBE_PATH && !['/usr/local/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/bin/ffprobe'].some((p) => existsSync(p)))('real ffprobe on uploaded footage', () => {
  it('reads duration, rotation and audio, and renders an upright phone clip as portrait', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const edit = await import('@/server/services/edit');
    const { getJob } = await import('@/server/services/videoJobs');
    const p = await projects.createProject({ title: 'Probe', kind: 'PERSONAL_CONTENT' });

    const land = await upload(p.id, 'landscape.mp4');
    expect(land.asset).toMatchObject({ status: 'probed', probe: { rotation: 0, displayWidth: 640, displayHeight: 360, orientation: 'landscape', hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', fps: 30 } });
    expect(land.asset.probe!.durationSec).toBeCloseTo(3, 1);
    const rot = await upload(p.id, 'portrait-rotated.mp4');
    expect(rot.asset.probe).toMatchObject({ rotation: 90, width: 640, height: 360, displayWidth: 360, displayHeight: 640, orientation: 'portrait' });
    const silent = await upload(p.id, 'silent.mp4');
    expect(silent.asset.probe).toMatchObject({ hasAudio: false, audioCodec: null });
    const audio = await upload(p.id, 'audio-only.mp4');
    expect(audio.asset.probe).toMatchObject({ videoCodec: null, width: null, hasAudio: true });

    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: p.id, topic: 'Wolle färben', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    // audio-only footage is refused when the EDL is saved, not later in FFmpeg
    await expect(edit.saveEditPlan(p.id, { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId: audio.asset.id, inSec: 0, outSec: 1 }] } })).rejects.toThrow(/ohne Videospur/);
    const plan = await edit.saveEditPlan(p.id, { scriptId: script.id, body: { clips: [
      { sceneIndex: 0, assetId: rot.asset.id, inSec: 0, outSec: 1.5 },
      { sceneIndex: 1, assetId: silent.asset.id, inSec: 0.5, outSec: 2 },
    ] } });
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    await edit.approveEditPlan(plan.id);
    const { job, render } = await edit.startRender(plan.id, {});
    for (let i = 0; i < 600 && ['queued', 'running'].includes((await getJob(job.id)).status); i++) await new Promise((r) => setTimeout(r, 100));
    expect((await getJob(job.id)).status).toBe('succeeded');
    const { read } = await import('@/server/store');
    const r = await read((db) => db.renders.find((x) => x.id === render!.id)!);
    // the rendered file, read back with ffprobe: portrait 1080x1920 without rotation metadata, 3 s
    const { stdout } = await run(probeBin!, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path.join(dir, r.storagePath!)]);
    const { parseProbe } = await import('@studio/core');
    expect(parseProbe(stdout)).toMatchObject({ width: 1080, height: 1920, rotation: 0, orientation: 'portrait', fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true });
    expect(parseProbe(stdout).durationSec).toBeCloseTo(3, 1);
  });
});
