import 'server-only';
import {
  assertVoiceSamples, criteriaFor, EVAL_CRITERIA, EVAL_USE_CASES, findModel, MIN_RATINGS_FOR_ROUTING, MODEL_REGISTRY, ROUTING_POLICIES, routeModel,
  scoreRatings, toCandidate, type UseCase,
} from '@studio/core';
import { z } from 'zod';
import { providerFromEnv } from '../env';
import { HttpError } from '../errors';
import { must, newId, now, read, write, type EvalRun } from '../store';
import { forcedCandidate, monthSpendUsd, requestSize, routeRequestFor, runAgent, type AgentTask } from './agentRuns';
import { prepareScriptTask, prepareStrategyTask } from './content';
import { prepareGrowthTask, prepareResearchTask } from './insights';
import { prepareReferenceTask } from './references';
import { generationBlocker, prepareScriptAgentTask, SCRIPT_AGENT_USE_CASE } from './scriptAgents';
import { prepareStyleSynthesisTask, prepareVoiceAnalysisTask } from './style';
import { prepareDesignTask } from './designSystem';
import { prepareChatEvalTask } from './chat';
import { prepareCarouselEvalTask } from './carousels';
import { prepareStoryEvalTask } from './editDirection';
import { prepareStoryWriterEvalTask } from './stories';
import { prepareWeekEvalTask } from './board';

type ScriptKind = keyof typeof SCRIPT_AGENT_USE_CASE;
const SCRIPT_KINDS = Object.keys(SCRIPT_AGENT_USE_CASE) as ScriptKind[];
const SCRIPT_KIND = Object.fromEntries(SCRIPT_KINDS.map((k) => [SCRIPT_AGENT_USE_CASE[k], k])) as Record<string, ScriptKind | undefined>;

/** Keep the lab bounded: outputs live in the main DB file. */
const MAX_STORED_RUNS = 100;

/** Each use case carries its own input shape; kinds match EVAL_INPUT_KIND (checked in the contract test). */
const Target = z.discriminatedUnion('useCase', [
  z.object({ useCase: z.literal('reference_image_analysis'), input: z.object({ kind: z.literal('reference'), referenceId: z.string().min(1) }) }),
  z.object({ useCase: z.literal('reference_video_analysis'), input: z.object({ kind: z.literal('reference'), referenceId: z.string().min(1) }) }),
  z.object({ useCase: z.literal('content_strategy'), input: z.object({ kind: z.literal('brief'), brief: z.unknown() }) }),
  z.object({ useCase: z.literal('ugc_scriptwriting'), input: z.object({ kind: z.literal('concept'), conceptId: z.string().min(1) }) }),
  // Current form / own texts / personal metrics – exactly what the normal button would send.
  z.object({ useCase: z.literal('style_synthesis'), input: z.object({ kind: z.literal('style') }) }),
  z.object({ useCase: z.literal('voice_analysis'), input: z.object({ kind: z.literal('voice') }) }),
  z.object({ useCase: z.literal('growth_analysis'), input: z.object({ kind: z.literal('growth') }) }),
  z.object({ useCase: z.literal('design_system_synthesis'), input: z.object({ kind: z.literal('design') }) }),
  // Etappe 15: her latest chat message (personal threads) with its history, on the current page state
  z.object({ useCase: z.literal('studio_chat'), input: z.object({ kind: z.literal('chat') }) }),
  // Etappe 16: the draft of her latest dramaturgy proposal, with the same inputs (nothing is stored or applied)
  z.object({ useCase: z.literal('edit_direction'), input: z.object({ kind: z.literal('story') }) }),
  // Etappe 18: the source and settings of her latest written carousel (nothing is stored or changed)
  z.object({ useCase: z.literal('carousel_writing'), input: z.object({ kind: z.literal('carousel') }) }),
  // Etappe 19: the source of her latest generated stories; Etappe 20: the current week (nothing is stored or changed)
  z.object({ useCase: z.literal('story_writing'), input: z.object({ kind: z.literal('ig_story') }) }),
  z.object({ useCase: z.literal('week_planning'), input: z.object({ kind: z.literal('week') }) }),
  // The sources of a stored research report (the user's own paste) are re-analysed.
  z.object({ useCase: z.literal('content_research'), input: z.object({ kind: z.literal('research'), reportId: z.string().min(1) }) }),
  ...Object.values(SCRIPT_AGENT_USE_CASE).map((useCase) =>
    z.object({ useCase: z.literal(useCase), input: z.object({ kind: z.literal('script'), scriptId: z.string().min(1) }) })),
]);
const Models = z.array(z.string()).min(2, 'Mindestens 2 Modelle').max(3, 'Höchstens 3 Modelle').refine((ids) => new Set(ids).size === ids.length, 'Modelle doppelt');
const QuoteRequest = z.intersection(Target, z.object({ modelIds: Models }));
const RunRequest = z.intersection(QuoteRequest, z.object({ approvedMaxUsd: z.number().min(0).default(0) }));
const RatingRequest = z.object({
  modelId: z.string().min(1),
  ratings: z.partialRecord(z.enum(EVAL_CRITERIA), z.number().int().min(1).max(5)),
  correction: z.string().max(4000).default(''),
});

