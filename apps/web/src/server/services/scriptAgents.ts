import 'server-only';
import { z } from 'zod';
import {
  allowedClaims, lintCaption, requiredDisclosures, ROUTING_POLICIES, runCinematicDirector, runContentQa, runInstagramCopywriter,
  storyboardHasAiMedia, type CaptionRules, type ScriptAgentResult, type SensitiveTerm, type UseCase,
} from '@studio/core';
import { HttpError } from '../errors';
import { must, newId, now, read, write, type Db, type ScriptOutput } from '../store';
import { runAgent, type AgentTask } from './agentRuns';
import { scriptContext, scriptLineage, scriptMeta } from './content';
import { localLintTerms, strategyBlockers, strategyGateError } from './strategyGate';

type Kind = ScriptOutput['kind'];
const ScriptAgentKind = z.enum(['qa', 'copy', 'storyboard'] satisfies Kind[]);
export const SCRIPT_AGENT_USE_CASE = { qa: 'content_quality_assurance', copy: 'instagram_copywriting', storyboard: 'cinematic_direction' } as const satisfies Record<Kind, UseCase>;

/** Caption rules from the CURRENT project kind, client claims, script and storyboards – used for writing, display and approval. */
function captionRules(db: Db, scriptId: string): CaptionRules {
  const { script, brief, project, lineageFlagged } = scriptLineage(db, scriptId);
  const storyboards = db.scriptOutputs.flatMap((o) => (o.scriptId === scriptId && o.kind === 'storyboard' ? [o.output] : []));
  return {
    required: requiredDisclosures({ projectKind: project.kind, script: script.body, storyboards }),
    allowed: allowedClaims({ brief: brief.input, client: project.client }),
    flagged: lineageFlagged,
  };
}

const isPersonal = (db: Db, scriptId: string) => scriptLineage(db, scriptId).project.kind === 'PERSONAL_CONTENT';

/**
 * Why a new output may not be created for this script (empty = ok). Etappe 10: no strategy check any more;
 * personal projects get copy for any script that is not rejected, client projects only for an approved one.
 */
export function generationBlocker(db: Db, kind: Kind, scriptId: string): string | null {
  const { script, project } = scriptLineage(db, scriptId);
  if (script.status === 'rejected') return 'Verworfene Skripte werden nicht weiterverarbeitet.';
  if (kind === 'copy' && project.kind !== 'PERSONAL_CONTENT' && script.status !== 'approved') return 'Instagram-Copy erst für ein freigegebenes Skript.';
  return null;
}

/**
 * Single approval policy for script outputs (API gate and UI hint). Does not include the user's confirmation.
 * Copy: script approved (client projects; personal: not rejected), lint against the current rules without
 * failures. Storyboard: script not rejected. Both: the strategy gate of their piece and the boundary lint of
 * their own text (`terms`: her sensitive terms) – empty for personal projects since Etappe 10.
 */
export function outputApprovalBlockers(db: Db, o: ScriptOutput, terms: readonly SensitiveTerm[]): string[] {
  if (o.kind === 'qa') return ['QA-Berichte sind Hinweise und werden nicht freigegeben.'];
  const { script } = scriptLineage(db, o.scriptId);
  const strategy = strategyBlockers(db, o.kind, o, terms);
  if (o.kind === 'storyboard') return [...(script.status === 'rejected' ? ['Das Skript wurde verworfen.'] : []), ...strategy];
  const scriptBlock = isPersonal(db, o.scriptId)
    ? (script.status === 'rejected' ? ['Das Skript wurde verworfen.'] : [])
    : (script.status !== 'approved' ? ['Das Skript ist nicht (mehr) freigegeben.'] : []);
  return [
    ...scriptBlock,
    ...lintCaption(o.output, captionRules(db, o.scriptId)).filter((l) => l.level === 'fail').map((l) => l.message),
    ...strategy,
  ];
}

/**
 * Confirmation the user must give before approving; for client projects with AI media also documented client
 * consent. Etappe 10: personal copy needs no confirmation; a storyboard with AI media keeps it everywhere
 * (it is the step before paid Higgsfield jobs).
 */
export function confirmationNeeded(db: Db, o: ScriptOutput): { confirm: boolean; clientConsent: boolean } {
  if (o.kind === 'copy') return { confirm: !isPersonal(db, o.scriptId), clientConsent: false };
  if (o.kind === 'qa' || !storyboardHasAiMedia(o.output)) return { confirm: false, clientConsent: false };
  return { confirm: true, clientConsent: scriptLineage(db, o.scriptId).project.kind === 'UGC_CLIENT' };
}

