import 'server-only';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { profileDocFromLegacyRaw, strategyDocFromLegacyRaw, versionAiText } from '@studio/core';
import type { ContextVersion, Db } from './store';

/**
 * Data migration db.json schema 1 → 2 (Etappe 11, E3), run once when a data folder is loaded.
 *
 * Schema 1 kept a context version in two places: the structured part (`aiSafe`) in db.json and the former local part
 * in `<dataDir>/private/context-local.json`, together with the override reasons and the self-check notes. Schema 2
 * keeps everything in db.json:
 * - strategy/profile: `aiSafe` + private `localOnly` → one `document` (`strategyDocFromLegacy`/`profileDocFromLegacy`);
 * - self-check notes → `selfAssessments[].note`; override reasons → `strategyGates[].*Overrides[].reason`;
 * - the pillar of an old FitCheck gate → the concept or free-cut root plan when that has none (`strategyGates` stays).
 *
 * Old data that breaks today's rules (duplicate pillar ids, dangling format refs, too long texts, broken entries)
 * is repaired, never rejected; every repair is logged in the document's `extras` (`LEGACY_REPAIR_KEY`). Two active
 * versions of one kind: the newest stays active.
 * Order: read and convert everything in memory first; only a broken private file (or a db.json entry that is not an
 * object) aborts with a clear message, and then nothing is written. Then a backup of both files goes to
 * `<dataDir>/backups/v1-<timestamp>/` (0700/0600), and only then does the store write db.json. The private file itself
 * is left untouched (it is no longer read). Idempotent: schema 2 is returned unchanged.
 */

export const LEGACY_PRIVATE_FILE = path.join('private', 'context-local.json');

const Rec = z.record(z.string(), z.unknown());
const LegacyPrivate = z.object({
  contextLocal: z.record(z.string(), z.object({ kind: z.enum(['strategy', 'profile']), data: z.unknown() }).loose()),
  overrideReasons: z.record(z.string(), z.string()),
  selfAssessmentNotes: z.record(z.string(), z.string()),
}).loose();
type LegacyPrivate = z.infer<typeof LegacyPrivate>;
const emptyPrivate = (): LegacyPrivate => ({ contextLocal: {}, overrideReasons: {}, selfAssessmentNotes: {} });

export class MigrationError extends Error {}

export interface MigrationReport {
  strategies: number; profiles: number; notes: number; reasons: number; pillarsCopied: number;
  /** repairs of old data (logged in the documents' extras) and extra active versions archived */
  repairs: number;
  /** private entries without a version in db.json (they stay in the backup) */
  orphanedPrivateEntries: number;
}

const ABORT = 'Datenmigration auf Schema 2 abgebrochen, es wurde nichts geschrieben:';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Converts a parsed schema-1 db plus the private file (pure; throws `MigrationError` with a value-free message). */
export function migrateV1(raw: Record<string, unknown>, priv: LegacyPrivate): { db: Db; report: MigrationReport } {
  const db = structuredClone(raw) as Record<string, unknown> & Partial<Db>;
  const report: MigrationReport = { strategies: 0, profiles: 0, notes: 0, reasons: 0, pillarsCopied: 0, repairs: 0, orphanedPrivateEntries: 0 };
  const versions = Array.isArray(db.contextVersions) ? (db.contextVersions as unknown[]) : [];
  const known = new Set<string>();
  db.contextVersions = versions.map((v): ContextVersion => {
    if (!isRecord(v) || typeof v.id !== 'string') throw new MigrationError(`${ABORT} ein Eintrag in contextVersions ist ungültig.`);
    known.add(v.id);
    if (isRecord(v.document)) return v as unknown as ContextVersion; // already converted (interrupted earlier run)
    const label = `${v.kind === 'profile' ? 'Profil' : 'Strategie'} v${String(v.version)}`;
    const entry = priv.contextLocal[v.id];
    const local = entry && entry.kind === v.kind ? entry.data : null;
    const base = {
      id: v.id, profileId: String(v.profileId), version: Number(v.version), status: v.status as ContextVersion['status'],
      source: (v.source ?? 'manual') as ContextVersion['source'], createdAt: String(v.createdAt), approvedAt: (v.approvedAt as string | null) ?? null,
    };
    // tolerant: old data that breaks today's rules is repaired and the repair logged in the document's extras
    const convert = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch {
        throw new MigrationError(`${ABORT} ${label} lässt sich nicht umwandeln.`);
      }
    };
    if (v.kind === 'strategy') {
      const { document, repairs } = convert(() => strategyDocFromLegacyRaw(v.aiSafe, local));
      report.strategies++;
      report.repairs += repairs.length;
      return { ...base, kind: 'strategy', sourceKey: null, document, aiTextHash: sha(versionAiText({ kind: 'strategy', version: base.version, document })) };
    }
    if (v.kind === 'profile') {
      const document = convert(() => profileDocFromLegacyRaw(v.aiSafe, local));
      report.profiles++;
      return { ...base, kind: 'profile', sourceKey: null, document, aiTextHash: sha(versionAiText({ kind: 'profile', version: base.version, document })) };
    }
    throw new MigrationError(`${ABORT} unbekannte Art in contextVersions.`);
  });
  report.orphanedPrivateEntries = Object.keys(priv.contextLocal).filter((id) => !known.has(id)).length;
  // one active version per (profile, kind): extra active ones of old data are archived (the newest stays active)
  for (const v of db.contextVersions) {
    if (v.status !== 'approved') continue;
    const newer = db.contextVersions.some((o) => o !== v && o.status === 'approved' && o.kind === v.kind && o.profileId === v.profileId && o.sourceKey === v.sourceKey && o.version > v.version);
    if (newer) { v.status = 'archived'; report.repairs++; }
  }

  // self-check notes → the record
  db.selfAssessments = (Array.isArray(db.selfAssessments) ? db.selfAssessments : []).map((a) => {
    const rest = { ...a } as typeof a & { hasNote?: boolean };
    delete rest.hasNote;
    const note = (rest as { note?: string }).note ?? priv.selfAssessmentNotes[rest.id] ?? '';
    if (note) report.notes++;
    return { ...rest, note };
  });

  // override reasons → the override; old FitCheck pillar → concept / free-cut root without a pillar
  const gates = Array.isArray(db.strategyGates) ? db.strategyGates : [];
  for (const g of gates) {
    const withReason = <T extends { id: string; hasReason?: boolean; reason?: string | null }>(o: T) => {
      const rest = { ...o };
      delete rest.hasReason;
      const reason = o.reason ?? priv.overrideReasons[o.id] ?? null;
      if (reason) report.reasons++;
      return { ...rest, reason };
    };
    g.fitOverrides = (g.fitOverrides ?? []).map(withReason);
    g.lintOverrides = (g.lintOverrides ?? []).map(withReason);
    if (!g.pillarId) continue;
    if (g.subject.kind === 'concept') {
      const c = (db.concepts ?? []).find((x) => x.id === (g.subject as { conceptId: string }).conceptId);
      if (c && c.pillarId == null) { c.pillarId = g.pillarId; report.pillarsCopied++; }
    } else {
      const p = (db.editPlans ?? []).find((x) => x.id === (g.subject as { rootPlanId: string }).rootPlanId);
      if (p && p.pillarId == null) { p.pillarId = g.pillarId; report.pillarsCopied++; }
    }
  }
  db.strategyGates = gates;
  db.schemaVersion = 2;
  return { db: db as Db, report };
}

