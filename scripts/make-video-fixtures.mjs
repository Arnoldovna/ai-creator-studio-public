#!/usr/bin/env node
/**
 * Synthetic video fixtures for Release 3 (no real footage in the repo).
 * Usage: node scripts/make-video-fixtures.mjs <outDir> [ffmpegPath]
 * Writes: landscape.mp4 (640x360, tone), portrait-rotated.mp4 (landscape pixels + display matrix -90 like an
 * upright phone clip), silent.mp4 (no audio track), audio-only.mp4 (no video track), speech-de.wav and speech-de-filler.wav when macOS `say` exists.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function makeFixtures(outDir, ff = process.env.FFMPEG_PATH || 'ffmpeg') {
  mkdirSync(outDir, { recursive: true });
  const run = (args) => execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const out = (n) => path.join(outDir, n);
  const video = (size, sec) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${sec}`];
  const tone = (sec) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${sec}`];
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  run([...video('640x360', 3), ...tone(3), ...h264, '-c:a', 'aac', '-shortest', out('landscape.mp4')]);
  run(['-display_rotation:v:0', '-90', '-i', out('landscape.mp4'), '-c', 'copy', out('portrait-rotated.mp4')]);
  run([...video('360x640', 2), ...h264, out('silent.mp4')]);
  run([...tone(2), '-c:a', 'aac', out('audio-only.mp4')]);
  const files = ['landscape.mp4', 'portrait-rotated.mp4', 'silent.mp4', 'audio-only.mp4'];
  // German speech for the whisper.cpp benchmark (macOS only; synthetic voice, not the user's material)
  if (process.platform === 'darwin' && spawnSync('say', ['-v', '?']).stdout?.toString().includes('Anna')) {
    const aiff = out('speech-de.aiff');
    execFileSync('say', ['-v', 'Anna', '-o', aiff, 'Heute zeige ich euch, wie ich meine Wolle färbe. Zuerst wasche ich das Garn mit lauwarmem Wasser, dann kommt die Farbe dazu. Nach einer Stunde spüle ich alles gründlich aus und lasse es trocknen.']);
    run(['-i', aiff, '-ar', '16000', '-ac', '1', out('speech-de.wav')]);
    files.push('speech-de.wav');
    // with hesitations and a 0.9 s pause, for the filler/pause suggestions (Etappe 8)
    const fillerAiff = out('speech-de-filler.aiff');
    execFileSync('say', ['-v', 'Anna', '-o', fillerAiff, 'Ähm, heute zeige ich euch, äh, wie ich meine Wolle färbe. [[slnc 900]] Also, zuerst wasche ich, hm, das Garn mit lauwarmem Wasser. Öhm, dann kommt die Farbe dazu.']);
    run(['-i', fillerAiff, '-ar', '16000', '-ac', '1', out('speech-de-filler.wav')]);
    files.push('speech-de-filler.wav');
  }
  return files.map(out);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outDir, ff] = process.argv.slice(2);
  if (!outDir) {
    console.error('Usage: node scripts/make-video-fixtures.mjs <outDir> [ffmpegPath]');
    process.exit(1);
  }
  for (const f of makeFixtures(outDir, ff)) console.log(f);
}
