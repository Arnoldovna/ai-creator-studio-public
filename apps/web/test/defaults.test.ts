import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseStrategyDocument, type ProfileAiSafe, type StrategyAiSafeDraft, type StrategyLocalOnly, type StyleBibleRules, type VoiceGuideRules } from '@studio/core';
import { canaryLocalOnly, fixtureProfileAiSafe, INTERVIEW_MD, PROFILE_MD, strategyImportJson } from '../../../packages/core/test/fixtures/strategy';

/**
 * Standard folder (Etappe 10, E2; file format v2 since Etappe 11): write-through, seed-on-empty (also from the
 * Etappe-10 format), invalid files, off switch, file modes.
 * Only temp folders: STUDIO_DEFAULTS_DIR is set per test and reset to `off` afterwards (vitest.config sets off).
 */
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'studio-defaults-'));
  process.env.AI_PROVIDER = 'mock';
  delete process.env.STUDIO_ACCESS_TOKEN;
});
afterAll(async () => {
  process.env.STUDIO_DEFAULTS_DIR = 'off';
  await rm(root, { recursive: true, force: true });
});

let n = 0;
/** Fresh data folder (the store reloads, and seeds, when the folder changes) and a defaults folder. */
async function fresh(defaults: string | 'off' = path.join(root, `std-${++n}`)) {
  const data = path.join(root, `data-${++n}`);
  process.env.STUDIO_DATA_DIR = data;
  process.env.STUDIO_DEFAULTS_DIR = defaults;
  (await d()).resetDefaultsState();
  return { data, defaults };
}
const d = () => import('@/server/defaults');
const store = () => import('@/server/store');
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const mode = async (p: string) => (await stat(p)).mode & 0o777;

const styleRules = (name = 'Werkstatt-Look'): StyleBibleRules => ({
  name, visual: { palette: ['#223344'], traits: ['warmes Licht'], avoid: ['Neon'], typography: 'Grotesk', lighting: 'Fenster', composition: 'mittig', textures: 'Holz' },
  motion: { pacing: 'ruhig', transitions: ['harter Schnitt'] }, approvedReferenceIds: [], approvedObservationIds: [],
});
const voiceRules = (trait = 'ehrlich'): VoiceGuideRules => ({ traits: [trait], avoid: ['Superlative'], ownExamples: ['Heute zeige ich, wie es wirklich lief.'] });
const strategyDoc = (notes = 'Notiz aus dem Standard') => {
  const r = parseStrategyDocument(JSON.stringify({ ...JSON.parse(strategyImportJson), summary: 'Kurze Werkstattvideos.', notes }));
  if (!r.ok || !r.document) throw new Error('fixture must parse');
  return r.document;
};

/** Activates versions purely through the store state (status approved), like either variant of the services does. */
async function activate(kind: 'style' | 'voice' | 'strategy' | 'profile' | 'source', body: unknown) {
  const { write, newId, now, PERSONAL_PROFILE_ID } = await store();
  const id = newId();
  await write((db) => {
    const at = now();
    if (kind === 'style' || kind === 'voice') {
      const list = kind === 'style' ? db.styleBibles : db.voiceGuides;
      for (const v of list) if (v.status === 'approved') v.status = 'archived';
      const version = list.length + 1;
      if (kind === 'style') db.styleBibles.push({ id, profileId: PERSONAL_PROFILE_ID, version, status: 'approved', rules: body as StyleBibleRules, createdAt: at, approvedAt: at });
      else db.voiceGuides.push({ id, profileId: PERSONAL_PROFILE_ID, version, status: 'approved', rules: body as VoiceGuideRules, createdAt: at, approvedAt: at });
    } else {
      const sourceKey = kind === 'source' ? (body as { key: string }).key : null;
      const same = (v: { kind: string; sourceKey: string | null }) => v.kind === kind && v.sourceKey === sourceKey;
      for (const v of db.contextVersions) if (same(v) && v.status === 'approved') v.status = 'archived';
      db.contextVersions.push({
        id, profileId: PERSONAL_PROFILE_ID, kind, sourceKey, version: db.contextVersions.filter(same).length + 1, status: 'approved',
        document: body, aiTextHash: 'x'.repeat(64), source: 'manual', createdAt: at, approvedAt: at,
      } as never);
    }
  });
  return id;
}

