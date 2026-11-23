import 'server-only';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseProbe, type MediaProbe } from '@studio/core';
import { waitForChild } from './proc';

const run = promisify(execFile);

// The binaries do not change while the process runs: resolve and probe them once.
let pathPromise: Promise<string | null> | null = null;
let probePathPromise: Promise<string | null> | null = null;
let statusPromise: Promise<FfmpegStatus> | null = null;

/**
 * FFmpeg comes from the system (ADR-009); `ffmpeg-static` was removed (GPL-3.0 package without ffprobe).
 * Homebrew's keg-only `ffmpeg-full` comes first: unlike `ffmpeg` it has libass (burned-in subtitles).
 */
const SYSTEM_DIRS = ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export async function firstExisting(candidates: (string | null | undefined)[]): Promise<string | null> {
  for (const c of candidates) {
    if (!c) continue;
    try {
      await access(c);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/** FFMPEG_PATH, then a system FFmpeg. */
export function ffmpegPath(): Promise<string | null> {
  return (pathPromise ??= firstExisting([process.env.FFMPEG_PATH, ...SYSTEM_DIRS.map((d) => path.join(d, 'ffmpeg'))]));
}

/** FFPROBE_PATH, then next to the resolved FFmpeg, then system paths. */
export function ffprobePath(): Promise<string | null> {
  return (probePathPromise ??= (async () => {
    const ff = await ffmpegPath();
    const sibling = ff && path.basename(ff) === 'ffmpeg' ? path.join(path.dirname(ff), 'ffprobe') : null;
    return firstExisting([process.env.FFPROBE_PATH, sibling, ...SYSTEM_DIRS.map((d) => path.join(d, 'ffprobe'))]);
  })());
}

export interface FfmpegStatus {
  available: boolean; version: string | null; path: string | null; ffprobe: boolean;
  /** `subtitles` filter (needs libass) – required to burn in subtitles. */
  subtitles: boolean;
}

export function ffmpegStatus(): Promise<FfmpegStatus> {
  return (statusPromise ??= probeFfmpeg());
}

async function probeFfmpeg(): Promise<FfmpegStatus> {
  const [bin, probe] = await Promise.all([ffmpegPath(), ffprobePath()]);
  const base = { path: bin, ffprobe: !!probe, subtitles: false };
  if (!bin) return { available: false, version: null, ...base };
  try {
    const [{ stdout }, filters] = await Promise.all([
      run(bin, ['-version'], { timeout: 5000 }),
      run(bin, ['-hide_banner', '-filters'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout, () => ''),
    ]);
    return { available: true, version: stdout.split('\n')[0]?.trim() ?? null, ...base, subtitles: /^\s*\S+\s+subtitles\s/m.test(filters) };
  } catch {
    return { available: false, version: null, ...base };
  }
}

/** ffprobe metadata (duration, size, rotation, codecs). `null` when ffprobe is missing or cannot read the file. */
export async function probeMedia(inputAbs: string): Promise<MediaProbe | null> {
  const bin = await ffprobePath();
  if (!bin) return null;
  try {
    const { stdout } = await run(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputAbs], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return parseProbe(stdout);
  } catch {
    return null;
  }
}

async function probeDuration(bin: string, input: string): Promise<number | null> {
  // ffmpeg prints "Duration: 00:00:12.34" to stderr when only probing input.
  try {
    await run(bin, ['-hide_banner', '-i', input], { timeout: 15000 });
  } catch (e) {
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String((e as { stderr?: string }).stderr ?? ''));
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

/**
 * Extract up to `count` evenly spaced JPEG keyframes (max 768px wide).
 * Arguments are passed as an array (no shell); the input path is server-generated.
 */
export async function extractKeyframes(inputAbs: string, count = 6): Promise<{ timestampSec: number; jpeg: Buffer }[]> {
  const bin = await ffmpegPath();
  if (!bin) throw new Error('FFmpeg ist nicht verfügbar (FFmpeg installieren, z. B. `brew install ffmpeg`, oder FFMPEG_PATH setzen).');
  const duration = (await probeDuration(bin, inputAbs)) ?? 0;
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-kf-'));
  try {
    const n = Math.max(1, Math.min(count, 12));
    const stamps = duration > 0 ? Array.from({ length: n }, (_, i) => Number(((duration * (i + 0.5)) / n).toFixed(2))) : [0];
    // Independent seeks → run in parallel; a frame past the end simply yields no file.
    const extracted = await Promise.all(
      stamps.map(async (t, i) => {
        const out = path.join(dir, `kf-${i}.jpg`);
        await run(bin, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', inputAbs, '-frames:v', '1', '-vf', "scale='min(768,iw)':-2", '-q:v', '4', '-y', out], { timeout: 30000 });
        const jpeg = await readFile(out).catch(() => null);
        return jpeg ? { timestampSec: t, jpeg } : null;
      }),
    );
    const frames = extracted.filter((f) => f !== null);
    if (!frames.length) throw new Error('FFmpeg konnte keine Keyframes extrahieren.');
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RunFfmpegOptions {
  signal?: AbortSignal;
  /** Expected output length; with it, progress is reported as a fraction 0..1. */
  durationSec?: number | null;
  onProgress?: (fraction: number | null, outSec: number) => void;
  /** `info` keeps filter reports such as the loudnorm measurement in the returned stderr tail. */
  loglevel?: 'error' | 'info';
  /** Bytes of stderr to keep (default 2000, 16000 at loglevel info); the silence scan needs all of it (capped at 2 MB). */
  keepStderr?: number;
}

/**
 * Long FFmpeg run for the video worker: spawned without a shell, progress read from
 * `-progress pipe:1` (no output buffering), stderr kept only as a short tail for the error message.
 * Aborting sends SIGTERM, then SIGKILL after 3 s; the promise rejects with an AbortError.
 */
export async function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<{ stderr: string }> {
  const bin = await ffmpegPath();
  if (!bin) throw new Error('FFmpeg ist nicht verfügbar (FFmpeg installieren, z. B. `brew install ffmpeg`, oder FFMPEG_PATH setzen).');
  opts.signal?.throwIfAborted();
  const child = spawn(bin, ['-hide_banner', '-nostdin', '-nostats', '-loglevel', opts.loglevel ?? 'error', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = Math.min(2 * 1024 * 1024, opts.keepStderr ?? (opts.loglevel === 'info' ? 16000 : 2000));
  let tail = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => (tail = (tail + d).slice(-keep)));
  let partial = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    const lines = (partial + d).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (!m || !opts.onProgress) continue;
      const sec = Number(m[1]) / 1e6;
      const total = opts.durationSec;
      opts.onProgress(total && total > 0 ? Math.min(1, sec / total) : null, sec);
    }
  });
  await waitForChild(child, { signal: opts.signal, label: 'FFmpeg', tail: () => tail });
  return { stderr: tail };
}
