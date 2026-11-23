/**
 * Geometry of everything burned into the 9:16 picture (Etappe 13, E6): ONE source for the ASS writer (overlays.ts), the
 * browser stage of the editor and the validator. Split out of overlays.ts; overlays.ts re-exports everything that was
 * exported there before, so existing imports keep working. Pure and deterministic, PlayRes 1080×1920.
 *
 * - Slot elements (no `pos`) keep the Etappe-8 boxes byte for byte (fixed bands inside the content area).
 * - A free position (`pos`, Etappe 13) is the CENTRE of the element in normalised picture coordinates (0..1). The box is
 *   kept inside the picture; the KI-Label zone (top 330 px) is an error, Instagram's interface zones are warnings
 *   (`freeBoxFindings`). The editor's drag goes through `placeElement`, which also keeps the box out of the label zone.
 */
import { z } from 'zod';

export const PLAY_RES = { width: 1080, height: 1920 } as const;

export const Slot = z.enum(['upper', 'center', 'lower']);
export type Slot = z.infer<typeof Slot>;
export const OverlayKind = z.enum(['lower_third', 'keyword', 'arrow', 'frame']);
export type OverlayKind = z.infer<typeof OverlayKind>;
export const ArrowDirection = z.enum(['left', 'right', 'up', 'down']);
export type ArrowDirection = z.infer<typeof ArrowDirection>;

/** Free position of an element: its centre in normalised picture coordinates (x 0 = left, y 0 = top). */
export const NormPos = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) });
export type NormPos = z.infer<typeof NormPos>;

export interface Box { x0: number; y0: number; x1: number; y1: number }
export const intersects = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
export const inside = (a: Box, b: Box) => a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1;
/** The whole picture. */
export const FRAME: Box = { x0: 0, y0: 0, x1: PLAY_RES.width, y1: PLAY_RES.height };
/** Top of the picture: Instagram header and the AI label (Label style, MarginV 170). Nothing else goes here. */
export const LABEL_ZONE: Box = { x0: 0, y0: 0, x1: 1080, y1: 330 };
/**
 * Subtitles at the legacy position: bottom-centred, baseline 380 px above the bottom (y 1540); two lines of 64 px plus
 * outline reach up to about y 1380. Slot overlays stay above it.
 */
export const SUBTITLE_BAND: Box = { x0: 0, y0: 1360, x1: 1080, y1: 1920 };
/** The area all slot elements and a slot hook live in (inside the frame). */
export const CONTENT_AREA: Box = { x0: 42, y0: 352, x1: 1038, y1: 1180 };
/** Three bands of equal height inside the content area; an element never leaves its slot's band. */
export const SLOT_BAND: Record<Slot, Box> = {
  upper: { x0: 42, y0: 352, x1: 1038, y1: 628 },
  center: { x0: 42, y0: 628, x1: 1038, y1: 904 },
  lower: { x0: 42, y0: 904, x1: 1038, y1: 1180 },
};
export const slotY = (s: Slot) => (SLOT_BAND[s].y0 + SLOT_BAND[s].y1) / 2;
/** The frame overlay: four 12 px bars around the content area (no reversed-rectangle hole: same in every renderer). */
export const FRAME_BARS: Box[] = [
  { x0: 30, y0: 340, x1: 1050, y1: 352 },
  { x0: 30, y0: 1180, x1: 1050, y1: 1192 },
  { x0: 30, y0: 352, x1: 42, y1: 1180 },
  { x0: 1038, y0: 352, x1: 1050, y1: 1180 },
];

/**
 * Zones of the 9:16 frame the stage shades: where Instagram's own interface usually sits (header, caption and the action
 * column; approximate, it differs per device and app version) and the AI label zone of the render.
 */
export const STAGE_ZONES = {
  label: { x0: 0, y0: 0, x1: 1080, y1: 330, title: 'KI-Label / oben (Instagram-Kopf)' },
  caption: { x0: 0, y0: 1600, x1: 1080, y1: 1920, title: 'Instagram: Bildunterschrift, Profil' },
  actions: { x0: 940, y0: 1000, x1: 1080, y1: 1600, title: 'Instagram: Gefällt mir, Kommentare, Teilen' },
} as const;

