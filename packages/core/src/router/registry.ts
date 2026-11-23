/**
 * Central model registry. Every value here was read from a public source on `verifiedAt`;
 * nothing is estimated. Unknown values are `null` and treated conservatively by the router.
 *
 * Three capability layers are kept apart on purpose:
 *  - `model`   – what the model itself accepts (OpenRouter `architecture.input_modalities`)
 *  - `gateway` – what *our* integration path sends to it (OpenRouter chat API via AI SDK)
 *  - `privacy` – which upstream endpoints satisfy our data rules
 * e.g. a model with native video input is still only reachable with keyframe images here.
 *
 * Sources (read 2026-11-15):
 *  - models/prices/modalities/parameters: GET https://openrouter.ai/api/v1/models
 *  - ZDR endpoints (+ safety_retention flag): GET https://openrouter.ai/api/v1/endpoints/zdr
 *  - benchmarks: arena.ai Text Arena overall (page dated 2026-11-11), Vision Arena overall (2026-11-08)
 */

export type Modality = 'text' | 'image' | 'video' | 'audio' | 'file';
export type GatewayId = 'openrouter';

export interface BenchmarkScore {
  /** Arena-style Elo as shown on the leaderboard. */
  score: number;
  /** ± confidence interval shown next to the score; the router uses the lower bound (score − ci). */
  ci: number;
  source: string;
  date: string;
  preliminary?: boolean;
}

