'use client';
import type { PillarMixView } from '@/lib/types';

const pieces = (n: number) => (n === 1 ? '1 fertiges Stück' : `${n} fertige Stücke`);

/**
 * Plain counts of finished, self-assessed pieces per pillar next to the target share (D9). Text rows only:
 * no colours for „behind“, no delta, nothing changes automatically.
 */
export function PillarMix({ mix }: { mix: PillarMixView | null }) {
  return (
    <section className="panel" data-testid="pillar-mix">
      <h2 className="mb-1 text-lg font-bold">Säulen-Mix</h2>
      <p className="hint">Fertige Stücke aus deinem Selbstcheck, letzte {mix?.weeks ?? 12} Wochen{mix?.strategyVersion ? ` · Strategie v${mix.strategyVersion}` : ''}.</p>
      {mix ? (
        <ul className="mt-2 grid gap-1 text-[13px]">
          {mix.rows.filter((r) => r.pillarId !== null || r.count > 0).map((r) => (
            <li key={r.pillarId ?? 'none'}>
              {r.name}: {pieces(r.count)}{r.targetShare != null ? ` (Ziel ca. ${r.targetShare} %)` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {mix && !mix.rows.some((r) => r.pillarId !== null) ? <p className="hint mt-2">Noch keine aktive Strategie mit Säulen.</p> : null}
      <p className="note mt-3">Nur zur Orientierung – ändert nichts automatisch.</p>
    </section>
  );
}
