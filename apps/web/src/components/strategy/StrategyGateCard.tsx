'use client';
import { useEffect } from 'react';
import { useApi } from '@/lib/api';
import type { StrategyGateView } from '@/lib/types';
import { ErrorNote, Pill } from '../ui';
import { useGateChanges } from './gateEvents';
import { BlockerList, FindingList, gatePath, LEGACY_LABEL, LINT_LIMIT_NOTE, OverrideList, type GateKind } from './GateParts';

/**
 * Boundary check next to an approve button in client projects (concept, script, copy, storyboard, edit plan): the
 * lint of this object's own text with override actions, and the blockers. `onBlocked` lets the parent disable its
 * approve button; the server enforces the same gate. Personal projects have no gate (Etappe 10): renders nothing.
 * The FitCheck is gone since Etappe 11.
 */
export function StrategyGateCard({ kind, id, texts, onBlocked, onChanged }: {
  kind: GateKind; id: string; texts?: Record<string, string>; onBlocked?: (blocked: boolean) => void; onChanged?: () => void;
}) {
  const gate = useApi<StrategyGateView>(gatePath(kind, id));
  // an override saved in any other view of the same piece (sibling plan, copy/storyboard, script)
  useGateChanges(gate.reload);
  const view = gate.data;
  const blocked = !view || view.blockers.length > 0;
  useEffect(() => {
    onBlocked?.(blocked);
  }, [blocked, onBlocked]);
  if (!view) return gate.error ? <ErrorNote error={gate.error} /> : null;
  // Etappe 10: her own projects have no strategy gate (the server returns no blockers or findings): nothing to show
  if (view.projectKind === 'PERSONAL_CONTENT') return null;
  const update = (v: StrategyGateView) => {
    gate.setData(v);
    onChanged?.();
  };
  return (
    <div className="mt-3 rounded-xl border border-line bg-card2 p-3 text-xs" data-testid="strategy-gate">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Strategie-Check</strong>
        {view.legacy ? <Pill>{LEGACY_LABEL}</Pill> : null}
        <span className="text-muted">Kundenprojekt: Grenz-Prüfung (eigene Liste, Wohnort).</span>
        {!view.blockers.length ? <Pill tone="ok">keine offenen Punkte</Pill> : null}
      </div>
      <FindingList view={view} texts={texts} />
      <BlockerList kind={kind} id={id} view={view} onChange={update} />
      <OverrideList view={view} />
      {view.findings.length ? <p className="hint mt-2">{LINT_LIMIT_NOTE}</p> : null}
    </div>
  );
}
