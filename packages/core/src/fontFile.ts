/**
 * Reads the metadata of an uploaded font file (Etappe 14): TrueType (`00 01 00 00` / `true`) or OpenType CFF
 * (`OTTO`) only, checked by magic bytes, never by the file name. Collections (`ttcf`), WOFF/WOFF2 and anything else
 * are refused. Pure; reads only the table directory and the `name`, `OS/2` and `head` tables, with bounds checks.
 */
import { ValidationError } from './schemas';

export const FONT_MAX_BYTES = 10 * 1024 * 1024;
export interface FontFileInfo {
  format: 'ttf' | 'otf'; family: string; subfamily: string; fullName: string; postscriptName: string; weight: number; italic: boolean;
  /** Name for the ASS style (libass matches full names of `fontsdir` fonts): the full name, else the family. */
  assName: string;
  /** Etappe 16b: licence description (name ID 13, shortened) and licence URL (ID 14) as the file states them; '' when absent. */
  licenseText: string; licenseUrl: string;
}

const bad = (msg: string) => new ValidationError(msg, 415);

/** Magic bytes of the formats libass and browsers both load from a file. */
export function fontFormat(b: Uint8Array): 'ttf' | 'otf' | null {
  if (b.length < 12) return null;
  const tag = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);
  if (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return 'ttf';
  if (tag === 'true') return 'ttf';
  if (tag === 'OTTO') return 'otf';
  return null;
}

function decodeName(b: Uint8Array, platform: number, start: number, length: number): string {
  if (platform === 3 || platform === 0) {
    let s = '';
    for (let i = start; i + 1 < start + length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return s;
  }
  return String.fromCharCode(...b.subarray(start, start + length)); // Mac Roman: ASCII part is enough for names
}

export function parseFontFile(bytes: Uint8Array): FontFileInfo {
  if (bytes.length > FONT_MAX_BYTES) throw new ValidationError(`Schriftdatei zu groß (max. ${FONT_MAX_BYTES / 1024 / 1024} MB).`, 413);
  const format = fontFormat(bytes);
  if (!format) throw bad('Keine TTF- oder OTF-Schriftdatei (Sammlungen .ttc und WOFF werden nicht unterstützt).');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => { if (o < 0 || o + 2 > bytes.length) throw bad('Schriftdatei ist beschädigt.'); return dv.getUint16(o); };
  const u32 = (o: number) => { if (o < 0 || o + 4 > bytes.length) throw bad('Schriftdatei ist beschädigt.'); return dv.getUint32(o); };
  const numTables = u16(4);
  if (numTables < 1 || numTables > 200) throw bad('Schriftdatei ist beschädigt.');
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(bytes[r]!, bytes[r + 1]!, bytes[r + 2]!, bytes[r + 3]!);
    const offset = u32(r + 8), length = u32(r + 12);
    if (offset + length > bytes.length) throw bad('Schriftdatei ist beschädigt.');
    tables.set(tag, { offset, length });
  }
  const name = tables.get('name');
  if (!name) throw bad('Schriftdatei ohne Namenstabelle.');
  const count = u16(name.offset + 2), strings = name.offset + u16(name.offset + 4);
  const found = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < Math.min(count, 2000); i++) {
    const r = name.offset + 6 + i * 12;
    const platform = u16(r), encoding = u16(r + 2), language = u16(r + 4), id = u16(r + 6), length = u16(r + 8), off = u16(r + 10);
    if (![1, 2, 4, 6, 13, 14, 16, 17].includes(id)) continue;
    const start = strings + off;
    if (start + length > name.offset + name.length || start + length > bytes.length) continue;
    // Windows English first, then any Windows/Unicode, then Mac Roman
    const score = platform === 3 && language === 0x409 ? 3 : platform === 3 || platform === 0 ? 2 : platform === 1 && encoding === 0 ? 1 : 0;
    if (!score || (found.get(id)?.score ?? 0) >= score) continue;
    found.set(id, { score, value: decodeName(bytes, platform, start, length).split('').filter((ch) => ch.charCodeAt(0) >= 0x20).join('').trim() });
  }
  const get = (id: number) => found.get(id)?.value ?? '';
  const family = (get(16) || get(1)).slice(0, 60);
  const subfamily = (get(17) || get(2)).slice(0, 60);
  const postscriptName = get(6).slice(0, 63);
  if (!family || !postscriptName) throw bad('Schriftdatei ohne Familien- oder PostScript-Namen.');
  let weight = 400, italic = /italic|oblique/i.test(subfamily);
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 64) {
    weight = u16(os2.offset + 4) || 400;
    italic ||= (u16(os2.offset + 62) & 1) === 1;
  }
  const head = tables.get('head');
  if (head && head.length >= 46) italic ||= (u16(head.offset + 44) & 2) === 2;
  const fullName = get(4).slice(0, 120);
  const assName = [fullName, family].find((n) => /^[A-Za-z0-9 _-]{1,63}$/.test(n));
  if (!assName) throw bad('Der Name der Schrift enthält Zeichen, die libass nicht sicher verarbeitet (erlaubt: A–Z, 0–9, Leerzeichen, - und _).');
  const licenseText = get(13).replace(/\s+/g, ' ').slice(0, 1000), licenseUrl = get(14).slice(0, 300);
  return { format, family, subfamily, fullName, postscriptName, weight: Math.max(1, Math.min(1000, weight)), italic, assName, licenseText, licenseUrl };
}