/** Average advance of a bold sans glyph relative to the font size (conservative: capitals are wide). */
export const CHAR_W = 0.62;
const fitSize = (len: number, width: number, max: number, min: number) => Math.max(min, Math.min(max, Math.floor(width / (Math.max(1, len) * CHAR_W))));
/** Lower third: a 864×150 bar; the text starts 36 px right of its left edge (x 108 in its slot). */
export const LOWER_THIRD = { x0: 72, width: 864, height: 150, stripe: 12, textX: 108, textWidth: 800 } as const;
export const LOWER_THIRD_TEXT_INSET = LOWER_THIRD.textX - LOWER_THIRD.x0;
export const KEYWORD_PAD = 18;
export const ARROW_SIZE = 180;
export const HOOK_PAD = 18;

/** Even pixel size of a scaled maximum (scale 1 = the Etappe-8 value, unchanged). */
export const scaled = (size: number, scale = 1) => (scale === 1 ? size : 2 * Math.round((size * scale) / 2));

/**
 * Font size of a single-line text element (lower third, keyword). `scale` is the size step (S 0.85, M 1, L 1.15): it
 * scales the largest size; the width limit still applies, so the text stays in its band.
 */
export function overlayFontSize(kind: 'lower_third' | 'keyword', text: string, scale = 1): number {
  return kind === 'lower_third' ? fitSize(text.length, LOWER_THIRD.textWidth, scaled(60, scale), 30) : fitSize(text.length, 900 - 2 * KEYWORD_PAD, scaled(84, scale), 40);
}

/** Pixel centre of a free position (whole pixels, so ASS `\pos` and the DOM agree). */
export const posCenter = (p: NormPos) => ({ cx: Math.round(p.x * PLAY_RES.width), cy: Math.round(p.y * PLAY_RES.height) });
/** Normalised position of a pixel centre (4 decimals: back to the same whole pixel). */
export const toNormPos = (cx: number, cy: number): NormPos => ({ x: Math.round((cx / PLAY_RES.width) * 1e4) / 1e4, y: Math.round((cy / PLAY_RES.height) * 1e4) / 1e4 });

/** Whole-pixel centre that keeps a w×h box inside `area` (a box larger than the area is centred on it). */
function clampCenter(cx: number, cy: number, w: number, h: number, area: Box) {
  const fit = (c: number, lo: number, hi: number, size: number) => {
    const min = Math.ceil(lo + size / 2), max = Math.floor(hi - size / 2);
    return min > max ? Math.round((lo + hi) / 2) : Math.min(max, Math.max(min, Math.round(c)));
  };
  return { cx: fit(cx, area.x0, area.x1, w), cy: fit(cy, area.y0, area.y1, h) };
}
const boxAt = (cx: number, cy: number, w: number, h: number): Box => ({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 });

export interface LayoutElement { kind: OverlayKind; text: string; slot: Slot; scale?: number; pos?: NormPos }

/** Width and height of an element's box (frames: the outer rectangle of their bars). */
export function elementSize(o: Pick<LayoutElement, 'kind' | 'text' | 'scale'>): { w: number; h: number } {
  switch (o.kind) {
    case 'lower_third': return { w: LOWER_THIRD.width, h: LOWER_THIRD.height };
    case 'keyword': {
      const s = overlayFontSize('keyword', o.text, o.scale);
      return { w: Math.ceil(o.text.length * CHAR_W * s) + 2 * KEYWORD_PAD, h: Math.ceil(s * 1.25) + 2 * KEYWORD_PAD };
    }
    case 'arrow': return { w: ARROW_SIZE, h: ARROW_SIZE };
    case 'frame': return { w: FRAME_BARS[0]!.x1 - FRAME_BARS[0]!.x0, h: FRAME_BARS[1]!.y1 - FRAME_BARS[0]!.y0 };
  }
}

/** Bounding box of one element: its slot box (Etappe 8, unchanged) or, with `pos`, centred there inside the picture. Frames never move. */
export function overlayBox(o: LayoutElement): Box {
  if (o.kind === 'frame') return { x0: FRAME_BARS[0]!.x0, y0: FRAME_BARS[0]!.y0, x1: FRAME_BARS[1]!.x1, y1: FRAME_BARS[1]!.y1 };
  const { w, h } = elementSize(o);
  if (o.pos) {
    const c = posCenter(o.pos);
    const { cx, cy } = clampCenter(c.cx, c.cy, w, h, FRAME);
    return boxAt(cx, cy, w, h);
  }
  const cy = slotY(o.slot);
  switch (o.kind) {
    case 'lower_third':
      return { x0: LOWER_THIRD.x0, y0: cy - LOWER_THIRD.height / 2, x1: LOWER_THIRD.x0 + LOWER_THIRD.width, y1: cy + LOWER_THIRD.height / 2 };
    case 'keyword':
    case 'arrow':
      return { x0: 540 - w / 2, y0: cy - h / 2, x1: 540 + w / 2, y1: cy + h / 2 };
  }
}

