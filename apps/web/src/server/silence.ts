import 'server-only';
import { parseSilencedetect, parseVolumedetect, SILENCE_MIN_SEC, silencedetectFilter, silenceThresholdDb } from '@studio/core';
import { runFfmpeg } from './ffmpeg';

export interface SilenceScanResult { params: { noiseDb: number; minSilenceSec: number; meanDb: number }; ranges: { startSec: number; endSec: number }[] }

/**
 * Silence scan of one audio file or video (Etappe 8): pass 1 `volumedetect` gives the mean volume, pass 2
 * `silencedetect` uses a threshold 20 dB below it (core `silenceThresholdDb`). Audio only, local, no shell.
 * Returns null when the file has no measurable audio (e.g. digital silence).
 */
export async function scanSilence(inputAbs: string, opts: { signal: AbortSignal; durationSec: number | null }): Promise<SilenceScanResult | null> {
  const vol = await runFfmpeg(['-i', inputAbs, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { signal: opts.signal, loglevel: 'info' });
  const v = parseVolumedetect(vol.stderr);
  if (!v || !Number.isFinite(v.meanDb)) return null;
  const noiseDb = silenceThresholdDb(v.meanDb);
  const sil = await runFfmpeg(['-i', inputAbs, '-vn', '-af', silencedetectFilter(noiseDb), '-f', 'null', '-'], { signal: opts.signal, loglevel: 'info', keepStderr: 2 * 1024 * 1024 });
  return { params: { noiseDb, minSilenceSec: SILENCE_MIN_SEC, meanDb: v.meanDb }, ranges: parseSilencedetect(sil.stderr, opts.durationSec).slice(0, 20000) };
}
