/**
 * Edit plan (EDL) for Release 3, Etappe 4: which take plays for which script scene, from where to where,
 * and how the first cut is rendered (1080x1920, 30 fps, H.264, AAC 48 kHz).
 * Framework-free and deterministic: the validator and the FFmpeg graph builder are pure functions.
 */
import { z } from 'zod';
import { AD_DISCLOSURE, AI_DISCLOSURE } from './agents/scriptAgents';
import { ValidationError, type ScriptScene } from './schemas';
import { buildTimeline, clipPieces, type Timeline } from './timeline';
import { applyCase, type OverlayFit } from './designSystem';
import { burnedTextFindings, ClipOverlay, freePositionFindings, hookLayout, layoutConflicts, overlayHasText, PlanHook, PlanLook, quoteProblem, TEXT_LIMIT, timedElements, type BurnedTextRules } from './overlays';
import { SIZE_SCALE } from './designSystem';
import { subtitleBox, SubtitleY } from './overlayLayout';
import { SubtitleMode, WordsPerLine } from './textAnim';
import { ClipImage, IMAGE_FADE_SEC, imageAlphaAt, imageBox, imageBoxFindings, imageRightsProblem, MAX_IMAGES_PER_CLIP, timedImages, type ImageAssetInfo, type ImageLayer } from './imageLayer';

export const ClipOrigin = z.enum(['own', 'licensed', 'client', 'generated']);
export type ClipOrigin = z.infer<typeof ClipOrigin>;

/**
 * Loudness target of the final mix. There is no official Instagram value: −14 LUFS is the usual
 * streaming assumption, not a platform rule. `off` keeps the original levels.
 */
export const LoudnessPreset = z.enum(['streaming_-14', 'quiet_-16', 'off']);
export type LoudnessPreset = z.infer<typeof LoudnessPreset>;
export const LOUDNESS: Record<Exclude<LoudnessPreset, 'off'>, { I: number; TP: number; LRA: number; label: string }> = {
  'streaming_-14': { I: -14, TP: -1.5, LRA: 11, label: '−14 LUFS (übliche Annahme für Social/Streaming, kein offizieller Instagram-Wert)' },
  'quiet_-16': { I: -16, TP: -1.5, LRA: 11, label: '−16 LUFS (etwas leiser, mehr Dynamik)' },
};

export const OUTPUT = { width: 1080, height: 1920, fps: 30, audioRate: 48000 } as const;
export const MIN_CLIP_SEC = 0.2;
export const MAX_CUT_SEC = 180;
/** Every remaining piece of every clip is one FFmpeg input (one decoder): capped to keep memory in bounds. */
export const MAX_SEGMENTS = 60;
export const ZOOM_AMOUNT = { min: 1.03, max: 1.15, default: 1.1 } as const;

/** A range of the take that is left out (source time). `reason`/`word` are for the version list only. */
export const CutRange = z.object({
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().positive(),
  reason: z.enum(['filler', 'pause', 'manual']).default('manual'),
  word: z.string().trim().max(40).default(''),
}).refine((c) => c.endSec > c.startSec, { message: 'Schnitt: Ende muss nach dem Anfang liegen.' });
export type CutRange = z.infer<typeof CutRange>;

/**
 * Two cuts joined into one: the strictest reason wins. Any filler or pause part makes the whole cut a
 * suggestion cut (checked by the client-claim gate and counted as such); only manual + manual stays manual.
 */
export function mergeCutPair<T extends { startSec: number; endSec: number; reason?: string; word?: string }>(a: T, b: T): T {
  const merged = { ...a, startSec: Math.min(a.startSec, b.startSec), endSec: Math.max(a.endSec, b.endSec) };
  if (a.reason === 'manual' && b.reason !== undefined && b.reason !== 'manual') return { ...merged, reason: b.reason, word: b.word ?? '' };
  return merged;
}

/** Sorted, overlapping or touching cuts merged (strictest reason kept, see `mergeCutPair`). */
export function normalizeCuts<T extends { startSec: number; endSec: number; reason?: string; word?: string }>(cuts: readonly T[]): T[] {
  const out: T[] = [];
  for (const c of [...cuts].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)) {
    const last = out[out.length - 1];
    if (last && c.startSec <= last.endSec + 0.0005) out[out.length - 1] = mergeCutPair(last, c);
    else out.push({ ...c });
  }
  return out;
}

export const ZoomKind = z.enum(['none', 'push_in', 'push_out', 'punch_in']);
export type ZoomKind = z.infer<typeof ZoomKind>;
/**
 * Zoom of one clip, applied to the picture before the join (labels and text are never zoomed).
 * push_in/push_out: slow zoom over the whole clip (continues across its cuts); punch_in: static crop-in;
 * punchOnCuts: alternates 1.0 / amount at every cut of the clip (hides jump cuts), not combinable with a push.
 */
export const ClipZoom = z.object({
  kind: ZoomKind.default('none'),
  amount: z.number().finite().min(ZOOM_AMOUNT.min).max(ZOOM_AMOUNT.max).default(ZOOM_AMOUNT.default),
  punchOnCuts: z.boolean().default(false),
}).refine((x) => !(x.punchOnCuts && (x.kind === 'push_in' || x.kind === 'push_out')), { message: 'Punch-in bei Schnitten lässt sich nicht mit Push-in/-out kombinieren.' });
export type ClipZoom = z.infer<typeof ClipZoom>;