/** Prepare the exact agent task the normal flow would run – without side effects on studio data. */
type Prepared = { task: AgentTask<unknown>; input: EvalRun['input']; projectIds?: string[]; publicationIds?: string[] };
async function prepareTask(t: z.infer<typeof Target>): Promise<Prepared> {
  const { input } = t;
  if (input.kind === 'reference') {
    // Check image vs video before preparing (FFmpeg work).
    const kind = await read((db) => must(db.references.find((r) => r.id === input.referenceId), 'Referenz').kind);
    const expected = kind === 'video' ? 'reference_video_analysis' : 'reference_image_analysis';
    if (expected !== t.useCase) throw new HttpError(400, `Diese Referenz ist ein ${kind === 'video' ? 'Video' : 'Bild'} – Aufgabe „${ROUTING_POLICIES[expected].label}“ wählen.`);
    const { ref, task } = await prepareReferenceTask(input.referenceId, { persistKeyframes: false });
    return { task, input: { kind: 'reference', referenceId: ref.id, label: ref.name } };
  }
  switch (input.kind) {
    case 'brief': {
      const { brief, task } = await prepareStrategyTask(input.brief);
      return { task, input: { kind: 'brief', brief, label: brief.topic }, projectIds: [brief.projectId] };
    }
    case 'concept': {
      const { concept, task } = await prepareScriptTask(input.conceptId);
      return { task, input: { kind: 'concept', conceptId: concept.id, label: concept.body.title }, projectIds: [concept.projectId] };
    }
    case 'script': {
      const kind = SCRIPT_KIND[t.useCase];
      if (!kind) throw new HttpError(400, 'Diese Aufgabe arbeitet nicht auf einem Skript.');
      const { script, task } = await prepareScriptAgentTask(kind, input.scriptId);
      return { task, input: { kind: 'script', scriptId: script.id, label: `${script.body.selectedHook.slice(0, 60)} (v${script.version})` }, projectIds: [script.projectId] };
    }
    case 'research': {
      const rep = await read((db) => must(db.researchReports.find((r) => r.id === input.reportId), 'Recherche'));
      const { task } = await prepareResearchTask({ projectId: rep.projectId, topic: rep.topic, audience: rep.audience ?? '', sources: rep.sources });
      return { task, input: { kind: 'research', reportId: rep.id, label: rep.audience == null ? `${rep.topic} (ohne Zielgruppe)` : rep.topic }, projectIds: [rep.projectId] };
    }
    case 'style':
      return { task: (await prepareStyleSynthesisTask({})).task, input: { kind: 'style', label: 'Aktuelles Style-Formular + bestätigte Beobachtungen' } };
    case 'voice': {
      const { input: v, task } = await prepareVoiceAnalysisTask({ samples: [] });
      assertVoiceSamples(v.samples); // like the normal button: too little own text is a 400, not a stored run of errors
      return { task, input: { kind: 'voice', label: 'Gespeicherte eigene Texte' } };
    }
    case 'growth': {
      const { task, projectIds, publicationIds } = await prepareGrowthTask({ includeClient: false });
      return { task, input: { kind: 'growth', label: 'Eigene Messwerte (ohne Kundenprojekte)' }, projectIds, publicationIds };
    }
    case 'design':
      return { task: (await prepareDesignTask()).task, input: { kind: 'design', label: 'Bestätigte Beobachtungen + Style Bible + Meine Marke' } };
    case 'chat': {
      const { task, label, projectIds } = await prepareChatEvalTask();
      return { task: task as AgentTask<unknown>, input: { kind: 'chat', label }, projectIds };
    }
    case 'story': {
      const { task, label, projectIds } = await prepareStoryEvalTask();
      return { task: task as AgentTask<unknown>, input: { kind: 'story', label }, projectIds };
    }
    case 'carousel': {
      const { task, label, projectIds } = await prepareCarouselEvalTask();
      return { task: task as AgentTask<unknown>, input: { kind: 'carousel', label }, projectIds };
    }
    case 'ig_story': {
      const { task, label, projectIds } = await prepareStoryWriterEvalTask();
      return { task: task as AgentTask<unknown>, input: { kind: 'ig_story', label }, projectIds };
    }
    case 'week': {
      const { task, label, projectIds } = await prepareWeekEvalTask();
      return { task: task as AgentTask<unknown>, input: { kind: 'week', label }, projectIds };
    }
  }
}

