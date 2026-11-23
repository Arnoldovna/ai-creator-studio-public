import 'server-only';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { HttpError } from './errors';
import { ImportChoice, type ImportInput } from './services/strategy';

/**
 * Request reading for the context import (Etappe 11): multipart files and/or pasted text, or JSON
 * `{ files: [{ name, text }], text?, choices? }`. Only text files (.json, .md, .markdown, .txt) within the size
 * limits; the bytes must be UTF-8 text without NUL bytes or a known binary signature. The content is untrusted data:
 * it is parsed, never executed or followed, and error messages never quote it.
 */

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const EXT = /\.(json|md|markdown|txt)$/i;
const MIME_OK = new Set(['', 'text/plain', 'text/markdown', 'text/x-markdown', 'application/json', 'application/octet-stream']);
const PASTED_NAME = 'Eingefügter Text';

/** Binary signatures that must never pass as text (PDF, ZIP/Office, PNG, JPEG, GIF, gzip, RTF is text and allowed). */
const MAGIC: readonly number[][] = [[0x25, 0x50, 0x44, 0x46], [0x50, 0x4b, 0x03, 0x04], [0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x1f, 0x8b]];

/** Bytes → text, or a German error (never the content). Strips a UTF-8 BOM. */
export function decodeText(bytes: Uint8Array, name: string): string {
  if (MAGIC.some((m) => m.every((b, i) => bytes[i] === b))) throw new HttpError(415, `„${safeName(name)}“ ist keine Textdatei.`);
  if (bytes.includes(0)) throw new HttpError(415, `„${safeName(name)}“ ist keine Textdatei (Binärdaten).`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(415, `„${safeName(name)}“ ist kein UTF-8-Text.`);
  }
  return text.replace(/^﻿/, '');
}

/** File names are shown back: trimmed, without control characters, at most 120 characters. */
export const safeName = (name: string) => name.replace(/[\p{C}]/gu, '').trim().slice(0, 120) || 'Datei';

function checkName(name: string) {
  if (!EXT.test(name)) throw new HttpError(415, `„${safeName(name)}“: nur .json, .md oder .txt.`);
}

const ChoicesJson = z.array(ImportChoice).max(20);
function parseChoices(raw: unknown): ImportChoice[] {
  if (raw == null || raw === '') return [];
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Feld „choices“ ist kein gültiges JSON.');
    }
  }
  return ChoicesJson.parse(value);
}

const JsonInput = z.object({
  files: z.array(z.object({ name: z.string().max(300), text: z.string() })).max(MAX_FILES).default([]),
  text: z.string().optional(),
  choices: z.unknown().optional(),
}).strict();

function addPasted(files: ImportInput['files'], text: string | null | undefined) {
  if (text == null || !text.trim()) return;
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new HttpError(413, `Der eingefügte Text ist zu groß (höchstens ${MAX_FILE_BYTES / 1024} KB).`);
  const trimmed = text.trimStart();
  files.push({ name: trimmed.startsWith('{') ? `${PASTED_NAME}.json` : `${PASTED_NAME}.md`, text });
}

export async function readImportRequest(req: NextRequest): Promise<ImportInput> {
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_TOTAL_BYTES + 64 * 1024) throw new HttpError(413, `Zu viele Daten auf einmal (höchstens ${MAX_TOTAL_BYTES / 1024 / 1024} MB).`);
  const type = req.headers.get('content-type') ?? '';
  const files: ImportInput['files'] = [];
  let choices: ImportChoice[] = [];
  if (type.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, 'Formulardaten konnten nicht gelesen werden.');
    }
    const uploads = form.getAll('files').filter((x): x is File => typeof x !== 'string');
    if (uploads.length > MAX_FILES) throw new HttpError(413, `Höchstens ${MAX_FILES} Dateien auf einmal.`);
    let total = 0;
    for (const f of uploads) {
      checkName(f.name);
      if (!MIME_OK.has(f.type) && !f.type.startsWith('text/')) throw new HttpError(415, `„${safeName(f.name)}“: Dateityp nicht erlaubt.`);
      if (f.size > MAX_FILE_BYTES) throw new HttpError(413, `„${safeName(f.name)}“ ist zu groß (höchstens ${MAX_FILE_BYTES / 1024} KB).`);
      total += f.size;
      if (total > MAX_TOTAL_BYTES) throw new HttpError(413, `Zu viele Daten auf einmal (höchstens ${MAX_TOTAL_BYTES / 1024 / 1024} MB).`);
      files.push({ name: safeName(f.name), text: decodeText(new Uint8Array(await f.arrayBuffer()), f.name) });
    }
    const text = form.get('text');
    addPasted(files, typeof text === 'string' ? text : null);
    const c = form.get('choices');
    choices = parseChoices(typeof c === 'string' ? c : null);
  } else {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, 'Ungültiges JSON');
    }
    const input = JsonInput.parse(body);
    let total = 0;
    for (const f of input.files) {
      checkName(f.name);
      const bytes = Buffer.byteLength(f.text, 'utf8');
      if (bytes > MAX_FILE_BYTES) throw new HttpError(413, `„${safeName(f.name)}“ ist zu groß (höchstens ${MAX_FILE_BYTES / 1024} KB).`);
      total += bytes;
      if (total > MAX_TOTAL_BYTES) throw new HttpError(413, `Zu viele Daten auf einmal (höchstens ${MAX_TOTAL_BYTES / 1024 / 1024} MB).`);
      if (f.text.includes('\u0000')) throw new HttpError(415, `„${safeName(f.name)}“ ist keine Textdatei (Binärdaten).`);
      files.push({ name: safeName(f.name), text: f.text.replace(/^﻿/, '') });
    }
    addPasted(files, input.text);
    choices = parseChoices(input.choices);
  }
  if (files.length > MAX_FILES) throw new HttpError(413, `Höchstens ${MAX_FILES} Dateien auf einmal.`);
  if (!files.length) throw new HttpError(400, 'Keine Datei und kein Text.');
  return { files, choices };
}
