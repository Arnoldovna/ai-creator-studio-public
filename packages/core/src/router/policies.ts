import type { Modality } from './registry';

export const USE_CASES = [
  'reference_image_analysis', 'reference_video_analysis', 'style_synthesis', 'voice_analysis', 'content_research',
  'content_strategy', 'ugc_scriptwriting', 'cinematic_direction', 'instagram_copywriting', 'growth_analysis',
  'content_quality_assurance', 'design_system_synthesis', 'studio_chat', 'edit_direction',
  'carousel_writing', 'story_writing', 'week_planning',
] as const;
export type UseCase = (typeof USE_CASES)[number];

/** Criteria the user rates in the Evaluation Lab (1–5). */
export const EVAL_CRITERIA = ['accuracy', 'creativity', 'styleFidelity', 'voiceFidelity', 'actionability', 'factuality'] as const;
export type EvalCriterion = (typeof EVAL_CRITERIA)[number];
export const EVAL_CRITERIA_LABELS: Record<EvalCriterion, string> = {
  accuracy: 'Genauigkeit', creativity: 'Kreativität', styleFidelity: 'Style-Treue', voiceFidelity: 'Voice-Treue',
  actionability: 'Umsetzbarkeit', factuality: 'Faktentreue',
};

export interface RoutingPolicy {
  label: string;
  /** Inputs our gateway path must deliver (video tasks use keyframe images). */
  requires: Modality[];
  /** How public benchmarks map to this task (weights sum to 1). Missing benchmark → 0 for that part (conservative). */
  benchmarkWeights: { textOverall?: number; vision?: number; creativeWriting?: number };
  /** Models within this quality distance (0..1 scale) of the best count as "good enough"; the cheapest of those wins. */
  qualityTolerance: number;
  /** Typical request size for cost estimates (tokens; images add IMAGE_TOKENS each). */
  typicalTokens: { input: number; output: number; images: number };
  maxOutputTokens: number;
  /** Weights for the user's Evaluation-Lab ratings (sum to 1). */
  evalWeights: Partial<Record<EvalCriterion, number>>;
  /** Agent wired to this use case today (others are configured for upcoming agents). */
  agent: string | null;
}

/** Rough per-image token cost used only for estimates (≈ 1.6k for a ~1–1.5 MP image). */
export const IMAGE_TOKENS = 1600;

