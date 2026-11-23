import 'server-only';
import { ROUTING_POLICIES, routeModel, USE_CASES, type ProviderConfig } from '@studio/core';
import { ffmpegStatus } from '../ffmpeg';
import { whisperStatus } from '../whisper';
import { higgsfieldStatus } from '../higgsfield';
import { monthCreditsCommitted } from './generations';
import { higgsfieldConfig, providerFromEnv, storageMode } from '../env';
import { isOrphaned, read } from '../store';
import { budgetOf, confidentialBlock, monthSpendUsd, reservedUsdOf, routeRequestFor } from './agentRuns';

/** Provider config without secrets (safe for pages and /api/status). */
function toPublic(config: ProviderConfig) {
  const { openrouterApiKey, ...rest } = config;
  return { ...rest, openrouterConfigured: Boolean(openrouterApiKey) };
}

/** Provider label + budget for the studio layout (one env resolve, one read). */
export async function getShellStatus() {
  const { config } = providerFromEnv();
  const { spent, reserved } = await read((db) => ({ spent: monthSpendUsd(db), reserved: reservedUsdOf(db) }));
  return { provider: toPublic(config), budget: budgetOf(config, spent, reserved) };
}

export async function getStatus() {
  const { config, provider } = providerFromEnv();
  const [ffmpeg, transcription, higgsfield, counts, confidentialBlocked] = await Promise.all([
    ffmpegStatus(),
    whisperStatus(),
    higgsfieldStatus(),
    read((db) => ({
      references: db.references.length,
      pendingObservations: db.observations.filter((o) => o.decision === 'pending').length,
      approvedObservations: db.observations.filter((o) => o.decision === 'approved').length,
      styleVersions: db.styleBibles.length,
      approvedStyle: db.styleBibles.find((v) => v.status === 'approved')?.version ?? null,
      voiceVersions: db.voiceGuides.length,
      projects: db.projects.filter((p) => p.status === 'active').length,
      concepts: db.concepts.length,
      scripts: db.scripts.length,
      publications: db.publications.length,
      footage: db.mediaAssets.length,
      footageBytes: db.mediaAssets.reduce((n, a) => n + a.size, 0),
      snapshots: db.metricSnapshots.length,
      agentRuns: db.agentRuns.length,
      monthSpendUsd: monthSpendUsd(db),
      reservedUsd: reservedUsdOf(db),
      orphanedReservations: db.budgetReservations.filter(isOrphaned),
      creditsCommitted: monthCreditsCommitted(db),
      mediaJobs: { queued: db.mediaJobs.filter((j) => j.status === 'queued').length, running: db.mediaJobs.filter((j) => j.status === 'running').length },
      recentRuns: db.agentRuns.slice(-8).reverse(), // append-only log, already in time order
    })),
    // Confidential = client data AND personal content with an approved strategy/profile (D8).
    read((db) => confidentialBlock(db, { provider, config }, 'content_strategy')),
  ]);
  return {
    provider: toPublic(config),
    budget: budgetOf(config, counts.monthSpendUsd, counts.reservedUsd),
    ffmpeg,
    // no local paths to the browser: model file name only
    transcription: { mode: transcription.mode, available: transcription.available, reason: transcription.reason, model: transcription.model?.split('/').pop() ?? null },
    higgsfield: { ...higgsfield, monthLimit: higgsfieldConfig().monthlyCredits },
    storage: storageMode(),
    auth: { accessToken: Boolean(process.env.STUDIO_ACCESS_TOKEN), jobToken: Boolean(process.env.STUDIO_JOB_TOKEN) },
    supabase: { configured: Boolean(process.env.SUPABASE_URL), adapter: 'nicht implementiert (lokaler Modus aktiv)' },
    counts,
    confidentialBlocked,
  };
}

/** What the router would choose per use case right now (no model is called). Same request builder as runAgent. */
export async function getRoutingOverview() {
  const { config } = providerFromEnv();
  return read((db) =>
    USE_CASES.map((useCase) => {
      const d = routeModel(routeRequestFor(db, config, useCase, { confidential: false }));
      const c = routeModel(routeRequestFor(db, config, useCase, { confidential: true }));
      return {
        useCase, label: ROUTING_POLICIES[useCase].label, agent: ROUTING_POLICIES[useCase].agent, preferred: db.routerPreferences[useCase] ?? null,
        chosen: d.chosen, fallbacks: d.fallbacks.map((f) => f.label), reasons: d.reasons,
        confidentialChoice: c.chosen?.label ?? null, confidentialReason: c.chosen ? null : c.rejected[0]?.reason ?? c.reasons[0] ?? null,
      };
    }),
  );
}
