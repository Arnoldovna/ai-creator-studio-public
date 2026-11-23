import 'server-only';
import { createHash } from 'node:crypto';
import {
  checkEligibility, costBounds, findModel, OpenRouterProvider, ProviderError, ROUTING_POLICIES, routeModel, toCandidate, ValidationError,
  type LlmProvider, type ProviderConfig, type RequestSize, type RouteRequest, type RoutingDecision, type StructuredResult, type UseCase,
  type UserModelStats,
} from '@studio/core';
import { z, ZodError } from 'zod';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import { newId, now, PROCESS_ID, read, write, isOrphaned, type AgentRun, type BudgetReservation, type Db, type RoutingLog } from '../store';

export function monthSpendUsd(db: Db, ref = new Date()): number {
  const month = ref.toISOString().slice(0, 7);
  return db.agentRuns
    .filter((r) => r.provider !== 'mock' && r.createdAt.startsWith(month))
    .reduce((s, r) => s + (r.costEstimateUsd ?? 0), 0);
}

/** Worst-case cost of paid calls in flight, including orphaned reservations from a crashed process. */
export const reservedUsdOf = (db: Db) => db.budgetReservations.reduce((s, r) => s + r.amountUsd, 0);

/** One budget rule for runAgent, the status page and the banner. */
export function budgetOf(config: Pick<ProviderConfig, 'active' | 'monthlyBudgetUsd' | 'budgetWarnFraction'>, spentUsd: number, reservedUsd: number) {
  const committed = spentUsd + reservedUsd;
  const limit = config.monthlyBudgetUsd;
  const fraction = limit > 0 ? committed / limit : 0;
  return {
    spentUsd, reservedUsd, limitUsd: limit, fraction,
    remainingUsd: config.active === 'mock' ? Infinity : Math.max(0, limit - committed),
    warn: limit > 0 && fraction >= config.budgetWarnFraction,
    blocked: config.active !== 'mock' && limit > 0 && fraction >= 1,
  };
}

/**
 * Checks the budget and reserves `amountUsd` in one serialized write, so parallel calls cannot
 * overspend. Earlier attempts of the same call are already saved (see `settle` in runAgent).
 */
async function reserveBudget(config: ProviderConfig, amountUsd: number, purpose: string) {
  return write((db) => {
    const budget = budgetOf(config, monthSpendUsd(db), reservedUsdOf(db));
    if (amountUsd > budget.remainingUsd) return { ok: false as const, remainingUsd: budget.remainingUsd };
    const r: BudgetReservation = { id: newId(), amountUsd, purpose: purpose.slice(0, 200), processId: PROCESS_ID, createdAt: now() };
    db.budgetReservations.push(r);
    return { ok: true as const, id: r.id };
  });
}

export const ReleaseReservationInput = z.object({ chargedUsd: z.number().finite().min(0).max(10_000) });

/**
 * The user releases a reservation left by a crashed process after checking the provider's bill,
 * and states what was actually charged (0 if nothing). That amount is booked as spend, so the
 * monthly budget stays correct. Only orphaned reservations can be released.
 */
export async function releaseOrphanedReservation(id: string, raw: unknown) {
  const { chargedUsd } = ReleaseReservationInput.parse(raw);
  return write((db) => {
    const r = db.budgetReservations.find((x) => x.id === id);
    if (!r) throw new HttpError(404, 'Reservierung nicht gefunden');
    if (!isOrphaned(r)) throw new HttpError(409, 'Diese Reservierung gehört zu einem laufenden Aufruf.');
    db.budgetReservations = db.budgetReservations.filter((x) => x.id !== id);
    if (chargedUsd > 0)
      db.agentRuns.push({
        id: newId(), agent: 'abgebrochener-aufruf', promptVersion: '-', provider: 'manual', model: r.purpose, projectId: null, inputHash: '',
        status: 'failed', error: 'Lauf beim Absturz unterbrochen; Kosten laut Abrechnung von der Nutzerin eingetragen', costEstimateUsd: chargedUsd,
        costSource: 'reported', usage: null, createdAt: now(),
      });
    return { released: id, reservedUsd: r.amountUsd, chargedUsd };
  });
}

/** Per model: number of ratings and mean policy-weighted score (0..1) for one use case. */
export function userStatsFor(db: Db, useCase: UseCase): Record<string, UserModelStats> {
  const acc: Record<string, { n: number; sum: number }> = {};
  for (const r of db.evalRatings) {
    if (r.useCase !== useCase || r.mock) continue; // mock outputs never steer real routing
    const a = (acc[r.modelId] ??= { n: 0, sum: 0 });
    a.n++;
    a.sum += r.score;
  }
  return Object.fromEntries(Object.entries(acc).map(([id, a]) => [id, { n: a.n, mean: a.sum / a.n }]));
}