async function seedStandardFolder() {
  const { defaults } = await fresh();
  await activate('strategy', strategyDoc('std-Notiz'));
  await activate('profile', { markdown: PROFILE_MD, sensitiveTerms: [{ term: 'Beispielstadt', category: 'home_location' }] });
  await activate('source', { key: 'interview', title: 'Interview', markdown: INTERVIEW_MD, sendMode: 'chat_voice_only' });
  await activate('style', styleRules());
  await activate('voice', voiceRules());
  await (await d()).flushDefaults();
  return defaults;
}

beforeEach(() => {
  process.env.STUDIO_DEFAULTS_DIR = 'off';
});

describe('standard folder: write-through', () => {
  it('writes strategie.json + strategie.md, profil.md, quellen/*.md, style, voice and manifest, with hashes and modes 0700/0600', async () => {
    const defaults = await seedStandardFolder();
    const s = await json(path.join(defaults, 'strategie.json'));
    expect(s).toMatchObject({ schemaVersion: 2, kind: 'strategy', source: { version: 1 }, document: { notes: 'std-Notiz' } });
    expect(await readFile(path.join(defaults, 'strategie.md'), 'utf8')).toMatch(/^# Strategie[\s\S]*## Notizen\n\nstd-Notiz/);
    const profile = await readFile(path.join(defaults, 'profil.md'), 'utf8');
    expect(profile).toMatch(/^---\nstudio: profil\nversion: 1\nsensitiveTerms: \[/);
    expect(profile.endsWith(PROFILE_MD)).toBe(true);
    const source = await readFile(path.join(defaults, 'quellen', 'interview.md'), 'utf8');
    expect(source).toMatch(/^---\nstudio: quelle\nkey: interview\ntitle: Interview\nsendMode: chat_voice_only\n/);
    expect((await json(path.join(defaults, 'style-bible.json'))).rules.name).toBe('Werkstatt-Look');
    expect((await json(path.join(defaults, 'voice.json'))).rules.traits).toEqual(['ehrlich']);

    const m = await json(path.join(defaults, 'manifest.json'));
    expect(m.schemaVersion).toBe(2);
    expect(Object.keys(m.files).sort()).toEqual(['profil.md', 'quellen/interview.md', 'strategie.json', 'strategie.md', 'style-bible.json', 'voice.json']);
    const text = await readFile(path.join(defaults, 'voice.json'), 'utf8');
    expect(m.files['voice.json'].sha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));

    expect(await mode(defaults)).toBe(0o700);
    expect(await mode(path.join(defaults, 'quellen'))).toBe(0o700);
    for (const f of ['strategie.json', 'strategie.md', 'profil.md', 'quellen/interview.md', 'style-bible.json', 'voice.json', 'manifest.json']) expect(await mode(path.join(defaults, f))).toBe(0o600);

    const status = await (await d()).getDefaultsStatus();
    expect(status.enabled).toBe(true);
    expect(status.lastSavedAt).toBe(m.savedAt);
    expect(status.files.every((f) => f.present && f.valid && !f.differs)).toBe(true);
    expect(status.fileNewer).toBe(false);
  });

  it('a new active version rewrites the file; writes that do not change the active state do not', async () => {
    const { defaults } = await fresh();
    await activate('voice', voiceRules('ehrlich'));
    await (await d()).flushDefaults();
    const first = await json(path.join(defaults, 'manifest.json'));
    // unrelated write: no snapshot
    await (await store()).write((db) => { db.routerPreferences = {}; });
    await (await d()).flushDefaults();
    expect((await json(path.join(defaults, 'manifest.json'))).savedAt).toBe(first.savedAt);
    await activate('voice', voiceRules('direkt'));
    await (await d()).flushDefaults();
    const voice = await json(path.join(defaults, 'voice.json'));
    expect(voice.rules.traits).toEqual(['direkt']);
    expect(voice.source.version).toBe(2);
  });

  it('a failing write-through never fails the activation; the error is in the status', async () => {
    const blocker = path.join(root, `blocker-${++n}`);
    await writeFile(blocker, 'kein Ordner');
    await fresh(path.join(blocker, 'standard'));
    await expect(activate('style', styleRules())).resolves.toBeTypeOf('string');
    await (await d()).flushDefaults();
    const status = await (await d()).getDefaultsStatus();
    expect(status.lastError).toMatch(/fehlgeschlagen/);
  });
});

describe('standard folder: seed', () => {
  it('seeds an empty data folder as version 1, active, source defaults: strategy, profile, source, style, voice', async () => {
    const defaults = await seedStandardFolder();
    const { data } = await fresh(defaults);
    const db = await (await store()).read((x) => x);
    const strategy = db.contextVersions.find((v) => v.kind === 'strategy');
    expect(strategy).toMatchObject({ version: 1, status: 'approved', source: 'defaults', profileId: 'profile-personal', document: { notes: 'std-Notiz' }, aiTextHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(strategy?.approvedAt).toBeTruthy();
    expect(db.contextVersions.find((v) => v.kind === 'profile')).toMatchObject({ version: 1, status: 'approved', document: { markdown: PROFILE_MD, sensitiveTerms: [{ term: 'Beispielstadt' }] } });
    expect(db.contextVersions.find((v) => v.kind === 'source')).toMatchObject({ sourceKey: 'interview', document: { title: 'Interview', sendMode: 'chat_voice_only', markdown: INTERVIEW_MD } });
    expect(db.styleBibles).toMatchObject([{ version: 1, status: 'approved', source: 'defaults', rules: { name: 'Werkstatt-Look' } }]);
    expect(db.voiceGuides).toMatchObject([{ version: 1, status: 'approved' }]);
    // persisted, not just cached; no private file any more
    expect((await json(path.join(data, 'db.json'))).styleBibles).toHaveLength(1);
    await expect(stat(path.join(data, 'private'))).rejects.toMatchObject({ code: 'ENOENT' });
    const status = await (await d()).getDefaultsStatus();
    expect(status.seed?.imported.sort()).toEqual(['profile', 'source:interview', 'strategy', 'style', 'voice']);
    expect(status.files.every((f) => !f.differs)).toBe(true);
  });

  it('seeds from the Etappe-10 format (strategie.json/profil.json with aiSafe + localOnly): one document each, nothing lost', async () => {
    const { defaults } = await fresh();
    await mkdir(defaults, { recursive: true });
    const aiSafe: StrategyAiSafeDraft = {
      summary: 'Alt.', phase: 'private_trial', phaseLabel: 'Private Erprobungsphase', formats: [], contentRules: [], disclosure: '',
      noGoLabels: [{ category: 'children', label: 'Keine Kinder zeigen oder benennen.' }],
      pillars: [{ id: 'werkstatt', name: 'Werkstatt', targetShare: 100, purpose: '', exampleTopics: [], fitCriteria: [] }],
    };
    const localOnly: StrategyLocalOnly = { ...canaryLocalOnly('e10'), localExampleTopics: [{ pillarId: 'werkstatt', topic: 'Altes Lieblingsthema' }] };
    const profileAi: ProfileAiSafe = fixtureProfileAiSafe();
    await writeFile(path.join(defaults, 'strategie.json'), JSON.stringify({ schemaVersion: 1, kind: 'strategy', source: { version: 3 }, aiSafe, localOnly }));
    await writeFile(path.join(defaults, 'profil.json'), JSON.stringify({ schemaVersion: 1, kind: 'profile', aiSafe: profileAi, localOnly: { notes: ['Alte private Notiz'], topicIdeas: [], sensitiveTerms: [] } }));
    await writeFile(path.join(defaults, 'voice.json'), JSON.stringify({ schemaVersion: 1, kind: 'voice', rules: voiceRules('alt') }));
    await fresh(defaults);
    const db = await (await store()).read((x) => x);
    const s = db.contextVersions.find((v) => v.kind === 'strategy');
    expect(s?.kind === 'strategy' && s.document).toMatchObject({ notes: localOnly.notes, pillars: [{ exampleTopics: ['Altes Lieblingsthema'] }] });
    expect(s?.kind === 'strategy' && s.document.boundaries.noGos).toContain('Keine Kinder zeigen oder benennen.');
    const p = db.contextVersions.find((v) => v.kind === 'profile');
    expect(p?.kind === 'profile' && p.document.markdown).toContain('- Alte private Notiz');
    expect(db.voiceGuides[0]?.rules.traits).toEqual(['alt']);
    const status = await (await d()).getDefaultsStatus();
    expect(status.files.find((f) => f.kind === 'profile')).toMatchObject({ file: 'profil.json', valid: true, differs: false });
    // the next „Jetzt sichern“ writes the new format next to the old file (nothing is deleted)
    await (await d()).postDefaults({ action: 'snapshot' });
    expect((await json(path.join(defaults, 'strategie.json'))).schemaVersion).toBe(2);
    expect(await readFile(path.join(defaults, 'profil.md'), 'utf8')).toContain('Alte private Notiz');
    expect((await json(path.join(defaults, 'profil.json'))).kind).toBe('profile');
  });

  it('never seeds a data folder that already has a version (existing data is never overwritten)', async () => {
    const defaults = await seedStandardFolder();
    const data = path.join(root, `data-existing-${++n}`);
    await mkdir(data, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(path.join(data, 'db.json'), JSON.stringify({
      voiceGuides: [{ id: 'v-own', profileId: 'profile-personal', version: 4, status: 'draft', rules: voiceRules('eigen'), createdAt: now, approvedAt: null }],
    }));
    process.env.STUDIO_DATA_DIR = data;
    process.env.STUDIO_DEFAULTS_DIR = defaults;
    const db = await (await store()).read((x) => x);
    expect(db.contextVersions).toEqual([]);
    expect(db.styleBibles).toEqual([]);
    expect(db.voiceGuides.map((v) => v.id)).toEqual(['v-own']);
  });

  it('seed repairs an Etappe-10 strategie.json with duplicate pillar ids and a dangling format instead of blocking style/voice', async () => {
    const { defaults } = await fresh();
    await mkdir(defaults, { recursive: true });
    const pillar = (id: string) => ({ id, name: id, targetShare: 33, purpose: '', exampleTopics: [], fitCriteria: [] });
    const aiSafe = {
      summary: '', phase: 'private_trial', phaseLabel: 'Private Erprobungsphase', contentRules: [], disclosure: '', noGoLabels: [],
      pillars: [pillar('saeule-2'), pillar('saeule-3'), pillar('saeule-3')], formats: [{ name: 'Format', pillarIds: ['saeule-1'], notes: '' }],
    };
    await writeFile(path.join(defaults, 'strategie.json'), JSON.stringify({ schemaVersion: 1, kind: 'strategy', aiSafe, localOnly: null }));
    await writeFile(path.join(defaults, 'voice.json'), JSON.stringify({ schemaVersion: 1, kind: 'voice', rules: voiceRules('repariert') }));
    await fresh(defaults);
    const db = await (await store()).read((x) => x);
    const s = db.contextVersions.find((v) => v.kind === 'strategy');
    expect(s?.kind === 'strategy' && s.document.pillars.map((p) => p.id)).toEqual(['saeule-2', 'saeule-3', 'saeule-3-2']);
    expect(s?.kind === 'strategy' && s.document.formats[0]!.pillarIds).toEqual([]);
    expect(JSON.stringify(s?.kind === 'strategy' && s.document.extras)).toContain('saeule-1');
    expect(db.voiceGuides[0]?.rules.traits).toEqual(['repariert']);
    // the repaired file reads the same again: status in sync, nothing applicable
    const status = await (await d()).getDefaultsStatus();
    expect(status.files.find((f) => f.kind === 'strategy')).toMatchObject({ valid: true, differs: false });
  });

  it('an invalid file imports nothing and shows a warning', async () => {
    const defaults = await seedStandardFolder();
    await writeFile(path.join(defaults, 'strategie.json'), JSON.stringify({ schemaVersion: 2, kind: 'strategy', document: { pillars: 'kaputt' } }));
    await fresh(defaults);
    const db = await (await store()).read((x) => x);
    expect(db.contextVersions).toEqual([]);
    expect(db.voiceGuides).toEqual([]); // all or nothing, even though voice.json is valid
    const status = await (await d()).getDefaultsStatus();
    expect(status.seed?.warnings.join(' ')).toMatch(/strategie\.json passt nicht zum Schema/);
    expect(status.files.find((f) => f.kind === 'strategy')).toMatchObject({ present: true, valid: false });
    expect(status.canApply).toBe(false);
    await expect((await d()).applyDefaults()).rejects.toMatchObject({ status: 422 });
  });

  it('broken JSON is reported without quoting the file content', async () => {
    const { defaults } = await fresh();
    await mkdir(defaults, { recursive: true });
    await writeFile(path.join(defaults, 'profil.json'), '{"geheim": "Wohnort-Kanarienvogel"');
    await fresh(defaults);
    await (await store()).read((x) => x);
    const status = await (await d()).getDefaultsStatus();
    expect(JSON.stringify(status)).not.toContain('Kanarienvogel');
    expect(status.seed?.warnings.join(' ')).toMatch(/profil\.json kein gültiges JSON/);
  });
});

describe('standard folder: apply and off switch', () => {
  it('a file edited outside the studio is flagged and applied as a new active version', async () => {
    const defaults = await seedStandardFolder();
    const file = path.join(defaults, 'voice.json');
    const voice = await json(file);
    await writeFile(file, JSON.stringify({ ...voice, rules: { ...voice.rules, traits: ['verspielt'] } }, null, 2));
    const before = await (await d()).getDefaultsStatus();
    expect(before.fileNewer).toBe(true);
    expect(before.files.find((f) => f.kind === 'voice')).toMatchObject({ differs: true, changedOutside: true });
    const r = await (await d()).postDefaults({ action: 'apply' });
    expect('applied' in r ? r.applied : null).toEqual(['voice']);
    const db = await (await store()).read((x) => x);
    expect(db.voiceGuides.map((v) => [v.version, v.status])).toEqual([[1, 'archived'], [2, 'approved']]);
    expect(db.voiceGuides[1]!.rules.traits).toEqual(['verspielt']);
    expect(r.status.fileNewer).toBe(false);
    expect(r.status.files.every((f) => !f.differs)).toBe(true);
    // nothing left to apply
    expect((await (await d()).applyDefaults()).applied).toEqual([]);
  });

  it('off: no seed, no write-through, status disabled, actions refused', async () => {
    const defaults = await seedStandardFolder();
    await fresh('off');
    const db = await (await store()).read((x) => x);
    expect(db.voiceGuides).toEqual([]);
    const savedAt = (await json(path.join(defaults, 'manifest.json'))).savedAt;
    await activate('voice', voiceRules('anders'));
    await (await d()).flushDefaults();
    expect((await json(path.join(defaults, 'manifest.json'))).savedAt).toBe(savedAt);
    const status = await (await d()).getDefaultsStatus();
    expect(status).toMatchObject({ enabled: false, dir: null, files: [] });
    await expect((await d()).postDefaults({ action: 'snapshot' })).rejects.toMatchObject({ status: 409 });
    await expect((await d()).postDefaults({ action: 'nope' })).rejects.toThrow();
  });

  it('STUDIO_DEFAULTS_DIR defaults to the private Documents folder and `off` disables it', async () => {
    const { defaultsDir } = await import('@/server/env');
    const prev = { dir: process.env.STUDIO_DEFAULTS_DIR, home: process.env.HOME };
    try {
      delete process.env.STUDIO_DEFAULTS_DIR;
      process.env.HOME = '/home/test';
      expect(defaultsDir()).toBe(path.join('/home/test', 'Documents', 'AI Creator Studio (privat)', 'standard'));
      process.env.STUDIO_DEFAULTS_DIR = 'off';
      expect(defaultsDir()).toBeNull();
    } finally {
      process.env.STUDIO_DEFAULTS_DIR = prev.dir;
      process.env.HOME = prev.home;
    }
  });
});

describe('standard folder: review fixes (stale files, per-kind write-through, origin, size limit)', () => {
  it('apply takes only files changed outside: a stale style-bible.json never replaces the newer active Style Bible', async () => {
    const defaults = await seedStandardFolder();
    // Style Bible v2 becomes active while the standard folder is off: style-bible.json (written by the studio) is now stale
    process.env.STUDIO_DEFAULTS_DIR = 'off';
    await activate('style', styleRules('Neuer Look'));
    process.env.STUDIO_DEFAULTS_DIR = defaults;
    const file = path.join(defaults, 'voice.json');
    const voice = await json(file);
    await writeFile(file, JSON.stringify({ ...voice, rules: { ...voice.rules, traits: ['verspielt'] } }, null, 2));

    const status = await (await d()).getDefaultsStatus();
    expect(status.files.find((f) => f.kind === 'style')).toMatchObject({ differs: true, changedOutside: false, applicable: false });
    expect(status.files.find((f) => f.kind === 'voice')).toMatchObject({ differs: true, changedOutside: true, applicable: true });
    expect(status.files.filter((f) => f.applicable).map((f) => f.kind)).toEqual(['voice']);

    const r = await (await d()).postDefaults({ action: 'apply' });
    expect('applied' in r ? r.applied : null).toEqual(['voice']);
    const db = await (await store()).read((x) => x);
    const activeStyle = db.styleBibles.filter((v) => v.status === 'approved');
    expect(activeStyle.map((v) => [v.version, v.rules.name])).toEqual([[2, 'Neuer Look']]);
    expect(db.voiceGuides.find((v) => v.status === 'approved')?.rules.traits).toEqual(['verspielt']);
  });

  it('a file without an active version of its kind is applicable even if the studio wrote it', async () => {
    const defaults = await seedStandardFolder();
    const data = path.join(root, `data-novoice-${++n}`);
    await mkdir(data, { recursive: true });
    const at = new Date().toISOString();
    // existing data folder (no seed): only a style version, no voice version
    await writeFile(path.join(data, 'db.json'), JSON.stringify({
      styleBibles: [{ id: 's-own', profileId: 'profile-personal', version: 1, status: 'approved', rules: styleRules('eigen'), createdAt: at, approvedAt: at }],
    }));
    process.env.STUDIO_DATA_DIR = data;
    process.env.STUDIO_DEFAULTS_DIR = defaults;
    const status = await (await d()).getDefaultsStatus();
    expect(status.files.find((f) => f.kind === 'voice')).toMatchObject({ changedOutside: false, activeVersion: null, applicable: true });
    expect(status.files.find((f) => f.kind === 'style')).toMatchObject({ differs: true, changedOutside: false, applicable: false });
    expect((await (await d()).applyDefaults()).applied.sort()).toEqual(['profile', 'source:interview', 'strategy', 'voice']);
    const db = await (await store()).read((x) => x);
    expect(db.styleBibles.map((v) => v.id)).toEqual(['s-own']);
  });

  it('write-through writes only the kinds whose active version changed; other files and manifest entries stay', async () => {
    const defaults = await seedStandardFolder();
    const styleFile = path.join(defaults, 'style-bible.json');
    const style = await json(styleFile);
    const edited = `${JSON.stringify({ ...style, rules: { ...style.rules, name: 'Von Hand geändert' } }, null, 2)}\n`;
    await writeFile(styleFile, edited);
    const before = await json(path.join(defaults, 'manifest.json'));

    await activate('voice', voiceRules('direkt'));
    await (await d()).flushDefaults();

    expect(await readFile(styleFile, 'utf8')).toBe(edited);
    const after = await json(path.join(defaults, 'manifest.json'));
    expect(after.files['style-bible.json']).toEqual(before.files['style-bible.json']);
    expect(after.files['strategie.json']).toEqual(before.files['strategie.json']);
    expect(after.files['voice.json']).not.toEqual(before.files['voice.json']);
    expect((await json(path.join(defaults, 'voice.json'))).rules.traits).toEqual(['direkt']);
    const status = await (await d()).getDefaultsStatus();
    expect(status.files.find((f) => f.kind === 'style')).toMatchObject({ changedOutside: true, applicable: true });
  });

  it('manifest records the origin as a hash; another data folder writes nothing automatically and sees foreignOrigin', async () => {
    const defaults = await seedStandardFolder();
    const first = await json(path.join(defaults, 'manifest.json'));
    const ownerData = process.env.STUDIO_DATA_DIR!;
    expect(first.origin).toBe((await d()).originOf(ownerData));
    expect(first.origin).toBe(createHash('sha256').update(path.resolve(ownerData), 'utf8').digest('hex'));
    expect(JSON.stringify(first)).not.toContain(ownerData);
    expect((await (await d()).getDefaultsStatus()).foreignOrigin).toBe(false);

    // a worktree/demo data folder: seeded from the standard, then a new activation there
    const { data } = await fresh(defaults);
    await (await store()).read((x) => x);
    const voiceBefore = await readFile(path.join(defaults, 'voice.json'), 'utf8');
    await activate('voice', voiceRules('fremd'));
    await (await d()).flushDefaults();
    expect(await readFile(path.join(defaults, 'voice.json'), 'utf8')).toBe(voiceBefore);
    expect(await json(path.join(defaults, 'manifest.json'))).toEqual(first);
    const status = await (await d()).getDefaultsStatus();
    expect(status.foreignOrigin).toBe(true);
    expect(status.lastError).toBeNull();

    // explicit „Jetzt sichern“ takes over the origin
    const r = await (await d()).postDefaults({ action: 'snapshot' });
    expect(r.status.foreignOrigin).toBe(false);
    const taken = await json(path.join(defaults, 'manifest.json'));
    expect(taken.origin).toBe((await d()).originOf(data));
    expect((await json(path.join(defaults, 'voice.json'))).rules.traits).toEqual(['fremd']);
    // and from now on this folder's activations are written through
    await activate('voice', voiceRules('weiter'));
    await (await d()).flushDefaults();
    expect((await json(path.join(defaults, 'voice.json'))).rules.traits).toEqual(['weiter']);
  });

  it('an empty/new standard folder is claimed by the first data folder that activates something', async () => {
    const { defaults, data } = await fresh();
    await activate('style', styleRules());
    await (await d()).flushDefaults();
    const m = await json(path.join(defaults, 'manifest.json'));
    expect(m.origin).toBe((await d()).originOf(data));
    expect(Object.keys(m.files)).toEqual(['style-bible.json']);
  });

  it('a file over 5 MB is rejected as too large', async () => {
    const { defaults } = await fresh();
    await mkdir(defaults, { recursive: true });
    await writeFile(path.join(defaults, 'voice.json'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20));
    const status = await (await d()).getDefaultsStatus();
    expect(status.files.find((f) => f.kind === 'voice')).toMatchObject({ present: true, valid: false, error: 'Datei ist zu groß.' });
  });
});
