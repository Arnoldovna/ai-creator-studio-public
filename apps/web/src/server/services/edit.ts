import 'server-only';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lookFontTypes, subtitleAnimationOf, usedElementFonts } from '@studio/core';
import { AI_DISCLOSURE, buildAss, buildLoudnessMeasure, buildRender, buildTimeline, imageDisclosureLabels, imageLayers, mergeLabelSpans, timedImages, type ImageAssetInfo, checkEditPlan, cuesForTimeline, designOf, disclosureLabels, EditPlanBody, fontFallbacks, hasGraphics, lookFit, lookKey, needsLibass, overlayAss, parseLoudness, PlanLook, renderSegments, styleTokens, subtitleMarginV, subtitleStyleOf, timedElements, usedPresetIds, validateEditPlan, ValidationError, type EditAssetInfo, type EditDraftBody, type EditPlanContext, type LookTokens, type SubtitleCue } from '@studio/core';
import { allowedFonts, expectedFaces, fontInfos, fontsDir } from './fonts';
import { z } from 'zod';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { HttpError } from '../errors';
import { absolutePath, deleteMediaFiles, sha256File } from '../media';
import { must, newId, now, read, write, type Db, type EditPlan, type Render, type RenderLook } from '../store';
import { enqueueJob, isFinished, pump, registerJobHandler } from '../worker';
import { dataDir } from '../env';
import { assertNoClaimCuts, protectedClaims } from './cuts';
import { latestTranscript, readTranscriptBody } from './transcripts';
import { currentApproved } from './aiContext';
import { localLintTerms, strategyBlockers, strategyGateError } from './strategyGate';

/**
 * Release 3, Etappe 4: versioned EDL per script and the FFmpeg first cut.
 * Human gates: the EDL is approved before anything renders; every render waits for review.
 * Etappe 10 (ADR-013): personal projects have no separate approval click. Rendering a saved draft approves it
 * implicitly (same checks as `approveEditPlan`), a scripted personal plan does not need an approved script, and
 * the render review is optional (download, publications and self-checks never required an approved render).
 * Client projects keep every gate.
 */

const assetInfo = (db: Db, projectId: string) =>
  new Map<string, EditAssetInfo>(db.mediaAssets.filter((a) => a.projectId === projectId).map((a) => [a.id, {
    origin: a.origin, durationSec: a.probe?.durationSec ?? null, hasAudio: a.probe?.hasAudio ?? false,
    hasVideo: a.probe ? a.probe.videoCodec != null || a.probe.width != null : true, // unprobed assets fail on the unknown duration
  }]));

/** Etappe 16: library images (kind and her usage note) for the image-overlay check – from the store only. */
export const imageInfo = (db: Db) => new Map<string, ImageAssetInfo>(db.references.map((r) => [r.id, { kind: r.kind === 'image' ? 'image' : 'video', usage: r.usage ?? null, mime: r.mime }]));

/** Versions count per script; scriptless plans („Freier Schnitt“) count per project. */
const nextPlanVersion = (db: Db, projectId: string, scriptId: string | null) =>
  db.editPlans.filter((p) => p.projectId === projectId && p.scriptId === scriptId).reduce((m, p) => Math.max(m, p.version), 0) + 1;

/**
 * Stored bodies are always read through the parser: plans saved before Etappe 8 have no cuts/zoom,
 * and the parser fills the defaults that do nothing (so they render exactly as before).
 */
export const planBody = (p: Pick<EditPlan, 'body'>): EditPlanBody => EditPlanBody.parse(p.body);

const isPersonal = (db: Db, projectId: string) => must(db.projects.find((p) => p.id === projectId), 'Projekt').kind === 'PERSONAL_CONTENT';

/**
 * Client projects: a script must be approved right now before its plan is approved, rendered or its render
 * reviewed (scripts can be demoted later). Personal projects (Etappe 10): only a rejected script stops the cut.
 */
function scriptBlocker(db: Db, plan: Pick<EditPlan, 'projectId' | 'scriptId'>, message: string): string | null {
  if (!plan.scriptId) return null;
  const status = must(db.scripts.find((s) => s.id === plan.scriptId), 'Skript').status;
  if (isPersonal(db, plan.projectId)) return status === 'rejected' ? 'Das Skript wurde verworfen.' : null;
  return status !== 'approved' ? message : null;
}

/** Rendering and render approval need the EDL AND (if it has one) its script to be approved right now (see `scriptBlocker`). */
function assertApproved(db: Db, plan: EditPlan) {
  if (plan.status !== 'approved') throw new HttpError(409, 'Nur freigegebene Schnittpläne werden gerendert.');
  const blocked = scriptBlocker(db, plan, 'Das Skript ist nicht mehr freigegeben.');
  if (blocked) throw new HttpError(409, blocked);
}

