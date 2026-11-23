import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildAss, ColorRole, composeStyleBible, contrastChecks, deriveDesignSystem, designOf, DesignSystem, fontFallbacks, isHex, lookFontTypes, overlayAss, OVERLAY_FONTS,
  runDesignDirector, SPECIMEN_TEXT, specimenSlots, StyleBibleRules, styleTokens, subtitleStyleOf, timedElements, buildTimeline, lookFit, unique,
  type DesignSuggestion, type DesignSynthesisInput, type Provenance,
} from '@studio/core';
import { z } from 'zod';
import { dataDir } from '../env';
import { HttpError } from '../errors';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { must, newId, now, PERSONAL_PROFILE_ID, read, write, type DirectorSuggestion, type Db, type StyleBibleVersion } from '../store';
import type { AgentTask } from './agentRuns';
import { allowedFonts, expectedFaces, fontInfos, fontsDir } from './fonts';
export { allowedFonts } from './fonts';
import { approvedObservations, composeRefs, currentStyle, currentVoice, formsOf, nextVersion, pushActive, runDirector } from './style';

/**
 * „Meine Marke“ (Etappe 14, E4): the design system lives in `rules.design` of the active Style Bible version.
 * - GET: the active version's design (or the legacy design of an old palette), contrast checks, her fonts, the
 *   confirmed observations and references it can point to, the latest Design Director suggestion.
 * - PUT and „ins Design System übernehmen“: a NEW active version with the changed `rules.design` (old one archived,
 *   like every Style Bible save since Etappe 10); stale saves (another version became active meanwhile) get 409.
 * - derive (deterministic) and suggest (Design Director, budget) only return proposals.
 * - specimen: a 1080×1920 PNG through the same FFmpeg+ASS path as the render, cached by content hash.
 */

/** Provenance ids are kept only while they point to confirmed observations / existing references. */
function cleanProvenance(d: DesignSystem, obsIds: Set<string>, refIds: Set<string>): DesignSystem {
  const p = (o: Provenance): Provenance => {
    const observationIds = o.observationIds.filter((id) => obsIds.has(id)), referenceIds = o.referenceIds.filter((id) => refIds.has(id));
    // an evidence claim whose evidence is gone (observation no longer confirmed, reference deleted) becomes manual
    if (o.source === 'observation' && !observationIds.length && !referenceIds.length) return { source: 'manual', observationIds, referenceIds, note: 'Beobachtung nicht mehr bestätigt' };
    if (o.source === 'reference' && !referenceIds.length) return { source: 'manual', observationIds, referenceIds, note: 'Referenz gelöscht' };
    return { ...o, observationIds, referenceIds };
  };
  const out = structuredClone(d);
  for (const k of Object.keys(out.colors) as (keyof DesignSystem['colors'])[]) out.colors[k].origin = p(out.colors[k].origin);
  for (const k of Object.keys(out.typography) as (keyof DesignSystem['typography'])[]) out.typography[k].origin = p(out.typography[k].origin);
  out.presets = out.presets.map((x) => ({ ...x, origin: p(x.origin) }));
  out.motion.origin = p(out.motion.origin);
  out.imagery = { ...out.imagery, referenceIds: out.imagery.referenceIds.filter((id) => refIds.has(id)), origin: p(out.imagery.origin) };
  out.phrases = out.phrases.map((x) => ({ ...x, origin: p(x.origin) }));
  out.guidelinesOrigin = p(out.guidelinesOrigin);
  return out;
}



/** The design the page edits: the active version's own, else its legacy palette design, else derived from scratch. */
export function baseDesign(db: Db): { design: DesignSystem; legacy: boolean; fresh: boolean } {
  const cur = currentStyle(db);
  const own = cur ? designOf(cur.rules) : null;
  if (own) return { ...own, fresh: false };
  return { design: derive(db, null).design, legacy: false, fresh: true };
}

function deriveInput(db: Db, current: DesignSystem | null) {
  const cur = currentStyle(db);
  const rules = cur?.rules ?? composeStyleBible({ form: formsOf(db).style, references: composeRefs(db), approvedObservations: approvedObservations(db) });
  const voiceSuggestion = [...db.directorSuggestions].reverse().find((s) => s.kind === 'voice' && s.profileId === PERSONAL_PROFILE_ID);
  const phrases = voiceSuggestion?.kind === 'voice' ? voiceSuggestion.output.signaturePhrases : [];
  return {
    rules,
    observations: approvedObservations(db).map((o) => ({ id: o.id, referenceId: o.referenceId, dimension: o.dimension, statement: o.statement, colors: o.colors })),
    references: db.references.map((r) => ({ id: r.id, palette: r.palette, likes: r.likes, tags: r.tags })),
    voice: phrases.length ? { phrases } : null,
    current,
  };
}
const derive = (db: Db, current: DesignSystem | null) => deriveDesignSystem(deriveInput(db, current));

