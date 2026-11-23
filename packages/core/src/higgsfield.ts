/**
 * Release 3, Etappe 7: optional generated B-roll via the Higgsfield CLI (ADR-010).
 * Pure functions only: CLI argument lists (no shell), tolerant parsing of the CLI's `--json` output and
 * the classification of failures. `account status`, `workspace list`, `generate cost` and `model get` were
 * checked against real CLI 1.2.3 output on 2026-11-16; the job shape of `generate create|get` is still from
 * the docs (no job was started). Unknown shapes fail closed.
 */
import { z } from 'zod';
import { ValidationError } from './schemas';

/**
 * Text-to-video models offered for B-roll. Image inputs (faces, client material, Soul ID) are deliberately not supported.
 * `resolutions`: only Seedance has a `resolution` param (`higgsfield model get`); Kling and Veo reject it
 * ("Unknown params: resolution"), their output size is set by the model.
 */
export const HIGGSFIELD_MODELS = {
  seedance_2_5: { label: 'Seedance 2.5', durations: [5, 10], resolutions: ['720p', '1080p'] },
  kling3_0: { label: 'Kling v3.0', durations: [5, 10], resolutions: [] },
  veo3_1_lite: { label: 'Google Veo 3.1 Lite', durations: [4, 6, 8], resolutions: [] },
} as const;
export type Resolution = '720p' | '1080p';
export const HiggsfieldModel = z.enum(Object.keys(HIGGSFIELD_MODELS) as [keyof typeof HIGGSFIELD_MODELS, ...(keyof typeof HIGGSFIELD_MODELS)[]]);
export type HiggsfieldModel = z.infer<typeof HiggsfieldModel>;

export const GenerationParams = z.object({
  model: HiggsfieldModel,
  prompt: z.string().trim().min(3).max(1200),
  durationSec: z.number().int().min(1).max(10),
  /** null = set by the model (models without a `resolution` param) */
  resolution: z.enum(['720p', '1080p']).nullish(),
}).transform((p, ctx) => {
  const m = HIGGSFIELD_MODELS[p.model];
  const allowed: readonly number[] = m.durations;
  if (!allowed.includes(p.durationSec)) ctx.addIssue({ code: 'custom', path: ['durationSec'], message: `${m.label}: Dauer ${allowed.join(' / ')} s` });
  const resolutions: readonly Resolution[] = m.resolutions;
  if (!resolutions.length) {
    if (p.resolution) ctx.addIssue({ code: 'custom', path: ['resolution'], message: `${m.label}: Auflösung wird vom Modell vorgegeben` });
    return { ...p, resolution: null };
  }
  return { ...p, resolution: p.resolution ?? resolutions[0]! };
});
export type GenerationParams = z.infer<typeof GenerationParams>;

/** Shared flags: always vertical 9:16 for Reels; the prompt is one `--prompt=` argument so it can never be read as a flag. */
const paramArgs = (p: GenerationParams) => [
  // eslint-disable-next-line no-control-regex -- control characters are flattened on purpose
  p.model, `--prompt=${p.prompt.replace(/[\u0000-\u001f\u007f]/g, ' ')}`,
  '--aspect_ratio', '9:16', '--duration', String(p.durationSec), ...(p.resolution ? ['--resolution', p.resolution] : []),
];

/** `generate cost`: a credit estimate, no job is created. */
export const buildCostArgs = (p: GenerationParams) => ['generate', 'cost', ...paramArgs(GenerationParams.parse(p)), '--json'];
/** `generate create` WITHOUT `--wait`: returns the job id at once; the studio polls itself (cancel, backoff). */
export const buildCreateArgs = (p: GenerationParams) => ['generate', 'create', ...paramArgs(GenerationParams.parse(p)), '--json'];
export const buildGetArgs = (jobId: string) => {
  if (!/^[\w-]{4,100}$/.test(jobId)) throw new ValidationError('Ungültige Higgsfield-Job-ID');
  return ['generate', 'get', jobId, '--json'];
};
export const ACCOUNT_STATUS_ARGS = ['account', 'status', '--json'];

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
function firstOf(o: Record<string, unknown>, keys: string[]) {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
}
function parseJson(stdout: string): unknown {
  const t = stdout.trim();
  try {
    return JSON.parse(t);
  } catch {
    throw new ValidationError('Higgsfield-CLI lieferte kein JSON');
  }
}

/** Credits from `generate cost --json`. A bare number or an object with a credit field; anything else is refused. */
export function parseCost(stdout: string): number {
  const j = parseJson(stdout);
  const o = obj(j);
  const v = num(j) ?? (o ? num(firstOf(o, ['credits', 'cost', 'total_credits', 'credits_cost', 'price', 'amount'])) : null)
    ?? (o && obj(o.cost) ? num(firstOf(obj(o.cost)!, ['credits', 'amount', 'total'])) : null);
  if (v == null || v < 0) throw new ValidationError('Unbekanntes Format der Kostenschätzung – keine Freigabe möglich');
  return v;
}