export const EditClip = z.object({
  /** Script scene of the clip; null in a scriptless plan („Freier Schnitt“). */
  sceneIndex: z.number().int().min(0).max(99).nullable().default(null),
  assetId: z.string().trim().min(1).max(100),
  inSec: z.number().finite().min(0),
  outSec: z.number().finite().positive(),
  /** On-screen text of the scene; burned in with ASS in Etappe 6, stored now. */
  subtitle: z.string().trim().max(300).default(''),
  /** Generated clips only (Etappe 7): the approved asset brief they come from. */
  briefId: z.string().trim().max(100).nullable().default(null),
  /** Ranges of the take that are left out (Etappe 8), normalised: sorted and merged. */
  cuts: z.array(CutRange).max(40).default([]).transform((c) => normalizeCuts(c)),
  zoom: ClipZoom.prefault({}),
  /** Lower thirds, keywords, arrows, frames (Etappe 8), in source time of the take; burned in with libass. */
  overlays: z.array(ClipOverlay).max(8).default([]),
  /**
   * Etappe 16: her own or licensed images from the library, in source time (FFmpeg overlay below the ASS layer). Optional:
   * absent = no images (every older plan parses and renders exactly as before).
   */
  images: z.array(ClipImage).max(MAX_IMAGES_PER_CLIP).optional(),
});
export type EditClip = z.infer<typeof EditClip>;

export const EditPlanBody = z.object({
  clips: z.array(EditClip).min(1, 'Mindestens ein Clip').max(100),
  loudness: LoudnessPreset.default('streaming_-14'),
  /** Burn subtitles (ASS) into the video: clip.subtitle, else the corrected transcript of the take. */
  subtitles: z.enum(['off', 'burn']).default('off'),
  /** Text hook from 0 s (Etappe 8): a reference to the script's hook, or (scriptless) her own short text. */
  hook: PlanHook.nullable().default(null),
  /** Font of hook and overlays (allow-list). Colours come from the plan's pinned Style Bible, not from here. */
  look: PlanLook.prefault({}),
  /**
   * Etappe 13: height of the burned subtitles (bottom edge of the text, share of the picture height, see `SUBTITLE_Y`).
   * Absent = the legacy 80.2 % (every plan saved before; same ASS bytes). New drafts start at 72 %.
   */
  subtitleY: SubtitleY.optional(),
  /**
   * Etappe 16b (optional): word-by-word subtitles (`karaoke`, the spoken word in her accent, `subtitleWords` 1–4 per line)
   * or one big word (`word`). Absent = the subtitle role's default in the pinned Meine Marke, else lines (every older plan).
   */
  subtitleMode: SubtitleMode.optional(),
  subtitleWords: WordsPerLine.optional(),
});
export type EditPlanBody = z.infer<typeof EditPlanBody>;

/**
 * Body of a working draft (Etappe 12, E7): the EDL shape with the same per-clip limits, but it may be empty while she
 * works. It is checked leniently (problems shown, see `checkEditPlan`); the render snapshot goes through `EditPlanBody`.
 */
export const EditDraftBody = EditPlanBody.extend({ clips: z.array(EditClip).max(100).default([]) });
export type EditDraftBody = z.infer<typeof EditDraftBody>;

/** What the validator needs to know about each referenced asset (from the store, never from the client). */
export interface EditAssetInfo { origin: ClipOrigin; durationSec: number | null; hasAudio: boolean; hasVideo: boolean }

