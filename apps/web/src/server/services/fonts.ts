import 'server-only';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { customFontId, FONT_MAX_BYTES, SYSTEM_FONTS, parseFontFile, type CustomFontInfo, type FontFileInfo, type ResolvedType } from '@studio/core';
import { z } from 'zod';
import { dataDir } from '../env';
import { HttpError } from '../errors';
import { deleteMediaFiles, safeFileName, writeBytes } from '../media';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type Db, type FontRecord } from '../store';

/**
 * Her own font files (Etappe 14): TTF/OTF only (magic bytes, `parseFontFile`), at most 10 MB, a licence note is
 * required. Stored in the data folder under `fonts/`; libass gets that folder (`fontsdir`) when a role uses one,
 * the browser loads it through `GET /api/fonts/[id]` for the preview.
 */
export const FONTS_FOLDER = 'fonts';
export const fontsDir = () => path.join(dataDir(), FONTS_FOLDER);
export const fontInfos = (db: Db): CustomFontInfo[] =>
  (db.fonts ?? []).map((f) => ({ id: f.id, family: f.family, postscriptName: f.postscriptName, assName: f.assName, weight: f.weight, italic: f.italic }));

const License = z.string().trim().min(3, 'Bitte den Lizenzvermerk angeben (z. B. „SIL OFL 1.1“ oder „gekauft, Desktop-Lizenz“).').max(500);
const MIME = { ttf: 'font/ttf', otf: 'font/otf' } as const;

export const listFonts = () => read((db) => [...(db.fonts ?? [])].sort((a, b) => a.family.localeCompare(b.family)));

export async function uploadFont(file: File | null, licenseRaw: unknown): Promise<{ font: FontRecord; duplicate: boolean }> {
  const license = License.parse(licenseRaw);
  if (!file || typeof file.arrayBuffer !== 'function') throw new HttpError(400, 'Keine Schriftdatei.');
  if (file.size > FONT_MAX_BYTES) throw new HttpError(413, `Schriftdatei zu groß (max. ${FONT_MAX_BYTES / 1024 / 1024} MB).`);
  return storeFont(new Uint8Array(await file.arrayBuffer()), file.name, () => ({ note: license }));
}

/**
 * Checks and stores a font file (her upload or, Etappe 16b, a Google Fonts download): magic bytes and tables
 * (`parseFontFile`), size, upright only, SHA-256; one record per file and PostScript name. `license` gets the parsed file
 * (a Google font's note is written from its own licence fields) and may refuse it.
 */
export async function storeFont(bytes: Uint8Array, fileName: string, license: (info: FontFileInfo) => { note: string; origin?: FontRecord['origin'] }): Promise<{ font: FontRecord; duplicate: boolean }> {
  const info = parseFontFile(bytes);
  if (info.italic) throw new HttpError(415, 'Kursive Schnitte werden für Overlays nicht unterstützt – bitte einen aufrechten Schnitt hochladen.');
  const { note, origin } = license(info);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = newId();
  const storagePath = `${FONTS_FOLDER}/${id}.${info.format}`;
  const dup = await read((db) => (db.fonts ?? []).find((f) => f.sha256 === sha256 || f.postscriptName === info.postscriptName) ?? null);
  if (dup) {
    if (dup.sha256 !== sha256) throw new HttpError(409, `Eine Schrift mit dem PostScript-Namen „${info.postscriptName}“ ist schon hochgeladen.`);
    return { font: dup, duplicate: true };
  }
  await writeBytes(storagePath, bytes);
  try {
    const out = await write((db) => {
      // checked again inside the write: two parallel uploads of the same file store one record
      const again = (db.fonts ?? []).find((f) => f.sha256 === sha256 || f.postscriptName === info.postscriptName);
      if (again) {
        if (again.sha256 !== sha256) throw new HttpError(409, `Eine Schrift mit dem PostScript-Namen „${info.postscriptName}“ ist schon hochgeladen.`);
        return { font: again, duplicate: true };
      }
      const rec: FontRecord = {
        id, profileId: PERSONAL_PROFILE_ID, name: safeFileName(fileName || `schrift.${info.format}`), format: info.format, family: info.family,
        postscriptName: info.postscriptName, assName: info.assName, weight: info.weight, italic: info.italic, size: bytes.length, sha256, storagePath, license: note, createdAt: now(),
        ...(origin ? { origin } : {}),
      };
      (db.fonts ??= []).push(rec);
      return { font: rec, duplicate: false };
    });
    if (out.duplicate) await deleteMediaFiles([storagePath]);
    return out;
  } catch (e) {
    await deleteMediaFiles([storagePath]);
    throw e;
  }
}

/** Versions whose design system uses the font (deleting it would change their look). */
function usedBy(db: Db, id: string): number[] {
  return db.styleBibles.filter((v) => {
    const d = v.rules.design as { typography?: Record<string, { font?: string }> } | undefined;
    return Object.values(d?.typography ?? {}).some((t) => t?.font && customFontId(t.font) === id);
  }).map((v) => v.version);
}

export async function deleteFont(id: string) {
  const rec = await write((db) => {
    const f = must((db.fonts ?? []).find((x) => x.id === id), 'Schrift');
    const versions = usedBy(db, id);
    if (versions.length) throw new HttpError(409, `Die Schrift wird in Style Bible v${versions.sort((a, b) => a - b).join(', v')} verwendet und bleibt deshalb erhalten.`);
    // Etappe 16b: an element of a cut can name the font itself (inspector)
    const ref = JSON.stringify(`custom:${id}`);
    if ([...db.editPlans, ...(db.editDrafts ?? [])].some((p) => JSON.stringify(p.body).includes(ref)))
      throw new HttpError(409, 'Die Schrift wird von einem Element in einem Schnitt verwendet und bleibt deshalb erhalten.');
    db.fonts = db.fonts.filter((x) => x.id !== id);
    return f;
  });
  await deleteMediaFiles([rec.storagePath]);
  return { deleted: id };
}

export const getFontRecord = (id: string) => read((db) => {
  const f = (db.fonts ?? []).find((x) => x.id === id);
  return f ? { storagePath: f.storagePath, mime: MIME[f.format] } : null;
});

/**
 * Etappe 16b: the exact faces libass has to take (checked in the render log by `fontFallbacks`): a Mac font by its
 * PostScript name, a Google/own font file by the PostScript name of that file.
 */
export function expectedFaces(db: Db, types: readonly ResolvedType[]): { name: string; postscriptName: string }[] {
  const out = new Map<string, { name: string; postscriptName: string }>();
  for (const t of types) {
    if (t.mac) out.set(t.assName, { name: t.assName, postscriptName: t.postscriptName ?? t.assName });
    else if (t.custom) {
      const f = (db.fonts ?? []).find((x) => x.assName === t.assName);
      if (f) out.set(t.assName, { name: t.assName, postscriptName: f.postscriptName });
    }
  }
  return [...out.values()];
}

/** The fonts a type role or an element can pick from the studio list: the system list, her own and her Google fonts. */
export const allowedFonts = (db: Db) => [
  ...SYSTEM_FONTS.map((f) => ({ ref: f as string, label: f as string, custom: false })),
  ...(db.fonts ?? []).map((f) => ({ ref: `custom:${f.id}`, label: f.origin?.kind === 'google' ? `${f.family} ${weightName(f.weight)} (Google Fonts)` : `${f.family} (eigene Schrift)`, custom: true })),
];

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
const weightName = (w: number) => WEIGHT_NAMES[Math.round(w / 100) * 100] ?? String(w);
