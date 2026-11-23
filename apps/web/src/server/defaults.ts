import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  parseLegacyProfile, parseProfileMarkdown, parseSourceMarkdown, parseStrategyDocument, renderStrategyMarkdown, SourceDocument, sourceKeyFromName,
  StyleBibleRules, versionAiText, VoiceGuideRules, withFrontMatter, type ProfileDocument, type StrategyDocument,
} from '@studio/core';
import { dataDir, defaultsDir } from './env';
import { HttpError } from './errors';
import { newId, now, PERSONAL_PROFILE_ID, read, write, type ContextVersion, type Db, type StyleBibleVersion, type VoiceGuideVersion } from './store';

/**
 * Standard folder (Etappe 10, E2; file format v2 since Etappe 11). The active documents are mirrored into
 * `defaultsDir()` (outside repo and data folder) so they survive data-folder changes, resets and code changes:
 * `strategie.json` (the strategy document) + `strategie.md` (its rendered read view, write-only), `profil.md`,
 * `quellen/<key>.md` (one per active source), `style-bible.json`, `voice.json` and `manifest.json` with hashes.
 * Markdown files carry a small front matter (`studio: profil|quelle`, source key, title, switch, sensitive terms).
 * - write-through: `store.ts` calls `onDbWritten` after every successful write; for each entry whose active version
 *   changed, a debounced `snapshotDefaults()` writes that file (other files and manifest entries stay; a source that
 *   is no longer active keeps its file: nothing is ever deleted here).
 * - origin: the manifest records which data folder wrote it (SHA-256 of the absolute data-folder path, never the path
 *   itself). The automatic write-through only writes into an empty/new manifest or one with the same origin.
 * - seed: `store.ts` calls `seedIfEmpty` when it loads a data folder without any context, style or voice version;
 *   the files become version 1, active, source `defaults`. Reads the v2 files and still the Etappe-10 files
 *   (`strategie.json`/`profil.json` with aiSafe/localOnly), converted into one document each.
 * - `GET/POST /api/defaults`: status (drift by content hash), „jetzt sichern“, „aus Datei übernehmen“.
 * The files are the user's own data but still untrusted input: every file passes the core schemas before use.
 */

export const DEFAULTS_SCHEMA_VERSION = 2;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEBOUNCE_MS = 200;
const SOURCES_DIR = 'quellen';
const MAX_SOURCE_FILES = 50;

/** `strategy` | `profile` | `style` | `voice` | `source:<key>` */
export type DefaultsKind = 'strategy' | 'profile' | 'style' | 'voice' | `source:${string}`;
export const DEFAULTS_FILES = {
  strategy: 'strategie.json', strategyRead: 'strategie.md', profile: 'profil.md', style: 'style-bible.json', voice: 'voice.json',
  /** Etappe-10 profile file (read only, when `profil.md` is missing) */
  legacyProfile: 'profil.json',
} as const;
export const MANIFEST_FILE = 'manifest.json';
const FIXED: DefaultsKind[] = ['strategy', 'profile', 'style', 'voice'];
const FIXED_LABEL: Record<string, string> = { strategy: 'Strategie', profile: 'Profil', style: 'Style Bible', voice: 'Voice Guide' };
export const fileOf = (kind: DefaultsKind) => (kind.startsWith('source:') ? `${SOURCES_DIR}/${kind.slice(7)}.md` : DEFAULTS_FILES[kind as 'strategy' | 'profile' | 'style' | 'voice']);
const labelOf = (kind: DefaultsKind, title?: string) => (kind.startsWith('source:') ? `Quelle „${title ?? kind.slice(7)}“` : FIXED_LABEL[kind]!);

// ---------- File format ----------
const Source = z.object({
  versionId: z.string().max(200).nullable(), version: z.number().int().nonnegative().nullable(), approvedAt: z.string().max(40).nullable(),
}).partial().optional();
type SourceMeta = z.infer<typeof Source>;
const RulesFile = {
  style: z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), source: Source, kind: z.literal('style'), rules: StyleBibleRules }),
  voice: z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), source: Source, kind: z.literal('voice'), rules: VoiceGuideRules }),
};

/** What a file holds once parsed: a context document or style/voice rules. */
type Content =
  | { kind: 'strategy'; document: StrategyDocument }
  | { kind: 'profile'; document: ProfileDocument }
  | { kind: 'source'; document: SourceDocument }
  | { kind: 'style'; rules: StyleBibleRules }
  | { kind: 'voice'; rules: VoiceGuideRules };