/** Boxes an element really paints (a frame paints only its four bars, so content inside it does not collide). */
export const paintedBoxes = (o: LayoutElement): Box[] => (o.kind === 'frame' ? FRAME_BARS : [overlayBox(o)]);

/** Greedy word wrap by estimated width; a word longer than a line stays whole (and is measured as such). */
function wrap(text: string, size: number, width: number): string[] {
  const max = Math.max(1, Math.floor(width / (size * CHAR_W)));
  const lines: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + w.length <= max) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines;
}

const HOOK_SIZES = [96, 84, 72, 64, 56] as const;
const HOOK_WIDTH = 900;
const HOOK_MAX_LINES = 4;
export interface HookLayout { size: number; lines: string[]; x: number; y: number; box: Box }
/**
 * Size, line breaks and position of the hook: the largest size that needs ≤ 3 lines (≤ 4 at the smallest). In its slot it
 * is centred on the slot and moved so the whole box stays inside the content area (never into the label zone); with a
 * free `pos` it is centred there and kept inside the picture. null = too long for the picture.
 */
export function hookLayout(text: string, slot: Slot, scale = 1, pos?: NormPos): HookLayout | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const sizes = HOOK_SIZES.map((x) => scaled(x, scale));
  for (const size of sizes) {
    const lines = wrap(clean, size, HOOK_WIDTH);
    const widest = Math.max(...lines.map((l) => l.length)) * CHAR_W * size;
    if (widest > HOOK_WIDTH || lines.length > (size === sizes[sizes.length - 1] ? HOOK_MAX_LINES : 3)) continue;
    // even sizes and integer centre: the box edges are whole pixels, and the clamp never rounds past the area
    const h = 2 * Math.ceil((lines.length * size * 1.2) / 2) + 2 * HOOK_PAD, w = 2 * Math.ceil(widest / 2) + 2 * HOOK_PAD;
    if (pos) {
      const c = posCenter(pos);
      const { cx, cy } = clampCenter(c.cx, c.cy, w, h, FRAME);
      return { size, lines, x: cx, y: cy, box: boxAt(cx, cy, w, h) };
    }
    const y = Math.min(CONTENT_AREA.y1 - h / 2, Math.max(CONTENT_AREA.y0 + h / 2, Math.round(slotY(slot))));
    return { size, lines, x: 540, y, box: { x0: 540 - w / 2, y0: y - h / 2, x1: 540 + w / 2, y1: y + h / 2 } };
  }
  return null;
}

// ---------- Free placement (editor drag) ----------

/** An element as the stage drags it: an overlay, or the hook (`kind: 'hook'`). */
export type PlaceTarget = { kind: OverlayKind; text: string; scale?: number } | { kind: 'hook'; text: string; scale?: number };

function targetBox(t: PlaceTarget, slot: Slot, pos?: NormPos): Box | null {
  if (t.kind === 'hook') return hookLayout(t.text, slot, t.scale ?? 1, pos)?.box ?? null;
  return overlayBox({ kind: t.kind, text: t.text, slot, scale: t.scale, pos });
}
const center = (b: Box) => ({ cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 });

/** Centre (px) of an element in each slot: dropping it there puts it back into the slot (no free position). */
export function slotAnchors(t: PlaceTarget): { slot: Slot; cx: number; cy: number }[] {
  return Slot.options.flatMap((slot) => {
    const b = targetBox(t, slot);
    return b ? [{ slot, ...center(b) }] : [];
  });
}

/** Snap distance of the stage drag (PlayRes pixels). */
export const SNAP_PX = 28;

export interface Placement {
  /** Set when the element snapped into a slot (then `pos` is absent and the Etappe-8 slot layout applies). */
  slot?: Slot;
  pos?: NormPos;
  /** What it snapped to, for the stage hint. */
  snapped: 'slot' | 'center' | 'middle' | null;
}

/**
 * Where a dragged element lands when its centre is dropped at (cx, cy) px: inside the picture and below the label zone
 * (the stage can never place anything over the AI label), snapped into a slot when its slot centre is near, else to the
 * horizontal centre line and the vertical middle of the picture. Frames do not move (`null`). `free` skips snapping (Alt).
 */