/**
 * Shared by quote and run: same task, same size, same eligibility and cost bounds as runAgent.
 * Throws before anything is called if a model, the mode, the per-run cap or the budget does not allow it.
 */
async function planEval(raw: unknown) {
  const req = QuoteRequest.parse(raw);
  const { config } = providerFromEnv();
  const mock = config.active === 'mock';
  const { task, input, projectIds = [], publicationIds = [] } = await prepareTask(req);
  if (task.meta.clientData === true) throw new HttpError(409, 'Vergleiche mit vertraulichen Kundendaten sind gesperrt – bitte ein persönliches Projekt verwenden.');
  // Etappe 10: personal strategy/profile context may go to every model; client data never gets here (refused above).
  if (task.meta.confidential) task.meta = { ...task.meta, confidential: false };
  const routeReq = await read((db) => routeRequestFor(db, config, req.useCase, { confidential: false, size: requestSize(task.meta) }));
  const candidates = req.modelIds.map((id) => forcedCandidate(id, config, routeReq));
  const worstTotalUsd = mock ? 0 : candidates.reduce((s, c) => s + c.worstCaseCostUsd, 0);
  const estTotalUsd = mock ? 0 : candidates.reduce((s, c) => s + c.estCostUsd, 0);
  if (!mock) {
    if (worstTotalUsd > config.evalMaxUsdPerRun)
      throw new HttpError(402, `Vergleich könnte bis ${worstTotalUsd.toFixed(3)} USD kosten – über dem Limit pro Lauf (${config.evalMaxUsdPerRun} USD, EVAL_MAX_USD_PER_RUN).`);
    if (worstTotalUsd > routeReq.budgetRemainingUsd)
      throw new HttpError(402, `Budget-Sperre: Der Vergleich könnte bis ${worstTotalUsd.toFixed(3)} USD kosten, verfügbar ${routeReq.budgetRemainingUsd.toFixed(3)} USD.`);
  }
  return { req, task, input, projectIds, publicationIds, mock, worstTotalUsd, estTotalUsd, perModel: candidates.map((c) => ({ id: c.id, estCostUsd: c.estCostUsd, worstCaseCostUsd: c.worstCaseCostUsd })) };
}

/** Cost quote for exactly this comparison – the UI asks the user to approve this number. */
export async function quoteEval(raw: unknown) {
  const { mock, worstTotalUsd, estTotalUsd, perModel } = await planEval(raw);
  return { mock, worstTotalUsd, estTotalUsd, perModel };
}

/**
 * Runs one task with 2–3 models side by side. Never automatic: paid runs require an explicit
 * approval ≥ the quoted worst case. Results are stored only in the Evaluation Lab – studio data
 * (observations, concepts, scripts) is not touched.
 */
export async function runEval(raw: unknown) {
  const { approvedMaxUsd } = RunRequest.parse(raw);
  const { req, task, input, projectIds, publicationIds, mock, worstTotalUsd } = await planEval(raw);
  if (!mock && approvedMaxUsd < worstTotalUsd)
    throw new HttpError(409, `Bitte Kosten bis ${worstTotalUsd.toFixed(3)} USD freigeben (freigegeben: ${approvedMaxUsd.toFixed(3)} USD).`);

  const run: EvalRun = { id: newId(), useCase: req.useCase, input, projectIds, publicationIds, modelIds: req.modelIds, approvedMaxUsd: mock ? 0 : approvedMaxUsd, mock, results: [], createdAt: now() };
  // The summed worst case already fits the budget; each attempt still passes runAgent's reservation.
  run.results = await Promise.all(
    req.modelIds.map(async (modelId) => {
      try {
        const { result, run: agentRun } = await runAgent({ ...task.meta, forceModelId: modelId }, task.run);
        return { modelId, agentRunId: agentRun.id, output: result.output, error: null, costUsd: agentRun.costEstimateUsd, latencyMs: agentRun.latencyMs ?? null };
      } catch (e) {
        return { modelId, agentRunId: null, output: null, error: (e as Error).message.slice(0, 500), costUsd: null, latencyMs: null };
      }
    }),
  );
  await write((db) => {
    // The models ran on a snapshot; outputs of data deleted meanwhile must not be stored.
    if (projectIds.some((id) => !db.projects.some((p) => p.id === id)) || publicationIds.some((id) => !db.publications.some((p) => p.id === id)))
      throw new HttpError(409, 'Verglichene Daten wurden inzwischen gelöscht – bitte Vergleich neu starten.');
    // Oldest stored outputs are dropped beyond the cap; their ratings stay (they feed routing).
    db.evalRuns = [...db.evalRuns, run].slice(-MAX_STORED_RUNS);
  });
  return run;
}

