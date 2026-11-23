import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Etappe 12: automatic preparation after upload (proxy, sprite, peaks, then pause scan / transcription) with real FFmpeg. */
const run = promisify(execFile);
let dir: string;
let ff: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-prepare-'));
  // whisper is configured to a missing binary: the preparation must say „nicht verfügbar“ and still measure the pauses
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', STUDIO_AUTO_PREPARE: 'on', TRANSCRIPTION: 'whisper', WHISPER_CLI: path.join(dir, 'no-whisper-cli') });
  ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
});
afterAll(async () => {
  process.env.STUDIO_AUTO_PREPARE = 'off';
  delete process.env.WHISPER_CLI;
  delete process.env.TRANSCRIPTION;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function fixture(name: string, seconds: number, size = '640x360', audio = true) {
  const out = path.join(dir, name);
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-af', 'volume=enable=\'between(t,1,1.8)\':volume=0', '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', '-y', out]);
  return out;
}
const fileStream = async (p: string) => new Blob([await readFile(p)]).stream();
async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 120000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 800)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const exists = (p: string) => access(p).then(() => true, () => false);

describe('Auto-Vorbereitung (prepare job)', () => {
  it('upload → proxy 540×960 CFR 30, sprite, peaks → pause scan (whisper missing: transcription „nicht verfügbar“); idempotent; removed with the footage', async () => {
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const prepare = await import('@/server/services/prepare');
    const drafts = await import('@/server/services/editDraft');
    await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Vorbereiten', kind: 'PERSONAL_CONTENT' });
    const file = await fixture('take.mp4', 4);
    const { asset } = await footage.uploadFootage(p.id, await fileStream(file), { name: 'take.mp4', origin: 'own' }, null);
    expect(asset.status).toBe('probed');

    // without another call: prepared, then the pause scan
    const item = await until(() => footage.listFootage(p.id).then((l) => l.items[0]!), (a) => a.prepare.status === 'ready' || a.prepare.status === 'failed');
    expect(item.prepare).toMatchObject({ status: 'ready', error: null });
    const d = item.derived!;
    expect(d.proxy).toMatchObject({ width: 540, height: 960, fps: 30 });
    expect(d.thumbs).toMatchObject({ count: 4, columns: 4, rows: 1, intervalSec: 1 });
    expect(d.peaks!.perSec).toBe(50);

    // the proxy: H.264 540x960 at a constant 30 fps, with sound, keyframes every 10 frames
    const proxy = path.join(dir, d.proxy.storagePath);
    const info = await run(ff, ['-hide_banner', '-i', proxy]).catch((e: { stderr: string }) => ({ stderr: e.stderr }));
    expect(info.stderr).toMatch(/Video: h264.*540x960/);
    expect(info.stderr).toMatch(/30 fps/);
    expect(info.stderr).toMatch(/Audio: aac/);
    const probeBin = (await (await import('@/server/ffmpeg')).ffprobePath())!; // the preparation needs ffprobe anyway
    const { stdout: flags } = await run(probeBin, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=flags', '-of', 'csv=p=0', proxy], { maxBuffer: 16 * 1024 * 1024 });
    const pkts = flags.trim().split('\n');
    expect(pkts.length).toBeGreaterThanOrEqual(119);
    const keyIdx = pkts.flatMap((f, i) => (f.startsWith('K') ? [i] : []));
    expect(keyIdx.slice(0, 4)).toEqual([0, 10, 20, 30]);
    // sprite: one JPEG of 4 tiles of 96x170
    const sprite = await run(ff, ['-hide_banner', '-i', path.join(dir, d.thumbs.storagePath)]).catch((e: { stderr: string }) => ({ stderr: e.stderr }));
    expect(sprite.stderr).toMatch(/mjpeg.*384x170/);
    // peaks: 4 s × 50, silence 1–1.8 s visible
    const peaks = await prepare.getPeaks(asset.id);
    expect(peaks.hasAudio).toBe(true);
    expect(peaks.peaks.length).toBeGreaterThanOrEqual(199);
    expect(Math.max(...peaks.peaks.slice(55, 85))).toBeLessThan(10);
    expect(Math.max(...peaks.peaks.slice(5, 45))).toBeGreaterThan(20); // lavfi sine: amplitude 1/8

    // follow-up: whisper is missing → no transcription, said plainly; the pause scan runs alone
    const v = await until(() => drafts.getEditDraft(p.id, null), (x) => x.media[0]!.silences != null);
    expect(v.transcription).toMatchObject({ available: false, mode: 'whisper' });
    expect(v.transcription.reason).toMatch(/whisper\.cpp ist nicht installiert/);
    expect(v.media[0]!.transcript).toBeNull();
    expect(v.media[0]!.silences!.some((s) => s.startSec > 0.9 && s.endSec < 1.95)).toBe(true);

    // idempotent: a second start returns „ready“ without a new job
    const jobsBefore = await read((db) => db.mediaJobs.filter((j) => j.kind === 'prepare').length);
    expect(await prepare.startPrepare(asset.id)).toMatchObject({ ready: true, job: null });
    expect(await read((db) => db.mediaJobs.filter((j) => j.kind === 'prepare').length)).toBe(jobsBefore);
    // a duplicate upload does not prepare again
    await footage.uploadFootage(p.id, await fileStream(file), { name: 'nochmal.mp4', origin: 'own' }, null);
    expect(await read((db) => db.mediaJobs.filter((j) => j.kind === 'prepare').length)).toBe(jobsBefore);

    // deleting the footage removes the derived folder
    const derivedDir = path.join(dir, 'derived', p.id, asset.id);
    expect(await exists(derivedDir)).toBe(true);
    await footage.deleteFootage(asset.id);
    expect(await exists(derivedDir)).toBe(false);
    await expect(prepare.derivedFile(asset.id, 'proxy')).rejects.toMatchObject({ status: 404 });
  }, 180000);

  it('footage without sound gets proxy and sprite, no peaks; unreadable footage is not prepared; a failed job is visible and can be restarted', async () => {
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const prepare = await import('@/server/services/prepare');
    const { read, write } = await import('@/server/store');
    const p = await projects.createProject({ title: 'Stumm', kind: 'PERSONAL_CONTENT' });
    const { asset } = await footage.uploadFootage(p.id, await fileStream(await fixture('silent.mp4', 2, '360x640', false)), { name: 'silent.mp4', origin: 'own' }, null);
    const item = await until(() => footage.listFootage(p.id).then((l) => l.items[0]!), (a) => a.prepare.status === 'ready' || a.prepare.status === 'failed');
    expect(item.prepare).toMatchObject({ status: 'ready', error: null });
    expect(item.derived!.peaks).toBeNull();
    expect(await prepare.getPeaks(asset.id)).toMatchObject({ hasAudio: false, peaks: [] });

    // a header-only file: probe fails, nothing queued, status „unsupported“, the button says why
    const junk = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from('ftypisom'), 0, 0, 2, 0, ...Buffer.from('isomiso2'), ...new Array(2000).fill(1)]);
    const bad = await footage.uploadFootage(p.id, new Blob([junk]).stream(), { name: 'kaputt.mp4', origin: 'own' }, null);
    const listed = (await footage.listFootage(p.id)).items.find((a) => a.id === bad.asset.id)!;
    expect(listed.prepare.status).toBe('unsupported');
    await expect(prepare.startPrepare(bad.asset.id)).rejects.toMatchObject({ status: 409 });

    // review fix: a failed re-preparation (outdated version, original unreadable) keeps the old working set usable
    const { asset: a3 } = await footage.uploadFootage(p.id, await fileStream(await fixture('third.mp4', 2, '320x240')), { name: 'third.mp4', origin: 'own' }, null);
    const ready3 = await until(() => footage.listFootage(p.id).then((l) => l.items.find((x) => x.id === a3.id)!), (a) => a.prepare.status === 'ready');
    const proxy3 = path.join(dir, ready3.derived!.proxy.storagePath);
    await write((db) => {
      const x = db.mediaAssets.find((m) => m.id === a3.id)!;
      x.derived = { ...x.derived!, version: 0 };
      x.storagePath = `footage/${p.id}/gone.mp4`;
    });
    await prepare.startPrepare(a3.id);
    await until(async () => (await read((db) => db.mediaJobs.find((j) => j.kind === 'prepare' && (j.input as { assetId: string }).assetId === a3.id && j.status === 'failed'))) ?? null, (j) => j != null);
    expect(await exists(proxy3)).toBe(true);
    expect((await prepare.derivedFile(a3.id, 'proxy')).storagePath).toBe(ready3.derived!.proxy.storagePath);

    // a broken original (file replaced after upload): the job fails visibly, a restart re-queues it
    const { asset: a2 } = await footage.uploadFootage(p.id, await fileStream(await fixture('second.mp4', 2)), { name: 'second.mp4', origin: 'own' }, null);
    await until(() => footage.listFootage(p.id).then((l) => l.items.find((x) => x.id === a2.id)!), (a) => a.prepare.status === 'ready');
    await write((db) => {
      const x = db.mediaAssets.find((m) => m.id === a2.id)!;
      x.derived = null;
      x.storagePath = `footage/${p.id}/does-not-exist.mp4`;
    });
    const { job } = await prepare.startPrepare(a2.id);
    expect(job).not.toBeNull();
    const failed = await until(() => footage.listFootage(p.id).then((l) => l.items.find((x) => x.id === a2.id)!), (a) => a.prepare.status === 'failed');
    expect(failed.prepare.error).toBeTruthy();
    const again = await prepare.startPrepare(a2.id);
    expect(again.job!.id).not.toBe(job!.id); // a new attempt; while it is queued a second start returns it
    expect((await prepare.startPrepare(a2.id)).job!.id).toBe(again.job!.id);
  }, 180000);
});
