import 'server-only';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ACCOUNT_STATUS_ARGS, backoffMs, buildCostArgs, buildCreateArgs, buildGetArgs, classifyFailure, FAILURE_LABEL, parseAccountStatus, parseCost, parseJob,
  type FailureKind, type GenerationParams, type HiggsfieldJob,
} from '@studio/core';
import { higgsfieldConfig } from './env';
import { firstExisting, runFfmpeg } from './ffmpeg';
import { sniffMime } from './media';

/**
 * HiggsfieldAdapter (ADR-010): the pinned CLI via `execFile` + `--json`, never a shell, never `--wait`
 * (the studio polls itself so it can cancel and back off). The mock mirrors the CLI's JSON shapes and is
 * labelled in the UI. Skills, plugin and MCP are deliberately not used.
 */
export interface HiggsfieldStatus {
  mode: 'off' | 'cli' | 'mock';
  /** ready = can quote and create; needs_login = the user has to run `higgsfield auth login` (or pick a workspace) herself. */
  state: 'disabled' | 'unavailable' | 'needs_login' | 'ready';
  credits: number | null; reason: string | null;
}
export interface HiggsfieldAdapter {
  mode: 'cli' | 'mock';
  pollMs: number; timeoutMs: number;
  /** Wait after the n-th HTTP 429 in a row. */
  backoffMs(n: number): number;
  status(): Promise<HiggsfieldStatus>;
  cost(p: GenerationParams): Promise<number>;
  create(p: GenerationParams, signal: AbortSignal): Promise<HiggsfieldJob>;
  get(jobId: string, signal: AbortSignal): Promise<HiggsfieldJob>;
  /** Downloads the finished clip into our own storage (the CDN link is never kept as the source). */
  fetchResult(job: HiggsfieldJob, dest: string, signal: AbortSignal): Promise<void>;
}

/** A failed CLI call with its classified reason (stderr is untrusted text and only shown shortened). */
export class HiggsfieldError extends Error {
  constructor(public kind: FailureKind, message: string) {
    super(message);
  }
}

const MAX_RESULT_BYTES = 500 * 1024 ** 2;

function runCli(cli: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, [...args, '--no-color'], { timeout: 60_000, maxBuffer: 2 * 1024 ** 2, signal, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      // stderr only: err.message holds the full argv (incl. the prompt) and stdout may echo the request
      const text = String(stderr);
      const kind = signal?.aborted ? 'cancelled' : (err as { killed?: boolean }).killed ? 'timeout' : classifyFailure(text);
      const last = String(stderr).trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
      reject(new HiggsfieldError(kind, last || `Higgsfield-CLI beendet mit Code ${String((err as { code?: unknown }).code ?? '?')}`));
    });
  });
}

async function downloadHttps(url: string, dest: string, signal: AbortSignal) {
  if (!/^https:\/\//i.test(url)) throw new HiggsfieldError('failed', 'Ergebnis-URL ist kein https-Link.');
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new HiggsfieldError('failed', `Download fehlgeschlagen (HTTP ${res.status}).`);
  if (!/^https:\/\//i.test(res.url)) throw new HiggsfieldError('failed', 'Download wurde auf eine unsichere Adresse umgeleitet.');
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_RESULT_BYTES) throw new HiggsfieldError('failed', 'Ergebnis größer als 500 MB.');
  let seen = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  body.on('data', (c: Buffer) => {
    seen += c.length;
    if (seen > MAX_RESULT_BYTES) body.destroy(new HiggsfieldError('failed', 'Ergebnis größer als 500 MB.'));
  });
  await pipeline(body, createWriteStream(dest), { signal });
  // MP4/MOV: "ftyp" box at offset 4; anything else is not stored
  const fh = await open(dest, 'r');
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await fh.read(head, 0, 64, 0);
    const mime = sniffMime(head.subarray(0, bytesRead));
    if (mime !== 'video/mp4' && mime !== 'video/quicktime') throw new HiggsfieldError('failed', 'Ergebnis ist kein MP4-Video.');
  } catch (e) {
    await rm(dest, { force: true });
    throw e;
  } finally {
    await fh.close();
  }
}