export const getDesignState = () => read((db) => {
  const cur = currentStyle(db);
  const base = baseDesign(db);
  const preset = base.design.presets.find((p) => p.id === base.design.defaultPresetId);
  const suggestion = [...db.directorSuggestions].reverse().find((s) => s.kind === 'design' && s.profileId === PERSONAL_PROFILE_ID) ?? null;
  const voice = currentVoice(db);
  return {
    version: cur ? { id: cur.id, version: cur.version, status: cur.status, createdAt: cur.createdAt } : null,
    design: base.design,
    /** true = the version has no `rules.design` yet: shown from its palette (palette[0]/[1]); saving makes it explicit. */
    legacy: base.legacy,
    /** true = no Style Bible colours at all: a derived starting point, nothing is stored yet. */
    fresh: base.fresh,
    checks: contrastChecks(base.design.colors, preset),
    fonts: allowedFonts(db),
    fontFiles: db.fonts.map((f) => ({ id: f.id, family: f.family, postscriptName: f.postscriptName, weight: f.weight, license: f.license, name: f.name, createdAt: f.createdAt, source: f.origin?.kind ?? 'upload', sourceUrl: f.origin?.url ?? null })),
    observations: approvedObservations(db).map((o) => ({ id: o.id, referenceId: o.referenceId, referenceName: o.referenceName, dimension: o.dimension, statement: o.statement, colors: o.colors })),
    references: db.references.map((r) => ({ id: r.id, name: r.name, kind: r.kind, palette: r.palette, liked: r.likes.length > 0 })),
    voice: voice ? { version: voice.version, traits: voice.rules.traits } : null,
    voicePhrases: (() => {
      const s = [...db.directorSuggestions].reverse().find((x) => x.kind === 'voice');
      return s?.kind === 'voice' ? s.output.signaturePhrases : [];
    })(),
    suggestion: suggestion?.kind === 'design' ? { ...suggestion, outdated: suggestion.baseVersionId !== (cur?.id ?? null) } : null,
  };
});

const SaveRequest = z.object({
  design: DesignSystem,
  /** The version the page was loaded with (null = none). Another active version meanwhile → 409. */
  baseVersionId: z.string().nullable(),
  suggestionId: z.string().nullish(),
}).strict();

/** Writes `design` as a new active Style Bible version (inside a write). */
export function saveDesignIn(db: Db, design: DesignSystem, baseVersionId: string | null | undefined, suggestionId: string | null = null): StyleBibleVersion {
  const cur = currentStyle(db);
  if (baseVersionId !== undefined && (cur?.id ?? null) !== baseVersionId)
    throw new HttpError(409, 'Inzwischen ist eine andere Style-Bible-Version aktiv – Seite neu laden und die Änderung noch einmal machen.');
  const known = new Set(db.fonts.map((f) => `custom:${f.id}`));
  for (const [role, t] of Object.entries(design.typography))
    if (t.font.startsWith('custom:') && !known.has(t.font)) throw new HttpError(400, `Schrift für „${role}“ gibt es nicht (mehr).`);
  const clean = cleanProvenance(design, new Set(approvedObservations(db).map((o) => o.id)), new Set(db.references.map((r) => r.id)));
  const rules = StyleBibleRules.parse({
    ...(cur?.rules ?? composeStyleBible({ form: formsOf(db).style, references: composeRefs(db), approvedObservations: approvedObservations(db) })),
    design: clean,
  });
  const v: StyleBibleVersion = {
    id: newId(), profileId: PERSONAL_PROFILE_ID, version: nextVersion(db.styleBibles, PERSONAL_PROFILE_ID), status: 'approved', rules, createdAt: now(), approvedAt: now(),
    suggestionId,
  };
  pushActive(db.styleBibles, v);
  return v;
}

/** PUT /api/design-system: her edited design system becomes the active version (Speichern macht aktiv). */
export async function saveDesign(raw: unknown) {
  const req = SaveRequest.parse(raw);
  return write((db) => {
    const sid = req.suggestionId ? must(db.directorSuggestions.find((s) => s.id === req.suggestionId && s.kind === 'design'), 'Design-Vorschlag').id : null;
    return saveDesignIn(db, req.design, req.baseVersionId, sid);
  });
}

const AdoptRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('color'), hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/), role: ColorRole, observationId: z.string().nullish(), referenceId: z.string().nullish() }).strict(),
  z.object({ kind: z.literal('observation'), observationId: z.string().min(1), target: z.enum(['guideline', 'imagery']) }).strict(),
  z.object({ kind: z.literal('reference'), referenceId: z.string().min(1) }).strict(),
]);

/**
 * „Ins Design System übernehmen“ from the Style Lab: a colour into a role, a confirmed observation into the
 * guidelines or the image look, a reference into the image look. Each is a new active version with provenance.
 */
export async function adoptIntoDesign(raw: unknown) {
  const req = AdoptRequest.parse(raw);
  return write((db) => {
    const { design } = baseDesign(db);
    const d = structuredClone(design);
    const approved = approvedObservations(db);
    const obs = (id: string) => {
      const o = approved.find((x) => x.id === id);
      if (!o) throw new HttpError(409, 'Nur bestätigte Beobachtungen können ins Design System übernommen werden.');
      return o;
    };
    if (req.kind === 'color') {
      const hex = req.hex.toUpperCase();
      let origin: Provenance = { source: 'manual', observationIds: [], referenceIds: [], note: 'aus dem Style Lab' };
      if (req.observationId) {
        const o = obs(req.observationId);
        if (!o.colors.map((c) => c.toUpperCase()).includes(hex)) throw new HttpError(400, 'Die Farbe gehört nicht zu dieser Beobachtung.');
        origin = { source: 'observation', observationIds: [o.id], referenceIds: [o.referenceId], note: 'aus dem Style Lab übernommen' };
      } else if (req.referenceId) {
        const r = must(db.references.find((x) => x.id === req.referenceId), 'Referenz');
        if (!r.palette.map((c) => c.toUpperCase()).includes(hex)) throw new HttpError(400, 'Die Farbe gehört nicht zu dieser Referenz.');
        origin = { source: 'reference', observationIds: [], referenceIds: [r.id], note: 'Farbe der Referenz' };
      } else if (currentStyle(db)?.rules.visual.palette.map((c) => c.toUpperCase()).includes(hex)) {
        origin = { source: 'palette', observationIds: [], referenceIds: [], note: 'Palette der Style Bible' };
      }
      d.colors[req.role] = { hex, origin };
    } else if (req.kind === 'observation') {
      const o = obs(req.observationId);
      if (req.target === 'guideline') {
        const wasEmpty = !d.guidelines.trim();
        if (!d.guidelines.includes(o.statement)) d.guidelines = [d.guidelines, `- ${o.statement}`].filter(Boolean).join('\n').slice(0, 2000);
        d.guidelinesOrigin = { ...d.guidelinesOrigin, source: wasEmpty ? 'observation' : d.guidelinesOrigin.source, observationIds: unique([...d.guidelinesOrigin.observationIds, o.id]).slice(0, 20) };
      } else {
        d.imagery.keywords = unique([...d.imagery.keywords, o.statement.slice(0, 80)]).slice(0, 20);
        d.imagery.referenceIds = unique([...d.imagery.referenceIds, o.referenceId]).slice(0, 24);
        d.imagery.origin = { ...d.imagery.origin, observationIds: unique([...d.imagery.origin.observationIds, o.id]).slice(0, 20), referenceIds: unique([...d.imagery.origin.referenceIds, o.referenceId]).slice(0, 24) };
      }
    } else {
      const r = must(db.references.find((x) => x.id === req.referenceId), 'Referenz');
      d.imagery.referenceIds = unique([...d.imagery.referenceIds, r.id]).slice(0, 24);
      d.imagery.origin = { ...d.imagery.origin, referenceIds: unique([...d.imagery.origin.referenceIds, r.id]).slice(0, 24) };
    }
    const v = saveDesignIn(db, DesignSystem.parse(d), undefined);
    return { version: { id: v.id, version: v.version }, design: v.rules.design! };
  });
}

/**
 * POST /api/design-system/derive: the deterministic proposal from her favourites, next to the current design. `design`
 * (optional) = her unsaved edits from the page: the proposal is built on them, so „Übernehmen“ keeps them.
 */
export const deriveDesign = (raw?: unknown) => read((db) => {
  const draft = z.object({ design: DesignSystem.optional() }).parse(raw ?? {}).design;
  const base = draft ? { design: draft, fresh: false } : baseDesign(db);
  const r = derive(db, base.fresh ? null : base.design);
  return { before: base.design, after: r.design, checks: r.checks, notes: r.notes, baseVersionId: currentStyle(db)?.id ?? null };
});

