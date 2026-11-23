/**
 * Footage for Release 3 (Hybrid Video): upload metadata with rights provenance and the ffprobe parser.
 * Framework-free; ffprobe output is untrusted data and only read field by field.
 */
import { z } from 'zod';

/** Where footage comes from. `generated` is reserved for Higgsfield assets (Release 3, Etappe 7) and never accepted as upload. */
export const FootageOrigin = z.enum(['own', 'licensed', 'client']);
export type FootageOrigin = z.infer<typeof FootageOrigin>;
export const FOOTAGE_ORIGIN_LABEL: Record<FootageOrigin | 'generated', string> = {
  own: 'Eigene Aufnahme', licensed: 'Lizenziert', client: 'Vom Kunden', generated: 'KI-generiert',
};

/**
 * Sent with every upload (query parameters – the body is the raw file stream).
 * Own footage („Eigene Aufnahme“) carries its rights implicitly (Etappe 10); licensed and client footage need
 * the user's rights confirmation and a source/licence note.
 */
export const FootageUploadMeta = z.object({
  name: z.string().trim().min(1).max(200),
  origin: FootageOrigin,
  rightsConfirmed: z.boolean().default(false),
  rightsNote: z.string().trim().max(500).default(''),
}).refine((m) => m.origin === 'own' || m.rightsConfirmed, {
  message: 'Bitte bestätigen, dass du die Rechte an diesem Material hast.', path: ['rightsConfirmed'],
}).refine((m) => m.origin === 'own' || m.rightsNote.length >= 3, {
  message: 'Für lizenziertes oder Kundenmaterial bitte Quelle bzw. Lizenz angeben.', path: ['rightsNote'],
}).transform((m) => (m.origin === 'own' ? { ...m, rightsConfirmed: true, rightsNote: '' } : m));
export type FootageUploadMeta = z.infer<typeof FootageUploadMeta>;

export interface MediaProbe {
  durationSec: number | null;
  /** Coded size of the video stream. */
  width: number | null; height: number | null;
  /** Clockwise rotation needed for display (0/90/180/270), from the display matrix or the legacy `rotate` tag. */
  rotation: 0 | 90 | 180 | 270;
  /** Size as displayed (rotation applied) and the resulting orientation. */
  displayWidth: number | null; displayHeight: number | null;
  orientation: 'portrait' | 'landscape' | 'square' | null;
  fps: number | null;
  videoCodec: string | null; audioCodec: string | null; hasAudio: boolean;
  container: string | null;
}

const num = (x: unknown): number | null => {
  const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (x: unknown, max = 40): string | null => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/** "30000/1001" → 29.97 */
function rate(x: unknown): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(typeof x === 'string' ? x : '');
  if (!m || Number(m[2]) === 0) return null;
  const v = Number(m[1]) / Number(m[2]);
  return v > 0 && v < 1000 ? Math.round(v * 100) / 100 : null;
}

/** ffprobe's display-matrix rotation is counter-clockwise (e.g. -90 for an upright iPhone clip); normalize to clockwise 0..270. */
function rotationOf(stream: Record<string, unknown>): MediaProbe['rotation'] {
  const side = Array.isArray(stream.side_data_list) ? stream.side_data_list.map(obj) : [];
  const fromMatrix = side.map((s) => num(s.rotation)).find((r) => r != null);
  const raw = fromMatrix != null ? -fromMatrix : num(obj(stream.tags).rotate) ?? 0;
  const r = ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
  return r as MediaProbe['rotation'];
}

/** Parses `ffprobe -print_format json -show_format -show_streams`. Throws only on non-JSON; missing fields become null. */
export function parseProbe(json: string): MediaProbe {
  const root = obj(JSON.parse(json));
  const streams = Array.isArray(root.streams) ? root.streams.map(obj) : [];
  const video = streams.find((s) => s.codec_type === 'video' && obj(s.disposition).attached_pic !== 1) ?? null;
  const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
  const format = obj(root.format);
  const width = video ? num(video.width) : null, height = video ? num(video.height) : null;
  const rotation = video ? rotationOf(video) : 0;
  const swap = rotation === 90 || rotation === 270;
  const displayWidth = swap ? height : width, displayHeight = swap ? width : height;
  const duration = num(format.duration) ?? (video ? num(video.duration) : null);
  return {
    durationSec: duration != null && duration >= 0 ? Math.round(duration * 1000) / 1000 : null,
    width, height, rotation, displayWidth, displayHeight,
    orientation: displayWidth && displayHeight ? (displayWidth === displayHeight ? 'square' : displayHeight > displayWidth ? 'portrait' : 'landscape') : null,
    fps: video ? rate(video.avg_frame_rate) ?? rate(video.r_frame_rate) : null,
    videoCodec: video ? str(video.codec_name) : null,
    audioCodec: audio ? str(audio.codec_name) : null,
    hasAudio: !!audio,
    container: str(format.format_name, 80),
  };
}

export const fmtDuration = (sec: number | null) => (sec == null ? '—' : `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`);
export const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
