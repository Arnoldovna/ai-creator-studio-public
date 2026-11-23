import 'server-only';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fmtBytes } from '@studio/core/media';
import { dataDir, MAX_UPLOAD_BYTES } from './env';
import { HttpError } from './errors';

export const ALLOWED_MIME = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
} as const;
export type AllowedMime = keyof typeof ALLOWED_MIME;

/** ISO-BMFF major brands that are video containers (HEIC/AVIF/M4A share the `ftyp` box but are not). */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'mmp4', 'dash', 'MSNV', '3gp4', '3gp5', '3gp6', '3g2a']);

/** Major brands of still-image / audio-only ISO-BMFF files – never accepted as video. */
const NON_VIDEO_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Detect the real type from magic bytes; never trust the client-declared MIME alone. */
export function sniffMime(b: Uint8Array): AllowedMime | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(b, 4, 8) === 'ftyp') {
    const major = ascii(b, 8, 12);
    if (major === 'qt  ') return 'video/quicktime';
    if (NON_VIDEO_BRANDS.has(major)) return null;
    // major brand + compatible brands (box size at offset 0); HEIC/AVIF/M4A list no video brand
    const boxEnd = Math.min(b.length, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0);
    const brands = [major];
    for (let o = 16; o + 4 <= boxEnd; o += 4) brands.push(ascii(b, o, o + 4));
    return brands.some((x) => MP4_BRANDS.has(x)) ? 'video/mp4' : null;
  }
  return null;
}

export function safeFileName(name: string): string {
  const base = path.basename(name).normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (base || 'upload').slice(0, 120);
}

export interface StoredMedia { storagePath: string; mime: AllowedMime; kind: 'image' | 'video'; size: number; sha256: string }

export async function storeUpload(id: string, file: File): Promise<StoredMedia> {
  if (file.size <= 0) throw new HttpError(400, 'Leere Datei');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(400, `Datei über ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) throw new HttpError(400, 'Dateityp nicht unterstützt (PNG, JPEG, WEBP, GIF, MP4, WEBM, MOV)');
  const declared = file.type as AllowedMime;
  if (declared && ALLOWED_MIME[declared] && ALLOWED_MIME[declared].kind !== ALLOWED_MIME[mime].kind)
    throw new HttpError(400, 'Dateiinhalt passt nicht zum angegebenen Typ');
  const storagePath = `media/${id}.${ALLOWED_MIME[mime].ext}`;
  await writeBytes(storagePath, bytes);
  return { storagePath, mime, kind: ALLOWED_MIME[mime].kind, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const SNIFF_BYTES = 64;

/**
 * Streams a request body to disk without buffering it: size limit enforced while reading, SHA-256 computed on the fly,
 * type detected from the first bytes (only `kinds` accepted). Writes to a `.part` file and renames on success,
 * so an aborted or rejected upload never leaves a usable file behind.
 */
export async function storeUploadStream(
  storageBase: string, body: ReadableStream<Uint8Array> | null, opts: { maxBytes: number; kinds: ('image' | 'video')[]; tooLargeMessage?: string },
): Promise<StoredMedia> {
  if (!body) throw new HttpError(400, 'Leere Datei');
  const partPath = `${storageBase}.part`;
  const partAbs = absolutePath(partPath);
  await mkdir(path.dirname(partAbs), { recursive: true });
  const out = createWriteStream(partAbs, { flags: 'wx' });
  const done = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  done.catch(() => undefined); // observed below; never an unhandled rejection
  const hash = createHash('sha256');
  let size = 0, head = new Uint8Array(0), mime: AllowedMime | null = null;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      size += value.byteLength;
      if (size > opts.maxBytes) throw new HttpError(413, opts.tooLargeMessage ?? `Datei über ${fmtBytes(opts.maxBytes)}`);
      if (!mime && head.byteLength < SNIFF_BYTES) {
        const next = new Uint8Array(head.byteLength + value.byteLength);
        next.set(head); next.set(value, head.byteLength);
        head = next;
        if (head.byteLength >= SNIFF_BYTES) mime = acceptedMime(head, opts.kinds);
      }
      hash.update(value);
      // A write error (disk full, permissions) rejects `done`; never wait for a 'drain' that will not come.
      if (!out.write(value)) await Promise.race([new Promise((r) => out.once('drain', r)), done]);
    }
    if (size === 0) throw new HttpError(400, 'Leere Datei');
    mime ??= acceptedMime(head, opts.kinds);
    out.end();
    await done;
  } catch (e) {
    reader.cancel().catch(() => undefined);
    // Wait until the (asynchronously opened) file is closed, otherwise it could reappear after the cleanup.
    const closed = out.closed ? Promise.resolve() : new Promise((r) => out.once('close', r));
    out.destroy();
    await closed;
    await rm(partAbs, { force: true });
    throw e;
  }
  const storagePath = `${storageBase}.${ALLOWED_MIME[mime].ext}`;
  await rename(partAbs, absolutePath(storagePath));
  return { storagePath, mime, kind: ALLOWED_MIME[mime].kind, size, sha256: hash.digest('hex') };
}

function acceptedMime(head: Uint8Array, kinds: ('image' | 'video')[]): AllowedMime {
  const mime = sniffMime(head);
  if (!mime || !kinds.includes(ALLOWED_MIME[mime].kind))
    throw new HttpError(400, `Dateityp nicht unterstützt (erlaubt: ${Object.entries(ALLOWED_MIME).filter(([, v]) => kinds.includes(v.kind)).map(([, v]) => v.ext.toUpperCase()).join(', ')})`);
  return mime;
}

/** Resolve a stored relative path, refusing anything that escapes the data dir. */
export function absolutePath(storagePath: string): string {
  const root = dataDir();
  const abs = path.resolve(root, storagePath);
  if (!abs.startsWith(root + path.sep)) throw new HttpError(400, 'Ungültiger Speicherpfad');
  return abs;
}

export async function writeBytes(storagePath: string, bytes: Uint8Array) {
  const abs = absolutePath(storagePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

export const readMedia = (storagePath: string) => readFile(absolutePath(storagePath));
export const deleteMedia = (storagePath: string) => rm(absolutePath(storagePath), { force: true });
/** Best-effort cleanup after DB rows are gone: a missing or locked file must not fail the request. */
export const deleteMediaFiles = (paths: string[]) => Promise.all(paths.map((p) => deleteMedia(p).catch(() => undefined)));

export const mimeForPath = (p: string): string => {
  const ext = path.extname(p).slice(1);
  const hit = Object.entries(ALLOWED_MIME).find(([, v]) => v.ext === ext);
  return hit ? hit[0] : 'application/octet-stream';
};

export async function sha256File(abs: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}