/** Generated clips enter an EDL only after their asset review, and only for the brief they were made for. */
function assertGeneratedReviewed(db: Db, scriptId: string | null, body: unknown) {
  const parsed = EditPlanBody.safeParse(body);
  if (!parsed.success) return; // validateEditPlan reports the shape errors
  const errors = parsed.data.clips.flatMap((c, i) => {
    const a = db.mediaAssets.find((x) => x.id === c.assetId);
    if (a?.origin !== 'generated') return [];
    if (a.generation?.review !== 'approved') return [`Clip ${i + 1}: Der KI-generierte Clip ist noch nicht geprüft und freigegeben.`];
    const g = db.generations.find((x) => x.id === a.generation!.generationId);
    if (!g || g.status !== 'approved') return [`Clip ${i + 1}: Die Generierung des Clips ist nicht freigegeben.`];
    if (c.briefId !== g.briefId || g.scriptId !== scriptId || c.sceneIndex !== g.sceneIndex)
      return [`Clip ${i + 1}: Der KI-generierte Clip gehört zu einem anderen Skript, einer anderen Szene oder einem anderen Asset-Brief.`];
    return [];
  });
  if (errors.length) throw new ValidationError(errors.join(' '));
}

/**
 * Look tokens of a plan: from its PINNED Style Bible version (lineage), never from „the latest approved“ one,
 * so an approved cut keeps its colours. A draft or missing version gives the labelled placeholder.
 */
export function planLook(db: Db, plan: Pick<EditPlan, 'styleBibleVersionId'>, look: Partial<PlanLook>, body?: (Parameters<typeof usedPresetIds>[0] & Parameters<typeof usedElementFonts>[0]) | null): LookTokens {
  const v = plan.styleBibleVersionId ? db.styleBibles.find((x) => x.id === plan.styleBibleVersionId) ?? null : null;
  const l = PlanLook.parse(look);
  // Etappe 13: the styles single elements name (only for a body that has such elements: older plans keep their tokens)
  // Etappe 16b: fonts single elements chose (only for a body that has such elements)
  return styleTokens(v, l.font, { preset: l.preset, fontSource: l.fontSource, fonts: fontInfos(db), elementPresets: body ? usedPresetIds(body) : [], elementFonts: body ? usedElementFonts(body) : [] });
}

/** Overlay styles („Meine Marke“ presets) of a pinned version, for the editor's picker (empty for legacy versions). */
export function lookPresets(db: Db, styleBibleVersionId: string | null) {
  const v = styleBibleVersionId ? db.styleBibles.find((x) => x.id === styleBibleVersionId) : null;
  const d = v && v.approvedAt != null ? designOf(v.rules) : null;
  if (!d || d.legacy) return { presets: [] as { id: string; name: string }[], defaultPresetId: null as string | null, hookSlot: null, overlaySlot: null };
  const def = d.design.presets.find((p) => p.id === d.design.defaultPresetId)!;
  return { presets: d.design.presets.map((p) => ({ id: p.id, name: p.name })), defaultPresetId: d.design.defaultPresetId, hookSlot: def.hookSlot, overlaySlot: def.overlaySlot };
}

/** Size steps and cases of the pinned design-system look, so the validator checks the layout the render will draw. */
const lookFor = (db: Db, styleBibleVersionId: string | null, body: unknown) => {
  const look = PlanLook.safeParse((body as { look?: unknown } | null)?.look ?? {});
  return planLook(db, { styleBibleVersionId }, look.success ? look.data : {});
};

/**
 * Validates against the plan's script, or (scriptless, personal only) against the project alone. Etappe 10:
 * the overlays of a free cut are free text, so its transcripts are no longer read for a quote check.
 */
