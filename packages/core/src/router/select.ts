import { IMAGE_TOKENS, ROUTING_POLICIES, type RoutingPolicy, type UseCase } from './policies';
import { MODEL_REGISTRY, priceUsd, type GatewayId, type ModelEntry, type Pricing } from './registry';

/** Ratings needed before the user's own evaluations influence routing (no switch after one good result). */
export const MIN_RATINGS_FOR_ROUTING = 5;
/** Arena Elo → 0..1 (clipped). Only relative distances matter. */
const ELO_FLOOR = 1100, ELO_CEIL = 1550;
const norm = (elo: number) => Math.min(1, Math.max(0, (elo - ELO_FLOOR) / (ELO_CEIL - ELO_FLOOR)));

export interface UserModelStats {
  /** Number of rated outputs for this model + use case. */
  n: number;
  /** Policy-weighted mean rating mapped to 0..1. */
  mean: number;
}

export interface RouteRequest {
  useCase: UseCase;
  /** Gateways with a configured key; empty = no routed calls (decision is only computed). */
  availableGateways: GatewayId[];
  /** Confidential data (UGC client projects): only strict-ZDR endpoints of explicitly allowed model families. */
  confidential: boolean;
  confidentialAllowedFamilies: ModelEntry['family'][];
  /** Remaining monthly budget in USD (Infinity when nothing is called). */
  budgetRemainingUsd: number;
  /** Request size; the larger of this and the policy's typical size is used for cost bounds. */
  size?: RequestSize;
  /** User's pinned model for this use case (Evaluation Lab). */
  preferredModelId?: string | null;
  userStats?: Record<string, UserModelStats>;
}

export interface RequestSize {
  inputTokens?: number;
  images?: number;
}

export type RejectCode = 'gateway' | 'modality' | 'structured_output' | 'confidential_family' | 'confidential_zdr' | 'budget';

export interface Candidate {
  id: string;
  label: string;
  quality: number | null;
  missingBenchmarks: string[];
  estCostUsd: number;
  worstCaseCostUsd: number;
  userStats: UserModelStats | null;
}

export interface RoutingDecision {
  useCase: UseCase;
  chosen: Candidate | null;
  /** Ordered safe fallbacks (same eligibility rules). */
  fallbacks: Candidate[];
  rejected: { id: string; code: RejectCode; reason: string }[];
  reasons: string[];
}

/** Typical and worst-case cost of one call. Worst case = 1.5× the (real or typical) input + the policy's output cap. */
export function costBounds(pricing: Pricing, policy: RoutingPolicy, size: RequestSize = {}) {
  const images = Math.max(size.images ?? 0, policy.typicalTokens.images);
  const input = Math.max(size.inputTokens ?? 0, policy.typicalTokens.input) + images * IMAGE_TOKENS;
  return { est: priceUsd(pricing, input, policy.typicalTokens.output), worstCase: priceUsd(pricing, input * 1.5, policy.maxOutputTokens) };
}

function benchmarkQuality(m: ModelEntry, policy: RoutingPolicy): { q: number | null; missing: string[] } {
  let q = 0, known = 0;
  const missing: string[] = [];
  for (const [dim, w] of Object.entries(policy.benchmarkWeights) as [keyof ModelEntry['benchmarks'], number][]) {
    const b = m.benchmarks[dim];
    if (b) {
      q += w * norm(b.score - b.ci); // conservative: lower bound of the confidence interval
      known += w;
    } else missing.push(dim);
  }
  return { q: known > 0 ? q : null, missing };
}

/** Eligibility of one model (step A). Shared by automatic routing and explicit model choice (Evaluation Lab). */
export function checkEligibility(m: ModelEntry, req: RouteRequest): { code: RejectCode; reason: string } | null {
  const policy = ROUTING_POLICIES[req.useCase];
  if (req.availableGateways.length && !req.availableGateways.includes(m.gateway)) return { code: 'gateway', reason: `Gateway ${m.gateway} nicht konfiguriert` };
  const missingInput = policy.requires.filter((x) => !m.gatewayInput.includes(x));
  if (missingInput.length) return { code: 'modality', reason: `Eingabe über Gateway nicht möglich: ${missingInput.join(', ')}` };
  if (!m.structuredOutputs) return { code: 'structured_output', reason: 'keine erzwungenen strukturierten Outputs' };
  if (req.confidential && !req.confidentialAllowedFamilies.includes(m.family))
    return { code: 'confidential_family', reason: `Vertrauliche Daten: Anbieter „${m.family}“ nicht freigegeben` };
  if (req.confidential && !m.privacy.strictZdrProviders.length)
    return { code: 'confidential_zdr', reason: 'Vertrauliche Daten: kein Endpunkt ohne Datenspeicherung' };
  const { worstCase } = costBounds(m.pricing, policy, req.size);
  if (worstCase > req.budgetRemainingUsd) return { code: 'budget', reason: `Restbudget reicht nicht (Worst Case ${worstCase.toFixed(3)} USD)` };
  return null;
}