function cliAdapter(cli: string): HiggsfieldAdapter {
  return {
    mode: 'cli', pollMs: 5_000, timeoutMs: 20 * 60_000, backoffMs,
    async status() {
      try {
        const { credits } = parseAccountStatus(await runCli(cli, ACCOUNT_STATUS_ARGS));
        return { mode: 'cli', state: 'ready', credits, reason: null };
      } catch (e) {
        if (e instanceof HiggsfieldError && (e.kind === 'needs_login' || e.kind === 'needs_workspace'))
          return { mode: 'cli', state: 'needs_login', credits: null, reason: FAILURE_LABEL[e.kind] };
        return { mode: 'cli', state: 'unavailable', credits: null, reason: `Kontostatus nicht lesbar: ${(e as Error).message}` };
      }
    },
    cost: async (p) => parseCost(await runCli(cli, buildCostArgs(p))),
    create: async (p, signal) => parseJob(await runCli(cli, buildCreateArgs(p), signal)),
    get: async (id, signal) => parseJob(await runCli(cli, buildGetArgs(id), signal)),
    fetchResult: (job, dest, signal) => downloadHttps(job.resultUrl ?? '', dest, signal),
  };
}

/** Offline stand-in in the CLI's JSON shapes; its clip is a local FFmpeg test pattern (no network, no credits). */
export function mockAdapter(opts: { failWith?: 'nsfw' | 'ip_detected' | 'failed' | 'rate_limited_once'; pollMs?: number; timeoutMs?: number; never?: boolean } = {}): HiggsfieldAdapter & { creates: number } {
  const jobs = new Map<string, { polls: number; params: GenerationParams }>();
  let limited = opts.failWith === 'rate_limited_once';
  const self = {
    mode: 'mock' as const, pollMs: opts.pollMs ?? 100, timeoutMs: opts.timeoutMs ?? 60_000, creates: 0, backoffMs: (n: number) => 50 * n,
    status: async (): Promise<HiggsfieldStatus> => ({ mode: 'mock', state: 'ready', credits: null, reason: null }),
    cost: async (p: GenerationParams) => parseCost(JSON.stringify({ credits: p.durationSec * (p.resolution === '1080p' ? 8 : 5) })),
    async create(p: GenerationParams) {
      self.creates++;
      const id = `mock-${randomUUID()}`;
      jobs.set(id, { polls: 0, params: p });
      return parseJob(JSON.stringify({ id, status: 'queued' }));
    },
    async get(id: string) {
      const j = jobs.get(id);
      if (!j) throw new HiggsfieldError('failed', 'Unbekannter Mock-Job');
      if (limited) {
        limited = false;
        throw new HiggsfieldError('rate_limited', 'Higgsfield API error (HTTP 429)');
      }
      j.polls++;
      if (opts.never || j.polls < 2) return parseJob(JSON.stringify({ id, status: 'in_progress' }));
      if (opts.failWith && opts.failWith !== 'rate_limited_once') return parseJob(JSON.stringify({ id, status: opts.failWith, fail_reason: 'mock' }));
      return parseJob(JSON.stringify({ id, status: 'completed', results: [{ raw: { url: `https://mock.invalid/${id}.mp4` } }] }));
    },
    async fetchResult(job: HiggsfieldJob, dest: string, signal: AbortSignal) {
      const p = jobs.get(job.id)?.params;
      await runFfmpeg(['-f', 'lavfi', '-i', `testsrc2=size=720x1280:rate=30:duration=${p?.durationSec ?? 5}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', dest], { signal });
    },
  };
  return self;
}

let override: HiggsfieldAdapter | null = null;
let mockSingleton: HiggsfieldAdapter | null = null;
/** Tests swap in a mock with failure modes. */
export function setHiggsfieldAdapter(a: HiggsfieldAdapter | null) {
  override = a;
}

/** The adapter for the configured mode, or null when the feature is off / the CLI is missing. */
export async function higgsfieldAdapter(): Promise<HiggsfieldAdapter | null> {
  if (override) return override;
  const cfg = higgsfieldConfig();
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'mock') return (mockSingleton ??= mockAdapter());
  const cli = await firstExisting(cfg.cli);
  return cli ? cliAdapter(cli) : null;
}

export async function higgsfieldStatus(): Promise<HiggsfieldStatus> {
  const cfg = higgsfieldConfig();
  if (!override && cfg.mode === 'off') return { mode: 'off', state: 'disabled', credits: null, reason: 'Generierte B-Roll ist ausgeschaltet (HIGGSFIELD=cli oder mock setzen).' };
  const a = await higgsfieldAdapter();
  if (!a) return { mode: 'cli', state: 'unavailable', credits: null, reason: 'Higgsfield-CLI nicht gefunden (HIGGSFIELD_CLI setzen oder die CLI in fester Version installieren).' };
  return a.status();
}