/** Design Director task (no side effects). */
export async function prepareDesignTask(draft?: DesignSystem) {
  const input = await read((db): DesignSynthesisInput & { baseVersionId: string | null } => {
    const obs = approvedObservations(db);
    if (!obs.length) throw new HttpError(400, 'Keine bestätigten Beobachtungen – bestätige zuerst Beobachtungen im Style Lab.');
    const cur = currentStyle(db);
    const base = baseDesign(db);
    const r = cur?.rules;
    const voice = currentVoice(db);
    const voiceSuggestion = [...db.directorSuggestions].reverse().find((s) => s.kind === 'voice');
    return {
      approvedObservations: obs.map((o) => ({ id: o.id, referenceId: o.referenceId, referenceName: o.referenceName, dimension: o.dimension, statement: o.statement, colors: o.colors })),
      rules: {
        palette: r?.visual.palette ?? [], traits: r?.visual.traits ?? [], avoid: r?.visual.avoid ?? [], typography: r?.visual.typography ?? '', lighting: r?.visual.lighting ?? '',
        composition: r?.visual.composition ?? '', textures: r?.visual.textures ?? '', pacing: r?.motion.pacing ?? '', transitions: r?.motion.transitions ?? [],
      },
      references: db.references.slice(0, 60).map((x) => ({ id: x.id, name: x.name, palette: x.palette, likes: x.likes, dislikes: x.dislikes, tags: x.tags })),
      voice: voice || voiceSuggestion
        ? { traits: voice?.rules.traits ?? [], texts: [...(voice?.rules.ownExamples ?? []), ...(voiceSuggestion?.kind === 'voice' ? voiceSuggestion.output.signaturePhrases : [])].slice(0, 20) }
        : null,
      fonts: allowedFonts(db).map(({ ref, label }) => ({ ref, label })),
      base: derive(db, draft ?? (base.fresh ? null : base.design)).design,
      baseVersionId: cur?.id ?? null,
    };
  });
  const { baseVersionId, ...agentInput } = input;
  const task: AgentTask<{ suggestion: DesignSuggestion; warnings: string[] }> = {
    meta: { agent: 'design_director', useCase: 'design_system_synthesis', projectId: null, input: agentInput },
    run: (p) => runDesignDirector(p, agentInput),
  };
  return { input: agentInput, baseVersionId, task };
}

/** POST /api/design-system/suggest: Design Director (budget, routing, mock labelled); stored as a suggestion only. */
export async function suggestDesign(raw?: unknown) {
  const draft = z.object({ design: DesignSystem.optional() }).parse(raw ?? {}).design;
  const { input, baseVersionId, task } = await prepareDesignTask(draft);
  const rec = await runDirector(task, {}, (base, result): Extract<DirectorSuggestion, { kind: 'design' }> => ({
    ...base, kind: 'design', output: result.output.suggestion, observationIds: input.approvedObservations.map((o) => o.id), baseVersionId,
  }));
  const before = draft ?? (await read((db) => baseDesign(db).design));
  return { suggestion: rec as Extract<DirectorSuggestion, { kind: 'design' }>, before };
}

// ---------- Specimen ----------

/** The cache keeps the newest specimens only (every unsaved variant is a new file). */
const SPECIMEN_CACHE_MAX = 60;
async function pruneSpecimens(dir: string) {
  const { readdir, stat } = await import('node:fs/promises');
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^[0-9a-f]{64}\.png$/.test(f));
  if (files.length <= SPECIMEN_CACHE_MAX) return;
  const aged = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })));
  await Promise.all(aged.sort((a, b) => b.t - a.t).slice(SPECIMEN_CACHE_MAX).flatMap((x) => [rm(path.join(dir, x.f), { force: true }), rm(path.join(dir, `${x.f}.warnings.json`), { force: true })]));
}

const SpecimenRequest = z.object({
  /** Unsaved edits from the page; without it the active design. */
  design: DesignSystem.optional(),
  presetId: z.string().max(40).nullish(),
  backdrop: z.enum(['neutral', 'background']).default('neutral'),
}).strict();


/**
 * Musterbild 1080×1920 (PNG) of hook, lower third, keyword and subtitle in a preset, rendered through FFmpeg + the
 * same ASS writer as the cut. Cached under `<data>/cache/specimens/<sha256>.png` (hash of ASS, backdrop and font files).
 */
