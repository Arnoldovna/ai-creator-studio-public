import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Etappe 17, QA „fehlende Wörter“: the render job's audio goes through FFmpeg (real) and whisper.cpp (stubbed here: it
 * „hears“ every word but one); the comparison with the words kept in the cut finds the missing one, at the cut, with its
 * output time. Nothing in the draft changes.
 */
const heard = { words: ['Heute', 'färbe', 'ich', 'Wolle', 'Zwiebelschalen', 'und', 'Essig.'], wav: '' };
vi.mock('@/server/whisper', async (orig) => {
  const real = await orig<typeof import('@/server/whisper')>();
  return {
    ...real,
    whisperStatus: async () => ({ mode: 'whisper' as const, available: true, cli: '/x/whisper-cli', model: '/x/ggml-test.bin', reason: null }),
    runWhisper: async (wav: string, outBase: string) => {
      heard.wav = wav;
      // whisper.cpp -ojf shape: one segment, one token per word (leading space = new word)
      const tokens = heard.words.map((w, i) => ({ text: ` ${w}`, offsets: { from: i * 400, to: i * 400 + 350 } }));
      await writeFile(`${outBase}.json`, JSON.stringify({ result: { language: 'de' }, transcription: [{ offsets: { from: 0, to: 3000 }, text: heard.words.join(' '), tokens }] }), 'utf8'); // whisper writes UTF-8 bytes
      return { jsonPath: `${outBase}.json`, model: 'ggml-test.bin', fillerPrompt: false, dtw: false };
    },
  };
});

const run = promisify(execFile);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-finish-qa-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1', STUDIO_DEFAULTS_DIR: 'off' });
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 120000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('QA „fehlende Wörter“ (FFmpeg real, whisper stubbed)', () => {
  it('re-transcribes the render, finds the word missing after the cut, stores the finding with its output time', async () => {
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const drafts = await import('@/server/services/editDraft');
    const fin = await import('@/server/services/finish');
    const { getJob } = await import('@/server/worker');
    const { write, read, now } = await import('@/server/store');
    const ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
    const project = await projects.createProject({ title: 'QA', kind: 'PERSONAL_CONTENT' });
    const take = path.join(dir, 'take.mp4');
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3C9E47:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', take]);
    const { asset } = await footage.uploadFootage(project.id, new Blob([await readFile(take)]).stream(), { name: 'take.mp4', origin: 'own', rightsConfirmed: true }, null);
    const words = ['Heute', 'färbe', 'ich', 'Wolle', 'mit', 'Zwiebelschalen', 'und', 'Essig.'].map((text, i) => ({ startSec: 0.2 + i * 0.45, endSec: 0.2 + i * 0.45 + 0.4, text }));
    const storagePath = `transcripts/${project.id}/t1.json`;
    await mkdir(path.join(dir, 'transcripts', project.id), { recursive: true });
    await writeFile(path.join(dir, storagePath), JSON.stringify({ language: 'de', segments: [{ startSec: 0, endSec: 4, text: words.map((w) => w.text).join(' '), words }] }), 'utf8');
    await write((db) => { db.transcripts.push({ id: 't1', projectId: project.id, assetId: asset.id, version: 1, parentId: null, source: 'whisper', model: 'test', language: 'de', storagePath, segmentCount: 1, createdAt: now() }); });

    const v = await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body: { clips: [{ assetId: asset.id, inSec: 0, outSec: 4, cuts: [{ startSec: 1.55, endSec: 2.05 }] }], loudness: 'off' } });
    const out = await drafts.renderEditDraft(project.id, { scriptId: null, revision: v.draft!.revision });
    expect((await until(() => getJob(out.job!.id), (j) => j.status === 'succeeded' || j.status === 'failed')).error).toBeNull();
    const before = await read((db) => db.editDrafts.find((d) => d.projectId === project.id)!.revision);

    expect((await fin.getFinishState(out.render!.id)).qa).toMatchObject({ available: true, reason: null, result: null });
    const { job } = await fin.startRenderQa(out.render!.id);
    const done = await until(() => getJob(job!.id), (j) => j.status === 'succeeded' || j.status === 'failed');
    expect(done.error).toBeNull();
    expect(heard.wav.endsWith('render.wav')).toBe(true);
    const state = await fin.getFinishState(out.render!.id);
    // „Wolle“ (middle inside the cut) is not expected; the stub still „hears“ it (an extra word is ignored)
    expect(state.qa.result).toMatchObject({ expected: 7, recognized: 7, matched: 6, model: 'ggml-test.bin', skippedClips: [] });
    // „mit“: source 2.0–2.4 (its middle after the cut), output 47/30 s ≈ 1.567 s, right at the cut
    expect(state.qa.result!.findings).toEqual([{ text: 'mit', startSec: 1.567, endSec: 1.917, words: 1, atCut: true }]);
    // no auto-fix: the draft is unchanged
    expect(await read((db) => db.editDrafts.find((d) => d.projectId === project.id)!.revision)).toBe(before);
  });
});
