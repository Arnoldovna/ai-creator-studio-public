import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtures } from '../../../scripts/make-video-fixtures.mjs';

/**
 * Etappe 17, QA „fehlende Wörter“ with REAL whisper.cpp on the synthetic German fixture (macOS `say -v Anna`): the take is
 * transcribed, rendered and the render transcribed again. A plain cut gives no false alarm; a cut through the first part of
 * a word is logged (whether whisper still hears the word is up to the model, so it is reported, not asserted).
 * Opt-in (`WHISPER_REAL=1`, takes minutes on CPU); skipped without whisper-cli, model or `say`.
 */
const run = promisify(execFile);
const enabled = process.env.WHISPER_REAL === '1';
let dir: string;
let take: string | null = null;
let ready = false;
beforeAll(async () => {
  if (!enabled) return;
  dir = await mkdtemp(path.join(tmpdir(), 'studio-whisper-qa-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, TRANSCRIPTION: 'whisper', AI_PROVIDER: 'mock', VIDEO_WORKER_CONCURRENCY: '1' });
  const ff = await (await import('@/server/ffmpeg')).ffmpegPath();
  const wav = ff ? makeFixtures(path.join(dir, 'fx'), ff).find((f: string) => f.endsWith('speech-de.wav')) : null;
  if (ff && wav && existsSync(wav)) {
    take = path.join(dir, 'speech.mp4');
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3C9E47:s=640x360:r=30', '-i', wav, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', take]);
  }
  ready = (await (await import('@/server/whisper')).whisperStatus()).available;
}, 120_000);
afterAll(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined));

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 600_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.runIf(enabled)('QA „fehlende Wörter“ with real whisper.cpp', () => {
  it('no false alarm on a plain cut; a cut into a word is reported (logged)', { timeout: 900_000 }, async (ctx) => {
    if (!ready || !take) ctx.skip();
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const transcripts = await import('@/server/services/transcripts');
    const drafts = await import('@/server/services/editDraft');
    const fin = await import('@/server/services/finish');
    const { getJob } = await import('@/server/worker');
    const { read } = await import('@/server/store');
    const { transcriptWords } = await import('@studio/core');
    const project = await projects.createProject({ title: 'QA echt', kind: 'PERSONAL_CONTENT' });
    const { asset } = await footage.uploadFootage(project.id, new Blob([await readFile(take!)]).stream(), { name: 'speech.mp4', origin: 'own', rightsConfirmed: true }, null);
    const tj = await transcripts.startTranscription(asset.id);
    expect((await until(() => getJob(tj.job.id), (j) => j.status === 'succeeded' || j.status === 'failed')).error).toBeNull();
    const t = await read((db) => transcripts.latestTranscript(db, asset.id)!);
    const words = transcriptWords(await transcripts.readTranscriptBody(t));
    const dur = asset.probe!.durationSec!;

    const qaOf = async (revision: number, body: unknown) => {
      const v = await drafts.putEditDraft(project.id, { scriptId: null, revision, body });
      const out = await drafts.renderEditDraft(project.id, { scriptId: null, revision: v.draft!.revision });
      expect((await until(() => getJob(out.job!.id), (j) => j.status === 'succeeded' || j.status === 'failed')).error).toBeNull();
      const { job } = await fin.startRenderQa(out.render!.id);
      expect((await until(() => getJob(job!.id), (j) => j.status === 'succeeded' || j.status === 'failed')).error).toBeNull();
      return { qa: (await fin.getFinishState(out.render!.id)).qa.result!, revision: v.draft!.revision };
    };
    const plain = await qaOf(0, { clips: [{ assetId: asset.id, inSec: 0, outSec: dur }], loudness: 'off' });
    console.info(`[qa echt] ohne Schnitt: ${plain.qa.matched}/${plain.qa.expected} erkannt, Funde: ${JSON.stringify(plain.qa.findings)}`);
    expect(plain.qa.expected).toBeGreaterThan(20);
    expect(plain.qa.findings.length).toBeLessThanOrEqual(1);

    // a cut through the first 45 % of a longer word in the middle („lauwarmem“ or the longest one): the word stays
    // expected (its middle is kept), its start is gone from the audio
    const mid = words.slice(5, -5).sort((a, b) => (b.endSec - b.startSec) - (a.endSec - a.startSec))[0]!;
    const cutEnd = mid.startSec + 0.45 * (mid.endSec - mid.startSec);
    const cutBody = { clips: [{ assetId: asset.id, inSec: 0, outSec: dur, cuts: [{ startSec: Math.max(0, mid.startSec - 0.03), endSec: cutEnd }] }], loudness: 'off' };
    const cut = await qaOf(plain.revision, cutBody);
    console.info(`[qa echt] Schnitt in „${mid.text}“: ${cut.qa.matched}/${cut.qa.expected} erkannt, Funde: ${JSON.stringify(cut.qa.findings)}`);
    expect(cut.qa.expected).toBe(plain.qa.expected);
  });
});