export interface ValidatedEditPlan {
  body: EditPlanBody;
  /** Clips with their asset's origin and the label each one needs. */
  clips: (EditClip & { origin: ClipOrigin; disclosure: string | null })[];
  durationSec: number;
  /** Labels every publication of this cut must carry. */
  disclosures: string[];
  warnings: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Validates an EDL against the script and the stored assets.
 * Rules: every clip points to an existing scene and asset with a known duration and lies inside it;
 * product scenes are never generated; generated clips need an approved brief and carry the AI label;
 * client projects with generated clips need the documented client consent.
 */
export function validateEditPlan(raw: unknown, ctx: EditPlanContext): ValidatedEditPlan {
  const { result, errors } = checkEditPlan(raw, ctx);
  if (errors.length) throw new ValidationError(errors.join(' '));
  return result;
}

/** What `validateEditPlan`/`checkEditPlan` need besides the body. */
export interface EditPlanContext {
  /** Scenes of the plan's script; null for a scriptless plan („Freier Schnitt“, personal content only). */
  scenes: Pick<ScriptScene, 'shotType' | 'origin'>[] | null;
  assets: ReadonlyMap<string, EditAssetInfo>;
  projectKind: 'PERSONAL_CONTENT' | 'UGC_CLIENT';
  clientConsentNote?: string | null;
  /**
   * The plan's script: its hooks (a hook is an exact reference to one of them) and its dialogue and
   * on-screen texts (client projects: the only texts a lower third or keyword of a scripted plan may quote).
   */
  script?: { selectedHook: string; hookVariants: readonly string[]; texts: readonly string[] } | null;
  /**
   * Scriptless plans: the transcript text of each take. Etappe 10: scriptless plans are personal, and personal
   * overlays are free text, so this is no longer checked (kept for callers; client plans always have a script).
   */
  transcriptTexts?: ReadonlyMap<string, string>;
  /** Claim rules for burned-in text (free hook, lower thirds, keywords): verified claims of the project and claims ever flagged in its scripts. */
  claimRules?: BurnedTextRules;
  /** Etappe 14: size steps and cases of the pinned design-system look (`lookFit`), so conflicts match the render. */
  fit?: OverlayFit;
  /** Etappe 13: overlay styles of the pinned design system (null/absent = not checked; [] = legacy look without styles). */
  presetIds?: readonly string[] | null;
  /** Etappe 13: size step of the subtitle role (for the subtitle overlap warning). */
  subtitleScale?: number;
  /** Etappe 16: library images the plan may show (kind and her usage/rights note), from the store. */
  images?: ReadonlyMap<string, ImageAssetInfo>;
}

/**
 * Etappe 12 (E7): the same checks as `validateEditPlan`, but the problems are returned instead of thrown, so a
 * working draft can show them. `result` is only meaningful when `errors` is empty. Shape errors of the body still throw (ZodError).
 */
export function checkEditPlan(raw: unknown, ctx: EditPlanContext): { result: ValidatedEditPlan; errors: string[] } {
  const body = EditPlanBody.parse(raw);
  const errors: string[] = [];
  const warnings: string[] = [];
  const scenes = ctx.scenes;
  const personal = ctx.projectKind === 'PERSONAL_CONTENT';
  const lintBurned = (text: string, where: string, prefix: string) => {
    const f = burnedTextFindings(text, ctx.claimRules ?? { allowed: [], flagged: [] }, where);
    errors.push(...f.denials.map((x) => `${prefix}: ${x}`));
    (personal ? warnings : errors).push(...f.claims.map((x) => `${prefix}: ${x}`));
  };
  if (!scenes && ctx.projectKind === 'UGC_CLIENT') errors.push('Kundenprojekte brauchen ein freigegebenes Skript – Freier Schnitt gibt es nur für eigenen Content.');
  const clips = body.clips.map((raw, i) => {
    const n = `Clip ${i + 1}`;
    // a scriptless plan has no scenes: the scene index is dropped
    const c = { ...raw, sceneIndex: scenes ? raw.sceneIndex : null, inSec: r3(raw.inSec), outSec: r3(raw.outSec), cuts: raw.cuts.map((x) => ({ ...x, startSec: r3(x.startSec), endSec: r3(x.endSec) })) };
    const scene = scenes && c.sceneIndex != null ? scenes[c.sceneIndex] : undefined;
    const asset = ctx.assets.get(c.assetId);
    if (scenes && c.sceneIndex == null) errors.push(`${n}: Szene fehlt.`);
    else if (scenes && !scene) errors.push(`${n}: Szene ${c.sceneIndex! + 1} gibt es im Skript nicht.`);
    if (c.cuts.some((x) => x.startSec < c.inSec - 0.0005 || x.endSec > c.outSec + 0.0005)) errors.push(`${n}: Ein Schnitt liegt außerhalb von In/Out.`);
    else if (r3(c.outSec - c.inSec) >= MIN_CLIP_SEC) {
      const pieces = clipPieces(c);
      if (!pieces.length) errors.push(`${n}: Die Schnitte entfernen den ganzen Clip.`);
      else if (c.cuts.length && pieces.some((p) => r3(p.rawSec) < MIN_CLIP_SEC)) errors.push(`${n}: Nach den Schnitten bleibt ein Stück unter ${MIN_CLIP_SEC} s übrig.`);
    }
    c.overlays = c.overlays.map((o) => ({ ...o, startSec: r3(o.startSec), endSec: r3(o.endSec), text: overlayHasText(o.kind) ? o.text : '' }));
    c.overlays.forEach((o, k) => {
      const on = `${n}, Overlay ${k + 1}`;
      if (o.startSec < c.inSec - 0.0005 || o.endSec > c.outSec + 0.0005) errors.push(`${on}: liegt außerhalb von In/Out.`);
      if (o.kind !== 'lower_third' && o.kind !== 'keyword') return;
      if (o.text.length > TEXT_LIMIT[o.kind]) errors.push(`${on}: höchstens ${TEXT_LIMIT[o.kind]} Zeichen.`);
      // client projects: burned-in text needs a source, the approved script's words (a client plan always has one).
      // Etappe 10: personal overlays are free text, no quote rule.
      const sources = !personal ? (scenes ? ctx.script?.texts : ctx.transcriptTexts ? [ctx.transcriptTexts.get(c.assetId) ?? ''] : undefined) : undefined;
      const problem = sources ? quoteProblem(o.text, sources) : null;
      if (problem === 'missing')
        errors.push(scenes
          ? `${on}: „${o.text}“ steht nicht wörtlich im Dialog oder On-Screen-Text des Skripts (in einem Satz) – eingebrannt wird nur Text aus dem freigegebenen Skript.`
          : `${on}: „${o.text}“ steht nicht wörtlich im Transkript dieses Takes (in einem Satz) – eingebrannt werden nur eigene, gesprochene Worte.`);
      else if (problem === 'negated') errors.push(`${on}: „${o.text}“ steht dort nur verneint (nach „nicht“, „kein“, „ohne“ …) – ohne die Verneinung würde daraus eine Aussage.`);
      else if (problem === 'question') errors.push(`${on}: „${o.text}“ ist dort eine Frage – nur mit „?“ übernehmen, sonst wird daraus eine Aussage.`);
      // the same claim lint as a free hook: a quote can still carry an unverified figure or a flagged claim.
      // Personal projects: claims only as warnings; a denied label is an error everywhere.
      lintBurned(o.text, 'im Overlay', on);
    });
    // Etappe 16: image overlays – personal projects only, her own or licensed (with source) library images
    if (c.images?.length) {
      c.images = c.images.map((o) => ({ ...o, startSec: r3(o.startSec), endSec: r3(o.endSec) }));
      c.images.forEach((o, k) => {
        const on = `${n}, Bild ${k + 1}`;
        if (!personal) { errors.push(`${on}: Bild-Einblendungen gibt es zunächst nur in eigenen Projekten.`); return; }
        if (o.startSec < c.inSec - 0.0005 || o.endSec > c.outSec + 0.0005) errors.push(`${on}: liegt außerhalb von In/Out.`);
        const problem = imageRightsProblem(ctx.images?.get(o.referenceId));
        if (problem) errors.push(`${on}: ${problem}`);
        const f = imageBoxFindings(imageBox(o), on);
        errors.push(...f.errors);
        warnings.push(...f.warnings);
      });
    }
    if (!asset) {
      errors.push(`${n}: Footage nicht gefunden (gelöscht oder aus einem anderen Projekt).`);
      return { ...c, origin: 'own' as const, disclosure: null };
    }
    if (r3(c.outSec - c.inSec) < MIN_CLIP_SEC) errors.push(`${n}: Out muss mindestens ${MIN_CLIP_SEC} s nach In liegen.`);
    if (!asset.hasVideo) errors.push(`${n}: Footage ohne Videospur (z. B. reine Audiodatei) kann nicht geschnitten werden.`);
    if (asset.durationSec == null) errors.push(`${n}: Dauer des Footage unbekannt (ffprobe fehlt oder konnte die Datei nicht lesen).`);
    else if (c.outSec > asset.durationSec + 0.05) errors.push(`${n}: Out (${c.outSec} s) liegt hinter dem Ende des Footage (${r3(asset.durationSec)} s).`);
    if (asset.origin === 'generated') {
      if (!scenes) errors.push(`${n}: KI-generierte Clips gibt es nur in Schnittplänen mit Skript.`);
      if (scene?.shotType === 'product') errors.push(`${n}: Produktszenen zeigen immer echtes Footage, nie KI-generierte Clips.`);
      if (!c.briefId) errors.push(`${n}: KI-generierter Clip ohne freigegebenen Asset-Brief.`);
    }
    if (scene && scene.origin === 'real' && asset.origin === 'generated') warnings.push(`${n}: Das Skript plant für Szene ${c.sceneIndex! + 1} echtes Footage.`);
    if (!asset.hasAudio) warnings.push(`${n}: Footage ohne Ton – an dieser Stelle wird Stille eingefügt.`);
    return { ...c, origin: asset.origin, disclosure: asset.origin === 'generated' ? AI_DISCLOSURE : null };
  });
  // Etappe 16: a generated image needs the AI label like a generated clip (labelled while it is shown)
  const generatedImage = clips.some((c) => (c.images ?? []).some((o) => ctx.images?.get(o.referenceId)?.usage?.origin === 'generated'));
  const generated = clips.some((c) => c.origin === 'generated') || generatedImage;
  if (generated && ctx.projectKind === 'UGC_CLIENT' && !ctx.clientConsentNote?.trim())
    errors.push('Kundenprojekt mit KI-generierten Clips: Zustimmung der Kundin dokumentieren.');
  const tl = buildTimeline(clips);
  const durationSec = tl.durationSec;
  if (durationSec > MAX_CUT_SEC) errors.push(`Der Schnitt ist ${durationSec} s lang, höchstens ${MAX_CUT_SEC} s.`);
  if (tl.segments.length > MAX_SEGMENTS) errors.push(`Der Schnitt hat ${tl.segments.length} Stücke (Clips und Teile zwischen Schnitten), höchstens ${MAX_SEGMENTS}.`);
  const hook = checkHook(body.hook, scenes != null, ctx, durationSec, errors, warnings, lintBurned);
  const timed = timedElements({ clips, hook }, tl, ctx.fit);
  for (const d of timed.dropped) warnings.push(`Clip ${d.clip + 1}, Overlay ${d.index + 1} liegt ganz in einem Schnitt und wird nicht gezeigt.`);
  for (const d of timedImages({ clips }, tl).dropped) warnings.push(`Clip ${d.clip + 1}, Bild ${d.index + 1} liegt ganz in einem Schnitt und wird nicht gezeigt.`);
  errors.push(...layoutConflicts(timed));
  // Etappe 13: free positions – the AI-label zone is an error, Instagram's interface and the subtitles are warnings
  const free = freePositionFindings(timed, body.subtitles === 'burn' ? subtitleBox(body.subtitleY, ctx.subtitleScale ?? 1) : null);
  errors.push(...free.errors);
  warnings.push(...free.warnings);
  if (ctx.presetIds) {
    const known = new Set(ctx.presetIds);
    const unknown = (id: string | undefined, name: string) => {
      if (id && !known.has(id)) warnings.push(ctx.presetIds!.length ? `${name}: Overlay-Stil „${id}“ gibt es in „Meine Marke“ nicht (mehr) – der Stil des Schnitts wird verwendet.` : `${name}: Eigene Overlay-Stile gibt es erst mit „Meine Marke“ – der Stil des Schnitts wird verwendet.`);
    };
    clips.forEach((c, i) => c.overlays.forEach((o, k) => unknown(o.presetId, `Clip ${i + 1}, Overlay ${k + 1}`)));
    unknown(hook?.presetId, 'Hook');
  }
  if (ctx.projectKind === 'UGC_CLIENT' && clips.some((c) => c.cuts.length))
    warnings.push('Schnitte verändern gesprochene Aussagen: vor der Lieferung mit der Kundin abstimmen.');
  if (scenes) {
    const covered = new Set(clips.map((c) => c.sceneIndex));
    const missing = scenes.map((_, i) => i).filter((i) => !covered.has(i));
    if (missing.length) warnings.push(`Ohne Clip: Szene ${missing.map((i) => i + 1).join(', ')}.`);
  }
  const disclosures = [...(ctx.projectKind === 'UGC_CLIENT' ? [AD_DISCLOSURE] : []), ...(generated ? [AI_DISCLOSURE] : [])];
  return {
    result: {
      body: { ...body, hook, clips: clips.map((c) => ({ sceneIndex: c.sceneIndex, assetId: c.assetId, inSec: c.inSec, outSec: c.outSec, subtitle: c.subtitle, briefId: c.briefId, cuts: c.cuts, zoom: c.zoom, overlays: c.overlays, ...(c.images?.length ? { images: c.images } : {}) })) },
      clips, durationSec, disclosures, warnings,
    },
    errors,
  };
}

/**
 * The hook of a plan, resolved: with a script an exact reference to its selected hook or variant (the stored
 * text becomes that script string); without a script her own text, ≤ 60 characters, through the claim lint.
 */
function checkHook(
  h: PlanHook | null, scripted: boolean, ctx: EditPlanContext, durationSec: number, errors: string[], warnings: string[],
  lintBurned: (text: string, where: string, prefix: string) => void,
): PlanHook | null {
  if (!h) return null;
  let text = h.text;
  if (scripted) {
    if (h.source === 'free') errors.push('Hook: Mit Skript kommt der Hook aus dem Skript (ausgewählter Hook oder eine Variante) – eigenen Text im Skript ändern und freigeben lassen.');
    else if (ctx.script) {
      const ref = h.source === 'selected' ? ctx.script.selectedHook : ctx.script.hookVariants[h.variantIndex ?? -1];
      if (ref == null || !ref.trim()) errors.push(h.source === 'selected' ? 'Hook: Das Skript hat keinen ausgewählten Hook.' : `Hook: Das Skript hat keine Variante ${(h.variantIndex ?? 0) + 1}.`);
      else text = ref.replace(/\s+/g, ' ').trim();
    } else errors.push('Hook: Das Skript des Schnittplans fehlt.');
  } else if (h.source !== 'free') errors.push('Hook: Ohne Skript gibt es nur einen eigenen Hook-Text.');
  else {
    if (!text) errors.push('Hook: Text fehlt.');
    else if (text.length > TEXT_LIMIT.free_hook) errors.push(`Hook: höchstens ${TEXT_LIMIT.free_hook} Zeichen.`);
    // Etappe 10: no `claimsReviewed` confirmation; the claim lint as for overlays (free hooks are personal only)
    else lintBurned(text, 'im Hook', 'Hook');
  }
  if (text && !hookLayout(ctx.fit ? applyCase(text, ctx.fit.hook.textCase) : text, h.slot, h.size ? SIZE_SCALE[h.size] : ctx.fit?.hook.scale ?? 1, h.pos)) errors.push('Hook: Der Text ist zu lang für das Bild (höchstens 4 Zeilen) – kürzere Variante wählen.');
  if (durationSec < 1) errors.push('Hook: Der Schnitt ist kürzer als 1 s.');
  else if (h.endSec > durationSec) warnings.push(`Hook: endet mit dem Schnitt nach ${durationSec} s statt nach ${h.endSec} s.`);
  return { ...h, text, variantIndex: h.source === 'variant' ? h.variantIndex : null, claimsReviewed: scripted ? false : h.claimsReviewed };
}

/**
 * Disclosure overlay for the render: the AI label over every generated clip on the output timeline
 * (adjacent generated clips merge into one label). The text is fixed here, never taken from input.
 */
export function disclosureLabels(clips: { origin: ClipOrigin; inSec: number; outSec: number; cuts?: readonly { startSec: number; endSec: number }[] }[]): { startSec: number; endSec: number; text: string }[] {
  const out: { startSec: number; endSec: number; text: string }[] = [];
  // a clip's cuts never open a gap in its label: it spans the clip's whole output range
  buildTimeline(clips).clips.forEach((span, i) => {
    if (clips[i]!.origin !== 'generated' || span.durationSec <= 0) return;
    const last = out[out.length - 1];
    if (last && Math.abs(last.endSec - r3(span.outStart)) < 0.001) last.endSec = r3(span.outEnd);
    else out.push({ startSec: r3(span.outStart), endSec: r3(span.outEnd), text: AI_DISCLOSURE });
  });
  return out;
}

/** Zoom of one render segment: a static factor or a push over the whole clip (offset/clip length after cuts). */
export type SegmentZoom = { kind: 'static'; factor: number } | { kind: 'push_in' | 'push_out'; amount: number; offsetSec: number; clipSec: number };
/**
 * One input of the render: a stored file (server path) and the range to take from it. Pieces created
 * by cuts carry 12 ms audio fades at the cut boundaries; zoomed clips carry their zoom. Plain clips carry neither.
 */
export interface RenderClip { path: string; hasAudio: boolean; inSec: number; outSec: number; fadeIn?: boolean; fadeOut?: boolean; zoom?: SegmentZoom }

/** Zoom of one segment (null = none). punchOnCuts alternates 1.0 / amount per piece, starting at the base. */
function segmentZoom(z: ClipZoom, piece: number, offsetSec: number, clipSec: number): SegmentZoom | null {
  if (z.kind === 'push_in' || z.kind === 'push_out') return { kind: z.kind, amount: z.amount, offsetSec, clipSec };
  const base = z.kind === 'punch_in' ? z.amount : 1;
  const factor = z.punchOnCuts && piece % 2 === 1 ? (base === 1 ? z.amount : 1) : base;
  return factor === 1 ? null : { kind: 'static', factor };
}

/**
 * The render inputs from the timeline: one per segment. `sources[i]` is the stored file of clip i.
 * Uses the same quantised durations as the timeline, so subtitles, labels and progress match the picture.
 */
export function renderSegments(tl: Timeline, clips: readonly { zoom?: ClipZoom }[], sources: readonly { path: string; hasAudio: boolean }[]): RenderClip[] {
  return tl.segments.map((s) => {
    const src = sources[s.clip]!;
    const seg: RenderClip = { path: src.path, hasAudio: src.hasAudio, inSec: s.srcIn, outSec: s.srcOut };
    if (s.fadeIn) seg.fadeIn = true;
    if (s.fadeOut) seg.fadeOut = true;
    const z = clips[s.clip]?.zoom;
    const zoom = z ? segmentZoom(z, s.piece, s.offsetInClip, tl.clips[s.clip]!.durationSec) : null;
    if (zoom) seg.zoom = zoom;
    return seg;
  });
}
export interface MeasuredLoudness { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }

const f3 = (n: number) => n.toFixed(3);
const even = (n: number) => 2 * Math.round(n / 2);
export const AUDIO_FADE_SEC = 0.012;

/**
 * Cover-scale from the source straight to the output (with the zoom folded in), then centre crop.
 * A push needs a per-frame size: the source is first cropped to 9:16 (config-time crop, no scaling), then
 * scaled per frame to one even width W(t) with H(t) derived from it, and the centre crop uses the same
 * W(t)/H(t) expressions (FFmpeg's crop keeps the first frame's in_w/in_h). All numbers are ours; the
 * expressions are single-quoted for the filtergraph and contain no backslashes.
 */
function scaleChain(z: SegmentZoom | undefined): string {
  const { width: W, height: H } = OUTPUT;
  if (!z) return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  if (z.kind === 'static') return `scale=${even(W * z.factor)}:${even(H * z.factor)}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  const p = `min((t+${f3(z.offsetSec)})/${f3(Math.max(z.clipSec, 0.001))},1)`;
  const zf = z.kind === 'push_in' ? `(1+${f3(z.amount - 1)}*${p})` : `(1+${f3(z.amount - 1)}*(1-${p}))`;
  const w = `2*trunc(${W}*${zf}/2)`, h = `2*trunc(${w}*${H}/${W}/2)`;
  return `crop=w='2*trunc(min(iw,ih*${W}/${H})/2)':h='2*trunc(min(ih,iw*${H}/${W})/2)',scale=w='${w}':h='${h}':eval=frame,crop=w=${W}:h=${H}:x='(${w}-${W})/2':y='(${h}-${H})/2'`;
}

const fades = (c: RenderClip, d: number) =>
  `${c.fadeIn ? `,afade=t=in:st=0:d=${AUDIO_FADE_SEC}` : ''}${c.fadeOut ? `,afade=t=out:st=${f3(Math.max(0, d - AUDIO_FADE_SEC))}:d=${AUDIO_FADE_SEC}` : ''}`;

/**
 * One input per clip with accurate input seeking (`-ss`/`-t` before `-i`): FFmpeg decodes from the
 * nearest keyframe and drops frames up to the in-point, so the re-encoded cut is frame-exact without
 * decoding long footage from its start. The same file may appear several times.
 */
const inputArgs = (clips: RenderClip[]) => clips.flatMap((c) => ['-ss', f3(c.inSec), '-t', f3(c.outSec - c.inSec), '-i', c.path]);

/** Per-clip video/audio chains + concat. All numbers are formatted by us; no user text enters the graph. */
function graph(clips: RenderClip[], withVideo: boolean): string[] {
  const { fps, audioRate } = OUTPUT;
  const parts: string[] = [];
  clips.forEach((c, i) => {
    const d = f3(c.outSec - c.inSec);
    if (withVideo)
      // a piece between cuts always has exactly d*30 frames (the last frame is held if the file ends earlier)
      parts.push(`[${i}:v:0]setpts=PTS-STARTPTS,${scaleChain(c.zoom)},fps=${fps},${c.fadeIn || c.fadeOut ? 'tpad=stop=-1:stop_mode=clone,' : ''}setsar=1,format=yuv420p,trim=duration=${d}[v${i}]`);
    // fades after atrim (on the final length), in the measure pass too: loudnorm measures the identical audio
    parts.push(c.hasAudio
      ? `[${i}:a:0]asetpts=PTS-STARTPTS,aresample=${audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d}${fades(c, Number(d))}[a${i}]`
      : `anullsrc=channel_layout=stereo:sample_rate=${audioRate},atrim=duration=${d},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  const streams = clips.map((_, i) => (withVideo ? `[v${i}][a${i}]` : `[a${i}]`)).join('');
  parts.push(`${streams}concat=n=${clips.length}:v=${withVideo ? 1 : 0}:a=1${withVideo ? '[vcat]' : ''}[acat]`);
  return parts;
}

/** Pass 1 of the two-pass loudnorm: audio only, prints the measurement as JSON to stderr. */
export function buildLoudnessMeasure(clips: RenderClip[], preset: Exclude<LoudnessPreset, 'off'>): string[] {
  const t = LOUDNESS[preset];
  const filter = [...graph(clips, false), `[acat]loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}:print_format=json[aout]`].join(';');
  return [...inputArgs(clips), '-filter_complex', filter, '-map', '[aout]', '-f', 'null', '-'];
}

/** Extracts the loudnorm JSON block from FFmpeg's stderr. */
export function parseLoudness(stderr: string): MeasuredLoudness | null {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
    // only finite numbers pass (silence measures as "-inf")
    if (!keys.every((k) => typeof o[k] === 'string' && Number.isFinite(Number(o[k])))) return null;
    return Object.fromEntries(keys.map((k) => [k, String(Number(o[k]))])) as unknown as MeasuredLoudness;
  } catch {
    return null;
  }
}

