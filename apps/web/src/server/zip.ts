import 'server-only';
import { open, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

/**
 * Etappe 17: a small ZIP writer for the finish package (STORE only: videos do not compress, the texts are small).
 * CRC and size of every entry are known BEFORE its header is written (files are read twice), so the archive has no data
 * descriptors and every unzip tool, Finder included, reads it. UTF-8 names (flag bit 11). No ZIP64: an entry or the
 * whole archive above 4 GiB is refused with a clear message instead of a broken file.
 * `prepareZip` opens every file and checks names, sizes and the 4-GiB limits BEFORE anything is sent; each file is then
 * read twice through the same handle (CRC, then data), so a file replaced on disk in between cannot give a wrong CRC.
 */
export type ZipEntry = { name: string; data: string | Uint8Array } | { name: string; file: string };

const LIMIT = 0xffffffff;
const enc = new TextEncoder();

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Entry names: relative, forward slashes, no `..`, no absolute paths, no control characters. */
export function safeEntryName(name: string): string {
  if (!name || /[\u0000-\u001f\\]/.test(name) || name.startsWith('/') || name.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`Ungültiger Dateiname im Paket: ${name.slice(0, 80)}`);
  return name;
}

const CHUNK = 1 << 20;
/** Reads [0, size) of an open file in chunks (positional reads: the handle can be read several times). */
async function* chunks(h: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  for (let pos = 0; pos < size;) {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
    const { bytesRead } = await h.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) throw new Error('Datei wurde beim Packen kürzer.');
    pos += bytesRead;
    yield buf.subarray(0, bytesRead);
  }
}

type Prepared = { name: Uint8Array; label: string; data: Uint8Array | null; handle: FileHandle | null; size: number };
export interface PreparedZip { entries: Prepared[]; close: () => Promise<void> }

/** Opens and checks everything up front (throws before any byte is sent). Call `close` when done (zipStream does it). */
export async function prepareZip(entries: readonly ZipEntry[]): Promise<PreparedZip> {
  const out: Prepared[] = [];
  const close = async () => { await Promise.all(out.map((p) => p.handle?.close().catch(() => undefined))); };
  try {
    const seen = new Set<string>();
    let offset = 0, cd = 0;
    for (const e of entries) {
      const name = enc.encode(safeEntryName(e.name));
      if (seen.has(e.name)) throw new Error(`Doppelter Dateiname im Paket: ${e.name}`);
      seen.add(e.name);
      const data = 'data' in e ? (typeof e.data === 'string' ? enc.encode(e.data) : e.data) : null;
      let handle: FileHandle | null = null;
      if (!data) {
        handle = await open((e as { file: string }).file, 'r').catch(() => { throw new Error(`Datei für das Paket fehlt: ${e.name}`); });
      }
      const size = data ? data.length : (await handle!.stat()).size;
      out.push({ name, label: e.name, data, handle, size });
      offset += 30 + name.length + size;
      cd += 46 + name.length;
      if (size >= LIMIT || offset + cd + 22 >= LIMIT) throw new Error('Das Paket wäre größer als 4 GB – bitte ohne Alpha-Ebene oder kürzer exportieren.');
    }
    if (out.length > 0xffff) throw new Error('Zu viele Dateien im Paket.');
    return { entries: out, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The archive as a stream of chunks (for a Response body or a file); closes the prepared handles at the end. */
export async function* zipStream(input: readonly ZipEntry[] | PreparedZip, at = new Date()): AsyncGenerator<Uint8Array> {
  const prepared = Array.isArray(input) ? await prepareZip(input as readonly ZipEntry[]) : (input as PreparedZip);
  try {
    yield* writeZip(prepared.entries, at);
  } finally {
    await prepared.close();
  }
}

async function* writeZip(entries: readonly Prepared[], at: Date): AsyncGenerator<Uint8Array> {
  const { time, date } = dosTime(at);
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const { name, data, handle, size } = e;
    let crc = 0;
    if (data) crc = crc32(data) >>> 0;
    else { for await (const c of chunks(handle!, size)) crc = crc32(c, crc); crc >>>= 0; }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    yield local;
    yield name;
    if (data) yield data;
    else {
      let again = 0;
      for await (const c of chunks(handle!, size)) { again = crc32(c, again); yield c; }
      if (again >>> 0 !== crc) throw new Error(`Datei hat sich beim Packen geändert: ${e.label}`);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(size, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attributes
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  for (const b of central) yield b;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}
