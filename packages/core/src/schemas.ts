/**
 * Domain + agent contracts. Every agent output is validated against these schemas
 * before it is stored. Agent *wire* schemas intentionally avoid numeric/array
 * constraints that structured-output engines reject; stricter checks run afterwards.
 */
import { z } from 'zod';
import { PillarId } from './strategy';
import { DesignSystem } from './designSystem';

export const HEX = /^#[0-9A-Fa-f]{6}$/;
export const HexColor = z.string().regex(HEX, 'Erwartet #RRGGBB');

// ---------- Projects ----------
export const ProjectKind = z.enum(['PERSONAL_CONTENT', 'UGC_CLIENT']);
export type ProjectKind = z.infer<typeof ProjectKind>;

/** Field rules only (no defaults) – the base for create (defaults) and PATCH (partial merge). */
export const ClientBriefFields = z.object({
  clientName: z.string().max(120),
  product: z.string().max(200),
  briefing: z.string().max(4000),
  /** Claims the client has provided and that may be used verbatim. */
  productClaims: z.array(z.string().max(300)).max(40),
  deliverables: z.array(z.string().max(200)).max(40),
  brandNotes: z.string().max(2000),
});
const EMPTY_CLIENT = { clientName: '', product: '', briefing: '', productClaims: [], deliverables: [], brandNotes: '' };
export const ClientBrief = ClientBriefFields.partial().transform((c) => ({ ...EMPTY_CLIENT, ...c }));
export type ClientBrief = z.infer<typeof ClientBrief>;

/** Domain validation error (400). Inside an agent run it is re-raised as invalid model output (502) by runAgent. */
export class ValidationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'ValidationError';
  }
}

const ProjectFields = z.object({
  title: z.string().trim().min(1).max(140),
  kind: ProjectKind,
  description: z.string().max(2000),
});
export const ProjectInput = ProjectFields.extend({
  description: ProjectFields.shape.description.default(''),
  client: ClientBrief.nullable().default(null),
});
export type ProjectInput = z.infer<typeof ProjectInput>;
// ---------- Style / Voice editor forms (raw user text; composed into rules by compose*) ----------
/** One Style/Voice list entry and one free-text style field (shared by rules, compose checks and director suggestions). */
export const STYLE_ITEM_MAX = 160;
export const STYLE_TEXT_MAX = 600;
/** Character limits of the editor form fields (lists are delimited strings, see splitList/joinList). */
export const STYLE_FORM_LIMITS = {
  name: 120, traits: 2000, typography: STYLE_TEXT_MAX, lighting: STYLE_TEXT_MAX, composition: STYLE_TEXT_MAX, textures: STYLE_TEXT_MAX,
  motion: STYLE_TEXT_MAX, transitions: 600, avoid: 2000, palette: 300,
} as const;
export const VOICE_FORM_LIMITS = { traits: 1500, avoid: 1500, example: 2000 } as const;
const formText = (max: number) => z.string().max(max).default('');
const formOf = <K extends string>(limits: Record<K, number>) =>
  z.object(Object.fromEntries(Object.entries(limits).map(([k, max]) => [k, formText(max as number)])) as Record<K, ReturnType<typeof formText>>);
export const StyleFormInput = formOf(STYLE_FORM_LIMITS);
export type StyleForm = z.infer<typeof StyleFormInput>;
export const VoiceFormInput = formOf(VOICE_FORM_LIMITS);
export type VoiceForm = z.infer<typeof VoiceFormInput>;
export const emptyStyleForm = (): StyleForm => StyleFormInput.parse({});
export const emptyVoiceForm = (): VoiceForm => VoiceFormInput.parse({});

/** PATCH schema without defaults: omitted fields stay untouched; `client` fields are merged, `null` removes the brief. */
export const ProjectUpdate = ProjectFields.partial().extend({ client: ClientBriefFields.partial().nullable().optional() });