export async function renderSpecimen(raw: unknown): Promise<{ png: Buffer; cached: boolean; warnings: string[] }> {
  const req = SpecimenRequest.parse(raw ?? {});
  const ff = await ffmpegStatus();
  if (!ff.available || !ff.subtitles) throw new HttpError(409, 'Das Musterbild braucht FFmpeg mit libass (Filter „subtitles“). FFmpeg mit libass installieren (brew install ffmpeg-full).');
  const { ass, backdrop, customFonts, fontsHash, notes, expected } = await read((db) => {
    const { design } = req.design ? { design: req.design } : baseDesign(db);
    const fonts = fontInfos(db);
    const look = styleTokens({ id: 'specimen', version: 0, approvedAt: now(), rules: { design } }, OVERLAY_FONTS[0], { preset: req.presetId ?? null, fontSource: 'design', fonts });
    const d = look.design!;
    const preset = design.presets.find((p) => p.id === d.presetId)!;
    const slots = specimenSlots(preset);
    const body = {
      clips: [{ overlays: [
        { kind: 'keyword' as const, text: SPECIMEN_TEXT.keyword, startSec: 0, endSec: 2, slot: slots.keyword, direction: 'down' as const },
        { kind: 'lower_third' as const, text: SPECIMEN_TEXT.lowerThird, startSec: 0, endSec: 2, slot: slots.lowerThird, direction: 'down' as const },
      ] }],
      hook: { source: 'free' as const, variantIndex: null, text: SPECIMEN_TEXT.hook, endSec: 2, slot: slots.hook, claimsReviewed: false },
    };
    const t = timedElements(body, buildTimeline([{ inSec: 0, outSec: 2, cuts: [] }]), lookFit(look));
    const ass = buildAss([{ startSec: 0, endSec: 2, text: SPECIMEN_TEXT.subtitle }], { overlays: overlayAss(t, look), subtitle: subtitleStyleOf(look) });
    const bg = req.backdrop === 'background' ? design.colors.background.hex : '#5A5F58';
    const types = lookFontTypes(look);
    const used = new Set(types.filter((x) => x.custom).map((x) => x.assName));
    const fontsHash = db.fonts.filter((f) => used.has(f.assName)).map((f) => f.sha256).sort().join(',');
    return { ass, backdrop: bg, customFonts: d.customFonts, fontsHash, notes: look.designNotes ?? [], expected: expectedFaces(db, types) };
  });
  if (!isHex(backdrop)) throw new HttpError(400, 'Hintergrundfarbe ungültig.');
  const key = createHash('sha256').update(JSON.stringify({ ass, backdrop, fontsHash, ff: ff.version })).digest('hex');
  const dir = path.join(dataDir(), 'cache', 'specimens');
  const file = path.join(dir, `${key}.png`);
  try {
    // Etappe 16b: the font check of the first render stays with the cached picture
    const png = await readFile(file);
    const warnings = await readFile(`${file}.warnings.json`, 'utf8').then((t) => JSON.parse(t) as string[], () => notes);
    // with a font warning it is drawn again (an installed Mac font is not part of the key)
    if (warnings.length <= notes.length) return { png, cached: true, warnings };
  } catch { /* not cached yet */ }
  await mkdir(dir, { recursive: true });
  const work = path.join(dir, `${key}.${process.pid}.${Date.now()}`);
  const assFile = `${work}.ass`, out = `${work}.png`;
  await writeFile(assFile, ass, 'utf8');
  try {
    const chars = /['\\:[\],;]/;
    if (chars.test(assFile) || (customFonts && chars.test(fontsDir()))) throw new HttpError(409, 'Der Datenordner-Pfad enthält Zeichen, die der FFmpeg-Filter nicht verarbeitet.');
    const filter = `subtitles=filename='${assFile}'${customFonts ? `:fontsdir='${fontsDir()}'` : ''}`;
    const { stderr } = await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x${backdrop.slice(1)}:s=1080x1920:d=1:r=30`, '-vf', filter, '-ss', '0.5', '-frames:v', '1', '-y', out], { loglevel: 'info', keepStderr: 256 * 1024 });
    await rename(out, file);
    await pruneSpecimens(dir);
    const warnings = [...notes, ...fontFallbacks(stderr, expected)];
    await writeFile(`${file}.warnings.json`, JSON.stringify(warnings), 'utf8').catch(() => undefined);
    return { png: await readFile(file), cached: false, warnings };
  } finally {
    await Promise.all([rm(assFile, { force: true }), rm(out, { force: true })]);
  }
}
