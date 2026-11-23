import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Etappe 10: Style Bible / Voice Guide are active on save, editable at the active version; observations are editable. */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-style-activate-'));
  process.env.STUDIO_DATA_DIR = dir;
  process.env.AI_PROVIDER = 'mock';
  delete process.env.STUDIO_ACCESS_TOKEN;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('Style Bible and Voice Guide: active on save', () => {
  it('a new version from the form is active at once; the previous one is archived', async () => {
    const style = await import('@/server/services/style');
    const v1 = await style.createStyleVersion({ name: 'Stil 1', traits: 'warm, ruhig', palette: '#D8FB96, #111411' });
    expect(v1).toMatchObject({ status: 'approved', approvedAt: expect.any(String), warnings: [] });
    const v2 = await style.createStyleVersion({ name: 'Stil 2' });
    const st = await style.getStyleState();
    expect(st.current?.id).toBe(v2.id);
    expect(st.versions.find((v) => v.id === v1.id)?.status).toBe('archived');
    expect(st.versions.filter((v) => v.status === 'approved')).toHaveLength(1);
  });

  it('editing the active version: edited rules (removed/changed chips, palette) become a new active version', async () => {
    const style = await import('@/server/services/style');
    await style.createStyleVersion({ name: 'Basis', traits: 'warm\nruhig\ngrafisch', avoid: 'Neon', palette: '#D8FB96, #111411' });
    const active = (await style.getStyleState()).current!;
    const rules = structuredClone(active.rules);
    rules.visual.traits = ['warm', 'grafisch und klar']; // „ruhig“ removed, one chip edited
    rules.visual.palette = ['#111411', '#E0A040']; // one removed, one added
    rules.visual.avoid = [];
    const edited = await style.createStyleVersion({ rules });
    expect(edited).toMatchObject({ status: 'approved', version: active.version + 1, rules: { visual: { traits: ['warm', 'grafisch und klar'], palette: ['#111411', '#E0A040'], avoid: [] } } });
    const st = await style.getStyleState();
    expect(st.current?.id).toBe(edited.id);
    expect(st.versions.find((v) => v.id === active.id)).toMatchObject({ status: 'archived', rules: active.rules }); // history unchanged
    // the form follows the active rules, so „aus Formular speichern“ does not bring back removed chips
    expect(st.form).toMatchObject({ traits: 'warm\ngrafisch und klar', palette: '#111411, #E0A040', avoid: '' });
  });

  it('invalid edited rules are a 400, never a silent fallback to the form', async () => {
    const style = await import('@/server/services/style');
    const { ZodError } = await import('zod');
    const active = (await style.getStyleState()).current!;
    const before = (await style.getStyleState()).versions.length;
    const bad = { ...active.rules, visual: { ...active.rules.visual, palette: ['rot'] } };
    await expect(style.createStyleVersion({ rules: bad })).rejects.toBeInstanceOf(ZodError);
    await expect(style.createStyleVersion({ rules: active.rules, extra: 1 })).rejects.toBeInstanceOf(ZodError);
    expect((await style.getStyleState()).versions.length).toBe(before);
  });

  it('approve reactivates an older version', async () => {
    const style = await import('@/server/services/style');
    const st = await style.getStyleState();
    const old = st.versions.find((v) => v.status === 'archived')!;
    await style.approveVersion('style', old.id);
    const after = await style.getStyleState();
    expect(after.current?.id).toBe(old.id);
    expect(after.versions.find((v) => v.id === st.current!.id)?.status).toBe('archived');
  });

  it('Voice Guide: form and edited rules both create an active version', async () => {
    const style = await import('@/server/services/style');
    const v1 = await style.createVoiceVersion({ traits: 'direkt, neugierig', avoid: 'Clickbait', example: 'Ich probier das mal.' });
    expect(v1.status).toBe('approved');
    const v2 = await style.createVoiceVersion({ rules: { ...v1.rules, traits: ['direkt'], avoid: [] } });
    expect(v2).toMatchObject({ status: 'approved', rules: { traits: ['direkt'], avoid: [] } });
    const st = await style.getStyleState();
    expect(st.voiceVersions.find((v) => v.id === v1.id)?.status).toBe('archived');
    expect(st.voiceForm.traits).toBe('direkt');
  });
});

describe('AI observations are editable', () => {
  it('statement, dimension and colors can be edited; the AI original and the decision stay', async () => {
    const refs = await import('@/server/services/references');
    const { reference } = await refs.createReference(new File([PNG], 'poster.png', { type: 'image/png' }), JSON.stringify(['#E0A040']));
    await refs.updateReference(reference.id, { likes: ['warme Schatten'] });
    const { observations } = await refs.analyzeReference(reference.id);
    const o = observations[0]!;
    const approved = await refs.reviewObservation(o.id, { decision: 'approved', feedback: 'passt' });
    expect(approved.decision).toBe('approved');

    const edited = await refs.reviewObservation(o.id, { statement: '  Warmes Seitenlicht, weiche Schatten  ', dimension: 'lighting', colors: ['#e0a040'] });
    expect(edited).toMatchObject({
      statement: 'Warmes Seitenlicht, weiche Schatten', dimension: 'lighting', colors: ['#E0A040'],
      decision: 'approved', feedback: 'passt', editedAt: expect.any(String),
      original: { statement: o.statement, dimension: o.dimension, colors: o.colors },
    });
    // a second edit keeps the FIRST original (the AI's wording)
    const again = await refs.reviewObservation(o.id, { statement: 'Noch einmal anders' });
    expect(again.original).toEqual({ statement: o.statement, dimension: o.dimension, colors: o.colors });
    expect(again.decision).toBe('approved');
    // a decision alone leaves the text alone
    const rejected = await refs.reviewObservation(o.id, { decision: 'rejected' });
    expect(rejected).toMatchObject({ decision: 'rejected', statement: 'Noch einmal anders', feedback: 'passt' });
  });

  it('validates: empty or too long statement, unknown dimension, bad colors, unknown keys, empty patch', async () => {
    const refs = await import('@/server/services/references');
    const { read } = await import('@/server/store');
    const id = await read((db) => db.observations[0]!.id);
    for (const body of [{ statement: '   ' }, { statement: 'x'.repeat(1001) }, { dimension: 'mood-board' }, { colors: ['rot'] }, { colors: Array(9).fill('#000000') }, { evidence: 'x' }, {}])
      await expect(refs.reviewObservation(id, body)).rejects.toThrow();
  });

  it('a hand-edited pending observation survives a new analysis of the same reference', async () => {
    const refs = await import('@/server/services/references');
    const { read } = await import('@/server/store');
    const refId = await read((db) => db.references[0]!.id);
    const pending = await read((db) => db.observations.find((o) => o.referenceId === refId && o.decision === 'pending')!);
    await refs.reviewObservation(pending.id, { statement: 'Meine Formulierung' });
    await refs.analyzeReference(refId);
    expect(await read((db) => db.observations.find((o) => o.id === pending.id))).toMatchObject({ statement: 'Meine Formulierung', decision: 'pending' });
  });
});