/**
 * Etappe 16: inputs of the image overlays, after the clip inputs. A still image is looped at 30 fps up to its end, so the
 * alpha fade has frames to work on. The path is an argument, never part of the filtergraph.
 */
const imageInputArgs = (images: readonly ImageLayer[]) =>
  images.flatMap((im) => ['-loop', '1', '-framerate', String(OUTPUT.fps), '-t', f3(im.endSec + 0.5), '-i', im.path]);

/** One image over the picture (FFmpeg `overlay`, between `startSec` and `endSec`, optional alpha fades); only our numbers. */
function imageChain(im: ImageLayer, input: number, k: number, from: string): { parts: string[]; out: string } {
  const fade = im.fade
    ? `,fade=t=in:st=${f3(im.startSec)}:d=${f3(IMAGE_FADE_SEC)}:alpha=1,fade=t=out:st=${f3(Math.max(im.startSec, im.endSec - IMAGE_FADE_SEC))}:d=${f3(IMAGE_FADE_SEC)}:alpha=1`
    : '';
  const out = `[vimg${k}]`;
  return {
    parts: [
      `[${input}:v:0]scale=${im.w}:${im.h}:flags=lanczos,format=rgba${fade},setpts=PTS-STARTPTS[img${k}]`,
      `${from}[img${k}]overlay=x=${Math.round(im.x)}:y=${Math.round(im.y)}:enable='between(t,${f3(im.startSec)},${f3(im.endSec)})':eof_action=pass${out}`,
    ],
    out,
  };
}

