import 'server-only';
import { spawn } from 'node:child_process';
import { FILLER_PROMPT } from '@studio/core';
import { transcriptionConfig } from './env';
import { firstExisting } from './ffmpeg';
import { waitForChild } from './proc';

export interface WhisperStatus { mode: 'mock' | 'whisper'; available: boolean; cli: string | null; model: string | null; reason: string | null }

/** Which speech-to-text runs here; never a dummy: without whisper.cpp it says so. */
export async function whisperStatus(): Promise<WhisperStatus> {
  const cfg = transcriptionConfig();
  if (cfg.mode === 'mock') return { mode: 'mock', available: true, cli: null, model: null, reason: null };
  const [cli, model] = await Promise.all([firstExisting(cfg.cli), firstExisting(cfg.model)]);
  const reason = !cli ? 'whisper.cpp ist nicht installiert (brew install whisper-cpp oder WHISPER_CLI setzen).'
    : !model ? 'Kein Whisper-Modell gefunden (WHISPER_MODEL setzen, z. B. ~/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin).' : null;
  return { mode: 'whisper', available: !reason, cli, model, reason };
}

/**
 * whisper.cpp's DTW alignment preset for a ggml model file (`ggml-large-v3-turbo-q5_0.bin` → `large.v3.turbo`);
 * null for models without a preset (then no DTW).
 */
export function dtwPreset(modelFile: string): string | null {
  const m = /^ggml-(tiny|base|small|medium|large-v1|large-v2|large-v3-turbo|large-v3)(\.en)?(?=[-.])/.exec(modelFile.split(/[\\/]/).pop() ?? '');
  return m ? `${m[1]!.replace(/-/g, '.')}${m[2] ?? ''}` : null;
}

/** The whisper-cli arguments (no shell). Flags checked against whisper-cli 1.9.5 `--help`. */
export function whisperArgs(model: string, wav: string, outBase: string, cfg: Pick<ReturnType<typeof transcriptionConfig>, 'threads' | 'vadModel' | 'fillerPrompt' | 'dtw'>) {
  const args = ['-m', model, '-l', 'de', '-t', String(cfg.threads), '-ojf', '-of', outBase, '-pp', '-np'];
  // the prompt is our constant (never user text); carried into every 30 s window, not only the first
  if (cfg.fillerPrompt) args.push('--prompt', FILLER_PROMPT, '--carry-initial-prompt');
  // DTW token times only work without flash attention (with it, whisper.cpp writes t_dtw = -1)
  const preset = cfg.dtw ? dtwPreset(model) : null;
  if (preset) args.push('-dtw', preset, '-nfa');
  args.push('-f', wav);
  if (cfg.vadModel) args.splice(0, 0, '--vad', '-vm', cfg.vadModel);
  return { args, fillerPrompt: cfg.fillerPrompt, dtw: preset != null };
}

/**
 * Runs whisper-cli on a 16 kHz mono WAV: German, full JSON (`-ojf`) next to `outBase`, progress from `-pp`.
 * No shell; aborting kills the process (SIGTERM, then SIGKILL).
 */
export async function runWhisper(wav: string, outBase: string, opts: { signal: AbortSignal; onProgress?: (fraction: number) => void }): Promise<{ jsonPath: string; model: string; fillerPrompt: boolean; dtw: boolean }> {
  const st = await whisperStatus();
  if (st.mode !== 'whisper' || !st.available) throw new Error(st.reason ?? 'whisper.cpp ist nicht verfügbar.');
  const { args, fillerPrompt, dtw } = whisperArgs(st.model!, wav, outBase, transcriptionConfig());
  opts.signal.throwIfAborted();
  // the binary and args come from config at runtime; keep the build tracer from including the whole project
  const child = spawn(/*turbopackIgnore: true*/ st.cli!, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    tail = (tail + d).slice(-4000);
    for (const m of d.matchAll(/progress\s*=\s*(\d+)%/g)) opts.onProgress?.(Number(m[1]) / 100);
  });
  await waitForChild(child, { signal: opts.signal, label: 'whisper.cpp', tail: () => tail });
  return { jsonPath: `${outBase}.json`, model: st.model!.split('/').pop()!, fillerPrompt, dtw };
}
