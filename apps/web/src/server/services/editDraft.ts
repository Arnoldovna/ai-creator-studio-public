import 'server-only';
import { EditDraftBody, claimRanges, type TimeRange } from '@studio/core';
import { z } from 'zod';
import { HttpError } from '../errors';
import { ffmpegStatus } from '../ffmpeg';
import { whisperStatus } from '../whisper';
import { must, newId, now, read, write, type Db, type EditDraft } from '../store';
import { isFinished } from '../worker';
import { assertNoClaimCuts, protectedClaims } from './cuts';
import { draftIssues, lookPresets, pinnedStyleFor, planBody, planLook, saveEditPlan, startRender } from './edit';
import { prepareView } from './prepare';
import { latestSilenceScan, latestTranscript, readTranscriptBody } from './transcripts';

/**
 * Etappe 12 (E7): the working draft of the editor. One mutable draft per project and script (null = Freier Schnitt),
 * autosaved with a revision check, validated leniently (problems are shown, never a 400 for content). Rendering takes
 * an immutable EditPlan snapshot through the strict path (`saveEditPlan`, then `startRender`, which approves a personal
 * draft implicitly as in Etappe 10). Client projects never render from here: their snapshot is saved as a draft
 * version and goes through the existing approval in the classic view.
 */

export const ScriptKey = z.string().trim().min(1).max(100).nullable();
export const findDraft = (db: Db, projectId: string, scriptId: string | null) => db.editDrafts.find((d) => d.projectId === projectId && d.scriptId === scriptId) ?? null;

export function checkBase(db: Db, projectId: string, scriptId: string | null) {
  const project = must(db.projects.find((p) => p.id === projectId), 'Projekt');
  if (scriptId) must(db.scripts.find((s) => s.id === scriptId && s.projectId === projectId), 'Skript');
  else if (project.kind !== 'PERSONAL_CONTENT') throw new HttpError(409, 'Freier Schnitt ohne Skript gibt es nur für eigenen Content – Kundenprojekte brauchen ein freigegebenes Skript.');
  return project;
}