/** The routing request for one use case – shared by runAgent and the Settings preview so both always agree. */
export function routeRequestFor(db: Db, config: ProviderConfig, useCase: UseCase, opts: { confidential: boolean; size?: RequestSize; spentUsd?: number }): RouteRequest {
  const routed = config.active === 'openrouter';
  return {
    useCase, confidential: opts.confidential, size: opts.size,
    availableGateways: routed ? ['openrouter'] : [],
    confidentialAllowedFamilies: config.confidentialAllowedFamilies,
    budgetRemainingUsd: routed ? budgetOf(config, opts.spentUsd ?? monthSpendUsd(db), reservedUsdOf(db)).remainingUsd : Infinity,
    preferredModelId: db.routerPreferences[useCase] ?? null,
    userStats: userStatsFor(db, useCase),
  };
}

/**
 * Why a confidential request (UGC client data) cannot reach any model right now, or null when it can. Mock mode sends nothing, so it never blocks. Shared by runAgent's refusal, the
 * „Was an die KI geht“ preview and Settings, so all three say the same thing.
 */
export function confidentialBlock(db: Db, env: { provider: Pick<LlmProvider, 'name' | 'family'>; config: ProviderConfig }, useCase: UseCase): string | null {
  const { provider: fixed, config } = env;
  if (config.active === 'mock') return null;
  if (config.active !== 'openrouter')
    return fixed.family && config.confidentialAllowedFamilies.includes(fixed.family) ? null : `${fixed.name} ist nicht in CONFIDENTIAL_ALLOWED_FAMILIES freigegeben`;
  if (!config.confidentialAllowedFamilies.length) return 'CONFIDENTIAL_ALLOWED_FAMILIES ist leer';
  const d = routeModel(routeRequestFor(db, config, useCase, { confidential: true }));
  return d.chosen ? null : `kein zulässiges Modell für „${ROUTING_POLICIES[useCase].label}“ (${d.rejected[0]?.reason ?? d.reasons[0] ?? 'keine Kandidaten'})`;
}

export const confidentialRefusal = (detail: string) => `Vertrauliche Kundendaten: ${detail} – nichts wurde gesendet.`;

/**
 * Strict privacy routing only for UGC client data (Etappe 10, User decision): her own strategy/profile context
 * may go to every router candidate. A caller's `confidential: true` without `clientData` no longer narrows routing.
 */
export const isConfidential = (meta: Pick<AgentMeta, 'clientData'>) => meta.clientData === true;

export interface AgentMeta {
  agent: string;
  useCase: UseCase;
  projectId: string | null;
  input: unknown;
  /** Legacy flag (before Etappe 10 also set for personal strategy/profile context); routing uses `clientData` only. */
  confidential?: boolean;
  /** The request carries UGC client data → strict privacy routing for every outbound call; the Model Lab refuses these. */
  clientData?: boolean;
  /** Approximate prompt size (characters) and image count – sizes the worst-case cost. */
  inputChars?: number;
  images?: number;
  styleVersionId?: string | null;
  voiceVersionId?: string | null;
  /** Evaluation Lab: run exactly this registry model (no automatic routing, no fallback). */
  forceModelId?: string;
  /** Etappe 9 lineage: strategy/profile versions in the request and sha256 of their AI text (lineage only). */
  strategyVersionId?: string | null;
  profileVersionId?: string | null;
  aiContextHash?: string | null;
}

/** Request size used for every cost bound (prompt ≈ chars/3 tokens, plus images); without `inputChars` the serialized input counts. */
export function requestSize(meta: Pick<AgentMeta, 'inputChars' | 'images' | 'input'>, inputJson?: string): RequestSize {
  const chars = meta.inputChars ?? (inputJson ?? JSON.stringify(meta.input) ?? '').length;
  return { inputTokens: chars ? Math.ceil(chars / 3) : undefined, images: meta.images };
}

/**
 * One explicitly chosen model (Evaluation Lab): checks mode, existence and eligibility and returns
 * its candidate with cost bounds. Comparisons run via OpenRouter or free in mock mode only.
 */