/**
 * Video and audio chains of the final mix (render and preview share them): the cut, the image overlays (Etappe 16, below
 * the ASS layer), the ASS burn-in (hook, text, subtitles, AI label on top), loudnorm. Without images the graph is the
 * same string as before Etappe 16.
 */
function mixGraph(clips: RenderClip[], loudness: { preset: LoudnessPreset; measured: MeasuredLoudness | null }, subtitlesFile?: string | null, fontsDir?: string | null, images: readonly ImageLayer[] = []): { parts: string[]; video: string } {
  if (!clips.length) throw new ValidationError('Kein Clip zum Rendern');
  const parts = graph(clips, true);
  let video = '[vcat]';
  images.forEach((im, k) => {
    const c = imageChain(im, clips.length + k, k, video);
    parts.push(...c.parts);
    video = c.out;
  });
  if (subtitlesFile) {
    parts.push(`${video}${subtitlesFilter(subtitlesFile, fontsDir)}[vsub]`);
    video = '[vsub]';
  }
  const { preset, measured } = loudness;
  if (preset === 'off') parts.push('[acat]anull[aout]');
  else {
    const t = LOUDNESS[preset];
    const lin = measured
      ? `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`
      : '';
    parts.push(`[acat]loudnorm=I=${t.I}:TP=${t.TP}:LRA=${t.LRA}${lin},aresample=${OUTPUT.audioRate}[aout]`);
  }
  return { parts, video };
}

