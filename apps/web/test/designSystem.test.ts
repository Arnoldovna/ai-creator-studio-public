import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedApprovedStrategy } from './helpers/strategy';

/**
 * Etappe 14: „Meine Marke“ through the services – save makes active, adopt from the Style Lab with provenance,
 * derive/suggest only propose, the editor's look follows the pinned version, fonts upload validation, and the
 * exact specimen through real FFmpeg + libass (preset and an uploaded font).
 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** An OFL-licensed TTF that ships with Next.js (Geist Regular); the tests copy it, nothing is installed. */
const GEIST = (() => {
  try {
    return createRequire(path.join(process.cwd(), 'package.json')).resolve('next/dist/compiled/@vercel/og/Geist-Regular.ttf');
  } catch {
    return null;
  }
})();
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-design-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', STUDIO_DEFAULTS_DIR: 'off' });
  await seedApprovedStrategy();
});
afterAll(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** A reference with a sampled palette, analysed (mock) and its colour observation confirmed. */
async function confirmedColour() {
  const refs = await import('@/server/services/references');
  const { reference } = await refs.createReference(new File([Buffer.concat([PNG, Buffer.from(String(Math.random()))])], 'poster.png', { type: 'image/png' }), JSON.stringify(['#C8553D', '#20302A']));
  await refs.updateReference(reference.id, { likes: ['warme Erdtöne'] });
  const { observations } = await refs.analyzeReference(reference.id);
  const colour = observations.find((o) => o.dimension === 'color')!;
  const liked = observations.find((o) => o.statement.startsWith('Von dir markiert'))!;
  await refs.reviewObservation(colour.id, { decision: 'approved' });
  await refs.reviewObservation(liked.id, { decision: 'approved' });
  return { reference, colour, liked, pending: observations.find((o) => o.dimension === 'composition')! };
}

describe('Meine Marke: save, adopt, derive, suggest', () => {
  it('starts from a derived proposal without a palette; adopting a confirmed colour makes a new active version with provenance', async () => {
    const ds = await import('@/server/services/designSystem');
    const { read } = await import('@/server/store');
    const before = await ds.getDesignState();
    expect(before).toMatchObject({ version: null, fresh: true });
    const { reference, colour, liked, pending } = await confirmedColour();
    const r = await ds.adoptIntoDesign({ kind: 'color', hex: '#c8553d', role: 'accent', observationId: colour.id });
    expect(r.version.version).toBe(1);
    expect(r.design.colors.accent).toEqual({ hex: '#C8553D', origin: { source: 'observation', observationIds: [colour.id], referenceIds: [reference.id], note: 'aus dem Style Lab übernommen' } });
    const state = await ds.getDesignState();
    expect(state).toMatchObject({ version: { id: r.version.id, version: 1, status: 'approved' }, legacy: false, fresh: false });
    expect(state.design.colors.accent.hex).toBe('#C8553D');
    // an observation into the guidelines and the image look, a reference into the image look
    await ds.adoptIntoDesign({ kind: 'observation', observationId: liked.id, target: 'guideline' });
    const v3 = await ds.adoptIntoDesign({ kind: 'observation', observationId: liked.id, target: 'imagery' });
    expect(v3.design.guidelines).toContain('Von dir markiert');
    expect(v3.design.guidelinesOrigin.observationIds).toEqual([liked.id]);
    expect(v3.design.imagery.referenceIds).toEqual([reference.id]);
    // only confirmed observations; the colour must belong to the observation
    await expect(ds.adoptIntoDesign({ kind: 'observation', observationId: pending.id, target: 'guideline' })).rejects.toMatchObject({ status: 409 });
    await expect(ds.adoptIntoDesign({ kind: 'color', hex: '#123456', role: 'accent', observationId: colour.id })).rejects.toMatchObject({ status: 400 });
    // one active version, history kept
    expect(await read((db) => db.styleBibles.map((v) => [v.version, v.status]))).toEqual([[1, 'archived'], [2, 'archived'], [3, 'approved']]);
  });

  it('PUT saves her edit as the active version; a stale base gets 409; unknown fonts 400; provenance ids cleaned', async () => {
    const ds = await import('@/server/services/designSystem');
    const state = await ds.getDesignState();
    const design = structuredClone(state.design);
    design.colors.surface = { hex: '#101820', origin: { source: 'observation', observationIds: ['gibt-es-nicht'], referenceIds: [], note: '' } };
    design.presets.push({ ...design.presets[0]!, id: 'clean', name: 'Clean', animation: 'none' });
    const v = await ds.saveDesign({ design, baseVersionId: state.version!.id });
    expect(v.rules.design!.colors.surface).toMatchObject({ hex: '#101820', origin: { observationIds: [] } });
    await expect(ds.saveDesign({ design, baseVersionId: state.version!.id })).rejects.toMatchObject({ status: 409 });
    const bad = structuredClone(design);
    bad.typography.hook.font = 'custom:weg';
    await expect(ds.saveDesign({ design: bad, baseVersionId: v.id })).rejects.toMatchObject({ status: 400 });
    // a rules edit from a page loaded before (echoing an older design) keeps the ACTIVE design (review fix)
    const style0 = await import('@/server/services/style');
    const { read: read0 } = await import('@/server/store');
    const old = await read0((db) => db.styleBibles.find((x) => x.version === 1)!.rules);
    const edited = await style0.createStyleVersion({ rules: { ...old, name: 'Chips-Edit' } });
    expect(edited.rules.design!.colors.surface.hex).toBe('#101820');
    // saving the Style Bible form keeps „Meine Marke“
    const style = await import('@/server/services/style');
    const next = await style.createStyleVersion({ name: 'Neu', traits: 'ruhig' });
    expect(next.rules.design!.presets.map((p) => p.id)).toEqual(['marke', 'clean']);
  });

  it('derive and suggest only propose: no version is created; suggest is mock-labelled', async () => {
    const ds = await import('@/server/services/designSystem');
    const { read } = await import('@/server/store');
    const count = () => read((db) => db.styleBibles.length);
    const n = await count();
    const d = await ds.deriveDesign();
    expect(d.after.colors.surface.hex).toBe('#20302A'); // the darkest confirmed colour carries white text
    expect(d.before.colors.surface.hex).toBe('#101820');
    expect(d.checks.length).toBeGreaterThan(0);
    const s = await ds.suggestDesign();
    expect(s.suggestion).toMatchObject({ kind: 'design', mock: true });
    expect(s.suggestion.output.uncertainties[0]).toMatch(/^\[MOCK\]/);
    expect(await count()).toBe(n);
    expect((await ds.getDesignState()).suggestion).toMatchObject({ id: s.suggestion.id, outdated: false });
    // taking it over is a normal save with the suggestion as lineage
    const state = await ds.getDesignState();
    const v = await ds.saveDesign({ design: s.suggestion.output.design, baseVersionId: state.version!.id, suggestionId: s.suggestion.id });
    expect(v.suggestionId).toBe(s.suggestion.id);
    expect((await ds.getDesignState()).suggestion).toMatchObject({ outdated: true });
  });
});

describe('the editor follows the pinned version', () => {
  it('a free cut saved now shows „Look aus Meine Marke (Style Bible vN)“; a plan pinned to an old palette version keeps its legacy look and key', async () => {
    const projects = await import('@/server/services/projects');
    const edit = await import('@/server/services/edit');
    const { write, read, newId, now } = await import('@/server/store');
    const core = await import('@studio/core');
    const project = await projects.createProject({ title: 'Marke', kind: 'PERSONAL_CONTENT' });
    const assetId = newId();
    await write((db) => {
      db.mediaAssets.push({ id: assetId, projectId: project.id, name: 'take.mp4', mime: 'video/mp4', size: 1, sha256: 'x', storagePath: `footage/${project.id}/x.mp4`, origin: 'own', rightsNote: '', rightsConfirmedAt: now(), status: 'probed', createdAt: now(),
        probe: { durationSec: 4, width: 1080, height: 1920, rotation: 0, displayWidth: 1080, displayHeight: 1920, orientation: 'portrait', fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, container: 'mov,mp4' } });
      // an old version without rules.design (before Etappe 14)
      db.styleBibles.push({ id: 'sb-old', profileId: 'profile-personal', version: 99, status: 'archived', createdAt: now(), approvedAt: now(),
        rules: { name: 'Alt', visual: { palette: ['#C8553D', '#F4E9D8'], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [] } });
    });
    const body = { clips: [{ assetId, inSec: 0, outSec: 4, overlays: [{ kind: 'keyword', startSec: 0, endSec: 2, text: 'Wolle' }] }], loudness: 'off', look: { fontSource: 'design', preset: 'clean' } };
    const plan = await edit.saveEditPlan(project.id, { scriptId: null, body });
    const active = await read((db) => db.styleBibles.find((v) => v.status === 'approved')!);
    const state = await edit.getEditState(project.id);
    expect(state.freeLook.label).toBe(`Look aus Meine Marke (Style Bible v${active.version}) · Stil „Marke“`);
    expect(state.freeLook.presets.map((p) => p.id)).toEqual(['marke', 'clean']);
    const shown = state.plans.find((p) => p.id === plan.id)!.look;
    expect(shown.label).toMatch(/Stil „Clean“/);
    // the old pinned version: exactly the Etappe-8 tokens and key
    await write((db) => { db.editPlans.find((p) => p.id === plan.id)!.styleBibleVersionId = 'sb-old'; });
    const legacy = await read((db) => edit.planLook(db, db.editPlans.find((p) => p.id === plan.id)!, { font: 'Futura' }));
    expect(legacy).toEqual(core.styleTokens({ id: 'sb-old', version: 99, approvedAt: 'x', rules: { visual: { palette: ['#C8553D', '#F4E9D8'] } } }, 'Futura'));
    expect(core.lookKey(legacy)).toBe('style_bible|sb-old|Futura|#C8553D|#F4E9D8|#111111');
    expect((await edit.getEditState(project.id)).plans.find((p) => p.id === plan.id)!.look.presets).toEqual([]);
  });
});

describe('own fonts', () => {
  it('validates magic bytes, size and the licence note; serves the file; refuses deleting a font in use', async () => {
    const fonts = await import('@/server/services/fonts');
    await expect(fonts.uploadFont(new File([PNG], 'x.ttf'), 'SIL OFL 1.1')).rejects.toMatchObject({ status: 415 });
    await expect(fonts.uploadFont(new File([Buffer.from('wOFF0000000000000000')], 'x.woff'), 'SIL OFL 1.1')).rejects.toMatchObject({ status: 415 });
    await expect(fonts.uploadFont(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.ttf'), 'SIL OFL 1.1')).rejects.toMatchObject({ status: 413 });
    if (!GEIST) return console.log('[fonts] Geist-Regular.ttf not found in next – upload of a real font skipped');
    const bytes = await readFile(GEIST);
    await expect(fonts.uploadFont(new File([bytes], 'Geist-Regular.ttf'), '')).rejects.toThrow(/Lizenzvermerk/);
    const { font, duplicate } = await fonts.uploadFont(new File([bytes], 'Geist-Regular.ttf'), 'SIL OFL 1.1 (Vercel)');
    expect(duplicate).toBe(false);
    expect(font).toMatchObject({ family: 'Geist', postscriptName: 'Geist-Regular', weight: 400, italic: false, format: 'ttf', license: 'SIL OFL 1.1 (Vercel)' });
    expect((await fonts.uploadFont(new File([bytes], 'again.ttf'), 'SIL OFL 1.1')).duplicate).toBe(true);
    expect(await fonts.getFontRecord(font.id)).toMatchObject({ mime: 'font/ttf' });
    expect(await readdir(path.join(dir, 'fonts'))).toEqual([`${font.id}.ttf`]);
    // used in the design system → stays
    const ds = await import('@/server/services/designSystem');
    const state = await ds.getDesignState();
    expect(state.fonts.map((f) => f.ref)).toContain(`custom:${font.id}`);
    const design = structuredClone(state.design);
    design.typography.hook = { ...design.typography.hook, font: `custom:${font.id}` };
    await ds.saveDesign({ design, baseVersionId: state.version!.id });
    await expect(fonts.deleteFont(font.id)).rejects.toMatchObject({ status: 409 });
  });
});

const ffmpegReady = async () => {
  const { ffmpegStatus } = await import('@/server/ffmpeg');
  const s = await ffmpegStatus();
  return s.available && s.subtitles;
};

describe('exact specimen through FFmpeg + libass', () => {
  it('renders 1080×1920 PNGs for both presets with the uploaded font, without font fallback; the second call is cached', async () => {
    const ds = await import('@/server/services/designSystem');
    if (!(await ffmpegReady())) {
      console.log('[libass] FFmpeg without libass: only the 409 is checked');
      await expect(ds.renderSpecimen({})).rejects.toMatchObject({ status: 409 });
      return;
    }
    for (const presetId of ['marke', 'clean']) {
      const a = await ds.renderSpecimen({ presetId });
      expect(a.png.subarray(1, 4).toString()).toBe('PNG');
      expect([a.png.readUInt32BE(16), a.png.readUInt32BE(20)]).toEqual([1080, 1920]);
      console.log(`[libass] specimen ${presetId}: ${a.png.length} bytes, warnings ${JSON.stringify(a.warnings)}`);
      expect(a.warnings).toEqual([]);
      expect(a.cached).toBe(false);
      expect((await ds.renderSpecimen({ presetId })).cached).toBe(true);
    }
    // the active design's hook uses the uploaded font (previous test): the empty warning list above means libass found
    // it in the fonts folder (`fontFallbacks` reports a family that resolved to another font)
    if (GEIST) expect((await ds.getDesignState()).design.typography.hook.font).toMatch(/^custom:/);
  });
});