// ---------- References ----------
export const ReferenceKind = z.enum(['image', 'video']);
export type ReferenceKind = z.infer<typeof ReferenceKind>;
export const ReferenceStatus = z.enum(['uploaded', 'analyzed', 'review_required', 'reviewed']);
export type ReferenceStatus = z.infer<typeof ReferenceStatus>;
export const RatingDimensions = ['color', 'typography', 'composition', 'lighting', 'texture', 'motion', 'mood'] as const;
export const RatingDimension = z.enum(RatingDimensions);
export type RatingDimension = z.infer<typeof RatingDimension>;
/** Manual 1..5 rating per aesthetic dimension; missing = not rated. */
export const Ratings = z.partialRecord(RatingDimension, z.number().int().min(1).max(5));

export const ReferenceUpdate = z.object({
  notes: z.string().max(2000).optional(),
  source: z.string().max(500).optional(),
  likes: z.array(z.string().trim().min(1).max(120)).max(25).optional(),
  dislikes: z.array(z.string().trim().min(1).max(120)).max(25).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(25).optional(),
  ratings: Ratings.optional(),
});
export type ReferenceUpdate = z.infer<typeof ReferenceUpdate>;

// ---------- Reference Analyst ----------
export const ObservationDimension = z.enum([
  'color', 'typography', 'composition', 'lighting', 'texture', 'aesthetic', 'motion', 'subject', 'other',
]);
export type ObservationDimension = z.infer<typeof ObservationDimension>;
/** German UI labels for every observation and rating dimension (one source for all screens). */
export const DIMENSION_LABELS: Record<ObservationDimension | RatingDimension, string> = {
  color: 'Farbe', typography: 'Typografie', composition: 'Komposition', lighting: 'Licht', texture: 'Textur',
  aesthetic: 'Ästhetik', motion: 'Motion', subject: 'Motiv', mood: 'Stimmung', other: 'Sonstiges',
};
export const ObservationKind = z.enum(['observed', 'interpreted']);
export type ObservationKind = z.infer<typeof ObservationKind>;

export const ReferenceAnalysisWire = z.object({
  summary: z.string(),
  colorCharacter: z.object({
    description: z.string(),
    dominantColors: z.array(z.string()),
    temperature: z.enum(['warm', 'cool', 'neutral', 'mixed']),
    contrast: z.enum(['low', 'medium', 'high']),
  }),
  typography: z.object({ visible: z.boolean(), description: z.string().nullable() }),
  composition: z.string(),
  lighting: z.string(),
  textures: z.string(),
  aesthetic: z.array(z.string()),
  observations: z.array(
    z.object({
      dimension: ObservationDimension,
      kind: ObservationKind,
      statement: z.string(),
      evidence: z.string(),
      confidence: z.number(),
    }),
  ),
  uncertainties: z.array(z.string()),
});
export type ReferenceAnalysis = z.infer<typeof ReferenceAnalysisWire>;

/** Post-validation applied to every provider's output. */
export function normalizeReferenceAnalysis(raw: unknown): ReferenceAnalysis {
  const a = ReferenceAnalysisWire.parse(raw);
  return {
    ...a,
    colorCharacter: {
      ...a.colorCharacter,
      dominantColors: a.colorCharacter.dominantColors.filter((c) => HEX.test(c)).map((c) => c.toUpperCase()).slice(0, 8),
    },
    aesthetic: a.aesthetic.slice(0, 12),
    observations: a.observations
      .filter((o) => o.statement.trim().length > 0)
      .slice(0, 30)
      .map((o) => ({ ...o, confidence: Math.min(1, Math.max(0, Number.isFinite(o.confidence) ? o.confidence : 0)) })),
    uncertainties: a.uncertainties.slice(0, 12),
  };
}

export const ObservationDecision = z.enum(['pending', 'approved', 'rejected']);
export type ObservationDecision = z.infer<typeof ObservationDecision>;
export const ObservationReview = z.object({
  decision: ObservationDecision,
  feedback: z.string().max(1000).default(''),
});

