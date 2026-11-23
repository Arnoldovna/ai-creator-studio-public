import 'server-only';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { HttpError } from '../errors';
import { cancelJob, enqueueJob, getJob, listJobs, registerJobHandler } from '../worker';
// Registers the render handler, so queued renders resume even if only the job routes are used after a restart.
import './edit';
import './transcripts';
import './generations';
import './cuts';
import './prepare';
import './editPreview';
import './finish';

/**
 * Video jobs of the studio. Every route imports this module, so all handlers are registered
 * before the worker picks up a queued job (also after a restart).
 */

export const SelftestInput = z.object({
  seconds: z.number().int().min(1).max(600).default(10),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

/**
 * Worker self-test: FFmpeg encodes a vertical test pattern (1080x1920, 30 fps, H.264) into the job's
 * work directory and reports the size. The file is deleted with the work directory: nothing is kept.
 */
registerJobHandler('selftest', async ({ job, signal, workDir, progress }) => {
  const { seconds } = SelftestInput.parse(job.input);
  const out = path.join(workDir, 'selftest.mp4');
  const t0 = Date.now();
  await runFfmpeg(
    ['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-y', out],
    { signal, durationSec: seconds, onProgress: (f, sec) => progress(f, `${sec.toFixed(1)} von ${seconds} s kodiert`) },
  );
  const { size } = await stat(out);
  return { seconds, bytes: size, encodeMs: Date.now() - t0, kept: false };
});

export async function startSelftest(raw: unknown) {
  const input = SelftestInput.parse(raw ?? {});
  const ff = await ffmpegStatus();
  if (!ff.available) throw new HttpError(503, 'FFmpeg ist nicht verfügbar – der Worker-Test braucht FFmpeg.');
  return enqueueJob('selftest', { seconds: input.seconds }, { idempotencyKey: input.idempotencyKey ?? null });
}

export { cancelJob, getJob, listJobs };
