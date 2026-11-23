'use client';
import { paletteFromPixels } from '@studio/core/palette';

/** Same 76×76 canvas sampling as the prototype; runs in the browser before upload. */
export async function extractPalette(file: File): Promise<string[]> {
  if (!file.type.startsWith('image/')) return [];
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = 76;
    canvas.height = 76;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0, 76, 76);
    return paletteFromPixels(ctx.getImageData(0, 0, 76, 76).data);
  } catch {
    return [];
  } finally {
    bitmap?.close?.();
  }
}