export const ROUTING_POLICIES: Record<UseCase, RoutingPolicy> = {
  reference_image_analysis: {
    label: 'Referenzbild-Analyse', requires: ['text', 'image'],
    benchmarkWeights: { vision: 0.8, textOverall: 0.2 }, qualityTolerance: 0.03,
    typicalTokens: { input: 1500, output: 1800, images: 1 }, maxOutputTokens: 4000,
    evalWeights: { accuracy: 0.45, styleFidelity: 0.3, factuality: 0.15, actionability: 0.1 }, agent: 'reference_analyst',
  },
  reference_video_analysis: {
    label: 'Referenzvideo-Analyse (Keyframes)', requires: ['text', 'image'],
    benchmarkWeights: { vision: 0.8, textOverall: 0.2 }, qualityTolerance: 0.03,
    typicalTokens: { input: 1500, output: 2200, images: 6 }, maxOutputTokens: 4000,
    evalWeights: { accuracy: 0.45, styleFidelity: 0.3, factuality: 0.15, actionability: 0.1 }, agent: 'reference_analyst',
  },
  style_synthesis: {
    label: 'Style-Synthese', requires: ['text'],
    benchmarkWeights: { textOverall: 1 }, qualityTolerance: 0.03,
    typicalTokens: { input: 6000, output: 2500, images: 0 }, maxOutputTokens: 4000,
    evalWeights: { styleFidelity: 0.45, accuracy: 0.3, actionability: 0.25 }, agent: 'style_director',
  },
  voice_analysis: {
    label: 'Voice-Analyse', requires: ['text'],
    benchmarkWeights: { textOverall: 0.6, creativeWriting: 0.4 }, qualityTolerance: 0.04,
    typicalTokens: { input: 5000, output: 1500, images: 0 }, maxOutputTokens: 3000,
    evalWeights: { voiceFidelity: 0.5, accuracy: 0.3, actionability: 0.2 }, agent: 'voice_director',
  },
  content_research: {
    label: 'Content-Recherche', requires: ['text'],
    benchmarkWeights: { textOverall: 1 }, qualityTolerance: 0.05,
    typicalTokens: { input: 4000, output: 2500, images: 0 }, maxOutputTokens: 4000,
    evalWeights: { factuality: 0.45, accuracy: 0.35, actionability: 0.2 }, agent: 'research_analyst',
  },
  content_strategy: {
    label: 'Content-Strategie', requires: ['text'],
    benchmarkWeights: { textOverall: 0.6, creativeWriting: 0.4 }, qualityTolerance: 0.05,
    typicalTokens: { input: 3500, output: 2500, images: 0 }, maxOutputTokens: 4000,
    evalWeights: { creativity: 0.35, styleFidelity: 0.2, voiceFidelity: 0.15, actionability: 0.2, factuality: 0.1 }, agent: 'content_strategist',
  },
  ugc_scriptwriting: {
    label: 'UGC-Skript', requires: ['text'],
    benchmarkWeights: { textOverall: 0.5, creativeWriting: 0.5 }, qualityTolerance: 0.04,
    typicalTokens: { input: 4000, output: 3000, images: 0 }, maxOutputTokens: 5000,
    evalWeights: { voiceFidelity: 0.3, creativity: 0.25, actionability: 0.2, factuality: 0.15, styleFidelity: 0.1 }, agent: 'ugc_scriptwriter',
  },
  cinematic_direction: {
    label: 'Dramaturgie & Shotlist', requires: ['text'],
    benchmarkWeights: { textOverall: 0.6, creativeWriting: 0.4 }, qualityTolerance: 0.05,
    typicalTokens: { input: 4000, output: 3000, images: 0 }, maxOutputTokens: 5000,
    evalWeights: { creativity: 0.3, actionability: 0.35, styleFidelity: 0.25, accuracy: 0.1 }, agent: 'cinematic_director',
  },
  instagram_copywriting: {
    label: 'Instagram-Copy', requires: ['text'],
    benchmarkWeights: { textOverall: 0.5, creativeWriting: 0.5 }, qualityTolerance: 0.06,
    typicalTokens: { input: 2500, output: 800, images: 0 }, maxOutputTokens: 1500,
    evalWeights: { voiceFidelity: 0.4, creativity: 0.3, factuality: 0.2, actionability: 0.1 }, agent: 'instagram_copywriter',
  },
  growth_analysis: {
    label: 'Growth-Analyse', requires: ['text'],
    benchmarkWeights: { textOverall: 1 }, qualityTolerance: 0.03,
    typicalTokens: { input: 5000, output: 2000, images: 0 }, maxOutputTokens: 3000,
    evalWeights: { factuality: 0.45, accuracy: 0.35, actionability: 0.2 }, agent: 'growth_analyst',
  },
  design_system_synthesis: {
    label: 'Design System (Meine Marke)', requires: ['text'],
    benchmarkWeights: { textOverall: 0.8, creativeWriting: 0.2 }, qualityTolerance: 0.03,
    typicalTokens: { input: 7000, output: 3000, images: 0 }, maxOutputTokens: 5000,
    evalWeights: { styleFidelity: 0.45, accuracy: 0.3, actionability: 0.25 }, agent: 'design_director',
  },
  studio_chat: {
    // Etappe 15 (E5): one sentence to the studio → reply + typed proposals; text and attached reference images
    label: 'Studio-Chat (Vorschläge per Satz)', requires: ['text', 'image'],
    benchmarkWeights: { textOverall: 0.7, creativeWriting: 0.2, vision: 0.1 }, qualityTolerance: 0.04,
    typicalTokens: { input: 7000, output: 1500, images: 0 }, maxOutputTokens: 3000,
    evalWeights: { actionability: 0.35, accuracy: 0.25, styleFidelity: 0.2, voiceFidelity: 0.2 }, agent: 'studio_chat',
  },
  edit_direction: {
    // Etappe 16 (E8): dramaturgy on numbered transcript sentences → beats, hook options, overlays; text (images optional later)
    label: 'KI-Dramaturgie (Schnitt aus Transkript)', requires: ['text'],
    benchmarkWeights: { textOverall: 0.6, creativeWriting: 0.4 }, qualityTolerance: 0.04,
    typicalTokens: { input: 6000, output: 2500, images: 0 }, maxOutputTokens: 4000,
    evalWeights: { creativity: 0.3, actionability: 0.3, voiceFidelity: 0.2, factuality: 0.2 }, agent: 'edit_director',
  },
  carousel_writing: {
    // Etappe 18: slide texts + caption draft from one idea (concept, script, reel transcript, her note); text only
    label: 'Karussell (Slides aus einer Idee)', requires: ['text'],
    benchmarkWeights: { textOverall: 0.5, creativeWriting: 0.5 }, qualityTolerance: 0.05,
    typicalTokens: { input: 4500, output: 2500, images: 0 }, maxOutputTokens: 4000,
    evalWeights: { voiceFidelity: 0.3, creativity: 0.25, factuality: 0.25, actionability: 0.2 }, agent: 'carousel_writer',
  },
  story_writing: {
    // Etappe 19: 3–5 Instagram stories from material she has (reel, carousel, concept, photos, note); text only
    label: 'Stories (aus vorhandenem Material)', requires: ['text'],
    benchmarkWeights: { textOverall: 0.5, creativeWriting: 0.5 }, qualityTolerance: 0.06,
    typicalTokens: { input: 3000, output: 1500, images: 0 }, maxOutputTokens: 2500,
    evalWeights: { voiceFidelity: 0.35, creativity: 0.25, factuality: 0.2, actionability: 0.2 }, agent: 'story_writer',
  },
  week_planning: {
    // Etappe 20: „Woche füllen“ – suggestions for empty days from pillars, goals and existing material; text only
    label: 'Wochenplanung (Woche füllen)', requires: ['text'],
    benchmarkWeights: { textOverall: 0.8, creativeWriting: 0.2 }, qualityTolerance: 0.06,
    typicalTokens: { input: 4000, output: 1500, images: 0 }, maxOutputTokens: 2500,
    evalWeights: { actionability: 0.4, accuracy: 0.3, factuality: 0.2, creativity: 0.1 }, agent: 'week_planner',
  },
  content_quality_assurance: {
    label: 'Content-QA (Claims, Style, Voice)', requires: ['text'],
    benchmarkWeights: { textOverall: 1 }, qualityTolerance: 0.02,
    typicalTokens: { input: 5000, output: 1200, images: 0 }, maxOutputTokens: 2500,
    evalWeights: { factuality: 0.5, accuracy: 0.35, styleFidelity: 0.15 }, agent: 'content_qa',
  },
};

