/**
 * Image overlays (Etappe 16, „Claude legt eigene Fotos ins Video“): her own photos or licensed images from the reference
 * library, shown over the footage for a moment. Pure and deterministic, PlayRes 1080×1920.
 *
 * - Stored per clip in SOURCE time (`EditClip.images`, optional: plans without it are unchanged), like text overlays, so an
 *   image stays on the same spoken moment when cuts change.
 * - Rendered with FFmpeg's `overlay` filter BELOW the ASS file: hook, text overlays, subtitles and the AI label are drawn
 *   afterwards by libass, so the label always lies on top. No user text enters the filtergraph (only our numbers); the
 *   image path is an input argument.
 * - Geometry: width from the size step, height from the image's aspect ratio (both even), centred at `pos` (default: the
 *   middle of the content area) and kept inside the picture. The same box drives the stage, the still frame and the render.
 * - Rights: only images marked as her own or licensed WITH a source are used; a generated image is allowed but carries the
 *   AI label for exactly the time it is shown (`imageDisclosureLabels`).
 */
import { z } from 'zod';
import { SizeStep } from './designSystem';
import { FRAME, intersects, LABEL_ZONE, NormPos, PLAY_RES, posCenter, slotY, toNormPos, type Box } from './overlayLayout';
import { mapSpan, type Timeline } from './timeline';

/** How an image of the library may be used in a video (set by her in the library; absent = not usable). */
export const ImageUsageOrigin = z.enum(['own', 'licensed', 'generated']);
export type ImageUsageOrigin = z.infer<typeof ImageUsageOrigin>;
export const IMAGE_USAGE_LABEL: Record<ImageUsageOrigin, string> = { own: 'Eigenes Foto/Bild', licensed: 'Lizenziert (mit Quelle)', generated: 'KI-generiert (wird gekennzeichnet)' };
export const ImageUsage = z.object({
  origin: ImageUsageOrigin,
  /** Licence or source (required for `licensed`). */
  source: z.string().trim().max(300).default(''),
}).refine((u) => u.origin !== 'licensed' || u.source.length >= 3, { message: 'Lizenzierte Bilder brauchen eine Quelle (Lizenz, Link oder Fotograf:in).' });
export type ImageUsage = z.infer<typeof ImageUsage>;

export const IMAGE_FADE_SEC = 0.15;
export const MAX_IMAGES_PER_CLIP = 4;
/** Width of an image per size step (px); the height follows the aspect ratio. */
export const IMAGE_WIDTH: Record<SizeStep, number> = { S: 360, M: 540, L: 720 };
/** Tallest image box (keeps a portrait photo below the label zone when centred). */
export const IMAGE_MAX_H = 1100;

/** One image on one clip, in SOURCE time of the take. */
export const ClipImage = z.object({
  kind: z.literal('image').default('image'),
  referenceId: z.string().trim().min(1).max(100),
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().positive(),
  /** Width ÷ height of the image (read from the file when it is placed). */
  aspect: z.number().finite().min(0.2).max(5),
  /** Centre in normalised picture coordinates; absent = middle of the content area. */
  pos: NormPos.optional(),
  size: SizeStep.default('M'),
  /** 150 ms fade in and out. */
  fade: z.boolean().default(true),
}).refine((o) => o.endSec > o.startSec, { message: 'Bild: Ende muss nach dem Anfang liegen.' });
export type ClipImage = z.infer<typeof ClipImage>;

const even = (n: number) => 2 * Math.round(n / 2);
/** Width and height (even px) of an image box. */
export function imageSize(o: Pick<ClipImage, 'aspect' | 'size'>): { w: number; h: number } {
  let w = IMAGE_WIDTH[o.size], h = even(w / o.aspect);
  if (h > IMAGE_MAX_H) { h = IMAGE_MAX_H; w = even(h * o.aspect); }
  return { w: Math.max(2, Math.min(PLAY_RES.width, w)), h: Math.max(2, h) };
}
/** Default centre: the middle of the content area (the centre slot). */
export const IMAGE_DEFAULT_CENTER = { cx: PLAY_RES.width / 2, cy: Math.round(slotY('center')) } as const;

