'use client';
import { useState } from 'react';
import { GROWTH_METRIC_LABEL } from '@studio/core/insights';
import { api, useApi } from '@/lib/api';
import type { GrowthReportRecord } from '@/lib/types';
import { useToast } from '../toast';
import { Button, ErrorNote, List, OutputCard, Pill } from '../ui';

/** Growth Analyst: interprets the measured table; a report only reaches ideation after "Für Ideation verwenden". */
export function GrowthPanel() {
  const toast = useToast();
  const { data, reload } = useApi<GrowthReportRecord[]>('/api/growth/reports');
  const [includeClient, setIncludeClient] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = data?.[0] ?? null;
  const approved = data?.find((r) => r.status === 'approved') ?? null;

  const setUse = (id: string, use: boolean, label: string) =>
    act(label, () => api(`/api/growth/reports/${id}/use`, { method: 'POST', json: { use } }), use ? 'Wird dem Content Strategist als Testidee übergeben.' : 'Nicht mehr für Ideation verwendet.');
  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label); setError(null);
    try { await fn(); await reload(); toast(ok); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="panel mt-4" data-testid="growth-panel">
      <h2 className="mb-1 text-lg font-bold">Growth-Analyse</h2>
      <p className="hint">Das Studio berechnet die Kennzahlen; der Agent interpretiert nur diese Tabelle, vergleicht nur im selben Messfenster und schlägt Experimente vor. Style- und Voice-Regeln ändert er nie.</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button busy={busy === 'run'} onClick={() => act('run', () => api('/api/growth/reports', { method: 'POST', json: { includeClient } }), 'Growth-Analyse erstellt – bitte prüfen.')}>Growth-Analyse erstellen</Button>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={includeClient} onChange={(e) => setIncludeClient(e.target.checked)} /> Kundenprojekte einbeziehen (vertraulich, nicht für eigene Ideation)
        </label>
      </div>
      {approved ? (
        <p className="hint mt-2">
          Für Ideation verwendet: Bericht vom {approved.createdAt.slice(0, 10)}.{' '}
          {approved.id !== report?.id ? <Button size="sm" variant="ghost" busy={busy === 'unuse'} onClick={() => setUse(approved.id, false, 'unuse')}>Nicht mehr verwenden</Button> : null}
        </p>
      ) : null}
      <ErrorNote error={error} />
      {report ? (
        <OutputCard testId="growth-report" title="Growth-Bericht" mock={report.mock} createdAt={report.createdAt} warnings={report.warnings}
          badges={<>{report.status === 'approved' ? <Pill tone="ok">für Ideation</Pill> : <Pill tone="warn">Entwurf</Pill>}{report.includesClientData ? <Pill tone="danger">enthält Kundendaten</Pill> : null}</>}>
          <p className="mb-1 text-muted">Datenbasis: {report.output.windows.map((w) => `${w.window}: ${w.posts} Beitrag/Beiträge`).join(' · ')}</p>
          <p className="mb-2">{report.output.summary}</p>
          <List title="Beobachtungen" items={report.output.observations.map((o) => `[${o.window}] ${o.statement}`)} />
          <div className="mt-2 font-semibold">Hypothese</div>
          <p>{report.output.hypothesis}</p>
          {report.output.unverifiedNumbers.length ? <p className="text-warn">⚠ Zahlen ohne Beleg in den Daten: {report.output.unverifiedNumbers.join(', ')}</p> : null}
          <List title="Experimente" items={report.output.experiments.map((e) => `${e.change} · konstant: ${e.keepConstant} · Messung: ${GROWTH_METRIC_LABEL[e.metric]} im ${e.window}-Fenster, mind. ${e.minPosts} Beiträge · Erfolg: ${e.successCriterion}`)} />
          <List title="Grenzen" items={report.output.limitations} tone="text-warn" />
          <div className="mt-3">
            {report.status === 'approved' ? (
              <Button size="sm" variant="ghost" busy={busy === 'use'} onClick={() => setUse(report.id, false, 'use')}>Nicht mehr verwenden</Button>
            ) : (
              <Button size="sm" disabled={report.includesClientData || report.output.unverifiedNumbers.length > 0}
                title={report.includesClientData ? 'Enthält Kundendaten' : report.output.unverifiedNumbers.length ? 'Enthält Zahlen ohne Beleg' : undefined}
                busy={busy === 'use'} onClick={() => setUse(report.id, true, 'use')}>
                ✓ Für Ideation verwenden
              </Button>
            )}
          </div>
        </OutputCard>
      ) : null}
    </section>
  );
}