export const JOB_STATES = ['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'ip_detected', 'canceled'] as const;
export type HiggsfieldJobState = (typeof JOB_STATES)[number];
export interface HiggsfieldJob { id: string; status: HiggsfieldJobState; resultUrl: string | null; error: string | null }

const STATUS_ALIASES: Record<string, HiggsfieldJobState> = {
  queued: 'queued', pending: 'queued', waiting: 'queued', created: 'queued',
  in_progress: 'in_progress', processing: 'in_progress', running: 'in_progress',
  completed: 'completed', succeeded: 'completed', success: 'completed', done: 'completed',
  failed: 'failed', error: 'failed', nsfw: 'nsfw', ip_detected: 'ip_detected', canceled: 'canceled', cancelled: 'canceled',
};

function resultUrlOf(o: Record<string, unknown>): string | null {
  const direct = firstOf(o, ['result_url', 'url', 'video_url', 'output_url']);
  if (typeof direct === 'string') return direct;
  for (const k of ['result', 'output', 'results', 'outputs', 'medias']) {
    const v = o[k];
    const items = Array.isArray(v) ? v : v != null ? [v] : [];
    for (const it of items) {
      if (typeof it === 'string') return it;
      const io = obj(it);
      const u = io && firstOf(io, ['url', 'result_url', 'video_url', 'raw_url']);
      if (typeof u === 'string') return u;
      const raw = io && obj(io.raw);
      if (raw && typeof raw.url === 'string') return raw.url;
    }
  }
  return null;
}

/** One job from `generate create|get --json` (an object, an array of jobs, or `{ job: … }`). */
export function parseJob(stdout: string): HiggsfieldJob {
  let j = parseJson(stdout);
  if (Array.isArray(j)) j = j[0];
  let o = obj(j);
  if (o && obj(o.job)) o = obj(o.job);
  const id = o && firstOf(o, ['id', 'job_id', 'jobId']);
  if (!o || typeof id !== 'string' || !/^[\w-]{4,100}$/.test(id)) throw new ValidationError('Unbekanntes Format der Higgsfield-Job-Antwort');
  const status = STATUS_ALIASES[String(o.status ?? 'queued').toLowerCase()];
  if (!status) throw new ValidationError(`Unbekannter Higgsfield-Status „${String(o.status).slice(0, 40)}“`);
  const err = firstOf(o, ['error', 'fail_reason', 'failure_reason', 'message']);
  return { id, status, resultUrl: resultUrlOf(o), error: typeof err === 'string' ? err.slice(0, 300) : null };
}

/** `account status --json`: the credit balance. A missing session is a CLI error, classified by `classifyFailure`. */
export function parseAccountStatus(stdout: string): { credits: number | null } {
  const o = obj(parseJson(stdout));
  if (!o) throw new ValidationError('Unbekanntes Format des Kontostatus');
  const nested = obj(o.credits) ?? obj(o.balance);
  const credits = num(firstOf(o, ['credits', 'balance', 'credits_balance', 'available_credits'])) ?? (nested ? num(firstOf(nested, ['available', 'total', 'balance'])) : null);
  return { credits };
}

/**
 * Why a CLI call or job failed, from the job status or the CLI's stderr. `charged` says whether credits
 * may have been used: Higgsfield's refund policy for failed jobs is not documented, so every failure after
 * the job was created counts as charged until the user corrects it.
 */
/** `local_only`: the studio's privacy guard stopped the prompt before submit (ADR-012); nothing was sent. */
export type FailureKind = 'needs_login' | 'needs_workspace' | 'rate_limited' | 'nsfw' | 'ip_detected' | 'timeout' | 'invalid' | 'cancelled' | 'local_only' | 'failed';
export function classifyFailure(text: string, status?: HiggsfieldJobState): FailureKind {
  if (status === 'nsfw') return 'nsfw';
  if (status === 'ip_detected') return 'ip_detected';
  if (status === 'canceled') return 'cancelled';
  const t = text.toLowerCase();
  if (/session expired|not authenticated|auth login|stored credentials/.test(t)) return 'needs_login';
  if (/http 429|too many requests|rate limit/.test(t)) return 'rate_limited';
  if (/\bnsfw\b/.test(t)) return 'nsfw';
  if (/ip_detected/.test(t)) return 'ip_detected';
  if (/timeout|timed out|deadline/.test(t)) return 'timeout';
  if (/no workspace selected/.test(t)) return 'needs_workspace';
  if (/missing required|invalid values|unknown params|unknown model|no model with job_type|should be (greater|less) than/.test(t)) return 'invalid';
  return 'failed';
}

export const FAILURE_LABEL: Record<FailureKind, string> = {
  needs_login: 'Higgsfield-Anmeldung fehlt oder ist abgelaufen – im Terminal `higgsfield auth login` ausführen.',
  needs_workspace: 'Kein Higgsfield-Workspace gewählt – im Terminal `higgsfield workspace list` und `higgsfield workspace set <id>` ausführen (darüber wird abgerechnet).',
  rate_limited: 'Higgsfield meldet zu viele Anfragen (HTTP 429).',
  nsfw: 'Higgsfield hat den Prompt als nicht jugendfrei abgelehnt (nsfw).',
  ip_detected: 'Higgsfield hat geschützte Inhalte erkannt (ip_detected) – Prompt ohne Marken/Figuren formulieren.',
  timeout: 'Zeitüberschreitung – der Job kann bei Higgsfield noch weiterlaufen.',
  invalid: 'Higgsfield hat die Parameter abgelehnt.',
  cancelled: 'Abgebrochen.',
  local_only: 'Gestoppt: Prompt enthält nur-lokale Angaben.',
  failed: 'Higgsfield-Job fehlgeschlagen.',
};

/** Exponential backoff for polling after HTTP 429: 5 s, 10 s, 20 s … capped at 60 s. */
export const backoffMs = (consecutive429: number) => Math.min(60_000, 5_000 * 2 ** Math.max(0, consecutive429 - 1));