const ManifestEntry = z.object({
  kind: z.string().max(80), sourceVersionId: z.string().nullable(), sourceVersion: z.number().nullable(),
  sha256: z.string(), contentSha256: z.string(),
});
const Manifest = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), savedAt: z.string(),
  /** SHA-256 of the absolute path of the data folder that wrote this manifest (absent in manifests before the origin). */
  origin: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  files: z.record(z.string(), ManifestEntry),
});
type Manifest = z.infer<typeof Manifest>;

/** Canonical JSON (sorted keys) so the content hash does not depend on key order. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Origin of a data folder: hash of its absolute path, so the manifest does not reveal where the data lives. */
export const originOf = (dataFolder: string) => sha256(path.resolve(/*turbopackIgnore: true*/ dataFolder));
const ownedBy = (manifest: Manifest | null, origin: string) =>
  !manifest || Object.keys(manifest.files).length === 0 || manifest.origin === origin;
const contentHash = (c: Content) => sha256(canonical('rules' in c ? { rules: c.rules } : { document: c.document }));

/** The file text for a content (deterministic). */
function serialize(c: Content, source: SourceMeta): string {
  const version = source?.version != null ? String(source.version) : null;
  switch (c.kind) {
    case 'strategy':
      return `${JSON.stringify({ schemaVersion: DEFAULTS_SCHEMA_VERSION, kind: 'strategy', source, document: c.document }, null, 2)}\n`;
    case 'profile':
      return withFrontMatter({ studio: 'profil', version, sensitiveTerms: c.document.sensitiveTerms.length ? JSON.stringify(c.document.sensitiveTerms) : null }, c.document.markdown);
    case 'source':
      return withFrontMatter({ studio: 'quelle', key: c.document.key, title: c.document.title, sendMode: c.document.sendMode, version }, c.document.markdown);
    default:
      return `${JSON.stringify({ schemaVersion: DEFAULTS_SCHEMA_VERSION, kind: c.kind, source, rules: c.rules }, null, 2)}\n`;
  }
}

// ---------- Active state (store only) ----------
type ActiveEntry = { kind: DefaultsKind; label: string; version: { id: string; version: number; approvedAt: string | null }; content: Content };
const newest = <T extends { version: number; status: string; profileId: string }>(xs: readonly T[]) =>
  xs.filter((v) => v.status === 'approved' && v.profileId === PERSONAL_PROFILE_ID).reduce<T | null>((a, b) => (!a || b.version > a.version ? b : a), null);
const pick = (v: { id: string; version: number; approvedAt: string | null }) => ({ id: v.id, version: v.version, approvedAt: v.approvedAt });

/** Every entry with an active version, from the store only. */
export function activeEntries(db: Db): ActiveEntry[] {
  const out: ActiveEntry[] = [];
  const s = newest(db.contextVersions.filter((v) => v.kind === 'strategy'));
  if (s?.kind === 'strategy') out.push({ kind: 'strategy', label: labelOf('strategy'), version: pick(s), content: { kind: 'strategy', document: s.document } });
  const p = newest(db.contextVersions.filter((v) => v.kind === 'profile'));
  if (p?.kind === 'profile') out.push({ kind: 'profile', label: labelOf('profile'), version: pick(p), content: { kind: 'profile', document: p.document } });
  const style = newest(db.styleBibles);
  if (style) out.push({ kind: 'style', label: labelOf('style'), version: pick(style), content: { kind: 'style', rules: style.rules } });
  const voice = newest(db.voiceGuides);
  if (voice) out.push({ kind: 'voice', label: labelOf('voice'), version: pick(voice), content: { kind: 'voice', rules: voice.rules } });
  for (const v of db.contextVersions)
    if (v.kind === 'source' && v.status === 'approved' && v.profileId === PERSONAL_PROFILE_ID)
      out.push({ kind: `source:${v.sourceKey}`, label: labelOf(`source:${v.sourceKey}`, v.document.title), version: pick(v), content: { kind: 'source', document: v.document } });
  return out;
}

