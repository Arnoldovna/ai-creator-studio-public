import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProfileAiSafe, ProfileLocalOnly, StrategyAiSafeDraft, StrategyLocalOnly } from '@studio/core';

/**
 * Etappe 11, E3: db.json schema 1 → 2 on load. Invented v1 fixture: a strategy and a profile split into db.json and
 * the private file, a self-check note and an override reason in the private file, an old FitCheck pillar on a gate.
 * Checks: one document each, nothing lost, backup of both files before the first write, idempotent, abort without
 * writing on a broken private file.
 */
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'studio-migrate-'));
  process.env.AI_PROVIDER = 'mock';
});
afterAll(() => rm(root, { recursive: true, force: true }));

const at = '2026-11-16T10:00:00.000Z';
const strategyAi: StrategyAiSafeDraft = {
  summary: 'Werkstattvideos ohne Perfektion.', phase: 'private_trial', phaseLabel: 'Private Erprobungsphase',
  pillars: [{ id: 'werkstatt', name: 'Werkstatt', targetShare: 100, purpose: 'Echte Schritte', exampleTopics: ['Hobeln'], fitCriteria: [{ id: 'werkstatt-f1', text: 'Echter Schritt' }] }],
  formats: [], contentRules: ['Kurz'], noGoLabels: [{ category: 'employer', label: 'Keine Interna vom Arbeitgeber.' }], disclosure: 'KI kennzeichnen.',
};
const strategyLocal: StrategyLocalOnly = {
  goal: { primary: 'Fertig werden', secondary: [], success6Months: '', success12Months: '' },
  positioning: { statement: 'Ehrlich', core: '', differentiators: [], notThis: [] }, audience: [],
  cadence: { postsPerWeek: 2, maxHoursPerWeek: null, notes: '' },
  boundaries: { showFace: 'ja', showVoice: 'ja', noGos: ['keine Adresse nennen'] },
  metrics: [{ goal: 'Freude', metric: 'Freude 1–5', reviewAfterWeeks: 8, decisionRule: '' }], openQuestions: [], assumptions: [],
  localExampleTopics: [{ pillarId: 'werkstatt', topic: 'LOCAL-DETAIL-3c1f Leimzwinge' }],
  sensitiveTerms: [{ term: 'Beispielstadt', category: 'home_location' }], notes: 'LOCAL-NOTE-7a2e Wochenende',
};
const profileAi: ProfileAiSafe = { who: 'Eine Person mit Werkstatt.', now: '', thread: 'Ausprobieren.', aiStance: '', recurringThemes: ['Holz'], tone: 'ruhig', boundariesGeneral: '' };
const profileLocal: ProfileLocalOnly = { notes: ['PROFILE-LOCAL-91bd Notiz'], topicIdeas: ['Idee'], sensitiveTerms: [] };

function v1Db() {
  const base = { profileId: 'profile-personal', status: 'approved', createdAt: at, approvedAt: at, aiTextHash: 'a'.repeat(64), importWarnings: ['summary_empty'] };
  return {
    schemaVersion: 1,
    profiles: [{ id: 'profile-personal', name: 'Meine Creator-DNA', kind: 'personal', createdAt: at }],
    projects: [{ id: 'p1', title: 'Eigenes', kind: 'PERSONAL_CONTENT', description: '', client: null, profileId: 'profile-personal', status: 'active', createdAt: at, updatedAt: at }],
    concepts: [{ id: 'c1', projectId: 'p1', briefId: 'b1', agentRunId: 'r', index: 0, body: {}, status: 'approved', styleBibleVersionId: null, voiceGuideVersionId: null, mock: true, createdAt: at, strategyVersionId: 's1', profileVersionId: 'pr1', pillarId: null }],
    contextVersions: [
      { ...base, id: 's1', kind: 'strategy', version: 1, aiSafe: strategyAi, source: 'import' },
      { ...base, id: 'pr1', kind: 'profile', version: 1, aiSafe: profileAi, source: 'manual' },
    ],
    strategyGates: [{
      id: 'g1', projectId: 'p1', subject: { kind: 'concept', conceptId: 'c1' }, strategyVersionId: 's1', pillarId: 'werkstatt', answers: [], joyExpected: 'ja', withinBoundaries: 'ja',
      confirmedAt: at, fitOverrides: [{ id: 'o1', key: 'joy_nein', at, hasReason: true }], lintOverrides: [], history: [], createdAt: at, updatedAt: at,
    }],
    selfAssessments: [
      { id: 'sa1', projectId: null, subject: { kind: 'session' }, pillarId: null, strategyVersionId: 's1', joy: 4, cameraComfort: 3, finished: null, hasNote: true, assessedAt: at, createdAt: at },
      { id: 'sa2', projectId: null, subject: { kind: 'session' }, pillarId: null, strategyVersionId: 's1', joy: 2, cameraComfort: null, finished: null, hasNote: false, assessedAt: at, createdAt: at },
    ],
  };
}
const v1Private = () => structuredClone({
  schemaVersion: 1,
  contextLocal: { s1: { kind: 'strategy', data: strategyLocal }, pr1: { kind: 'profile', data: profileLocal }, orphan: { kind: 'strategy', data: {} } },
  overrideReasons: { o1: 'REASON-5f0a Begründung lang genug' },
  selfAssessmentNotes: { sa1: 'SELFNOTE-c3d9 lief gut' },
});