export function toCandidate(m: ModelEntry, req: RouteRequest): Candidate {
  const policy = ROUTING_POLICIES[req.useCase];
  const { est, worstCase } = costBounds(m.pricing, policy, req.size);
  const bq = benchmarkQuality(m, policy);
  const stats = req.userStats?.[m.id] ?? null;
  let quality = bq.q;
  if (stats && stats.n >= MIN_RATINGS_FOR_ROUTING) {
    const w = Math.min(0.8, stats.n / (stats.n + MIN_RATINGS_FOR_ROUTING));
    quality = (1 - w) * (bq.q ?? 0) + w * stats.mean;
  }
  return { id: m.id, label: m.label, quality, missingBenchmarks: bq.missing, estCostUsd: est, worstCaseCostUsd: worstCase, userStats: stats };
}

/**
 * Deterministic, rule-based routing:
 *  A eligibility (modalities via our gateway, structured output, privacy, budget)
 *  B quality (public benchmarks per use-case weights, blended with the user's ratings once n ≥ MIN)
 *  C among "good enough" models (within the policy's tolerance of the best) the cheapest wins
 *  D remaining eligible models become ordered fallbacks.
 * No randomness, never calls a model.
 */
export function routeModel(req: RouteRequest): RoutingDecision {
  const policy = ROUTING_POLICIES[req.useCase];
  const rejected: RoutingDecision['rejected'] = [];
  const reasons: string[] = [];
  const eligible: Candidate[] = [];
  for (const m of MODEL_REGISTRY) {
    const no = checkEligibility(m, req);
    if (no) rejected.push({ id: m.id, ...no });
    else eligible.push(toCandidate(m, req));
  }

  const byQuality = eligible.sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1) || a.estCostUsd - b.estCostUsd);
  if (!byQuality.length) {
    reasons.push('Kein Modell erfüllt Modalitäten, Datenschutz und Budget für diese Aufgabe.');
    return { useCase: req.useCase, chosen: null, fallbacks: [], rejected, reasons };
  }

  let chosen: Candidate;
  const pinned = req.preferredModelId ? byQuality.find((c) => c.id === req.preferredModelId) : undefined;
  const best = byQuality[0]!;
  if (pinned) {
    chosen = pinned;
    reasons.push(`${pinned.label}: von dir im Evaluation Lab als bevorzugtes Modell festgelegt.`);
  } else {
    if (req.preferredModelId) reasons.push(`Bevorzugtes Modell ${req.preferredModelId} ist hier nicht zulässig (siehe Ausschlüsse) – automatische Wahl.`);
    if (best.quality == null) {
      chosen = best; // all unknown → sort fell through to cost
      reasons.push(`Keine Benchmarks/Bewertungen für diese Aufgabe – günstigstes zulässiges Modell ${chosen.label}.`);
    } else {
      const goodEnough = byQuality.filter((c) => c.quality != null && c.quality >= best.quality! - policy.qualityTolerance);
      chosen = goodEnough.sort((a, b) => a.estCostUsd - b.estCostUsd || (b.quality ?? 0) - (a.quality ?? 0))[0]!;
      const basis = chosen.userStats && chosen.userStats.n >= MIN_RATINGS_FOR_ROUTING ? `deine ${chosen.userStats.n} Bewertungen + Benchmarks` : 'öffentliche Benchmarks (arena.ai)';
      reasons.push(
        chosen.id === best.id
          ? `${chosen.label}: beste Qualität für „${policy.label}“ (${basis}).`
          : `${chosen.label}: innerhalb der Qualitätstoleranz von ${best.label} (${basis}), aber günstiger (≈ ${chosen.estCostUsd.toFixed(4)} statt ${best.estCostUsd.toFixed(4)} USD).`,
      );
    }
  }
  if (chosen.missingBenchmarks.length) reasons.push(`Ohne Benchmark bewertet: ${chosen.missingBenchmarks.join(', ')} (zählt konservativ als 0).`);
  if (req.confidential) reasons.push('Vertraulich: nur Endpunkte ohne Datenspeicherung (ZDR, ohne Safety Retention).');
  const fallbacks = byQuality.filter((c) => c.id !== chosen.id).slice(0, 2);
  return { useCase: req.useCase, chosen, fallbacks, rejected, reasons };
}