export function planContext(db: Db, plan: { projectId: string; scriptId: string | null; styleBibleVersionId: string | null }, body: unknown, clientConsentNote: string | null) {
  const script = plan.scriptId ? must(db.scripts.find((s) => s.id === plan.scriptId), 'Skript') : null;
  if (script && script.projectId !== plan.projectId) throw new HttpError(409, 'Das Skript gehört zu einem anderen Projekt.');
  const project = must(db.projects.find((p) => p.id === plan.projectId), 'Projekt');
  if (!script && project.kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Freier Schnitt ohne Skript gibt es nur für eigenen Content – Kundenprojekte brauchen ein freigegebenes Skript.');
  const look = lookFor(db, plan.styleBibleVersionId, body);
  const ctx: EditPlanContext = {
    scenes: script ? script.body.scenes : null, assets: assetInfo(db, project.id), projectKind: project.kind, clientConsentNote,
    // hooks are exact references into the script; client lower thirds/keywords quote its dialogue or on-screen text
    script: script ? { selectedHook: script.body.selectedHook, hookVariants: script.body.hookVariants, texts: script.body.scenes.flatMap((sc) => [sc.dialogue, sc.onScreenText]) } : null,
    // a free hook: the project's verified claims, and every claim ever flagged in its scripts
    claimRules: { allowed: protectedClaims(db, project.id), flagged: [...new Set(db.scripts.filter((s) => s.projectId === project.id).flatMap((s) => s.body.claimsToVerify))] },
    fit: lookFit(look),
    // Etappe 13: element styles are checked against the pinned version's styles; the subtitle role's size for the overlap warning
    presetIds: lookPresets(db, plan.styleBibleVersionId).presets.map((p) => p.id),
    subtitleScale: look.design?.subtitle.type.scale ?? 1,
    images: imageInfo(db),
  };
  return { script, project, ctx };
}

const subtitleWarning = (db: Db, clips: readonly { subtitle: string; assetId: string }[]) => {
  const bare = clips.flatMap((c, i) => (!c.subtitle.trim() && !latestTranscript(db, c.assetId) ? [i + 1] : []));
  return bare.length ? `Untertitel: Clip ${bare.join(', ')} hat weder Transkript noch eigenen Text – dort erscheinen keine Untertitel.` : null;
};

export function validateFor(db: Db, plan: { projectId: string; scriptId: string | null; styleBibleVersionId: string | null }, body: unknown, clientConsentNote: string | null) {
  const { script, project, ctx } = planContext(db, plan, body, clientConsentNote);
  assertGeneratedReviewed(db, plan.scriptId, body);
  const v = validateEditPlan(body, ctx);
  if (v.body.subtitles === 'burn') {
    const w = subtitleWarning(db, v.body.clips);
    if (w) v.warnings.push(w);
  }
  return { script, project, v };
}

/**
 * Etappe 12 (E7): the problems of a working draft – the checks of `validateFor`, collected instead of thrown. The render
 * snapshot runs the strict path (`saveEditPlan`); the claim-cut gate of client projects is added by the draft service.
 */
export function draftIssues(db: Db, plan: { projectId: string; scriptId: string | null; styleBibleVersionId: string | null }, body: EditDraftBody, clientConsentNote: string | null): { errors: string[]; warnings: string[]; durationSec: number } {
  if (!body.clips.length) return { errors: ['Noch kein Clip im Schnitt.'], warnings: [], durationSec: 0 };
  const errors: string[] = [];
  try {
    const { ctx } = planContext(db, plan, body, clientConsentNote);
    try { assertGeneratedReviewed(db, plan.scriptId, body); } catch (e) { errors.push((e as Error).message); }
    const { result, errors: e } = checkEditPlan(body, ctx);
    errors.push(...e);
    const warnings = [...result.warnings];
    if (body.subtitles === 'burn') {
      const w = subtitleWarning(db, body.clips);
      if (w) warnings.push(w);
    }
    return { errors, warnings, durationSec: result.durationSec };
  } catch (e) {
    return { errors: [...errors, (e as Error).message], warnings: [], durationSec: buildTimeline(body.clips).durationSec };
  }
}

/** The style version a new plan of this base pins: the script's, or (free cut) the profile's version approved right now. */
export function pinnedStyleFor(db: Db, projectId: string, scriptId: string | null): string | null {
  const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
  if (scriptId) return db.scripts.find((s) => s.id === scriptId)?.styleBibleVersionId ?? null;
  return db.styleBibles.find((x) => x.profileId === project.profileId && x.status === 'approved' && x.approvedAt != null)?.id ?? null;
}

const SaveRequest = z.object({
  /** null = „Freier Schnitt“ without a script (personal content only). */
  scriptId: z.string().min(1).nullable(),
  body: z.unknown(),
  parentId: z.string().nullable().default(null),
  clientConsentNote: z.string().trim().max(500).default(''),
});

/** Saves an EDL as a new draft version (approved versions are never changed). Invalid plans are refused (400). */
export async function saveEditPlan(projectId: string, raw: unknown): Promise<EditPlan> {
  const req = SaveRequest.parse(raw);
  await assertNoClaimCuts(projectId, req.body, req.scriptId);
  return write((db) => {
    const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
    // lineage: from the script, or (scriptless) the profile's style/voice versions approved right now (never a draft)
    const approved = <T extends { profileId: string; status: string; approvedAt: string | null; id: string }>(xs: T[]) =>
      xs.find((x) => x.profileId === project.profileId && x.status === 'approved' && x.approvedAt != null)?.id ?? null;
    const pinnedStyle = req.scriptId ? db.scripts.find((s) => s.id === req.scriptId)?.styleBibleVersionId ?? null : approved(db.styleBibles);
    const { script, v } = validateFor(db, { projectId, scriptId: req.scriptId, styleBibleVersionId: pinnedStyle }, req.body, req.clientConsentNote || null);
    if (req.parentId) must(db.editPlans.find((p) => p.id === req.parentId && p.projectId === projectId && p.scriptId === req.scriptId), 'Vorgängerversion');
    const plan: EditPlan = {
      id: newId(), projectId, scriptId: req.scriptId,
      version: nextPlanVersion(db, projectId, req.scriptId),
      parentId: req.parentId, status: 'draft', body: v.body, durationSec: v.durationSec, disclosures: v.disclosures, warnings: v.warnings,
      clientConsentNote: req.clientConsentNote || null,
      styleBibleVersionId: script ? script.styleBibleVersionId : pinnedStyle,
      voiceGuideVersionId: script ? script.voiceGuideVersionId : approved(db.voiceGuides),
      createdAt: now(), approvedAt: null,
      // Etappe 9: copied from the script; a free cut pins the strategy/profile approved now (pillar from its FitCheck at approval)
      ...(script
        ? { strategyVersionId: script.strategyVersionId, profileVersionId: script.profileVersionId, pillarId: script.pillarId }
        : {
          strategyVersionId: currentApproved(db, 'strategy', project.profileId)?.id ?? null,
          profileVersionId: currentApproved(db, 'profile', project.profileId)?.id ?? null, pillarId: null,
        }),
    };
    db.editPlans.push(plan);
    return plan;
  });
}

/**
 * Human gate: approve an EDL. Needs a plan that still validates (footage may have been deleted) and, in client
 * projects, an approved script. Personal projects call it implicitly from `startRender` (Etappe 10).
 */
export async function approveEditPlan(id: string): Promise<EditPlan> {
  const stored = await read((db) => must(db.editPlans.find((p) => p.id === id), 'Schnittplan'));
  // client claims and transcripts may have changed since the save, and derived versions (revise, generated
  // clip) never passed the save gate: the claim-cut check runs again before every approval
  if (stored.status !== 'approved') await assertNoClaimCuts(stored.projectId, planBody(stored), stored.scriptId);
  const terms = await localLintTerms();
  return write((db) => {
    const plan = must(db.editPlans.find((p) => p.id === id), 'Schnittplan');
    if (plan.status === 'approved') return plan;
    const { v } = validateFor(db, plan, planBody(plan), plan.clientConsentNote);
    const blocked = scriptBlocker(db, plan, 'Erst das Skript freigeben, dann den Schnittplan.');
    if (blocked) throw new HttpError(409, blocked);
    // strategy gate: FitCheck of the piece (script's concept, or the free cut's root) and the lint of hook/overlays/subtitles
    const strategy = strategyBlockers(db, 'edit_plan', plan, terms);
    if (strategy.length) throw strategyGateError(strategy);
    // the plan keeps the strategy/profile/pillar pins it was saved with: personal projects have no FitCheck since
    // Etappe 10 (an old Etappe-9 gate must not pull it back to its strategy version), client projects never had pins
    Object.assign(plan, { status: 'approved', approvedAt: now(), disclosures: v.disclosures, warnings: v.warnings, durationSec: v.durationSec });
    return plan;
  });
}

/**
 * Puts a reviewed generated clip into a new draft version of an EDL (after the clips of its scene and
 * the scenes before it). The new version has to be approved again before it renders.
 */
export async function addGeneratedClip(editPlanId: string, raw: unknown): Promise<EditPlan> {
  const { generationId } = z.object({ generationId: z.string().min(1) }).parse(raw);
  return write((db) => {
    const base = must(db.editPlans.find((p) => p.id === editPlanId), 'Schnittplan');
    if (!base.scriptId) throw new HttpError(409, 'KI-generierte Clips gibt es nur in Schnittplänen mit Skript, nicht im Freien Schnitt.');
    const g = must(db.generations.find((x) => x.id === generationId && x.projectId === base.projectId), 'Generierung');
    if (g.status !== 'approved' || !g.assetId) throw new HttpError(409, 'Erst den generierten Clip prüfen und freigeben.');
    if (g.scriptId !== base.scriptId) throw new HttpError(409, 'Der Clip wurde für ein anderes Skript erzeugt.');
    const asset = must(db.mediaAssets.find((a) => a.id === g.assetId), 'Footage');
    const clip = { sceneIndex: g.sceneIndex, assetId: asset.id, inSec: 0, outSec: Math.round((asset.probe?.durationSec ?? g.params.durationSec) * 1000) / 1000, subtitle: '', briefId: g.briefId, cuts: [], zoom: {}, overlays: [] };
    const baseBody = planBody(base);
    const at = baseBody.clips.reduce((pos, c, i) => (c.sceneIndex != null && c.sceneIndex <= g.sceneIndex ? i + 1 : pos), 0);
    const body = { ...baseBody, clips: [...baseBody.clips.slice(0, at), clip, ...baseBody.clips.slice(at)] };
    const { v } = validateFor(db, base, body, base.clientConsentNote);
    const plan: EditPlan = {
      ...base, id: newId(), parentId: base.id, version: nextPlanVersion(db, base.projectId, base.scriptId), status: 'draft', approvedAt: null, createdAt: now(),
      body: v.body, durationSec: v.durationSec, disclosures: v.disclosures, warnings: v.warnings,
    };
    db.editPlans.push(plan);
    return plan;
  });
}

export const RenderReview = z.object({
  decision: z.enum(['approve', 'reject', 'revise']),
  note: z.string().trim().max(1000).default(''),
});

/**
 * Human gate on a finished render. `approve` / `reject` close the review; `revise` rejects it too and
 * creates a new draft EDL version from the plan, ready to be edited and approved again.
 */
export async function reviewRender(id: string, raw: unknown) {
  const { decision, note } = RenderReview.parse(raw);
  return write((db) => {
    const render = must(db.renders.find((r) => r.id === id), 'Render');
    if (render.status !== 'pending_review') throw new HttpError(409, 'Nur fertige Renders, die auf Prüfung warten, können freigegeben oder abgelehnt werden.');
    if (decision !== 'approve' && note.length < 3) throw new HttpError(400, 'Bitte kurz begründen, was nicht passt.');
    if (decision === 'approve') {
      // the cut must still stand: script and EDL approved, footage and labels unchanged
      const plan = must(db.editPlans.find((p) => p.id === render.editPlanId), 'Schnittplan');
      assertApproved(db, plan);
      const { v } = validateFor(db, plan, planBody(plan), plan.clientConsentNote);
      if (v.disclosures.join('|') !== render.disclosures.join('|')) throw new HttpError(409, 'Die Kennzeichnungspflicht hat sich seit dem Render geändert – bitte neu rendern.');
      // hook/overlay look: the reviewed video must still show the pinned Style Bible's colours and font
      const current = hasGraphics(v.body) ? lookKey(planLook(db, plan, v.body.look, v.body)) : null;
      if (current !== (render.look ? lookKey(render.look) : null)) throw new HttpError(409, 'Der Look (Style Bible, Schrift) hat sich seit dem Render geändert – bitte neu rendern.');
    }
    Object.assign(render, { status: decision === 'approve' ? 'approved' : 'rejected', reviewNote: note, reviewedAt: now() });
    let revision: EditPlan | null = null;
    if (decision === 'revise') {
      const plan = must(db.editPlans.find((p) => p.id === render.editPlanId), 'Schnittplan');
      revision = {
        ...plan, id: newId(), parentId: plan.id, status: 'draft', approvedAt: null, createdAt: now(), body: planBody(plan),
        version: nextPlanVersion(db, plan.projectId, plan.scriptId),
      };
      db.editPlans.push(revision);
    }
    return { render, revision };
  });
}

/**
 * Queues the render of an approved EDL (202 + polling). The render record is created in the same write as the job.
 * Personal projects (Etappe 10): a draft is approved here first, with the checks of `approveEditPlan`, so
 * „Speichern → Rendern“ needs no separate approval click. Client drafts still get 409.
 */
export async function startRender(editPlanId: string, raw: unknown) {
  const { idempotencyKey } = z.object({ idempotencyKey: z.string().trim().min(8).max(200).optional() }).parse(raw ?? {});
  const implicit = await read((db) => {
    const p = must(db.editPlans.find((x) => x.id === editPlanId), 'Schnittplan');
    return p.status === 'draft' && isPersonal(db, p.projectId);
  });
  if (implicit) await approveEditPlan(editPlanId);
  const { projectId, scriptId, body, generated } = await read((db) => {
    const p = must(db.editPlans.find((x) => x.id === editPlanId), 'Schnittplan');
    assertApproved(db, p); // a draft gets 409 "Nur freigegebene …" before any claim check
    const body = planBody(p);
    return { projectId: p.projectId, scriptId: p.scriptId, body, generated: hasGenerated(db, body.clips) };
  });
  // the claim-cut gate once more right before the render (claims or transcripts changed since the approval)
  await assertNoClaimCuts(projectId, body, scriptId);
  const libass = (await ffmpegStatus()).subtitles;
  if (!libass && needsLibass(body, generated ? [true] : [])) throw new HttpError(409, generated ? LABEL_UNAVAILABLE : body.subtitles === 'burn' ? SUBTITLES_UNAVAILABLE : OVERLAYS_UNAVAILABLE);
  const keyUsedElsewhere = () => new HttpError(409, 'idempotencyKey wird bereits für einen anderen Schnittplan verwendet');
  const { job, replayed } = await enqueueJob('render', { editPlanId }, {
    projectId, idempotencyKey: idempotencyKey ?? null,
    onQueued: (db, job) => {
      const existing = db.renders.find((r) => r.jobId === job.id); // a failed/cancelled job re-queued with the same key
      if (existing && existing.editPlanId !== editPlanId) throw keyUsedElsewhere();
      const p = must(db.editPlans.find((x) => x.id === editPlanId), 'Schnittplan');
      assertApproved(db, p);
      if (db.renders.some((r) => r.editPlanId === p.id && r.status === 'rendering' && r.jobId !== job.id)) throw new HttpError(409, 'Dieser Schnittplan wird bereits gerendert.');
      // labels from a fresh validation: the project kind or the footage may have changed since the approval
      const { v } = validateFor(db, p, planBody(p), p.clientConsentNote);
      const fresh = {
        status: 'rendering' as const, storagePath: null, size: null, sha256: null, loudness: null, error: null, reviewNote: '', finishedAt: null, reviewedAt: null,
        durationSec: v.durationSec, disclosures: v.disclosures,
        // snapshot of the look the hook/overlays are rendered with (compared at approval)
        look: hasGraphics(v.body) ? { ...planLook(db, p, v.body.look, v.body), warnings: [] } : null,
      };
      if (existing) Object.assign(existing, fresh);
      else db.renders.push({ id: newId(), projectId: p.projectId, editPlanId: p.id, jobId: job.id, createdAt: now(), ...fresh });
    },
  });
  if (replayed && (job.input as { editPlanId?: string } | null)?.editPlanId !== editPlanId) throw keyUsedElsewhere();
  const render = await read((db) => db.renders.find((r) => r.jobId === job.id) ?? null);
  return { job, render, replayed };
}

/** A generated clip or (Etappe 16) a generated library image: both need the AI label, so libass. */
const hasGenerated = (db: Db, clips: { assetId: string; images?: { referenceId: string }[] }[]) =>
  clips.some((c) => db.mediaAssets.find((a) => a.id === c.assetId)?.origin === 'generated' || (c.images ?? []).some((im) => db.references.find((r) => r.id === im.referenceId)?.usage?.origin === 'generated'));
export const LABEL_UNAVAILABLE = 'Der Schnitt enthält KI-generierte Clips: Das KI-Label wird mit libass eingebrannt, und das installierte FFmpeg hat keinen Filter „subtitles“. FFmpeg mit libass installieren (brew install ffmpeg-full).';
const OVERLAYS_UNAVAILABLE = 'Text-Hook und Grafik-Overlays werden mit libass eingebrannt (Filter „subtitles“) – das installierte FFmpeg hat ihn nicht. Schnittplan ohne Hook/Overlays speichern oder FFmpeg mit libass installieren (brew install ffmpeg-full, danach den Server neu starten).';
const SUBTITLES_UNAVAILABLE = 'Untertitel einbrennen braucht FFmpeg mit libass (Filter „subtitles“) – das installierte FFmpeg hat ihn nicht. Schnittplan ohne Untertitel speichern oder FFmpeg mit libass installieren.';

/** Subtitle cues on the render's output timeline (core `cuesForTimeline`), with the transcripts read from disk. */
export async function subtitleCues(items: { subtitle: string; inSec: number; outSec: number; cuts: { startSec: number; endSec: number }[]; transcript: { storagePath: string; fillerPrompt?: boolean } | null }[], opts: { maxWords?: number; withWords?: boolean } = {}): Promise<SubtitleCue[]> {
  const bodies = await Promise.all(items.map((c) => (c.subtitle.trim() || !c.transcript ? null : readTranscriptBody(c.transcript))));
  return cuesForTimeline(buildTimeline(items), items.map((c, i) => ({ subtitle: c.subtitle, inSec: c.inSec, outSec: c.outSec, transcript: bodies[i] ?? null, fillerPrompt: c.transcript?.fillerPrompt ?? false })), opts);
}

/**
 * What the FFmpeg+ASS path needs for a body (render, exact preview, still frame; Etappe 13: one place, so all three
 * draw the same): the inputs per segment, the AI labels from the stored origins, hook/overlays in the given look and the
 * subtitle items. `proxy` reads the editing proxies where they exist (preview only; the render always reads the originals).
 */
export function renderInputs(db: Db, projectId: string, body: EditPlanBody, look: LookTokens, opts: { proxy?: boolean } = {}) {
  const assets = body.clips.map((c) => must(db.mediaAssets.find((x) => x.id === c.assetId && x.projectId === projectId), 'Footage'));
  // one input per piece between cuts, on the same frame-quantised timeline as labels, subtitles and progress
  const tl = buildTimeline(body.clips);
  const sources = assets.map((a) => ({ path: absolutePath(opts.proxy && a.derived ? a.derived.proxy.storagePath : a.storagePath), hasAudio: a.probe?.hasAudio ?? false }));
  const clips = renderSegments(tl, body.clips, sources);
  const subtitleItems = body.clips.map((c) => ({ subtitle: c.subtitle, inSec: c.inSec, outSec: c.outSec, cuts: c.cuts, transcript: latestTranscript(db, c.assetId) }));
  // the AI label is derived from the stored origin of each clip, never from the plan or the client
  const clipLabels = disclosureLabels(body.clips.map((c, i) => ({ origin: assets[i]!.origin, inSec: c.inSec, outSec: c.outSec, cuts: c.cuts })));
  // Etappe 16: image overlays (FFmpeg overlay below the ASS); a generated image gets the AI label while it is shown.
  // Plans without images: no image layers and the labels exactly as before.
  const timed = timedImages(body, tl).images;
  const refs = new Map(db.references.map((r) => [r.id, r]));
  const images = imageLayers(timed, (id) => {
    const r = refs.get(id);
    if (!r || r.kind !== 'image') throw new ValidationError('Ein eingeblendetes Bild gibt es in der Bibliothek nicht mehr.');
    return absolutePath(r.storagePath);
  });
  const imageLabels = imageDisclosureLabels(timed, (id) => refs.get(id)?.usage?.origin === 'generated', AI_DISCLOSURE);
  const labels = imageLabels.length ? mergeLabelSpans([...clipLabels, ...imageLabels]) : clipLabels;
  const graphics = hasGraphics(body) ? overlayAss(timedElements(body, tl, lookFit(look)), look) : null;
  // Etappe 14: subtitles in the design system's subtitle role (legacy looks keep the fixed Etappe-6 style)
  const subtitleStyle = body.subtitles === 'burn' ? subtitleStyleOf(look) : undefined;
  // Etappe 16b: word-by-word subtitles (null = lines, the cues and ASS of every older plan)
  const subtitleAnimation = body.subtitles === 'burn' ? subtitleAnimationOf(body, look) : null;
  const fontTypes = lookFontTypes(look);
  return {
    tl, assets, sources, clips, images, imageRefs: timed.map((t) => ({ id: t.referenceId, sha256: refs.get(t.referenceId)?.sha256 ?? '' })), subtitleItems, labels, clipLabels, graphics, subtitleStyle, subtitleAnimation,
    customFonts: fontTypes.some((t) => t.custom), expectedFonts: expectedFaces(db, fontTypes), total: tl.durationSec,
  };
}
export type RenderInputs = ReturnType<typeof renderInputs>;



/** The ASS text of a body (subtitles, hook, overlays, AI label) when anything is burned in; null when nothing is. */
export async function renderAssText(body: EditPlanBody, inputs: RenderInputs): Promise<string | null> {
  if (!needsLibass(body, inputs.labels)) return null;
  if (!(await ffmpegStatus()).subtitles) throw new Error(inputs.labels.length ? LABEL_UNAVAILABLE : body.subtitles === 'burn' ? SUBTITLES_UNAVAILABLE : OVERLAYS_UNAVAILABLE);
  const anim = inputs.subtitleAnimation;
  const cues = body.subtitles === 'burn' ? await subtitleCues(inputs.subtitleItems, anim ? { maxWords: anim.wordsPerLine, withWords: true } : {}) : [];
  if (body.subtitles === 'burn' && !cues.length) throw new Error('Untertitel gewählt, aber kein Clip hat ein Transkript oder eigenen Text.');
  // Etappe 13: the plan's subtitle height; absent = the legacy 380 px (same bytes as before)
  const marginV = body.subtitleY != null ? subtitleMarginV(body.subtitleY) : undefined;
  return buildAss(cues, { labels: inputs.labels, overlays: inputs.graphics ?? undefined, subtitle: inputs.subtitleStyle, ...(marginV != null ? { marginV } : {}), ...(anim ? { animation: { mode: anim.mode, highlight: anim.highlight } } : {}) });
}

/** Writes the ASS file of a body when anything is burned in; null when nothing is. */
async function writeRenderAss(file: string, body: EditPlanBody, inputs: RenderInputs): Promise<string | null> {
  const ass = await renderAssText(body, inputs);
  if (ass == null) return null;
  await writeFile(file, ass, 'utf8');
  return file;
}

registerJobHandler('render', async ({ job, signal, workDir, progress }) => {
  const { editPlanId } = z.object({ editPlanId: z.string() }).parse(job.input);
  const { plan, body, clips, renderId, total, graphics, subtitleStyle, customFonts, inputs } = await read((db) => {
    const p = must(db.editPlans.find((x) => x.id === editPlanId), 'Schnittplan');
    assertApproved(db, p); // a job queued before the script was demoted does not run
    const render = must(db.renders.find((r) => r.jobId === job.id), 'Render');
    const body = planBody(p);
    // Re-validate: footage may have been deleted since the approval.
    validateFor(db, p, body, p.clientConsentNote);
    // hook and overlays on the same timeline, in the look snapshotted when the render was queued
    const look = render.look ?? planLook(db, p, body.look, body);
    const inputs = renderInputs(db, p.projectId, body, look);
    return { plan: p, body, clips: inputs.clips, renderId: render.id, total: inputs.total, graphics: inputs.graphics, subtitleStyle: inputs.subtitleStyle, customFonts: inputs.customFonts, inputs };
  });
  const subtitlesFile = await writeRenderAss(path.join(workDir, 'subtitles.ass'), body, inputs);
  let measured = null;
  const loud = body.loudness;
  const measureShare = loud === 'off' ? 0 : 0.25;
  if (loud !== 'off') {
    progress(0, 'Lautheit messen');
    const { stderr } = await runFfmpeg(buildLoudnessMeasure(clips, loud), {
      signal, durationSec: total, loglevel: 'info', onProgress: (f) => progress(f == null ? null : f * measureShare, 'Lautheit messen'),
    });
    // Silence or a failed measurement falls back to one-pass loudnorm.
    measured = parseLoudness(stderr);
  }
  const out = path.join(workDir, 'render.mp4');
  // with hook/overlays: loglevel info, so libass reports which font it really took (silent fallback check)
  const { stderr: renderLog } = await runFfmpeg(buildRender(clips, out, { preset: loud, measured }, subtitlesFile, subtitlesFile && customFonts ? fontsDir() : null, inputs.images), {
    signal, durationSec: total, ...(graphics || subtitleStyle ? { loglevel: 'info' as const, keepStderr: 512 * 1024 } : {}), onProgress: (f, sec) => progress(f == null ? null : measureShare + f * (1 - measureShare), `${sec.toFixed(1)} von ${total} s gerendert`),
  });
  const [{ size }, sha256] = await Promise.all([stat(out), sha256File(out)]);
  signal.throwIfAborted();
  const storagePath = `renders/${plan.projectId}/${renderId}.mp4`;
  await mkdir(path.dirname(absolutePath(storagePath)), { recursive: true });
  await rename(out, absolutePath(storagePath));
  // Cancelled (or project deleted) during the move: never leave an unreferenced file behind.
  if (signal.aborted) {
    await rm(absolutePath(storagePath), { force: true }).catch(() => undefined);
    signal.throwIfAborted();
  }
  return { renderId, storagePath, size, sha256, loudness: { preset: loud, measured }, fontWarnings: graphics || subtitleStyle ? fontFallbacks(renderLog, inputs.expectedFonts) : [], labelKey: JSON.stringify(inputs.labels) };
}, (db, job) => {
  const r = db.renders.find((x) => x.jobId === job.id);
  if (!r) return;
  const res = job.result as { storagePath: string; size: number; sha256: string; loudness: Render['loudness']; fontWarnings?: string[]; labelKey?: string } | null;
  if (job.status === 'succeeded' && res) {
    Object.assign(r, { status: 'pending_review', storagePath: res.storagePath, size: res.size, sha256: res.sha256, loudness: res.loudness, error: null, finishedAt: now(), ...(res.labelKey != null ? { labelKey: res.labelKey } : {}) });
    if (r.look) r.look = { ...r.look, warnings: res.fontWarnings ?? [] } satisfies RenderLook;
  }
  else if (job.status === 'failed' || job.status === 'cancelled') Object.assign(r, { status: job.status, error: job.error, finishedAt: now() });
});

/** Everything the Video Studio needs for one project's cut. */
export const getEditState = async (projectId: string) => {
  const ff = await ffmpegStatus();
  return read((db) => {
    const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
    // what a new plan would pin: the script's Style Bible version, or (free cut) the profile's approved one now
    const approvedNow = db.styleBibles.find((x) => x.profileId === project.profileId && x.status === 'approved' && x.approvedAt != null)?.id ?? null;
    // a new plan takes the fonts of „Meine Marke“; legacy versions ignore it (plan font, Etappe-8 look)
    const look = (styleBibleVersionId: string | null) => ({ ...planLook(db, { styleBibleVersionId }, { fontSource: 'design' }), ...lookPresets(db, styleBibleVersionId) });
    return {
      projectKind: project.kind,
      // Etappe 16b: the studio font list for an element's own font (Mac fonts and Google fonts come from the library)
      fonts: allowedFonts(db).map(({ ref, label }) => ({ ref, label })),
      // hook and overlays need libass like subtitles; without it they are not offered (never a fake preview)
      capabilities: { subtitles: ff.subtitles, overlays: ff.subtitles },
      scripts: db.scripts.filter((s) => s.projectId === projectId).map((s) => ({
        id: s.id, version: s.version, status: s.status, conceptId: s.conceptId, scenes: s.body.scenes,
        selectedHook: s.body.selectedHook, hookVariants: s.body.hookVariants, look: look(s.styleBibleVersionId),
      })),
      freeLook: look(approvedNow),
      // bodies through the parser: older plans get the new fields' do-nothing defaults; a body that fails is flagged, not loadable
      plans: db.editPlans.filter((p) => p.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => {
        const parsed = EditPlanBody.safeParse(p.body);
        return { ...p, body: parsed.success ? parsed.data : p.body, bodyError: !parsed.success, look: { ...(parsed.success ? planLook(db, p, parsed.data.look, parsed.data) : look(p.styleBibleVersionId)), ...lookPresets(db, p.styleBibleVersionId) } };
      }),
      renders: db.renders.filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({
        ...r, job: db.mediaJobs.find((j) => j.id === r.jobId) ?? null,
      })),
    };
  });
};