/** Per entry: changes whenever another version becomes active or the active version's stored content changes. */
export function activeFingerprints(db: Db): Record<string, string> {
  return Object.fromEntries(activeEntries(db).map((e) => [e.kind, `${e.version.id}|${e.version.approvedAt}|${contentHash(e.content)}`]));
}

// ---------- Files ----------
async function writeAtomic(dir: string, name: string, text: string) {
  const file = path.join(dir, name);
  const folder = path.dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const tmp = path.join(folder, `.${path.basename(name)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

async function readText(file: string): Promise<string | null> {
  try {
    // size first: an oversized (or non-regular) file is never read into memory
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not_a_file');
    if (info.size > MAX_FILE_BYTES) throw new Error('too_large');
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('too_large'); // grew between stat and read
    return text;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const text = await readText(path.join(dir, MANIFEST_FILE));
    if (text == null) return null;
    const r = Manifest.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

type FileRead =
  | { kind: DefaultsKind; file: string; present: false }
  | { kind: DefaultsKind; file: string; present: true; valid: false; error: string; sha256: string | null }
  | { kind: DefaultsKind; file: string; present: true; valid: true; sha256: string; contentSha256: string; content: Content; fileVersion: number | null; title?: string };
type ValidRead = Extract<FileRead, { valid: true }>;
type BadRead = Extract<FileRead, { valid: false }>;

const errorPath = (issues: { path: string; severity?: string }[]) => issues.find((i) => i.severity !== 'warning')?.path || 'Wurzel';
const jsonOf = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};
const versionOfFile = (raw: unknown) => (raw as { source?: SourceMeta } | null)?.source?.version ?? null;

/** Parses one file's text. Error texts name the field path only, never file content. */
function parseFile(kind: DefaultsKind, file: string, text: string): FileRead {
  const fileSha = sha256(text);
  const bad = (error: string): BadRead => ({ kind, file, present: true, valid: false, error, sha256: fileSha });
  const ok = (content: Content, fileVersion: number | null, title?: string): ValidRead =>
    ({ kind, file, present: true, valid: true, sha256: fileSha, contentSha256: contentHash(content), content, fileVersion, title });
  if (kind === 'strategy') {
    const j = jsonOf(text);
    if (!j.ok) return bad('kein gültiges JSON.');
    // v2 `{ document }`, v1 `{ aiSafe, localOnly }` (Etappe 10) or a plain strategy document
    const inner = j.value && typeof j.value === 'object' && 'document' in j.value ? (j.value as { document: unknown }).document : j.value;
    const r = parseStrategyDocument(JSON.stringify(inner));
    if (!r.ok || !r.document) return bad(`passt nicht zum Schema (${errorPath(r.issues)}).`);
    return ok({ kind: 'strategy', document: r.document }, versionOfFile(j.value));
  }
  if (kind === 'profile') {
    if (file.endsWith('.json')) {
      const j = jsonOf(text);
      if (!j.ok) return bad('kein gültiges JSON.');
      const r = parseLegacyProfile(j.value);
      if (!r?.ok || !r.document) return bad(`passt nicht zum Schema (${r ? errorPath(r.issues) : 'Wurzel'}).`);
      return ok({ kind: 'profile', document: r.document }, versionOfFile(j.value));
    }
    const r = parseProfileMarkdown(text);
    if (!r.ok || !r.document) return bad('ist leer oder zu lang.');
    return ok({ kind: 'profile', document: r.document }, null);
  }
  if (kind.startsWith('source:')) {
    const r = parseSourceMarkdown(text, path.basename(file));
    if (!r.ok || !r.document) return bad('ist leer oder zu lang.');
    // the key is the file name, so a key inside the file cannot overwrite another source
    const document = SourceDocument.parse({ ...r.document, key: kind.slice(7) });
    return ok({ kind: 'source', document }, null, document.title);
  }
  const j = jsonOf(text);
  if (!j.ok) return bad('kein gültiges JSON.');
  const rulesKind = kind as 'style' | 'voice';
  const r = RulesFile[rulesKind].safeParse(j.value);
  if (!r.success) return bad(`passt nicht zum Schema (${r.error.issues[0]?.path.join('.') || 'Wurzel'}).`);
  const content: Content = rulesKind === 'style' ? { kind: 'style', rules: r.data.rules as StyleBibleRules } : { kind: 'voice', rules: r.data.rules as VoiceGuideRules };
  return ok(content, r.data.source?.version ?? null);
}

async function readDoc(dir: string, kind: DefaultsKind): Promise<FileRead> {
  let file = fileOf(kind);
  let text: string | null;
  try {
    text = await readText(path.join(/*turbopackIgnore: true*/ dir, file));
    if (text == null && kind === 'profile') {
      // Etappe-10 standard folder: profil.json with aiSafe/localOnly
      const legacy = await readText(path.join(/*turbopackIgnore: true*/ dir, DEFAULTS_FILES.legacyProfile));
      if (legacy != null) {
        file = DEFAULTS_FILES.legacyProfile;
        text = legacy;
      }
    }
  } catch (e) {
    return { kind, file, present: true, valid: false, error: (e as Error).message === 'too_large' ? 'Datei ist zu groß.' : 'Datei kann nicht gelesen werden.', sha256: null };
  }
  if (text == null) return { kind, file, present: false };
  return parseFile(kind, file, text);
}

/** Source files in `quellen/` (only `<key>.md` with a valid key; at most 50). */
async function sourceKinds(dir: string): Promise<DefaultsKind[]> {
  try {
    const names = await readdir(path.join(dir, SOURCES_DIR));
    return names.filter((n) => n.endsWith('.md') && sourceKeyFromName(n) === n.slice(0, -3)).sort().slice(0, MAX_SOURCE_FILES)
      .map((n) => `source:${n.slice(0, -3)}` as DefaultsKind);
  } catch {
    return [];
  }
}

async function readAllDocs(dir: string, extra: DefaultsKind[] = []) {
  const kinds = [...new Set([...FIXED, ...(await sourceKinds(dir)), ...extra])];
  return Promise.all(kinds.map((k) => readDoc(dir, k)));
}

// ---------- Write-through ----------
interface RuntimeState {
  lastSnapshotAt: string | null; lastError: string | null; lastWarnings: string[];
  lastSeed: { at: string; imported: DefaultsKind[]; warnings: string[] } | null;
}
const state: RuntimeState = { lastSnapshotAt: null, lastError: null, lastWarnings: [], lastSeed: null };

export interface SnapshotResult { ok: boolean; skipped?: 'off' | 'foreign-origin'; written: DefaultsKind[]; warnings: string[]; error: string | null }
export interface SnapshotOptions {
  /** Entries to write (default: all with an active version). The write-through passes only the changed ones. */
  kinds?: readonly DefaultsKind[];
  /** Explicit „Jetzt sichern“: writes even into a manifest of another data folder and takes over its origin. */
  explicit?: boolean;
  /** Data folder the change happened in (write-through); default the current one. */
  dataFolder?: string;
}

let chain: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = chain.then(fn);
  chain = p.catch(() => undefined);
  return p;
};

/**
 * Writes the active state into the standard folder. Never throws: failures are logged and kept for the status.
 * Automatic (not explicit) snapshots write nothing into a manifest that belongs to another data folder.
 */
export function snapshotDefaults(opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  return serialized(async () => {
    const dir = defaultsDir();
    if (!dir) return { ok: false, skipped: 'off' as const, written: [], warnings: [], error: null };
    const folder = opts.dataFolder ?? dataDir();
    // the data folder was switched before a debounced write-through ran: the store now shows another folder's state
    if (path.resolve(/*turbopackIgnore: true*/ folder) !== dataDir()) return { ok: true, written: [], warnings: [], error: null };
    const origin = originOf(folder);
    try {
      const previous = await readManifest(dir);
      if (!opts.explicit && !ownedBy(previous, origin)) return { ok: true, skipped: 'foreign-origin' as const, written: [], warnings: [], error: null };
      const entries = await read((db) => structuredClone(activeEntries(db)));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      // entries not written now keep their file and manifest entry (nothing is ever deleted here)
      const files: Manifest['files'] = { ...(previous?.files ?? {}) };
      const written: DefaultsKind[] = [];
      for (const e of entries) {
        if (opts.kinds && !opts.kinds.includes(e.kind)) continue;
        const source: SourceMeta = { versionId: e.version.id, version: e.version.version, approvedAt: e.version.approvedAt };
        const text = serialize(e.content, source);
        const name = fileOf(e.kind);
        await writeAtomic(dir, name, text);
        files[name] = { kind: e.kind, sourceVersionId: e.version.id, sourceVersion: e.version.version, sha256: sha256(text), contentSha256: contentHash(e.content) };
        if (e.content.kind === 'strategy') {
          const md = renderStrategyMarkdown(e.content.document);
          await writeAtomic(dir, DEFAULTS_FILES.strategyRead, md);
          files[DEFAULTS_FILES.strategyRead] = { kind: 'strategy_read', sourceVersionId: e.version.id, sourceVersion: e.version.version, sha256: sha256(md), contentSha256: contentHash(e.content) };
        }
        written.push(e.kind);
      }
      const savedAt = now();
      const manifest: Manifest = { schemaVersion: DEFAULTS_SCHEMA_VERSION, savedAt, origin, files };
      await writeAtomic(dir, MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
      Object.assign(state, { lastSnapshotAt: savedAt, lastError: null, lastWarnings: [] });
      return { ok: true, written, warnings: [], error: null };
    } catch (e) {
      // the error code/message names a path at most, never strategy text
      const code = (e as NodeJS.ErrnoException).code;
      const error = `Sicherung in den Standard-Ordner fehlgeschlagen${code ? ` (${code})` : ''}.`;
      console.error(`[defaults] ${error}`, code ? '' : (e as Error).message);
      Object.assign(state, { lastError: error });
      return { ok: false, written: [], warnings: [], error };
    }
  });
}

let baseline: { file: string; fps: Record<string, string> } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Changed entries collected over the debounce window, with the data folder they changed in. */
let pending: { dataFolder: string; kinds: Set<DefaultsKind> } | null = null;

/** store.ts: a data folder was loaded (and maybe seeded). Its active state is the baseline, nothing is written. */
export function onDbLoaded(file: string, db: Db) {
  baseline = { file, fps: activeFingerprints(db) };
}

const runPending = () => {
  const p = pending;
  pending = null;
  timer = null;
  if (p) void snapshotDefaults({ kinds: [...p.kinds], dataFolder: p.dataFolder });
};

/** store.ts: called after every successful write. Schedules a snapshot of the entries whose active version changed. */
export function onDbWritten(file: string, db: Db) {
  const fps = activeFingerprints(db);
  const changed = baseline?.file === file ? (Object.keys(fps) as DefaultsKind[]).filter((k) => baseline!.fps[k] !== fps[k]) : [];
  baseline = { file, fps };
  if (!changed.length || !defaultsDir()) return;
  const dataFolder = path.dirname(file);
  if (pending && pending.dataFolder !== dataFolder) runPending(); // never mix entries of two data folders
  pending ??= { dataFolder, kinds: new Set() };
  for (const k of changed) pending.kinds.add(k);
  if (timer) clearTimeout(timer);
  timer = setTimeout(runPending, DEBOUNCE_MS);
  timer.unref?.();
}

/** Runs a pending debounced snapshot now and waits for every snapshot in flight (tests, shutdown). */
export async function flushDefaults() {
  if (timer) clearTimeout(timer);
  runPending();
  await chain;
}

// ---------- Seed / apply ----------
const nextNumber = (xs: readonly { version: number; profileId: string }[]) =>
  xs.filter((v) => v.profileId === PERSONAL_PROFILE_ID).reduce((n, v) => Math.max(n, v.version), 0) + 1;

/** Adds the files as new active versions (archives the previously active one of the same entry). */
function addVersions(db: Db, reads: ValidRead[], at: string) {
  for (const r of reads) {
    const c = r.content;
    if (c.kind === 'style' || c.kind === 'voice') {
      const list: (StyleBibleVersion | VoiceGuideVersion)[] = c.kind === 'style' ? db.styleBibles : db.voiceGuides;
      for (const v of list) if (v.profileId === PERSONAL_PROFILE_ID && v.status === 'approved') v.status = 'archived';
      const v = { id: newId(), profileId: PERSONAL_PROFILE_ID, version: nextNumber(list), status: 'approved' as const, createdAt: at, approvedAt: at, suggestionId: null, source: 'defaults' as const };
      if (c.kind === 'style') db.styleBibles.push({ ...v, rules: c.rules });
      else db.voiceGuides.push({ ...v, rules: c.rules });
      continue;
    }
    const sourceKey = c.kind === 'source' ? c.document.key : null;
    const same = (v: ContextVersion) => v.kind === c.kind && v.profileId === PERSONAL_PROFILE_ID && v.sourceKey === sourceKey;
    for (const v of db.contextVersions) if (same(v) && v.status === 'approved') v.status = 'archived';
    const version = nextNumber(db.contextVersions.filter(same));
    const typed = c.kind === 'source'
      ? { kind: 'source' as const, sourceKey: c.document.key, document: c.document }
      : c.kind === 'strategy' ? { kind: 'strategy' as const, sourceKey: null, document: c.document } : { kind: 'profile' as const, sourceKey: null, document: c.document };
    db.contextVersions.push({
      id: newId(), profileId: PERSONAL_PROFILE_ID, version, status: 'approved', source: 'defaults', createdAt: at, approvedAt: at,
      aiTextHash: sha256(versionAiText({ ...typed, version } as Parameters<typeof versionAiText>[0])), ...typed,
    } as ContextVersion);
  }
}

const hasAnyVersion = (db: Db) => db.contextVersions.length > 0 || db.styleBibles.length > 0 || db.voiceGuides.length > 0;

const invalidWarning = (bad: BadRead[]) =>
  `Standard-Ordner: ${bad.map((b) => `${b.file} ${b.error}`).join(' ')} Es wurde nichts übernommen.`;

/**
 * store.ts `loadFromDisk`: imports the standard folder into a data folder without any context, style or voice
 * version. Mutates `db` (the caller saves it) and returns whether anything was imported. All files or none: one
 * invalid file blocks the whole import. Never throws. Runs inside the store's write queue: no `read`/`write`.
 */
export async function seedIfEmpty(db: Db): Promise<boolean> {
  const dir = defaultsDir();
  if (!dir || hasAnyVersion(db)) return false;
  const at = now();
  try {
    const reads = await readAllDocs(dir);
    const bad = reads.filter((r): r is BadRead => r.present && !r.valid);
    if (bad.length) {
      const warning = invalidWarning(bad);
      console.warn(`[defaults] ${warning}`);
      state.lastSeed = { at, imported: [], warnings: [warning] };
      return false;
    }
    const valid = reads.filter((r): r is ValidRead => r.present && r.valid);
    if (!valid.length) return false;
    addVersions(db, valid, at);
    state.lastSeed = { at, imported: valid.map((r) => r.kind), warnings: [] };
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const warning = `Standard-Ordner konnte nicht geladen werden${code ? ` (${code})` : ''}. Es wurde nichts übernommen.`;
    console.warn(`[defaults] ${warning}`);
    state.lastSeed = { at, imported: [], warnings: [warning] };
    return false;
  }
}

// ---------- Status ----------
export interface DefaultsFileStatus {
  kind: DefaultsKind; label: string; file: string; present: boolean; valid: boolean; error: string | null;
  activeVersion: number | null; fileVersion: number | null;
  /** file content ≠ active content (hash of the content, metadata ignored) */
  differs: boolean;
  /** file differs from what the studio last wrote (edited outside or never written by this manifest) */
  changedOutside: boolean;
  /** „Übernehmen“ takes this file: valid, differs, and changed outside or no active version of this entry */
  applicable: boolean;
}
export interface DefaultsStatus {
  enabled: boolean; dir: string | null; lastSavedAt: string | null; lastSnapshotAt: string | null; lastError: string | null;
  warnings: string[]; seed: RuntimeState['lastSeed']; files: DefaultsFileStatus[];
  /** some file is applicable → „Übernehmen“ */
  fileNewer: boolean; canApply: boolean;
  /** the manifest was written by another data folder: no automatic write-through, „Jetzt sichern“ takes it over */
  foreignOrigin: boolean;
}

/** Same rule for the status banner and for `applyDefaults`: stale files (written by the studio, not edited) never win. */
const isApplicable = (f: { differs: boolean; changedOutside: boolean; hasActive: boolean }) =>
  f.differs && (f.changedOutside || !f.hasActive);

function statusOf(reads: FileRead[], active: ActiveEntry[], manifest: Manifest | null): DefaultsFileStatus[] {
  const byKind = new Map(active.map((a) => [a.kind, a]));
  return reads.map((r): DefaultsFileStatus => {
    const a = byKind.get(r.kind);
    const activeVersion = a?.version.version ?? null;
    const title = r.present && r.valid ? r.title : a?.content.kind === 'source' ? a.content.document.title : undefined;
    const label = labelOf(r.kind, title);
    if (!r.present) return { kind: r.kind, label, file: r.file, present: false, valid: false, error: null, activeVersion, fileVersion: null, differs: !!a, changedOutside: false, applicable: false };
    const entry = manifest?.files[r.file];
    const changedOutside = !entry || entry.sha256 !== r.sha256;
    if (!r.valid) return { kind: r.kind, label, file: r.file, present: true, valid: false, error: r.error, activeVersion, fileVersion: null, differs: true, changedOutside, applicable: false };
    const differs = !a || contentHash(a.content) !== r.contentSha256;
    return {
      kind: r.kind, label, file: r.file, present: true, valid: true, error: null,
      activeVersion, fileVersion: r.fileVersion ?? entry?.sourceVersion ?? null, differs, changedOutside,
      applicable: isApplicable({ differs, changedOutside, hasActive: !!a }),
    };
  });
}

export async function getDefaultsStatus(): Promise<DefaultsStatus> {
  const dir = defaultsDir();
  const common = { lastSnapshotAt: state.lastSnapshotAt, lastError: state.lastError, seed: state.lastSeed };
  if (!dir) return { enabled: false, dir: null, lastSavedAt: null, warnings: [], files: [], fileNewer: false, canApply: false, foreignOrigin: false, ...common };
  const active = await read((db) => structuredClone(activeEntries(db)));
  // active sources without a file yet are listed too (they show as „fehlt“)
  const [reads, manifest] = await Promise.all([readAllDocs(dir, active.map((a) => a.kind).filter((k) => k.startsWith('source:'))), readManifest(dir)]);
  const files = statusOf(reads, active, manifest);
  const fileNewer = files.some((f) => f.applicable);
  return {
    enabled: true, dir, lastSavedAt: manifest?.savedAt ?? null, warnings: [...state.lastWarnings], files,
    fileNewer, canApply: fileNewer && files.every((f) => !f.present || f.valid),
    foreignOrigin: !ownedBy(manifest, originOf(dataDir())),
    ...common,
  };
}

/**
 * „Aus Datei übernehmen“: every valid file whose content differs from the active state and that was changed outside
 * the studio or has no active version of its entry becomes a new active version (the previous one is archived).
 * One invalid file blocks the whole apply.
 */
export async function applyDefaults(): Promise<{ applied: DefaultsKind[] }> {
  const dir = defaultsDir();
  if (!dir) throw new HttpError(409, 'Der Standard-Ordner ist ausgeschaltet (STUDIO_DEFAULTS_DIR=off).');
  const reads = await readAllDocs(dir);
  const bad = reads.filter((r): r is BadRead => r.present && !r.valid);
  if (bad.length) throw new HttpError(422, invalidWarning(bad));
  const manifest = await readManifest(dir);
  const applied = await write((db) => {
    const active = new Map(activeEntries(db).map((a) => [a.kind, a]));
    const planned = reads.filter((r): r is ValidRead => r.present && r.valid).filter((r) => {
      const a = active.get(r.kind);
      const entry = manifest?.files[r.file];
      return isApplicable({ differs: !a || contentHash(a.content) !== r.contentSha256, changedOutside: !entry || entry.sha256 !== r.sha256, hasActive: !!a });
    });
    addVersions(db, planned, now());
    return planned.map((r) => r.kind);
  });
  return { applied };
}

const PostInput = z.object({ action: z.enum(['snapshot', 'apply']) });

export async function postDefaults(body: unknown) {
  const { action } = PostInput.parse(body);
  if (action === 'apply') {
    const r = await applyDefaults();
    await flushDefaults(); // the write-through of the new versions, so the status shows the files in sync
    return { ...r, status: await getDefaultsStatus() };
  }
  if (!defaultsDir()) throw new HttpError(409, 'Der Standard-Ordner ist ausgeschaltet (STUDIO_DEFAULTS_DIR=off).');
  const r = await snapshotDefaults({ explicit: true });
  if (!r.ok) throw new HttpError(500, r.error ?? 'Sicherung fehlgeschlagen.');
  return { ...r, status: await getDefaultsStatus() };
}

/** Test helper: forget the in-memory status (seed/snapshot results). */
export function resetDefaultsState() {
  Object.assign(state, { lastSnapshotAt: null, lastError: null, lastWarnings: [], lastSeed: null });
}