let n = 0;
async function v1Folder(priv: string | null = JSON.stringify(v1Private())) {
  const data = path.join(root, `data-${++n}`);
  await mkdir(path.join(data, 'private'), { recursive: true });
  await writeFile(path.join(data, 'db.json'), JSON.stringify(v1Db()));
  if (priv != null) await writeFile(path.join(data, 'private', 'context-local.json'), priv, { mode: 0o600 });
  return data;
}
/** Points the store at a folder; switching folders makes the store load (and migrate) from disk. */
async function load(data: string) {
  process.env.STUDIO_DATA_DIR = data;
  process.env.STUDIO_DEFAULTS_DIR = 'off';
  const { read } = await import('@/server/store');
  return read((db) => structuredClone(db));
}
const backups = async (data: string) => readdir(path.join(data, 'backups')).catch(() => [] as string[]);
const mode = async (p: string) => (await stat(p)).mode & 0o777;

describe('migration schema 1 → 2', () => {
  it('merges each version into one document and moves notes and reasons; the pillar of the old gate goes to the concept', async () => {
    const data = await v1Folder();
    const db = await load(data);
    expect(db.schemaVersion).toBe(2);
    const s = db.contextVersions.find((v) => v.id === 's1')!;
    expect(s).toMatchObject({ kind: 'strategy', sourceKey: null, status: 'approved', version: 1, source: 'import', aiTextHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(s).not.toHaveProperty('aiSafe');
    expect(s).not.toHaveProperty('importWarnings');
    expect(s.kind === 'strategy' && s.document).toMatchObject({
      summary: strategyAi.summary, notes: 'LOCAL-NOTE-7a2e Wochenende', goal: { primary: 'Fertig werden' },
      pillars: [{ id: 'werkstatt', share: 100, exampleTopics: ['Hobeln', 'LOCAL-DETAIL-3c1f Leimzwinge'], fitCriteria: ['Echter Schritt'] }],
      boundaries: { noGos: ['keine Adresse nennen', 'Keine Interna vom Arbeitgeber.'], disclosure: 'KI kennzeichnen.' },
      sensitiveTerms: [{ term: 'Beispielstadt' }], metrics: [{ reviewAfterWeeks: 8 }],
    });
    const p = db.contextVersions.find((v) => v.id === 'pr1')!;
    expect(p.kind === 'profile' && p.document.markdown).toMatch(/## Wer ich bin\n\nEine Person mit Werkstatt\.[\s\S]*- PROFILE-LOCAL-91bd Notiz/);
    expect(db.selfAssessments.map((a) => [a.id, a.note, 'hasNote' in a])).toEqual([['sa1', 'SELFNOTE-c3d9 lief gut', false], ['sa2', '', false]]);
    expect(db.strategyGates[0]!.fitOverrides[0]).toEqual({ id: 'o1', key: 'joy_nein', at, reason: 'REASON-5f0a Begründung lang genug' });
    expect(db.concepts[0]!.pillarId).toBe('werkstatt');
    // persisted as schema 2
    expect(JSON.parse(await readFile(path.join(data, 'db.json'), 'utf8')).schemaVersion).toBe(2);
    // the AI context now carries the formerly local detail
    const { getContext } = await import('@/server/services/strategy');
    expect((await getContext()).ai.agentText).toContain('LOCAL-DETAIL-3c1f');
  });

  it('backs up db.json and the private file before writing (0700/0600); the private file stays untouched', async () => {
    const data = await v1Folder();
    const originalDb = await readFile(path.join(data, 'db.json'), 'utf8');
    const originalPriv = await readFile(path.join(data, 'private', 'context-local.json'), 'utf8');
    await load(data);
    const [dirName, ...more] = await backups(data);
    expect(more).toEqual([]);
    expect(dirName).toMatch(/^v1-\d{4}-\d{2}-\d{2}T/);
    const dir = path.join(data, 'backups', dirName!);
    expect(await readFile(path.join(dir, 'db.json'), 'utf8')).toBe(originalDb);
    expect(await readFile(path.join(dir, 'private', 'context-local.json'), 'utf8')).toBe(originalPriv);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(path.join(dir, 'db.json'))).toBe(0o600);
    expect(await mode(path.join(dir, 'private', 'context-local.json'))).toBe(0o600);
    expect(await readFile(path.join(data, 'private', 'context-local.json'), 'utf8')).toBe(originalPriv);
  });

  it('two parallel first loads (also from two copies of the store module) migrate once and make exactly one backup', async () => {
    const data = await v1Folder();
    process.env.STUDIO_DATA_DIR = data;
    process.env.STUDIO_DEFAULTS_DIR = 'off';
    const a = await import('@/server/store');
    vi.resetModules(); // a second evaluation of the module, as separate Next.js route bundles can have
    const b = await import('@/server/store');
    expect(b).not.toBe(a);
    const [x, y, z] = await Promise.all([a.read((db) => db.schemaVersion), b.read((db) => db.schemaVersion), a.read((db) => db.contextVersions.length)]);
    expect([x, y, z]).toEqual([2, 2, 2]);
    expect(await backups(data)).toHaveLength(1);
  });

  it('is idempotent: loading the migrated folder again changes nothing and makes no second backup', async () => {
    const data = await v1Folder();
    const first = await load(data);
    const text = await readFile(path.join(data, 'db.json'), 'utf8');
    await load(path.join(root, 'elsewhere')); // the store forgets the cache when the folder changes
    const again = await load(data);
    expect(again.contextVersions).toEqual(first.contextVersions);
    expect(await readFile(path.join(data, 'db.json'), 'utf8')).toBe(text);
    expect(await backups(data)).toHaveLength(1);
    // a pure re-run on schema 2 is the identity
    const { migrateOnLoad } = await import('@/server/migrateData');
    expect(await migrateOnLoad(JSON.parse(text), data)).toMatchObject({ migrated: false });
  });

  it('a broken private file aborts with a clear message and writes nothing (no db change, no backup)', async () => {
    const data = await v1Folder('{"contextLocal": {"s1": SECRET-CANARY-18e2');
    const before = await readFile(path.join(data, 'db.json'), 'utf8');
    await expect(load(data)).rejects.toThrow(/Datenmigration auf Schema 2 abgebrochen, es wurde nichts geschrieben: die private Datei .* ist beschädigt/);
    await expect(load(data)).rejects.not.toThrow(/SECRET-CANARY/);
    expect(await readFile(path.join(data, 'db.json'), 'utf8')).toBe(before);
    expect(await backups(data)).toEqual([]);
    // a wrong shape is just as broken
    const shaped = await v1Folder(JSON.stringify({ contextLocal: [], overrideReasons: {}, selfAssessmentNotes: {} }));
    await expect(load(shaped)).rejects.toThrow(/beschädigt/);
    await load(path.join(root, 'elsewhere-2'));
  });

  it('old data that breaks today\'s rules is repaired, not rejected: duplicate pillar ids, dangling formats, wrong types, too long texts', async () => {
    const db = v1Db();
    const pillar = (id: string, name: string) => ({ id, name, targetShare: 33, purpose: '', exampleTopics: [], fitCriteria: [] });
    // Etappe-10 editor data: „+ Säule“ after a delete gave saeule-3 twice; the format still points at the removed saeule-1
    Object.assign(db.contextVersions[0]!, { status: 'archived', aiSafe: { ...strategyAi, pillars: [pillar('saeule-2', 'Zwei'), pillar('saeule-3', 'Drei'), pillar('saeule-3', 'Drei bis')], formats: [{ name: 'Talking Head', pillarIds: ['saeule-1', 'saeule-2'], notes: '' }] } });
    db.contextVersions.push({ ...db.contextVersions[0]!, id: 's2', version: 2, status: 'approved', aiSafe: { ...strategyAi, summary: 'x'.repeat(2500) } });
    (db.concepts[0] as { pillarId: string | null }).pillarId = 'saeule-3';
    const priv = v1Private();
    (priv.contextLocal.s1.data as Record<string, unknown>).notes = 42;
    (priv.contextLocal.s1.data as { audience: unknown[] }).audience = [{ name: 'Ok' }, { situation: 'ohne Namen' }];
    const data = path.join(root, `data-${++n}`);
    await mkdir(path.join(data, 'private'), { recursive: true });
    await writeFile(path.join(data, 'db.json'), JSON.stringify(db));
    await writeFile(path.join(data, 'private', 'context-local.json'), JSON.stringify(priv));
    const migrated = await load(data);
    const s1 = migrated.contextVersions.find((v) => v.id === 's1')!;
    if (s1.kind !== 'strategy') throw new Error('strategy expected');
    expect(s1.status).toBe('archived');
    expect(s1.document.pillars.map((p) => [p.id, p.name])).toEqual([['saeule-2', 'Zwei'], ['saeule-3', 'Drei'], ['saeule-3-2', 'Drei bis']]);
    expect(s1.document.formats[0]!.pillarIds).toEqual(['saeule-2']);
    expect(s1.document.notes).toBe('');
    expect(s1.document.audience.map((a) => a.name)).toEqual(['Ok']);
    const log = JSON.stringify(s1.document.extras['Repariert beim Umwandeln']);
    expect(log).toContain('saeule-3-2');
    expect(log).toContain('saeule-1');
    expect(log).toContain('notes');
    expect(log).toContain('ohne Namen');
    const s2 = migrated.contextVersions.find((v) => v.id === 's2')!;
    expect(s2.kind === 'strategy' && s2.document.summary.length).toBe(2000);
    expect(JSON.stringify(s2.kind === 'strategy' && s2.document.extras)).toContain('auf 2000 Zeichen gekürzt');
    // concept and gate keep the old id
    expect(migrated.concepts[0]!.pillarId).toBe('saeule-3');
    expect(migrated.strategyGates[0]!.pillarId).toBe('werkstatt');
    // second run: nothing changes
    const text = await readFile(path.join(data, 'db.json'), 'utf8');
    await load(path.join(root, 'elsewhere-r'));
    await load(data);
    expect(await readFile(path.join(data, 'db.json'), 'utf8')).toBe(text);
    expect(await backups(data)).toHaveLength(1);
  });

  it('two active versions of one kind in old data: the newest stays active', async () => {
    const db = v1Db();
    db.contextVersions.push({ ...db.contextVersions[0]!, id: 's3', version: 3 });
    const data = path.join(root, `data-${++n}`);
    await mkdir(path.join(data, 'private'), { recursive: true });
    await writeFile(path.join(data, 'db.json'), JSON.stringify(db));
    const migrated = await load(data);
    expect(migrated.contextVersions.filter((v) => v.kind === 'strategy').map((v) => [v.id, v.status])).toEqual([['s1', 'archived'], ['s3', 'approved']]);
    await load(path.join(root, 'elsewhere-a'));
  });

  it('without a private file the migration still runs', async () => {
    const bare = await v1Folder(null);
    const db = await load(bare);
    const s = db.contextVersions.find((v) => v.id === 's1')!;
    expect(s.kind === 'strategy' && s.document.notes).toBe('');
    expect(db.selfAssessments[0]!.note).toBe('');
    expect(await readdir(path.join(bare, 'backups', (await backups(bare))[0]!))).toEqual(['db.json', 'private']);
    await load(path.join(root, 'elsewhere-3'));
  });

  it('counts orphaned private entries in the report (they stay in the backup)', async () => {
    const { migrateV1 } = await import('@/server/migrateData');
    const r = migrateV1(v1Db() as never, v1Private() as never);
    expect(r.report).toEqual({ strategies: 1, profiles: 1, notes: 1, reasons: 1, pillarsCopied: 1, repairs: 0, orphanedPrivateEntries: 1 });
  });
});