/** Media of the project as the editor needs it: proxies, sprite, waveform state, transcript and pause scan (summaries). */
function mediaOf(db: Db, projectId: string) {
  const active = new Set(db.mediaJobs.filter((j) => (j.kind === 'transcribe' || j.kind === 'silence_scan') && !isFinished(j)).map((j) => `${j.kind}:${(j.input as { assetId?: string } | null)?.assetId}`));
  return db.mediaAssets.filter((a) => a.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((a) => {
    const t = latestTranscript(db, a.id);
    const scan = latestSilenceScan(db, a.id);
    return {
      id: a.id, name: a.name, origin: a.origin, durationSec: a.probe?.durationSec ?? null, hasAudio: a.probe?.hasAudio ?? false,
      hasVideo: a.probe ? a.probe.videoCodec != null || a.probe.width != null : false,
      prepare: prepareView(db, a), derived: a.derived ?? null,
      transcript: t ? { id: t.id, version: t.version, source: t.source, fillerPrompt: t.fillerPrompt ?? false } : null,
      transcribing: active.has(`transcribe:${a.id}`), scanning: active.has(`silence_scan:${a.id}`),
      silences: scan ? scan.ranges : null,
      generationReview: a.generation?.review ?? null,
    };
  });
}

async function view(projectId: string, scriptId: string | null) {
  const snap = await read((db) => {
    const project = checkBase(db, projectId, scriptId);
    const draft = findDraft(db, projectId, scriptId);
    const pinned = pinnedStyleFor(db, projectId, scriptId);
    const issues = draft ? draftIssues(db, { projectId, scriptId, styleBibleVersionId: pinned }, draft.body, draft.clientConsentNote || null) : null;
    const plans = db.editPlans.filter((p) => p.projectId === projectId && p.scriptId === scriptId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = plans[0] ?? null;
    const snapshotPlan = draft?.lastSnapshot ? db.editPlans.find((p) => p.id === draft.lastSnapshot!.planId) ?? null : null;
    const planIds = new Set(plans.map((p) => p.id));
    const renders = db.renders.filter((r) => planIds.has(r.editPlanId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3)
      .map((r) => ({ ...r, planVersion: plans.find((p) => p.id === r.editPlanId)?.version ?? null, job: db.mediaJobs.find((j) => j.id === r.jobId) ?? null }));
    const look = { ...planLook(db, { styleBibleVersionId: pinned }, draft?.body.look ?? { fontSource: 'design' }, draft?.body ?? null), ...lookPresets(db, pinned) };
    // client projects: sentences with a client claim are never shortened by pacing (same list as the save gate)
    const claims = project.kind === 'UGC_CLIENT' ? protectedClaims(db, projectId, scriptId) : [];
    const script = scriptId ? db.scripts.find((s) => s.id === scriptId)! : null;
    return {
      projectKind: project.kind, scriptId,
      script: script ? { id: script.id, version: script.version, status: script.status, scenes: script.body.scenes.map((s) => ({ shotType: s.shotType, dialogue: s.dialogue })), selectedHook: script.body.selectedHook, hookVariants: script.body.hookVariants } : null,
      draft: draft ? { id: draft.id, revision: draft.revision, body: draft.body, clientConsentNote: draft.clientConsentNote, basePlanId: draft.basePlanId, updatedAt: draft.updatedAt } : null,
      issues,
      // a new draft starts from the latest saved version of this base (if any)
      latestPlan: latest ? { id: latest.id, version: latest.version, status: latest.status, body: EditDraftBody.safeParse(planBody(latest)).data ?? null } : null,
      snapshot: draft?.lastSnapshot && snapshotPlan ? { planId: snapshotPlan.id, version: snapshotPlan.version, status: snapshotPlan.status, revision: draft.lastSnapshot.revision } : null,
      renders, look, media: mediaOf(db, projectId),
      transcriptsToRead: db.mediaAssets.filter((a) => a.projectId === projectId).flatMap((a) => {
        const t = latestTranscript(db, a.id);
        return t ? [{ assetId: a.id, t }] : [];
      }),
      claims,
      body: draft?.body ?? null,
    };
  });
  // client projects: the claim-cut gate (async, reads transcripts) as one more problem instead of a 400
  if (snap.issues && snap.projectKind === 'UGC_CLIENT' && snap.body?.clips.length) {
    try { await assertNoClaimCuts(projectId, snap.body, scriptId); } catch (e) { snap.issues.errors.push((e as Error).message); }
  }
  const protectedRanges: Record<string, (TimeRange & { reason: string })[]> = {};
  if (snap.claims.length) {
    for (const { assetId, t } of snap.transcriptsToRead) {
      const ranges = claimRanges(await readTranscriptBody(t), snap.claims);
      if (ranges.length) protectedRanges[assetId] = ranges.map((r) => ({ startSec: r.startSec, endSec: r.endSec, reason: r.reason }));
    }
  }
  const [st, ff] = await Promise.all([whisperStatus(), ffmpegStatus()]);
  const { transcriptsToRead: _t, claims: _c, body: _b, ...rest } = snap;
  void _t; void _c; void _b;
  return {
    ...rest, protectedRanges,
    transcription: { available: st.available, mode: st.mode, reason: st.reason },
    // hook, overlays and burned subtitles need libass (as in the classic view: never offered without it)
    capabilities: { ffmpeg: ff.available, subtitles: ff.subtitles },
    etag: snap.draft ? `"r${snap.draft.revision}"` : '"r0"',
  };
}

export type EditDraftView = Awaited<ReturnType<typeof view>>;

export const getEditDraft = (projectId: string, rawScriptId: unknown) => view(projectId, ScriptKey.parse(rawScriptId || null));

export const PutDraft = z.object({
  scriptId: ScriptKey,
  /** The revision the editor started from (0 = no draft yet). A different stored revision is a conflict (409). */
  revision: z.number().int().min(0),
  body: EditDraftBody,
  clientConsentNote: z.string().trim().max(500).default(''),
  /** Only when creating: the saved version the draft continues. */
  basePlanId: z.string().min(1).max(100).nullable().default(null),
});

/** `If-Match: "r<n>"` wins over the body's revision when both are given. */
const revisionFromIfMatch = (h: string | null | undefined) => {
  const m = h ? /^"r(\d+)"$/.exec(h.trim()) : null;
  return m ? Number(m[1]) : null;
};

export async function putEditDraft(projectId: string, raw: unknown, ifMatch?: string | null) {
  const req = PutDraft.parse(raw);
  const expected = revisionFromIfMatch(ifMatch) ?? req.revision;
  await write((db) => {
    checkBase(db, projectId, req.scriptId);
    const existing = findDraft(db, projectId, req.scriptId);
    const current = existing?.revision ?? 0;
    if (current !== expected)
      throw new HttpError(409, `Der Entwurf wurde inzwischen an anderer Stelle geändert (Stand ${current}, hier ${expected}) – neu laden.`, 'draft_conflict');
    const at = now();
    if (existing) {
      Object.assign(existing, { body: req.body, clientConsentNote: req.clientConsentNote, revision: current + 1, updatedAt: at });
      return;
    }
    const base = req.basePlanId ? db.editPlans.find((p) => p.id === req.basePlanId && p.projectId === projectId && p.scriptId === req.scriptId) : null;
    const draft: EditDraft = {
      id: newId(), projectId, scriptId: req.scriptId, revision: 1, body: req.body, clientConsentNote: req.clientConsentNote,
      basePlanId: base?.id ?? null, lastSnapshot: null, createdAt: at, updatedAt: at,
    };
    db.editDrafts.push(draft);
  });
  return view(projectId, req.scriptId);
}

export const RenderDraft = z.object({
  scriptId: ScriptKey,
  /** The revision the editor shows: rendering an older or newer state than she sees is refused (409). */
  revision: z.number().int().min(1),
  /** `save` stores the snapshot as a version only (client projects: approval in the classic view). */
  mode: z.enum(['render', 'save']).default('render'),
});

/** One snapshot at a time per draft (double click, two tabs): the second request gets 409. */
const inFlight = new Set<string>();

/**
 * Snapshot + render. The snapshot is a new EditPlan version through the strict validation (`saveEditPlan`: 400 with the
 * problems, the claim-cut gate); the same revision is snapshotted once (a second click reuses the version and, through
 * the idempotency key, the render). Personal projects: `startRender` approves the version implicitly (Etappe 10).
 */
export async function renderEditDraft(projectId: string, raw: unknown) {
  const req = RenderDraft.parse(raw);
  const draft = await read((db) => {
    const project = checkBase(db, projectId, req.scriptId);
    const d = findDraft(db, projectId, req.scriptId);
    if (!d) throw new HttpError(404, 'Kein Entwurf vorhanden.');
    if (d.revision !== req.revision) throw new HttpError(409, 'Der Entwurf wurde inzwischen geändert – erst speichern lassen, dann rendern.', 'draft_conflict');
    if (project.kind === 'UGC_CLIENT' && req.mode === 'render')
      throw new HttpError(409, 'Kundenprojekte rendern nur nach der Freigabe: „Als Version speichern“ und in der Klassischen Ansicht freigeben.');
    const reuse = d.lastSnapshot?.revision === d.revision ? db.editPlans.find((p) => p.id === d.lastSnapshot!.planId) ?? null : null;
    const parent = d.basePlanId && db.editPlans.some((p) => p.id === d.basePlanId) ? d.basePlanId : null;
    return { ...d, reuseId: reuse?.id ?? null, parent };
  });
  if (inFlight.has(draft.id)) throw new HttpError(409, 'Für diesen Entwurf läuft schon ein Speichern oder Rendern.');
  inFlight.add(draft.id);
  try {
    const planId = draft.reuseId ?? (await saveEditPlan(projectId, { scriptId: req.scriptId, body: draft.body, parentId: draft.parent, clientConsentNote: draft.clientConsentNote })).id;
    await write((db) => {
      const d = db.editDrafts.find((x) => x.id === draft.id);
      // the draft content stays; only the lineage moves on (no revision bump: the editor's next autosave still matches)
      if (d) Object.assign(d, { lastSnapshot: { revision: draft.revision, planId }, basePlanId: planId });
    });
    const plan = await read((db) => must(db.editPlans.find((p) => p.id === planId), 'Schnittplan'));
    if (req.mode === 'save') return { plan, job: null, render: null, replayed: !!draft.reuseId };
    const out = await startRender(planId, { idempotencyKey: `draft-render:${planId}` });
    return { plan: await read((db) => db.editPlans.find((p) => p.id === planId)!), ...out };
  } finally {
    inFlight.delete(draft.id);
  }
}