/** Deletes a render that is not approved (file included). Approved renders stay as the reviewed record. */
export async function deleteRender(id: string) {
  const { files, project } = await write((db) => {
    const r = must(db.renders.find((x) => x.id === id), 'Render');
    if (r.status === 'rendering') throw new HttpError(409, 'Der Render läuft noch – erst abbrechen.');
    if (r.status === 'approved') throw new HttpError(409, 'Freigegebene Renders bleiben erhalten.');
    db.renders = db.renders.filter((x) => x.id !== id);
    // Etappe 17: the finish files (clean video, alpha layer, cover) go with it
    return { project: r.projectId, files: [r.storagePath, ...Object.values(r.finish?.files ?? {}).map((f) => f.storagePath)].filter((x): x is string => !!x) };
  });
  if (files.length) await deleteMediaFiles(files);
  // also files of a failed/cancelled finish job that were never recorded
  await rm(absolutePath(`renders/${project}/finish/${id}`), { recursive: true, force: true }).catch(() => undefined);
  return { deleted: id };
}

/** Tool output can name local files; outside the app only a path-free text is shown. */
export const pathFree = (msg: string | null) =>
  msg == null ? null : msg.split(dataDir()).join('<daten>').replace(/(?:\/[^\s:'"/]+){2,}/g, '<pfad>').slice(0, 300);

/** Job status for n8n polling (WF-06): states only, no file paths. `done` is true once the job ended. */
export const getJobView = (jobId: string) => {
  void pump(); // n8n may be the only caller after a restart: resume queued jobs here too
  return read((db) => {
    const job = must(db.mediaJobs.find((j) => j.id === jobId), 'Job');
    const render = db.renders.find((r) => r.jobId === job.id) ?? null;
    return {
      jobId: job.id, kind: job.kind, status: job.status, progress: job.progress, error: pathFree(job.error),
      done: isFinished(job),
      render: render ? { id: render.id, status: render.status, reviewRequired: render.status === 'pending_review' } : null,
    };
  });
};