// ---------- Style Bible & Voice Guide (contracts/style-bible.schema.json) ----------
export const StyleBibleRules = z.object({
  name: z.string().trim().min(1).max(120),
  visual: z.object({
    palette: z.array(HexColor).max(12),
    traits: z.array(z.string().max(STYLE_ITEM_MAX)).max(40),
    avoid: z.array(z.string().max(STYLE_ITEM_MAX)).max(40),
    typography: z.string().max(STYLE_TEXT_MAX),
    lighting: z.string().max(STYLE_TEXT_MAX),
    composition: z.string().max(STYLE_TEXT_MAX),
    textures: z.string().max(STYLE_TEXT_MAX),
  }),
  motion: z.object({
    pacing: z.string().max(STYLE_TEXT_MAX),
    transitions: z.array(z.string().max(STYLE_ITEM_MAX)).max(20),
  }),
  approvedReferenceIds: z.array(z.string()).max(500),
  approvedObservationIds: z.array(z.string()).max(1000),
  /** „Meine Marke“ (Etappe 14, E4): optional and additive; absent = legacy version (palette[0]/[1]). */
  design: DesignSystem.optional(),
});
export type StyleBibleRules = z.infer<typeof StyleBibleRules>;

export const VoiceGuideRules = z.object({
  traits: z.array(z.string().max(160)).max(30),
  avoid: z.array(z.string().max(160)).max(30),
  ownExamples: z.array(z.string().max(2000)).max(20),
});
export type VoiceGuideRules = z.infer<typeof VoiceGuideRules>;

export const VersionStatus = z.enum(['draft', 'approved', 'archived']);
export type VersionStatus = z.infer<typeof VersionStatus>;

// ---------- Briefing / Content ----------
export const VideoFormat = z.enum(['talking_head', 'product_demo', 'voiceover']);
export type VideoFormat = z.infer<typeof VideoFormat>;
/** `practice` = „Üben & Freude“ (Etappe 9; UI default for personal projects, the Zod default stays `growth`). */
export const BriefGoal = z.enum(['growth', 'engagement', 'trust', 'conversion', 'practice']);
export const VideoLength = z.union([z.literal(15), z.literal(30), z.literal(45)]);

export const BriefInput = z.object({
  projectId: z.string().min(1),
  topic: z.string().trim().min(1, 'Thema fehlt').max(200),
  audience: z.string().trim().max(200).default(''),
  goal: BriefGoal.default('growth'),
  /** Verified facts / real experience, one per entry. The only claims a script may state. */
  verifiedFacts: z.array(z.string().trim().min(1).max(350)).max(20).default([]),
  format: VideoFormat.default('talking_head'),
  lengthSeconds: VideoLength.default(30),
  cta: z.string().trim().max(200).default(''),
  notes: z.string().trim().max(1500).default(''),
  /** Primary strategy pillar (Etappe 9); optional since Etappe 10 (an unknown pillar is treated as none). */
  pillarId: PillarId.nullable().default(null),
});
export type BriefInput = z.infer<typeof BriefInput>;

export const ConceptWire = z.object({
  title: z.string(),
  kind: z.string(),
  hook: z.string(),
  hookVariants: z.array(z.string()),
  angle: z.string(),
  structure: z.array(z.string()),
  cta: z.string(),
  rationale: z.string(),
  styleNotes: z.string(),
});
export const ConceptsWire = z.object({ concepts: z.array(ConceptWire), warnings: z.array(z.string()) });
export type ConceptDraft = z.infer<typeof ConceptWire>;

export function normalizeConcepts(raw: unknown): { concepts: ConceptDraft[]; warnings: string[] } {
  const parsed = ConceptsWire.parse(raw);
  if (parsed.concepts.length < 3) throw new ValidationError(`Content Strategist lieferte ${parsed.concepts.length} statt 3 Konzepte`);
  const concepts = parsed.concepts.slice(0, 3);
  const titles = new Set(concepts.map((c) => c.title.trim().toLowerCase()));
  if (titles.size < 3) throw new ValidationError('Konzepte sind nicht unterscheidbar (doppelte Titel)');
  return { concepts, warnings: parsed.warnings };
}

export const SceneOrigin = z.enum(['real', 'generated', 'hybrid']);
export const ShotType = z.enum(['talking_head', 'close_up', 'macro', 'wide', 'over_shoulder', 'screen', 'b_roll', 'product']);