export interface Pricing {
  /** USD per 1M tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
}
/** The one place where token counts become money. */
export const priceUsd = (p: Pricing, inputTokens: number, outputTokens: number) => (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1e6;

export const MODEL_FAMILIES = ['anthropic', 'openai', 'google', 'meta', 'deepseek', 'qwen'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export interface ModelEntry {
  id: string;
  family: ModelFamily;
  label: string;
  gateway: GatewayId;
  model: { inputModalities: Modality[]; contextTokens: number };
  /** What our gateway path delivers. Video is sent as extracted keyframes (images), never as a video file. */
  gatewayInput: Modality[];
  /** `structured_outputs` listed in OpenRouter `supported_parameters` (JSON-schema enforcement, per endpoint). */
  structuredOutputs: boolean;
  /** OpenRouter list price. */
  pricing: Pricing;
  benchmarks: { textOverall: BenchmarkScore | null; vision: BenchmarkScore | null; creativeWriting: BenchmarkScore | null };
  privacy: {
    /** OpenRouter provider slugs with zero-data-retention endpoints WITHOUT safety retention that support structured outputs. */
    strictZdrProviders: string[];
    note: string;
  };
  limitations: string[];
  verifiedAt: string;
}

const TEXT = 'arena.ai/leaderboard/chat/text';
const VISION = 'arena.ai/leaderboard/vision';
const t = (score: number, ci: number, preliminary = false): BenchmarkScore => ({ score, ci, source: TEXT, date: '2026-11-11', preliminary });
const v = (score: number, ci: number, preliminary = false): BenchmarkScore => ({ score, ci, source: VISION, date: '2026-11-08', preliminary });
const VERIFIED = '2026-11-15';
const IMG: Modality[] = ['text', 'image'];

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'anthropic/claude-opus-5.5', family: 'anthropic', label: 'Claude Opus 5.5', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'file'], contextTokens: 1_000_000 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 4, outputPerMTok: 20 },
    benchmarks: { textOverall: t(1507, 6), vision: v(1295, 10), creativeWriting: null },
    privacy: { strictZdrProviders: ['google-vertex'], note: 'Strikte ZDR-Endpunkte über Google Vertex.' },
    limitations: ['Teuerstes Modell im Pool – nur wenn Qualität den Aufpreis rechtfertigt.'], verifiedAt: VERIFIED,
  },
  {
    id: 'anthropic/claude-sonnet-5.5', family: 'anthropic', label: 'Claude Sonnet 5.5', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'file'], contextTokens: 1_000_000 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    benchmarks: { textOverall: t(1473, 6), vision: v(1263, 10), creativeWriting: null },
    privacy: { strictZdrProviders: ['google-vertex'], note: 'Strikte ZDR-Endpunkte über Google Vertex.' },
    limitations: [], verifiedAt: VERIFIED,
  },
  {
    id: 'anthropic/claude-haiku-5.5', family: 'anthropic', label: 'Claude Haiku 5.5', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'file'], contextTokens: 1_000_000 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    benchmarks: { textOverall: t(1421, 6), vision: null, creativeWriting: null },
    privacy: { strictZdrProviders: ['google-vertex'], note: 'Strikte ZDR-Endpunkte über Google Vertex.' },
    limitations: ['Kein Vision-Arena-Eintrag gefunden – für Bildaufgaben nur mit eigener Bewertung.'], verifiedAt: VERIFIED,
  },
  {
    id: 'openai/gpt-6.1-sol', family: 'openai', label: 'GPT-6.1 Sol', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'file'], contextTokens: 1_050_000 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    benchmarks: { textOverall: t(1481, 6), vision: v(1293, 11), creativeWriting: null },
    privacy: { strictZdrProviders: ['azure'], note: 'Strikte ZDR-Endpunkte über Azure.' },
    limitations: ['Arena-Werte gelten für die Variante „Max“ (höchster Reasoning-Aufwand).'], verifiedAt: VERIFIED,
  },
  {
    id: 'openai/gpt-6-luna', family: 'openai', label: 'GPT-6 Luna', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'file'], contextTokens: 1_050_000 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    benchmarks: { textOverall: t(1441, 4), vision: v(1235, 9), creativeWriting: null },
    privacy: { strictZdrProviders: ['azure'], note: 'Strikte ZDR-Endpunkte über Azure.' },
    limitations: ['Arena-Werte gelten für die Variante „Max“.'], verifiedAt: VERIFIED,
  },
  {
    id: 'google/gemini-3.8-flash', family: 'google', label: 'Gemini 3.8 Flash', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'video', 'file', 'audio'], contextTokens: 1_048_576 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 0.825, outputPerMTok: 4.125 },
    benchmarks: { textOverall: t(1497, 4, true), vision: v(1293, 8, true), creativeWriting: null },
    privacy: { strictZdrProviders: [], note: 'Nur Endpunkte mit Safety Retention (bis zu 90 Tage für markierte Prompts) – nicht für vertrauliche Kundendaten.' },
    limitations: ['Arena-Werte vorläufig.', 'Native Video-Eingabe wird über unseren Gateway-Pfad nicht genutzt (Keyframes).'], verifiedAt: VERIFIED,
  },
  {
    id: 'google/gemini-4-argon', family: 'google', label: 'Gemini 4 Argon', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'video', 'file', 'audio'], contextTokens: 1_048_576 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    benchmarks: { textOverall: t(1522, 5), vision: null, creativeWriting: null },
    privacy: { strictZdrProviders: [], note: 'Nur Endpunkte mit Safety Retention – nicht für vertrauliche Kundendaten.' },
    limitations: ['Kein Vision-Arena-Eintrag gefunden.'], verifiedAt: VERIFIED,
  },
  {
    id: 'meta/muse-spark-1.3', family: 'meta', label: 'Meta Muse Spark 1.3', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'video', 'file'], contextTokens: 1_048_576 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 1.25, outputPerMTok: 4.25 },
    benchmarks: { textOverall: t(1497, 5), vision: v(1291, 8), creativeWriting: null },
    privacy: { strictZdrProviders: [], note: 'Nur über Google Vertex mit Safety Retention – nicht für vertrauliche Kundendaten.' },
    limitations: ['Arena-Werte gelten für die Variante „Max“ (höchster Reasoning-Aufwand).', 'Native Video-Eingabe wird über unseren Gateway-Pfad nicht genutzt (Keyframes).'],
    verifiedAt: VERIFIED,
  },
  {
    id: 'meta/muse-wonder', family: 'meta', label: 'Meta Muse Wonder', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'video', 'file', 'audio'], contextTokens: 1_048_576 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 4, outputPerMTok: 20 },
    benchmarks: { textOverall: t(1511, 6), vision: null, creativeWriting: null },
    privacy: { strictZdrProviders: [], note: 'Nur über Google Vertex mit Safety Retention – nicht für vertrauliche Kundendaten.' },
    limitations: ['Kein Vision-Arena-Eintrag gefunden.', 'Arena-Wert gilt für „Max“.'], verifiedAt: VERIFIED,
  },
  {
    id: 'meta/muse-ember', family: 'meta', label: 'Meta Muse Ember', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image', 'video', 'file', 'audio'], contextTokens: 1_048_576 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    benchmarks: { textOverall: null, vision: null, creativeWriting: null },
    privacy: { strictZdrProviders: [], note: 'Nur über Google Vertex mit Safety Retention – nicht für vertrauliche Kundendaten.' },
    limitations: ['Neu (2026-11-09), noch kein Arena-Eintrag – nur über eigene Bewertungen im Evaluation Lab einstufbar.'], verifiedAt: VERIFIED,
  },
  {
    id: 'meta-llama/llama-4-maverick', family: 'meta', label: 'Llama 4 Maverick', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image'], contextTokens: 524_288 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 0.35, outputPerMTok: 1 },
    benchmarks: { textOverall: null, vision: v(1145, 9), creativeWriting: null },
    privacy: { strictZdrProviders: ['parasail'], note: 'Strikte ZDR über Parasail (fp8).' },
    limitations: ['Ältere Meta-Generation (2025); nicht unter den ersten 151 der Text-Arena.', 'Meta-Herkunft bedeutet keinen Instagram-Vorteil.'], verifiedAt: VERIFIED,
  },
  {
    id: 'deepseek/deepseek-v4.1-flash', family: 'deepseek', label: 'DeepSeek V4.1 Flash', gateway: 'openrouter',
    model: { inputModalities: ['text', 'image'], contextTokens: 1_048_576 }, gatewayInput: IMG, structuredOutputs: true,
    pricing: { inputPerMTok: 0.051, outputPerMTok: 0.203 },
    benchmarks: { textOverall: t(1475, 6), vision: v(1263, 10), creativeWriting: null },
    privacy: { strictZdrProviders: ['fireworks', 'together', 'deepinfra', 'parasail'], note: 'Viele Drittanbieter-Endpunkte; Auswahl über ZDR-Liste.' },
    limitations: ['Arena-Werte gelten für „DeepSeek-V4.1-Flash-20260910 (Max)“.'], verifiedAt: VERIFIED,
  },
];

export const findModel = (id: string) => MODEL_REGISTRY.find((m) => m.id === id) ?? null;
