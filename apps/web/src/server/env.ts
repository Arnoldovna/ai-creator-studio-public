import 'server-only';
import path from 'node:path';
import { resolveProvider } from '@studio/core';

export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

const bytesEnv = (key: string, fallback: number) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
/** Footage is streamed to disk; limits are configurable (ADR-009 / Release 3, Etappe 2). */
export const footageLimits = () => ({
  perFile: bytesEnv('FOOTAGE_MAX_BYTES', 4 * 1024 ** 3),
  perProject: bytesEnv('FOOTAGE_MAX_PROJECT_BYTES', 50 * 1024 ** 3),
});

/**
 * Speech-to-text (ADR-009): whisper.cpp runs locally, audio never leaves the machine.
 * TRANSCRIPTION=mock gives labelled stand-ins (tests, demo); otherwise whisper.cpp or "nicht verfügbar".
 */
export function transcriptionConfig() {
  const home = process.env.HOME ?? '';
  const models = ['ggml-large-v3-turbo-q5_0.bin', 'ggml-medium-q5_0.bin', 'ggml-small-q5_1.bin'].map((m) => path.join(home, '.cache', 'whisper.cpp', m));
  return {
    mode: process.env.TRANSCRIPTION === 'mock' ? ('mock' as const) : ('whisper' as const),
    cli: process.env.WHISPER_CLI ? [process.env.WHISPER_CLI] : ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'],
    model: process.env.WHISPER_MODEL ? [process.env.WHISPER_MODEL] : models,
    vadModel: process.env.WHISPER_VAD_MODEL || null,
    threads: Math.min(16, Math.max(1, Math.floor(Number(process.env.WHISPER_THREADS)) || 8)),
    /** Etappe 8: fixed prompt with fillers and normal casing/punctuation (WHISPER_FILLER_PROMPT=0 switches it off). */
    fillerPrompt: process.env.WHISPER_FILLER_PROMPT !== '0',
    /** Etappe 8: DTW word times (`-dtw`, needs `-nfa`, about 1.4× slower) so fillers can be found in the audio (WHISPER_DTW=0 switches it off). */
    dtw: process.env.WHISPER_DTW !== '0',
  };
}

export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.STUDIO_DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), '.data'));
}

/**
 * Standard folder (Etappe 10, E2): the active strategy, profile, Style Bible and Voice Guide are mirrored here on every
 * activation and seed an empty data folder. Outside repo and data folder, so it survives resets and folder changes.
 * STUDIO_DEFAULTS_DIR=off switches it off (tests always do); null = off.
 */
export function defaultsDir(): string | null {
  const raw = process.env.STUDIO_DEFAULTS_DIR?.trim();
  if (raw === 'off') return null;
  if (raw) return path.resolve(/*turbopackIgnore: true*/ raw);
  const home = process.env.HOME;
  return home ? path.join(/*turbopackIgnore: true*/ home, 'Documents', 'AI Creator Studio (privat)', 'standard') : null;
}

export function providerFromEnv() {
  return resolveProvider(process.env);
}

export function storageMode(): { mode: 'local' | 'supabase'; note: string } {
  // Supabase adapter is not implemented yet (see docs/IMPLEMENTATION_LOG.md).
  return { mode: 'local', note: `Lokale Dateiablage unter ${dataDir()} (nur dieser Rechner).` };
}

/**
 * Generated B-roll (Release 3, Etappe 7, ADR-010), behind a feature flag: HIGGSFIELD=off (default) | cli | mock.
 * The monthly credit budget is separate from the USD budget of the text agents; 0 allows no paid job.
 */
export function higgsfieldConfig() {
  const home = process.env.HOME ?? '';
  const raw = process.env.HIGGSFIELD;
  const credits = Number(process.env.HIGGSFIELD_MONTHLY_CREDITS);
  return {
    mode: raw === 'cli' || raw === 'mock' ? raw : ('off' as const),
    cli: process.env.HIGGSFIELD_CLI ? [process.env.HIGGSFIELD_CLI]
      : [path.join(home, '.local', 'bin', 'higgsfield'), '/opt/homebrew/bin/higgsfield', '/usr/local/bin/higgsfield'],
    monthlyCredits: Number.isFinite(credits) && credits > 0 ? credits : 0,
  };
}
