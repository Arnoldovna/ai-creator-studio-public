import type { Metrics, MetricWindow } from './schemas';

export interface Rates {
  savesPerReachPct: number | null;
  sharesPerReachPct: number | null;
  savesSharesPerReachPct: number | null;
  /** Engagement only when likes+comments were actually entered. */
  engagementPerReachPct: number | null;
  followsPer1kReach: number | null;
  denominator: 'reach';
}

const pct = (n: number, d: number) => (100 * n) / d;

/** Rates use reach as denominator and are null when reach is 0 or a metric is missing. */
export function computeRates(m: Metrics): Rates {
  const ok = m.reach > 0;
  return {
    savesPerReachPct: ok ? pct(m.saves, m.reach) : null,
    sharesPerReachPct: ok ? pct(m.shares, m.reach) : null,
    savesSharesPerReachPct: ok ? pct(m.saves + m.shares, m.reach) : null,
    engagementPerReachPct: ok && m.likes != null && m.comments != null ? pct(m.likes + m.comments + m.saves + m.shares, m.reach) : null,
    followsPer1kReach: ok && m.follows != null ? (1000 * m.follows) / m.reach : null,
    denominator: 'reach',
  };
}

export const fmtPct = (x: number | null) => (x == null ? '—' : x.toFixed(2).replace('.', ',') + ' %');

export interface InsightPost {
  publicationId: string;
  title: string;
  hook: string;
  window: MetricWindow;
  metrics: Metrics;
  observedAt: string;
}

export interface GrowthInsight {
  sampleSize: number;
  window: MetricWindow;
  publicationId: string;
  hypothesis: string;
  caveat: string;
  /** Always false here: insights are suggestions; the user decides whether to use them. */
  autoApplied: false;
}

/**
 * Cautious experiment hypothesis (ported from the prototype). Only compares posts
 * measured in the SAME window as the most recent snapshot. Never changes style rules.
 */
export function deriveGrowthInsight(posts: InsightPost[]): GrowthInsight | null {
  const valid = posts.filter((p) => p.metrics.reach > 0).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  if (!valid.length) return null;
  const latest = valid[0]!;
  // one snapshot per publication: the latest in this window
  const byPub = new Map<string, InsightPost>();
  for (const p of valid) if (p.window === latest.window && !byPub.has(p.publicationId)) byPub.set(p.publicationId, p);
  const peers = [...byPub.values()];
  const score = (p: InsightPost) => computeRates(p.metrics).savesSharesPerReachPct ?? 0;
  const best = [...peers].sort((a, b) => score(b) - score(a))[0]!;
  const angle = best.hook ? `Hook im Ansatz „${best.hook}“` : `Einstieg zum Thema „${best.title}“`;
  return {
    sampleSize: peers.length,
    window: latest.window,
    publicationId: best.publicationId,
    hypothesis: `Experiment-Hypothese: Teste erneut einen ${angle}, aber mit einem klar veränderten Detail (z. B. der ersten Einstellung). Dieser Beitrag hatte ${fmtPct(score(best))} kombinierte Saves + Shares pro erreichten Accounts (${best.window}-Messfenster).`,
    caveat: peers.length < 3 ? 'Sehr kleine Datenbasis; daraus lässt sich noch kein verlässliches Muster ableiten.' : 'Beobachtungsdaten; Korrelation belegt keine Ursache.',
    autoApplied: false,
  };
}