export function forcedCandidate(modelId: string, config: ProviderConfig, req: RouteRequest) {
  if (config.active !== 'openrouter' && config.active !== 'mock')
    throw new HttpError(409, 'Modellvergleiche laufen über OpenRouter (AI_PROVIDER=openrouter) oder kostenlos im Mock-Modus.');
  const m = findModel(modelId);
  if (!m) throw new HttpError(404, `Unbekanntes Modell ${modelId}`);
  const no = checkEligibility(m, req);
  if (no) throw new HttpError(no.code === 'budget' ? 402 : 409, `${m.label} ist für „${ROUTING_POLICIES[req.useCase].label}“ nicht zulässig: ${no.reason}`);
  return toCandidate(m, req);
}

export type AgentResult<T> = StructuredResult<T> & { promptVersion: string };
/** A fully prepared agent call: routing metadata + the call itself. Shared by the normal flow and the Evaluation Lab. */
export interface AgentTask<T> {
  meta: AgentMeta;
  run: (provider: LlmProvider) => Promise<AgentResult<T>>;
}
interface Attempt { provider: LlmProvider; worstCaseUsd: number }

/** Schema/consistency failures inside an agent are invalid MODEL output (502, billed), not user input (400). */
function asProviderError(err: unknown, agent: string): unknown {
  if (err instanceof ZodError || err instanceof ValidationError) return new ProviderError(`Ungültige Modellausgabe (${agent}): ${err.message.slice(0, 300)}`, true, true);
  return err;
}

/** Build the ordered list of calls to try; throws with a clear status when nothing may be called. */
function planAttempts(meta: AgentMeta, config: ProviderConfig, fixed: LlmProvider, decision: RoutingDecision, req: RouteRequest): Attempt[] {
  const policy = ROUTING_POLICIES[meta.useCase];
  const mode = config.active === 'openrouter' ? 'routed' : config.active === 'mock' ? 'mock' : 'direct';
  const openRouter = (id: string, worstCaseUsd: number): Attempt => ({
    provider: new OpenRouterProvider(config.openrouterApiKey!, findModel(id)!, { confidential: req.confidential, maxOutputTokens: policy.maxOutputTokens, worstCaseUsd }),
    worstCaseUsd,
  });
  const direct = (): Attempt => ({ provider: fixed, worstCaseUsd: fixed.pricing ? costBounds(fixed.pricing, policy, req.size).worstCase : 0 });

  if (meta.forceModelId) {
    const c = forcedCandidate(meta.forceModelId, config, req);
    return mode === 'mock' ? [direct()] : [openRouter(c.id, c.worstCaseCostUsd)];
  }
  if (mode === 'mock') return [direct()];
  if (mode === 'direct') {
    // Same privacy rule as the router: confidential data only to explicitly allowed families.
    if (req.confidential && !(fixed.family && config.confidentialAllowedFamilies.includes(fixed.family)))
      throw new HttpError(409, confidentialRefusal(`${fixed.name} ist nicht in CONFIDENTIAL_ALLOWED_FAMILIES freigegeben`));
    return [direct()];
  }
  if (!decision.chosen) {
    const budgetOnly = decision.rejected.some((r) => r.code === 'budget');
    const details = `${decision.reasons.join(' ')} ${decision.rejected.map((r) => `${r.id}: ${r.reason}`).join('; ')}`;
    throw new HttpError(budgetOnly ? 402 : 409, `${budgetOnly ? 'Budget-Sperre' : 'Kein geeignetes Modell'}: ${details}`);
  }
  return [decision.chosen, ...decision.fallbacks].map((c) => openRouter(c.id, c.worstCaseCostUsd));
}

/**
 * Executes an agent: plans the calls (router choice + safe fallbacks, or the direct/mock provider),
 * applies confidential routing for client data, reserves each attempt's worst-case cost
 * against the monthly budget (hard stop, also for parallel calls), and records every attempt with
 * routing reasons, cost source and latency in one write.
 */