const fit = (c: number, lo: number, hi: number, size: number) => {
  const min = Math.ceil(lo + size / 2), max = Math.floor(hi - size / 2);
  return min > max ? Math.round((lo + hi) / 2) : Math.min(max, Math.max(min, Math.round(c)));
};
/** Box of an image (whole pixels): centred at `pos` (or the default centre), kept inside the picture. */
export function imageBox(o: Pick<ClipImage, 'aspect' | 'size' | 'pos'>): Box {
  const { w, h } = imageSize(o);
  const c = o.pos ? posCenter(o.pos) : IMAGE_DEFAULT_CENTER;
  // the default position also keeps clear of the label zone (a tall image moves down); a free one is checked by the validator
  const area = o.pos ? FRAME : { ...FRAME, y0: LABEL_ZONE.y1 };
  const cx = fit(c.cx, area.x0, area.x1, w), cy = fit(c.cy, area.y0, area.y1, h);
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/** Where a dragged image lands (centre px): inside the picture and below the AI-label zone (the stage never covers it). */
export function placeImage(o: Pick<ClipImage, 'aspect' | 'size'>, cx: number, cy: number): NormPos {
  const { w, h } = imageSize(o);
  return toNormPos(fit(cx, 0, PLAY_RES.width, w), fit(cy, LABEL_ZONE.y1, PLAY_RES.height, h));
}

/** Opacity of an image at output time t (linear 150 ms fades, like FFmpeg's `fade` with alpha). */
export function imageAlphaAt(o: { startSec: number; endSec: number; fade: boolean }, t: number): number {
  if (t < o.startSec || t >= o.endSec) return 0;
  if (!o.fade) return 1;
  const a = Math.min(1, (t - o.startSec) / IMAGE_FADE_SEC, (o.endSec - t) / IMAGE_FADE_SEC);
  return Math.max(0, Math.round(a * 1000) / 1000);
}

export interface TimedImage { clip: number; index: number; referenceId: string; startSec: number; endSec: number; box: Box; fade: boolean; size: SizeStep; aspect: number; pos?: NormPos }

/** Images on the output timeline: one contiguous span each (no blinking at cuts); one entirely inside a cut is dropped. */
export function timedImages(body: { clips: readonly { images?: readonly ClipImage[] }[] }, tl: Timeline): { images: TimedImage[]; dropped: { clip: number; index: number }[] } {
  const images: TimedImage[] = [];
  const dropped: { clip: number; index: number }[] = [];
  body.clips.forEach((c, ci) => (c.images ?? []).forEach((o, k) => {
    const span = mapSpan(tl, ci, o.startSec, o.endSec);
    if (!span || span.endSec - span.startSec < 0.05) { dropped.push({ clip: ci, index: k }); return; }
    images.push({ clip: ci, index: k, referenceId: o.referenceId, ...span, box: imageBox(o), fade: o.fade, size: o.size, aspect: o.aspect, ...(o.pos ? { pos: o.pos } : {}) });
  }));
  return { images, dropped };
}

/** What the validator knows about a library image (from the store, never from the client). */
export interface ImageAssetInfo { kind: 'image' | 'video'; usage: ImageUsage | null; mime?: string }
/** Still formats FFmpeg reads as a looped image input (`-loop 1`); GIF has its own demuxer without that option. */
export const IMAGE_OVERLAY_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

/** Why an image may not be used (null = fine). */
export function imageRightsProblem(info: ImageAssetInfo | undefined): string | null {
  if (!info) return 'Das Bild gibt es in der Bibliothek nicht (mehr).';
  if (info.kind !== 'image') return 'Nur Bilder lassen sich einblenden, keine Videos.';
  if (info.mime && !IMAGE_OVERLAY_MIMES.includes(info.mime)) return 'GIFs lassen sich nicht einblenden – bitte als PNG, JPEG oder WebP hochladen.';
  if (!info.usage) return 'Für dieses Bild ist nicht angegeben, ob es dein eigenes oder lizenziert ist – in der Bibliothek unter „Im Video nutzen“ festlegen.';
  const u = ImageUsage.safeParse(info.usage);
  if (!u.success) return 'Lizenziertes Bild ohne Quelle – Quelle in der Bibliothek ergänzen.';
  return null;
}

/** The AI label over every generated image while it is shown (fixed text, merged when spans touch). */
export function imageDisclosureLabels(images: readonly TimedImage[], isGenerated: (referenceId: string) => boolean, text: string): { startSec: number; endSec: number; text: string }[] {
  return mergeLabelSpans(images.filter((i) => isGenerated(i.referenceId)).map((i) => ({ startSec: i.startSec, endSec: i.endSec, text })));
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Label spans sorted and merged where they overlap or touch (same text). */
export function mergeLabelSpans<L extends { startSec: number; endSec: number; text: string }>(spans: readonly L[]): L[] {
  const out: L[] = [];
  for (const s of [...spans].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)) {
    const last = out[out.length - 1];
    if (last && last.text === s.text && s.startSec <= last.endSec + 0.001) last.endSec = r3(Math.max(last.endSec, s.endSec));
    else out.push({ ...s, startSec: r3(s.startSec), endSec: r3(s.endSec) });
  }
  return out;
}

/** Problems of an image's box: the label zone is an error, Instagram's interface zones are warnings. */
export function imageBoxFindings(box: Box, name: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (intersects(box, LABEL_ZONE)) errors.push(`${name}: liegt im Bereich des KI-Labels und des Instagram-Kopfs (obere 330 px) – dort darf nichts liegen.`);
  if (box.y1 > 1600) warnings.push(`${name}: reicht unten in den Bereich der Instagram-Bildunterschrift.`);
  return { errors, warnings };
}

// ---------- Render ----------

/** One image for the FFmpeg graph: a server path and our numbers only. */
export interface ImageLayer { path: string; x: number; y: number; w: number; h: number; startSec: number; endSec: number; fade: boolean }

/** Render layers from timed images (`pathOf` resolves the library file). */
export const imageLayers = (images: readonly TimedImage[], pathOf: (referenceId: string) => string): ImageLayer[] =>
  images.map((i) => ({ path: pathOf(i.referenceId), x: i.box.x0, y: i.box.y0, w: i.box.x1 - i.box.x0, h: i.box.y1 - i.box.y0, startSec: i.startSec, endSec: i.endSec, fade: i.fade }));