/** Use cases the Evaluation Lab can run: every use case has a wired agent (checked by a contract test). */
export const EVAL_USE_CASES = USE_CASES;
/** Which studio input a Model Lab comparison runs on (server schema and UI picker use this one table). */
export const EVAL_INPUT_KIND = {
  reference_image_analysis: 'reference', reference_video_analysis: 'reference', content_strategy: 'brief', ugc_scriptwriting: 'concept',
  style_synthesis: 'style', voice_analysis: 'voice', growth_analysis: 'growth', content_research: 'research',
  content_quality_assurance: 'script', instagram_copywriting: 'script', cinematic_direction: 'script', design_system_synthesis: 'design',
  studio_chat: 'chat', edit_direction: 'story', carousel_writing: 'carousel', story_writing: 'ig_story', week_planning: 'week',
} as const satisfies Record<UseCase, string>;
export type EvalUseCase = (typeof EVAL_USE_CASES)[number];

/** Criteria relevant for a use case (those with a weight), most important first. */
export const criteriaFor = (useCase: UseCase): EvalCriterion[] =>
  (Object.entries(ROUTING_POLICIES[useCase].evalWeights) as [EvalCriterion, number][]).sort((a, b) => b[1] - a[1]).map(([c]) => c);

/**
 * User ratings (1–5 per criterion) → one 0..1 score with the use case's weights.
 * Only rated criteria count (weights renormalised); null when nothing relevant was rated.
 */
export function scoreRatings(useCase: UseCase, ratings: Partial<Record<EvalCriterion, number>>): number | null {
  let sum = 0, weight = 0;
  for (const [c, w] of Object.entries(ROUTING_POLICIES[useCase].evalWeights) as [EvalCriterion, number][]) {
    const r = ratings[c];
    if (r == null) continue;
    sum += w * ((Math.min(5, Math.max(1, r)) - 1) / 4);
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}
