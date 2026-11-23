import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseWhisperJson, suggestCuts } from '@studio/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtures } from '../../../scripts/make-video-fixtures.mjs';

/**
 * Real speech-to-text with whisper.cpp on the synthetic German fixture (macOS `say -v Anna`).
 * Opt-in (`WHISPER_REAL=1`) because one run takes minutes on CPU; skipped without whisper-cli, model or `say`.
 */
const enabled = process.env.WHISPER_REAL === '1';
let dir: string;
let wav: string | null = null;
let fillerWav: string | null = null;
let ready: { available: boolean; reason: string | null } = { available: false, reason: 'not checked' };
beforeAll(async () => {
  if (!enabled) return;
  dir = await mkdtemp(path.join(tmpdir(), 'studio-whisper-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, TRANSCRIPTION: 'whisper' });
  const ff = await import('@/server/ffmpeg');
  const ffmpeg = await ff.ffmpegPath();
  const files = ffmpeg ? makeFixtures(path.join(dir, 'fx'), ffmpeg) : [];
  wav = files.find((f) => f.endsWith('speech-de.wav')) ?? null;
  fillerWav = files.find((f) => f.endsWith('speech-de-filler.wav')) ?? null;
  ready = await (await import('@/server/whisper')).whisperStatus();
}, 120_000);
afterAll(() => (dir ? rm(dir, { recursive: true, force: true }) : undefined));

describe.runIf(enabled)('whisper.cpp with real German speech', () => {
  it('transcribes the fixture through the app adapter and parses word timings', async (ctx) => {
    if (!ready.available || !wav || !existsSync(wav)) ctx.skip();
    const { runWhisper } = await import('@/server/whisper');
    const progress: number[] = [];
    const { jsonPath, model, fillerPrompt, dtw } = await runWhisper(wav!, path.join(dir, 'out'), { signal: new AbortController().signal, onProgress: (f) => progress.push(f) });
    expect({ fillerPrompt, dtw }).toEqual({ fillerPrompt: true, dtw: true }); // defaults since Etappe 8
    const body = parseWhisperJson(await readFile(jsonPath, 'latin1'), { bytes: true }); // as services/transcripts.ts reads it
    const text = body.segments.map((s) => s.text).join(' ');
    console.info(`[whisper] ${model} (Füllwort-Prompt, DTW): ${text}`);
    expect(text).toMatch(/Wolle färbe/);
    expect(text).toMatch(/Garn/);
    expect(text).toMatch(/trocknen/);
    const words = body.segments.flatMap((s) => s.words ?? []);
    expect(words.length).toBeGreaterThan(20);
    // timings are monotonic and inside the ~11.6 s clip
    for (let i = 1; i < words.length; i++) expect(words[i]!.startSec).toBeGreaterThanOrEqual(words[i - 1]!.startSec);
    expect(words.at(-1)!.endSec).toBeLessThan(13);
    expect(progress.length).toBeGreaterThan(0);
    // the prompt gives normal casing and punctuation; DTW gives every word a time inside the audio
    expect(text).toMatch(/^Heute /);
    expect(text).toMatch(/[.!?]$/);
    expect(words.every((w) => w.atSec != null && w.atSec <= 13)).toBe(true);
  }, 900_000);

  it('finds the spoken fillers in the audio: whisper with prompt + DTW, silence scan, suggestions', async (ctx) => {
    if (!ready.available || !fillerWav || !existsSync(fillerWav)) ctx.skip();
    const { runWhisper } = await import('@/server/whisper');
    const { scanSilence } = await import('@/server/silence');
    const signal = new AbortController().signal;
    const { jsonPath } = await runWhisper(fillerWav!, path.join(dir, 'filler'), { signal });
    const body = parseWhisperJson(await readFile(jsonPath, 'latin1'), { bytes: true });
    const text = body.segments.map((s) => s.text).join(' ');
    const scan = (await scanSilence(fillerWav!, { signal, durationSec: 11.12 }))!;
    const r = suggestCuts({ transcript: body, silences: scan.ranges, clip: { inSec: 0, outSec: 11.1 } });
    console.info(`[whisper] Füllwort-Aufnahme: ${text}`);
    console.info(`[whisper] Stille unter ${scan.params.noiseDb} dB (Mittel ${scan.params.meanDb} dB): ${scan.ranges.length} Bereiche; Vorschläge: ${r.suggestions.map((s) => `${s.kind} ${s.word} ${s.startSec}–${s.endSec} ${s.confidence}`).join(' | ')}`);
    // „Ähm“, „äh“, „hm“, „Öhm“ are spoken; at least three are found as safe cuts, the 0.9 s pause as well
    expect(r.suggestions.filter((s) => s.kind === 'filler' && s.safe).length).toBeGreaterThanOrEqual(3);
    expect(r.suggestions.some((s) => s.kind === 'pause' && s.startSec > 3.5 && s.endSec < 4.8)).toBe(true);
  }, 900_000);
});