export async function runAgent<T>(
  meta: AgentMeta,
  fn: (provider: LlmProvider) => Promise<AgentResult<T>>,
): Promise<{ result: AgentResult<T>; run: AgentRun; mock: boolean; routing: RoutingDecision }> {
  const { provider: fixed, config } = providerFromEnv();
  const confidential = isConfidential(meta);
  const inputJson = JSON.stringify(meta.input);
  const size = requestSize(meta, inputJson);
  const req = await read((db) => routeRequestFor(db, config, meta.useCase, { confidential, size }));
  if (meta.forceModelId) req.preferredModelId = meta.forceModelId;
  const decision = routeModel(req);
  const attempts = planAttempts(meta, config, fixed, decision, req);

  const mode: RoutingLog['mode'] = config.active === 'openrouter' ? 'routed' : config.active === 'mock' ? 'mock' : 'direct';
  const inputHash = createHash('sha256').update(inputJson).digest('hex').slice(0, 32);
  const runs: AgentRun[] = [];
  const recordRun = (provider: LlmProvider, attempt: number, t0: number, fields: Pick<AgentRun, 'promptVersion' | 'status' | 'error' | 'costEstimateUsd' | 'usage' | 'costSource' | 'model'>): AgentRun => {
    const run: AgentRun = {
      id: newId(), agent: meta.agent, provider: provider.name, projectId: meta.projectId, inputHash, createdAt: now(),
      useCase: meta.useCase, latencyMs: Date.now() - t0, styleVersionId: meta.styleVersionId ?? null, voiceVersionId: meta.voiceVersionId ?? null,
      ...(meta.strategyVersionId !== undefined ? { strategyVersionId: meta.strategyVersionId } : {}),
      ...(meta.profileVersionId !== undefined ? { profileVersionId: meta.profileVersionId } : {}),
      ...(meta.aiContextHash !== undefined ? { aiContextHash: meta.aiContextHash } : {}),
      routing: {
        mode, attempt, confidential, reasons: decision.reasons, fallbacks: decision.fallbacks.map((f) => f.id),
        rejected: decision.rejected.map(({ id, code }) => ({ id, code })),
      },
      ...fields,
    };
    runs.push(run);
    return run;
  };
  // Saves the runs recorded so far and releases the attempt's reservation in ONE write: the reserved
  // amount stays counted until the cost that replaces it is stored (no gap for parallel calls).
  let saved = 0;
  const settle = async (reservationId: string | null) => {
    const pending = runs.slice(saved);
    if (!reservationId && !pending.length) return;
    await write((db) => {
      db.agentRuns.push(...pending);
      if (reservationId) db.budgetReservations = db.budgetReservations.filter((r) => r.id !== reservationId);
    });
    saved += pending.length;
  };

  let lastError: unknown = null;
  try {
    for (const [i, { provider, worstCaseUsd }] of attempts.entries()) {
      let reservationId: string | null = null;
      if (provider.name !== 'mock') {
        const r = await reserveBudget(config, worstCaseUsd, `${meta.agent} · ${provider.model}`);
        if (!r.ok) {
          lastError = new HttpError(402, `Budget-Sperre: ${provider.model} könnte bis ${worstCaseUsd.toFixed(3)} USD kosten, verfügbar ${r.remainingUsd.toFixed(3)} USD.`);
          break;
        }
        reservationId = r.id;
      }
      const t0 = Date.now();
      // Tracks whether the agent reached the model: errors before that are the caller's input, not model output.
      let called = false;
      const tracked: LlmProvider = Object.assign(Object.create(provider) as LlmProvider, {
        generate: ((req) => {
          called = true;
          return provider.generate(req);
        }) as LlmProvider['generate'],
      });
      try {
        const result = await fn(tracked);
        const run = recordRun(provider, i, t0, {
          model: result.model, promptVersion: result.promptVersion, status: 'succeeded', error: null, usage: result.usage,
          costEstimateUsd: result.costEstimateUsd, costSource: result.costSource ?? (provider.name === 'mock' ? 'none' : 'tokens'),
        });
        return { result, run, mock: provider.name === 'mock', routing: decision };
      } catch (err) {
        if (!called) throw err; // input/precondition error (e.g. ValidationError → 400): no attempt, no cost, no fallback
        const e = asProviderError(err, meta.agent);
        // A billed failure without usage data (e.g. schema mismatch) counts with its conservative upper bound.
        const billed = e instanceof ProviderError && e.billed && provider.name !== 'mock';
        recordRun(provider, i, t0, {
          model: provider.model, promptVersion: 'unknown', status: 'failed', error: (e as Error).message.slice(0, 500), usage: null,
          costEstimateUsd: billed ? worstCaseUsd : 0, costSource: billed ? 'worst_case' : 'none',
        });
        lastError = e;
        if (!(e instanceof ProviderError && e.retryable)) break;
      } finally {
        // On a failed write the reservation stays (conservative) and the run is retried by the final settle.
        if (reservationId) await settle(reservationId).catch((e) => console.error('Lauf/Reservierung konnte nicht gespeichert werden', e));
      }
    }
    throw lastError;
  } finally {
    await settle(null);
  }
}
