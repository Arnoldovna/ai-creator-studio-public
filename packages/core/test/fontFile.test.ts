import { describe, expect, it } from 'vitest';
import { FONT_MAX_BYTES, fontFormat, parseFontFile } from '../src/fontFile';

/** Minimal sfnt: a `name` table (Windows, UTF-16BE) and an `OS/2` table with weight and fsSelection. */
function sfnt(magic: number[], names: Record<number, string>, weight = 400, italic = false): Uint8Array {
  const recs = Object.entries(names).map(([id, v]) => ({ id: Number(id), bytes: [...v].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 255]) }));
  const strings = recs.flatMap((r) => r.bytes);
  const nameLen = 6 + recs.length * 12 + strings.length;
  const os2Len = 64;
  const head = 12 + 2 * 16;
  const b = new Uint8Array(head + nameLen + os2Len);
  const dv = new DataView(b.buffer);
  b.set(magic, 0);
  dv.setUint16(4, 2);
  const table = (i: number, tag: string, off: number, len: number) => { b.set([...tag].map((c) => c.charCodeAt(0)), 12 + i * 16); dv.setUint32(12 + i * 16 + 8, off); dv.setUint32(12 + i * 16 + 12, len); };
  table(0, 'name', head, nameLen);
  table(1, 'OS/2', head + nameLen, os2Len);
  dv.setUint16(head + 2, recs.length);
  dv.setUint16(head + 4, 6 + recs.length * 12);
  let off = 0;
  recs.forEach((r, i) => {
    const o = head + 6 + i * 12;
    dv.setUint16(o, 3); dv.setUint16(o + 2, 1); dv.setUint16(o + 4, 0x409); dv.setUint16(o + 6, r.id); dv.setUint16(o + 8, r.bytes.length); dv.setUint16(o + 10, off);
    off += r.bytes.length;
  });
  b.set(strings, head + 6 + recs.length * 12);
  dv.setUint16(head + nameLen + 4, weight);
  dv.setUint16(head + nameLen + 62, italic ? 1 : 0);
  return b;
}

describe('parseFontFile (magic bytes, names, weight)', () => {
  it('reads TTF and OTF names, weight and italic; the ASS name is the full name', () => {
    const ttf = parseFontFile(sfnt([0, 1, 0, 0], { 1: 'Werkstatt Sans', 2: 'Bold', 4: 'Werkstatt Sans Bold', 6: 'WerkstattSans-Bold' }, 700));
    expect(ttf).toMatchObject({ format: 'ttf', family: 'Werkstatt Sans', postscriptName: 'WerkstattSans-Bold', assName: 'Werkstatt Sans Bold', weight: 700, italic: false });
    expect(parseFontFile(sfnt([0x4f, 0x54, 0x54, 0x4f], { 1: 'Fein', 4: 'Fein Italic', 6: 'Fein-Italic' }, 400, true))).toMatchObject({ format: 'otf', italic: true });
  });

  it('refuses everything that is not a single TTF/OTF by content, not by name', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]);
    expect(fontFormat(png)).toBeNull();
    expect(() => parseFontFile(png)).toThrow(expect.objectContaining({ status: 415 }));
    for (const magic of ['ttcf', 'wOFF', 'wOF2'])
      expect(() => parseFontFile(sfnt([...magic].map((c) => c.charCodeAt(0)), { 1: 'X', 4: 'X', 6: 'X' }))).toThrow(/Keine TTF- oder OTF/);
    expect(() => parseFontFile(new Uint8Array(FONT_MAX_BYTES + 1))).toThrow(expect.objectContaining({ status: 413 }));
    // truncated table directory, missing names, names libass cannot take safely
    expect(() => parseFontFile(sfnt([0, 1, 0, 0], { 1: 'X', 4: 'X', 6: 'X' }).subarray(0, 30))).toThrow(/beschädigt/);
    expect(() => parseFontFile(sfnt([0, 1, 0, 0], { 2: 'Regular' }))).toThrow(/ohne Familien- oder PostScript-Namen/);
    expect(() => parseFontFile(sfnt([0, 1, 0, 0], { 1: 'Böse,{Font}', 4: 'Böse,{Font}', 6: 'Bose-Font' }))).toThrow(/libass nicht sicher/);
  });
});