export function placeElement(t: PlaceTarget, cx: number, cy: number, opts: { free?: boolean; tolerance?: number } = {}): Placement | null {
  if (t.kind === 'frame') return null;
  const probe = targetBox(t, 'center', { x: 0.5, y: 0.5 });
  if (!probe) return null;
  const w = probe.x1 - probe.x0, h = probe.y1 - probe.y0;
  const allowed: Box = { x0: 0, y0: LABEL_ZONE.y1, x1: PLAY_RES.width, y1: PLAY_RES.height };
  let c = clampCenter(cx, cy, w, h, allowed);
  const tol = opts.tolerance ?? SNAP_PX;
  if (!opts.free) {
    const hit = slotAnchors(t).find((a) => Math.abs(a.cx - c.cx) <= tol && Math.abs(a.cy - c.cy) <= tol);
    if (hit) return { slot: hit.slot, snapped: 'slot' };
    let snapped: Placement['snapped'] = null;
    const midX = t.kind === 'lower_third' ? LOWER_THIRD.x0 + LOWER_THIRD.width / 2 : PLAY_RES.width / 2;
    if (Math.abs(c.cx - midX) <= tol) { c = { ...c, cx: midX }; snapped = 'center'; }
    if (Math.abs(c.cy - PLAY_RES.height / 2) <= tol) { c = clampCenter(c.cx, PLAY_RES.height / 2, w, h, allowed); snapped = 'middle'; }
    return { pos: toNormPos(c.cx, c.cy), snapped };
  }
  return { pos: toNormPos(c.cx, c.cy), snapped: null };
}

/**
 * Problems of an element at a free position: the AI-label zone is an error (nothing may cover the disclosure or the
 * Instagram header), Instagram's caption and action column are warnings (covered on most phones), and burned
 * subtitles at the same height are a warning.
 */
export function freeBoxFindings(box: Box, name: string, subtitles?: Box | null): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (intersects(box, LABEL_ZONE)) errors.push(`${name}: liegt im Bereich des KI-Labels und des Instagram-Kopfs (obere 330 px) – dort darf nichts liegen.`);
  if (intersects(box, STAGE_ZONES.caption)) warnings.push(`${name}: liegt unten im Bereich der Instagram-Bildunterschrift – wird dort meist verdeckt.`);
  if (intersects(box, STAGE_ZONES.actions)) warnings.push(`${name}: liegt unter den Instagram-Knöpfen rechts (Gefällt mir, Kommentare).`);
  if (subtitles && intersects(box, subtitles)) warnings.push(`${name}: liegt im Bereich der eingebrannten Untertitel.`);
  return { errors, warnings };
}

// ---------- Subtitles ----------

/** Legacy subtitle position: ASS MarginV 380, i.e. the bottom edge of the text at y 1540 (80.2 % of the height). */
export const SUBTITLE_MARGIN_V_LEGACY = 380;
/**
 * Vertical subtitle position `subtitleY` = bottom edge of the subtitle text as a share of the height. Plans without it
 * keep the legacy 80.2 %. New drafts start at 72 % (y 1382): Instagram's caption, profile and audio row cover roughly
 * the bottom 17 % (from y ~1600, `STAGE_ZONES.caption`) and grow when the caption opens; Meta's own Reels guidance keeps
 * text out of a larger bottom band. At 72 % two lines (≈ y 1220–1382) end ~220 px above the caption zone and still lie
 * below the lowest overlay slot (ends at y 1180), so lower thirds and subtitles do not collide.
 */
export const SUBTITLE_Y = { min: 0.5, max: 0.85, legacy: (PLAY_RES.height - SUBTITLE_MARGIN_V_LEGACY) / PLAY_RES.height, recommended: 0.72 } as const;
export const SubtitleY = z.number().finite().min(SUBTITLE_Y.min).max(SUBTITLE_Y.max);
/** ASS MarginV of the subtitle style (bottom-aligned): 380 for plans without `subtitleY`. */
export const subtitleMarginV = (y?: number | null) => (y == null ? SUBTITLE_MARGIN_V_LEGACY : Math.round(PLAY_RES.height * (1 - y)));
/** Font size of the subtitles (64 px at size M). */
export const SUBTITLE_SIZE = 64;
/** Area two subtitle lines cover (ASS margins 90 px left/right), for the stage and the overlap warning. */
export function subtitleBox(y?: number | null, scale = 1): Box {
  const bottom = PLAY_RES.height - subtitleMarginV(y);
  const size = scaled(SUBTITLE_SIZE, scale);
  return { x0: 90, y0: bottom - Math.ceil(2 * size * 1.2) - 8, x1: 990, y1: bottom + 8 };
}