/** Agent task for one script version (no side effects). */
export async function prepareScriptAgentTask(kind: Kind, scriptId: string) {
  const { script, ctx, rules, blocker } = await read((db) => ({ ...scriptContext(db, scriptId), rules: captionRules(db, scriptId), blocker: generationBlocker(db, kind, scriptId) }));
  if (blocker) throw new HttpError(409, blocker);
  const runners = {
    qa: (p) => runContentQa(p, ctx, script.body),
    copy: (p) => runInstagramCopywriter(p, ctx, script.body, rules),
    storyboard: (p) => runCinematicDirector(p, ctx, script.body),
  } satisfies Record<Kind, AgentTask<{ value: unknown; warnings: string[] }>['run']>;
  const useCase = SCRIPT_AGENT_USE_CASE[kind];
  const task: AgentTask<{ value: ScriptOutput['output']; warnings: string[] }> = {
    meta: { agent: ROUTING_POLICIES[useCase].agent!, useCase, ...scriptMeta(ctx, script) },
    run: runners[kind] as (p: Parameters<typeof runContentQa>[0]) => Promise<ScriptAgentResult<ScriptOutput['output']>>,
  };
  return { script, task };
}

/** Runs QA / copywriter / cinematic director and stores the result as a draft; older drafts of the same kind are replaced. */
export async function runScriptAgent(kindRaw: unknown, scriptId: string) {
  const kind = ScriptAgentKind.parse(kindRaw);
  const { script, task } = await prepareScriptAgentTask(kind, scriptId);
  const { result, run, mock } = await runAgent(task.meta, task.run);
  return write((db) => {
    const blocker = generationBlocker(db, kind, script.id); // the script may have changed during the model call
    if (blocker) throw new HttpError(409, blocker);
    const out = {
      id: newId(), scriptId: script.id, projectId: script.projectId, agentRunId: run.id, promptVersion: result.promptVersion,
      warnings: result.output.warnings, mock, createdAt: now(), status: 'draft', approvedAt: null, clientConsentNote: null, kind, output: result.output.value,
    } as ScriptOutput; // kind ↔ output pairing comes from the same `kind` key above
    // Keep the approved one and the newest draft per (script, kind); the agent run log keeps the history.
    db.scriptOutputs = db.scriptOutputs.filter((x) => !(x.scriptId === out.scriptId && x.kind === kind && x.status === 'draft'));
    db.scriptOutputs.push(out);
    return out;
  });
}

const ApproveRequest = z.object({ confirmed: z.boolean().default(false), clientConsentNote: z.string().trim().max(500).default('') });

/** Human gate for copy and storyboard (see outputApprovalBlockers / confirmationNeeded). */
export async function approveScriptOutput(id: string, raw: unknown) {
  const { confirmed, clientConsentNote } = ApproveRequest.parse(raw ?? {});
  const terms = await localLintTerms();
  return write((db) => {
    const o = must(db.scriptOutputs.find((x) => x.id === id), 'Ergebnis');
    const blockers = outputApprovalBlockers(db, o, terms);
    if (blockers.length) {
      const strategy = o.kind === 'qa' ? [] : strategyBlockers(db, o.kind, o, terms);
      if (strategy.length) throw strategyGateError(strategy, blockers.filter((b) => !strategy.includes(b)));
      throw new HttpError(409, `Freigabe blockiert: ${blockers.join(' ')}`);
    }
    const need = confirmationNeeded(db, o);
    if (need.confirm && !confirmed)
      throw new HttpError(409, o.kind === 'copy'
        ? 'Bestätigung fehlt: keine unbelegten Aussagen, Kennzeichnungen stimmen (auch die Instagram-Labels beim Posten).'
        : 'Bestätigung fehlt, dass die KI-Elemente gekennzeichnet sind, keine Produktdarstellung zeigen und kein bezahlter Job ohne weitere Freigabe startet.');
    if (need.clientConsent && !clientConsentNote) throw new HttpError(409, 'Kundenprojekt mit KI-Elementen: Zustimmung der Kundin dokumentieren (z. B. „Mail vom 12.11.“).');
    for (const x of db.scriptOutputs) if (x.scriptId === o.scriptId && x.kind === o.kind && x.id !== o.id && x.status === 'approved') Object.assign(x, { status: 'draft', approvedAt: null });
    Object.assign(o, { status: 'approved', approvedAt: now(), clientConsentNote: need.clientConsent ? clientConsentNote : null });
    // A storyboard can add AI media: an approved caption without the AI label falls back to draft.
    if (o.kind === 'storyboard')
      for (const c of db.scriptOutputs)
        if (c.kind === 'copy' && c.scriptId === o.scriptId && c.status === 'approved' && outputApprovalBlockers(db, c, terms).length) Object.assign(c, { status: 'draft', approvedAt: null });
    return o;
  });
}

/** Outputs of a project with the server's approval view (blockers + required confirmations) for the UI. */
export const outputsWithGates = (db: Db, projectId: string, terms: readonly SensitiveTerm[]) =>
  db.scriptOutputs.filter((o) => o.projectId === projectId).map((o) => ({ ...o, gate: { blockers: outputApprovalBlockers(db, o, terms), ...confirmationNeeded(db, o) } }));