/** Reads the old private file. Missing = empty; unreadable or broken = abort (nothing is written). */
async function readLegacyPrivate(dataFolder: string): Promise<{ data: LegacyPrivate; present: boolean }> {
  let text: string;
  try {
    text = await readFile(path.join(dataFolder, LEGACY_PRIVATE_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { data: emptyPrivate(), present: false };
    throw new MigrationError(`${ABORT} die private Datei (private/context-local.json) kann nicht gelesen werden.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null; // never quote the content or the parser message
  }
  const r = LegacyPrivate.safeParse(isRecord(parsed) ? { ...emptyPrivate(), ...parsed } : parsed);
  if (!r.success || !Rec.safeParse(parsed).success)
    throw new MigrationError(`${ABORT} die private Datei (private/context-local.json) ist beschädigt. Bitte aus einem Backup wiederherstellen oder die Datei prüfen.`);
  return { data: r.data, present: true };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Copies db.json and the private file into a fresh `backups/v1-<timestamp>/` folder (0700/0600). */
export async function backupV1(dataFolder: string, withPrivate: boolean, at = new Date()): Promise<string> {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  let dir = path.join(dataFolder, 'backups', `v1-${stamp}`);
  for (let n = 2; await exists(dir); n++) dir = path.join(dataFolder, 'backups', `v1-${stamp}-${n}`);
  await mkdir(path.join(dir, 'private'), { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await chmod(path.join(dir, 'private'), 0o700);
  const copy = async (rel: string) => {
    await copyFile(path.join(dataFolder, rel), path.join(dir, rel));
    await chmod(path.join(dir, rel), 0o600);
  };
  await copy('db.json');
  if (withPrivate) await copy(LEGACY_PRIVATE_FILE);
  return dir;
}

/**
 * store.ts: called with the parsed db.json. Schema 2 → unchanged. Schema 1 → converted in memory, then backed up;
 * the caller writes the result. Throws (nothing written) when the private file is broken or a version cannot be
 * converted.
 */
export async function migrateOnLoad(parsed: unknown, dataFolder: string): Promise<{ db: Partial<Db>; migrated: boolean; report?: MigrationReport; backupDir?: string }> {
  if (!isRecord(parsed)) throw new Error(`${ABORT} db.json enthält kein Objekt.`);
  const version = parsed.schemaVersion ?? 1;
  if (version === 2) return { db: parsed as Partial<Db>, migrated: false };
  if (version !== 1) throw new Error(`db.json hat Schema ${String(version)}; diese Version des Studios kennt höchstens Schema 2.`);
  const priv = await readLegacyPrivate(dataFolder);
  const { db, report } = migrateV1(parsed, priv.data);
  const backupDir = await backupV1(dataFolder, priv.present);
  console.info(`[migration] db.json Schema 1 → 2: ${report.strategies} Strategie-, ${report.profiles} Profil-Version(en), ${report.notes} Notiz(en), ${report.reasons} Begründung(en), ${report.pillarsCopied} Säule(n) übernommen, ${report.repairs} Reparatur(en). Backup: ${backupDir}`);
  return { db, migrated: true, report, backupDir };
}