/** Candidates per use case, the router's pick, preferences, recent runs (with their ratings) and selectable inputs. */
export async function getEvalOverview() {
  const { config } = providerFromEnv();
  return read((db) => {
    const spentUsd = monthSpendUsd(db);
    const clientIds = new Set(db.projects.filter((p) => p.kind === 'UGC_CLIENT').map((p) => p.id));
    const mockCounts = new Map<string, number>();
    for (const r of db.evalRatings) if (r.mock) mockCounts.set(`${r.useCase}|${r.modelId}`, (mockCounts.get(`${r.useCase}|${r.modelId}`) ?? 0) + 1);
    const useCases = EVAL_USE_CASES.map((useCase) => {
      const req = routeRequestFor(db, config, useCase, { confidential: false, spentUsd });
      const decision = routeModel(req);
      const rejected = new Map(decision.rejected.map((r) => [r.id, r.reason]));
      return {
        useCase, label: ROUTING_POLICIES[useCase].label, criteria: criteriaFor(useCase),
        routerChoice: decision.chosen?.id ?? null, preferred: db.routerPreferences[useCase] ?? null,
        models: MODEL_REGISTRY.map((m) => {
          const reason = rejected.get(m.id) ?? null;
          const c = reason ? null : toCandidate(m, req);
          const stats = req.userStats?.[m.id];
          return {
            id: m.id, eligible: !reason, reason,
            estCostUsd: c?.estCostUsd ?? null, worstCaseCostUsd: c?.worstCaseCostUsd ?? null,
            ratings: { n: stats?.n ?? 0, mean: stats?.mean ?? null, mockN: mockCounts.get(`${useCase}|${m.id}`) ?? 0 },
          };
        }),
      };
    });
    const runs = db.evalRuns.slice(-20).reverse();
    const runIds = new Set(runs.map((r) => r.id));
    return {
      mode: config.active, mock: config.active === 'mock', evalMaxUsdPerRun: config.evalMaxUsdPerRun, minRatings: MIN_RATINGS_FOR_ROUTING,
      registry: MODEL_REGISTRY.map(({ id, label, family }) => ({ id, label, family })),
      useCases, runs,
      ratings: db.evalRatings.filter((r) => runIds.has(r.evalRunId)),
      references: db.references.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
      concepts: db.concepts.map((c) => ({ id: c.id, title: c.body.title })),
      // Only inputs the lab accepts: no client data, and per script the use cases its gates allow.
      scripts: db.scripts.filter((s) => !clientIds.has(s.projectId)).flatMap((s) => {
        const useCases = SCRIPT_KINDS.filter((k) => !generationBlocker(db, k, s.id)).map((k) => SCRIPT_AGENT_USE_CASE[k]);
        return useCases.length ? [{ id: s.id, version: s.version, hook: s.body.selectedHook, useCases: useCases as UseCase[] }] : [];
      }),
      researchReports: db.researchReports.filter((r) => !clientIds.has(r.projectId)).map((r) => ({ id: r.id, topic: r.topic })),
      projects: db.projects.map((p) => ({ id: p.id, title: p.title, kind: p.kind })),
    };
  });
}

export async function rateEval(runId: string, raw: unknown) {
  const body = RatingRequest.parse(raw);
  return write((db) => {
    const run = must(db.evalRuns.find((r) => r.id === runId), 'Vergleich');
    const result = run.results.find((r) => r.modelId === body.modelId);
    if (!result || result.error) throw new HttpError(400, 'Für dieses Modell gibt es kein Ergebnis zu bewerten.');
    const score = scoreRatings(run.useCase, body.ratings);
    if (score == null) throw new HttpError(400, `Bitte mindestens ein Kriterium bewerten (${criteriaFor(run.useCase).join(', ')}).`);
    // One rating per run + model: re-rating replaces the previous one.
    db.evalRatings = db.evalRatings.filter((r) => !(r.evalRunId === runId && r.modelId === body.modelId));
    const rating = { id: newId(), evalRunId: runId, useCase: run.useCase as UseCase, modelId: body.modelId, ratings: body.ratings, score, correction: body.correction, mock: run.mock, createdAt: now() };
    db.evalRatings.push(rating);
    return rating;
  });
}

/** Pin a model per use case (null = automatic routing). Applies to all use cases, not only those with an agent. */
export async function setPreference(raw: unknown) {
  const { useCase, modelId } = z.object({ useCase: z.enum(Object.keys(ROUTING_POLICIES) as [UseCase, ...UseCase[]]), modelId: z.string().nullable() }).parse(raw);
  if (modelId && !findModel(modelId)) throw new HttpError(404, `Unbekanntes Modell ${modelId}`);
  return write((db) => {
    db.routerPreferences[useCase] = modelId;
    return { useCase, modelId };
  });
}
