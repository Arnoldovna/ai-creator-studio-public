/**
 * Derived media of one footage clip (Etappe 12, „Auto-Vorbereitung“): the editing proxy, the thumbnail sprite and the
 * waveform peaks. Pure and deterministic: the parameters and the FFmpeg arguments are built here, the server runs them.
 * Everything derived is a working copy for the browser editor; the render always reads the original file.
 */

/** Bump when the parameters change: footage prepared with an older version is prepared again on request. */
export const PREPARE_VERSION = 1;

/**
 * Proxy: 540×960 (half of the output), cover-scaled and centre-cropped exactly like the render (`scaleChain`), so the
 * browser stage shows the picture the render will show (without zoom). CFR 30 and a keyframe every 10 frames make
 * scrubbing and the jumps at cuts fast.
 */
export const PROXY = { width: 540, height: 960, fps: 30, gop: 10 } as const;

export function proxyArgs(input: string, output: string, hasAudio: boolean): string[] {
  const { width: W, height: H, fps, gop } = PROXY;
  return [
    '-i', input, '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []),
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},setsar=1,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-profile:v', 'high', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-r', String(fps), '-fps_mode', 'cfr',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000'] : ['-an']),
    '-movflags', '+faststart', '-y', output,
  ];
}

/** Thumbnail sprite: one 9:16 tile per `intervalSec` (1 s, longer clips fewer), at most `SPRITE.maxTiles` tiles. */
export const SPRITE = { tileWidth: 96, tileHeight: 170, columns: 10, maxTiles: 300 } as const;
export interface SpritePlan { intervalSec: number; count: number; columns: number; rows: number; tileWidth: number; tileHeight: number }

export function spritePlan(durationSec: number): SpritePlan {
  const d = Math.max(0.001, durationSec);
  const intervalSec = d <= SPRITE.maxTiles ? 1 : Math.ceil((d / SPRITE.maxTiles) * 10) / 10;
  const count = Math.max(1, Math.min(SPRITE.maxTiles, Math.ceil(d / intervalSec)));
  const columns = Math.min(SPRITE.columns, count);
  return { intervalSec, count, columns, rows: Math.ceil(count / columns), tileWidth: SPRITE.tileWidth, tileHeight: SPRITE.tileHeight };
}

/** FFmpeg arguments for the sprite (read from the proxy: already 9:16 and fast to decode). Tile k shows time k·interval. */
export function spriteArgs(proxy: string, output: string, plan: SpritePlan): string[] {
  return [
    '-i', proxy, '-an',
    '-vf', `fps=1/${plan.intervalSec}:round=down,scale=${plan.tileWidth}:${plan.tileHeight},tile=${plan.columns}x${plan.rows}`,
    '-frames:v', '1', '-q:v', '5', '-y', output,
  ];
}

/** Position of the tile that shows source time `sec` (the nearest earlier tile). */
export function spriteTile(plan: SpritePlan, sec: number): { index: number; x: number; y: number } {
  const index = Math.max(0, Math.min(plan.count - 1, Math.floor(sec / plan.intervalSec + 1e-6)));
  return { index, x: (index % plan.columns) * plan.tileWidth, y: Math.floor(index / plan.columns) * plan.tileHeight };
}

/** Waveform: mono PCM at 8 kHz, peaks per bin (50 per second, fewer for long clips so the file stays small). */
export const PEAKS = { sampleRate: 8000, perSec: 50, maxBins: 90_000 } as const;
export interface PeaksFile { version: 1; perSec: number; durationSec: number; peaks: number[] }

export function peaksRate(durationSec: number): number {
  return durationSec * PEAKS.perSec <= PEAKS.maxBins ? PEAKS.perSec : Math.max(1, Math.floor(PEAKS.maxBins / Math.max(1, durationSec)));
}

export const peaksPcmArgs = (input: string, output: string): string[] =>
  ['-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(PEAKS.sampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', '-y', output];

/** Peak (max |sample|) per bin, scaled to 0..255. `samples` = signed 16-bit mono PCM. */
export function computePeaks(samples: Int16Array, sampleRate: number, perSec: number): number[] {
  const per = sampleRate / perSec;
  const bins = Math.ceil(samples.length / per);
  const out = new Array<number>(bins).fill(0);
  for (let b = 0; b < bins; b++) {
    const from = Math.floor(b * per), to = Math.min(samples.length, Math.floor((b + 1) * per));
    let m = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(samples[i]!);
      if (v > m) m = v;
    }
    out[b] = Math.min(255, Math.round((m / 32768) * 255));
  }
  return out;
}

/** The peaks of source range [from, to] resampled to `bins` values (max per bin), for drawing one piece. */
export function peaksSlice(file: Pick<PeaksFile, 'perSec' | 'peaks'>, from: number, to: number, bins: number): number[] {
  const n = Math.max(0, Math.floor(bins));
  if (!n || to <= from) return [];
  const a = from * file.perSec, span = (to - from) * file.perSec;
  return Array.from({ length: n }, (_, i) => {
    const s = Math.floor(a + (i * span) / n), e = Math.max(s + 1, Math.floor(a + ((i + 1) * span) / n));
    let m = 0;
    for (let k = s; k < e && k < file.peaks.length; k++) if (k >= 0 && file.peaks[k]! > m) m = file.peaks[k]!;
    return m;
  });
}
