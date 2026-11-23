/**
 * Technical colour sampling (ported 1:1 from prototype/app.js).
 * This is NOT an AI interpretation — just quantized pixel frequencies.
 */
export type RGB = [number, number, number];

export function quantColor(r: number, g: number, b: number, step = 32): RGB {
  const v = (x: number) => Math.max(0, Math.min(255, Math.round(x / step) * step));
  return [v(r), v(g), v(b)];
}

export const toHex = (rgb: RGB): string =>
  '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const dist = (a: RGB, b: RGB) => Math.sqrt(a.reduce((s, n, i) => s + (n - b[i]!) ** 2, 0));

/**
 * @param pixels RGBA bytes (e.g. canvas ImageData.data of a 76x76 downscale)
 * @param stride byte stride between sampled pixels (prototype used 16 = every 4th pixel)
 */
export function paletteFromPixels(pixels: ArrayLike<number>, { max = 5, minDistance = 55, stride = 16 } = {}): string[] {
  const counts = new Map<string, number>();
  for (let i = 0; i + 3 < pixels.length; i += stride) {
    if (pixels[i + 3]! < 128) continue;
    const key = quantColor(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!).join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const chosen: RGB[] = [];
  for (const [key] of sorted) {
    const c = key.split(',').map(Number) as RGB;
    if (chosen.every((v) => dist(c, v) > minDistance)) chosen.push(c);
    if (chosen.length >= max) break;
  }
  return chosen.map(toHex);
}

/** Rough warm/cool classification used by the mock analyst. */
export function describePalette(hexes: string[]): { temperature: 'warm' | 'cool' | 'neutral' | 'mixed'; contrast: 'low' | 'medium' | 'high' } {
  if (!hexes.length) return { temperature: 'neutral', contrast: 'low' };
  const rgbs = hexes.map(hexToRgb);
  const warmth = rgbs.map(([r, , b]) => r - b);
  const warm = warmth.filter((w) => w > 24).length;
  const cool = warmth.filter((w) => w < -24).length;
  const temperature = warm && cool ? 'mixed' : warm ? 'warm' : cool ? 'cool' : 'neutral';
  const lum = rgbs.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const spread = Math.max(...lum) - Math.min(...lum);
  return { temperature, contrast: spread > 150 ? 'high' : spread > 70 ? 'medium' : 'low' };
}