/** The `subtitles` filter (libass) with the server-generated ASS path and her fonts folder; quoting characters are refused, never escaped. */
function subtitlesFilter(subtitlesFile: string, fontsDir?: string | null): string {
  if (/['\\:[\],;]/.test(subtitlesFile.replace(/^[A-Za-z]:/, ''))) throw new ValidationError('Untertitel-Pfad enthält unzulässige Zeichen');
  // Etappe 14: her uploaded fonts (data folder) for libass; same refusal of quoting characters
  if (fontsDir && /['\\:[\],;]/.test(fontsDir.replace(/^[A-Za-z]:/, ''))) throw new ValidationError('Schriftordner-Pfad enthält unzulässige Zeichen');
  return `subtitles=filename='${subtitlesFile}'${fontsDir ? `:fontsdir='${fontsDir}'` : ''}`;
}

/** Pass 2 / single pass: frame-exact cut (input seek + concat, re-encoded) to a vertical H.264/AAC MP4, cropped to fill 9:16. */
export function buildRender(clips: RenderClip[], output: string, loudness: { preset: LoudnessPreset; measured: MeasuredLoudness | null }, subtitlesFile?: string | null, fontsDir?: string | null, images: readonly ImageLayer[] = []): string[] {
  const { parts, video } = mixGraph(clips, loudness, subtitlesFile, fontsDir, images);
  return [
    ...inputArgs(clips), ...imageInputArgs(images), '-filter_complex', parts.join(';'),
    '-map', video, '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(OUTPUT.fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(OUTPUT.audioRate), '-ac', '2',
    '-movflags', '+faststart', '-y', output,
  ];
}

/** Size of the exact preview (Etappe 13): half the output resolution. */
export const PREVIEW = { width: 540, height: 960 } as const;

/**
 * Exact low-res preview (Etappe 13): the SAME graph as `buildRender` (cut, zoom, ASS with hook, overlays, subtitles and
 * the AI label at 1080×1920, loudnorm in one pass), then scaled to 540×960 and encoded fast. The inputs may be the
 * editing proxies (cover-cropped 9:16, scaled up by the same chain), so only the picture detail differs from the render.
 */
export function buildPreview(clips: RenderClip[], output: string, loudness: { preset: LoudnessPreset }, subtitlesFile?: string | null, fontsDir?: string | null, images: readonly ImageLayer[] = []): string[] {
  const { parts, video } = mixGraph(clips, { preset: loudness.preset, measured: null }, subtitlesFile, fontsDir, images);
  parts.push(`${video}scale=${PREVIEW.width}:${PREVIEW.height}:flags=bilinear[vprev]`);
  return [
    ...inputArgs(clips), ...imageInputArgs(images), '-filter_complex', parts.join(';'),
    '-map', '[vprev]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', String(OUTPUT.fps),
    '-c:a', 'aac', '-b:a', '96k', '-ar', String(OUTPUT.audioRate), '-ac', '2',
    '-movflags', '+faststart', '-y', output,
  ];
}

/**
 * The input of ONE output frame at time t (Etappe 13, „Standbild prüfen“): the segment that shows t, starting at that
 * source moment, with the zoom of that moment (a push continues from the segment's offset). `outT` is the frame's output
 * time (whole frames), so the ASS events of that moment are drawn. null for an empty timeline.
 */
export function frameInput(tl: Timeline, clips: readonly { zoom?: ClipZoom }[], sources: readonly { path: string; hasAudio: boolean }[], t: number): { clip: RenderClip; outT: number } | null {
  if (!tl.segments.length) return null;
  const last = Math.max(0, Math.floor(tl.durationSec * OUTPUT.fps - 1e-6) / OUTPUT.fps);
  const outT = Math.min(last, Math.max(0, Math.round(t * OUTPUT.fps) / OUTPUT.fps));
  let i = tl.segments.findIndex((s) => outT >= s.outStart - 0.0005 && outT < s.outEnd - 0.0005);
  if (i < 0) i = tl.segments.length - 1;
  const s = tl.segments[i]!;
  const seg = renderSegments(tl, clips, sources)[i]!;
  const local = Math.max(0, Math.min(outT - s.outStart, s.durationSec - 1 / OUTPUT.fps));
  const zoom = seg.zoom?.kind === 'push_in' || seg.zoom?.kind === 'push_out' ? { ...seg.zoom, offsetSec: seg.zoom.offsetSec + local } : seg.zoom;
  const clip: RenderClip = { path: seg.path, hasAudio: false, inSec: r3(seg.inSec + local), outSec: r3(Math.min(seg.outSec, seg.inSec + local + 2 / OUTPUT.fps)) };
  if (zoom) clip.zoom = zoom;
  return { clip, outT: r3(outT) };
}

/**
 * One frame as PNG through the render's picture chain (seek, cover scale with zoom, 30 fps) and the same ASS file: the
 * frame gets its output time as timestamp, so libass draws exactly the events of that moment (hook, overlays, subtitles,
 * AI label). `size` scales the finished 1080×1920 frame (the ASS is always drawn at full size).
 */
export function buildFrame(clip: RenderClip, outT: number, output: string, subtitlesFile?: string | null, fontsDir?: string | null, size: { width: number; height: number } = OUTPUT, images: readonly ImageLayer[] = []): string[] {
  // seek half a second earlier and trim to the frame: a seek right at the last frame of a file can return no frame at all
  const pre = Math.min(clip.inSec, 0.5);
  const zoom = clip.zoom && clip.zoom.kind !== 'static' ? { ...clip.zoom, offsetSec: clip.zoom.offsetSec - pre } : clip.zoom;
  const chain = [`[0:v:0]setpts=PTS-STARTPTS`, scaleChain(zoom), `fps=${OUTPUT.fps}`, 'tpad=stop=2:stop_mode=clone', `trim=start=${f3(pre)}`, 'setpts=PTS-STARTPTS', 'setsar=1', 'format=yuv420p', 'trim=end_frame=1', `setpts=PTS+${f3(outT)}/TB`];
  const input = ['-ss', f3(clip.inSec - pre), '-t', f3(pre + Math.max(clip.outSec - clip.inSec, 1 / OUTPUT.fps) + 0.2), '-i', clip.path];
  // Etappe 16: the images visible at outT, each with its opacity at that moment (the render's fade, as a constant here)
  const shown = images.map((im) => ({ im, alpha: imageAlphaAt(im, outT) })).filter((x) => x.alpha > 0);
  const tail: string[] = [];
  if (subtitlesFile) tail.push(subtitlesFilter(subtitlesFile, fontsDir));
  if (size.width !== OUTPUT.width || size.height !== OUTPUT.height) tail.push(`scale=${size.width}:${size.height}:flags=bilinear`);
  if (!shown.length) {
    const filter = `${[...chain, ...tail].join(',')}[vout]`;
    return [...input, '-filter_complex', filter, '-map', '[vout]', '-frames:v', '1', '-an', '-y', output];
  }
  const parts = [`${chain.join(',')}[vbase]`];
  let video = '[vbase]';
  shown.forEach(({ im, alpha }, k) => {
    parts.push(`[${k + 1}:v:0]scale=${im.w}:${im.h}:flags=lanczos,format=rgba${alpha < 1 ? `,colorchannelmixer=aa=${alpha.toFixed(3)}` : ''}[img${k}]`);
    parts.push(`${video}[img${k}]overlay=x=${Math.round(im.x)}:y=${Math.round(im.y)}:eof_action=repeat[vimg${k}]`);
    video = `[vimg${k}]`;
  });
  parts.push(tail.length ? `${video}${tail.join(',')}[vout]` : `${video}null[vout]`);
  return [...input, ...shown.flatMap(({ im }) => ['-i', im.path]), '-filter_complex', parts.join(';'), '-map', '[vout]', '-frames:v', '1', '-an', '-y', output];
}