export const ScriptScene = z.object({
  startSecond: z.number(),
  endSecond: z.number(),
  beat: z.string(),
  dialogue: z.string(),
  onScreenText: z.string(),
  visual: z.string(),
  shotType: ShotType,
  origin: SceneOrigin,
});
export type ScriptScene = z.infer<typeof ScriptScene>;

export const ShotlistItem = z.object({
  shot: z.string(),
  shotType: ShotType,
  framing: z.string(),
  notes: z.string(),
  origin: SceneOrigin,
});

export const UgcScriptWire = z.object({
  format: VideoFormat,
  estimatedSeconds: z.number(),
  hookVariants: z.array(z.string()),
  selectedHook: z.string(),
  scenes: z.array(ScriptScene),
  cta: z.string(),
  shotlist: z.array(ShotlistItem),
  verifiedClaims: z.array(z.string()),
  claimsToVerify: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type UgcScript = z.infer<typeof UgcScriptWire>;

/** Strict validation + timing checks for any script (generated or user-edited). */
export function validateScript(raw: unknown, lengthSeconds?: number): UgcScript {
  const s = UgcScriptWire.parse(raw);
  if (!s.scenes.length) throw new ValidationError('Skript braucht mindestens eine Szene');
  let prevEnd = 0;
  const scenes = [...s.scenes].sort((a, b) => a.startSecond - b.startSecond);
  for (const sc of scenes) {
    if (sc.startSecond < 0 || sc.endSecond <= sc.startSecond) throw new ValidationError(`Ungültige Szenenzeit ${sc.startSecond}–${sc.endSecond}s`);
    if (sc.startSecond < prevEnd - 0.001) throw new ValidationError('Szenen überlappen sich');
    prevEnd = sc.endSecond;
  }
  const total = scenes[scenes.length - 1]!.endSecond;
  const warnings = [...s.warnings];
  if (lengthSeconds && Math.abs(total - lengthSeconds) > Math.max(3, lengthSeconds * 0.15)) {
    warnings.push(`Szenenlänge (${total}s) weicht von der Ziellänge (${lengthSeconds}s) ab.`);
  }
  return { ...s, scenes, estimatedSeconds: total, hookVariants: s.hookVariants.slice(0, 6), warnings: [...new Set(warnings)] };
}

// ---------- Analytics ----------
export const MetricWindow = z.enum(['24h', '7d', '30d']);
export type MetricWindow = z.infer<typeof MetricWindow>;
const count = z.number().int().min(0).max(1_000_000_000);

export const PublicationInput = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(140),
  platform: z.literal('instagram').default('instagram'),
  format: z.enum(['reel', 'carousel', 'photo', 'story']).default('reel'),
  publishedAt: z.iso.datetime({ offset: true }).or(z.iso.date()),
  permalink: z.string().trim().max(500).default(''),
  conceptId: z.string().nullable().default(null),
  scriptVersionId: z.string().nullable().default(null),
  hook: z.string().trim().max(300).default(''),
  styleBibleVersionId: z.string().nullable().default(null),
  voiceGuideVersionId: z.string().nullable().default(null),
  /** Etappe 9: the cut this publication shows (lineage), and a pillar when nothing upstream carries one. */
  editPlanId: z.string().nullable().default(null),
  pillarId: PillarId.nullable().default(null),
});
export type PublicationInput = z.infer<typeof PublicationInput>;

export const MetricSnapshotInput = z.object({
  publicationId: z.string().min(1),
  window: MetricWindow,
  observedAt: z.iso.datetime({ offset: true }).optional(),
  source: z.enum(['manual', 'file_import']).default('manual'),
  metrics: z.object({
    reach: count,
    views: count,
    likes: count.nullable().default(null),
    comments: count.nullable().default(null),
    saves: count,
    shares: count,
    follows: count.nullable().default(null),
  }),
});
export type MetricSnapshotInput = z.infer<typeof MetricSnapshotInput>;
export type Metrics = MetricSnapshotInput['metrics'];
