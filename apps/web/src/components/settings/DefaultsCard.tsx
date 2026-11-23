'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import type { DefaultsStatus } from '@/lib/types';
import { Button, ErrorNote, fmtDateTime, Pill } from '../ui';

/** Settings card „Standard“ (Etappe 10): where the active context is mirrored, last backup, drift and actions. */
export function DefaultsCard() {
  const { data: s, error: loadError, reload, setData } = useApi<DefaultsStatus>('/api/defaults');
  const [busy, setBusy] = useState<'snapshot' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (action: 'snapshot' | 'apply') => {
    setBusy(action);
    setError(null);
    setNote(null);
    try {
      const r = await api<{ status: DefaultsStatus; applied?: string[] }>('/api/defaults', { method: 'POST', json: { action } });
      setData(r.status);
      setNote(action === 'snapshot' ? 'Gesichert.' : r.applied?.length ? 'Datei-Stand übernommen – neue aktive Versionen angelegt.' : 'Nichts zu übernehmen.');
    } catch (e) {
      setError((e as Error).message);
      void reload();
    } finally {
      setBusy(null);
    }
  };

  const applicable = s?.files.filter((f) => f.applicable) ?? [];
  const stale = s?.files.filter((f) => f.present && f.valid && f.differs && !f.applicable) ?? [];
  const invalid = s?.files.filter((f) => f.present && !f.valid) ?? [];
  return (
    <section className="panel lg:col-span-2" data-testid="defaults-card">
      <h2 className="mb-1 text-lg font-bold">Standard</h2>
      <p className="hint mb-3">Aktive Strategie, Profil (vollständig), Style Bible und Voice Guide werden bei jeder Aktivierung als JSON in diesen Ordner gesichert. Ein leerer Datenordner startet mit diesem Stand; vorhandene Daten werden nie überschrieben.</p>
      <ErrorNote error={loadError} />
      {s && !s.enabled ? <p className="text-xs text-warn">Aus (<code>STUDIO_DEFAULTS_DIR=off</code>).</p> : null}
      {s?.enabled ? (
        <>
          <dl className="grid grid-cols-[150px_1fr] gap-y-2 text-xs">
            <dt className="text-muted">Ordner</dt><dd className="break-all"><code>{s.dir}</code></dd>
            <dt className="text-muted">Letzte Sicherung</dt><dd>{s.lastSavedAt ? fmtDateTime(s.lastSavedAt) : 'noch keine'}</dd>
            <dt className="text-muted">Dateien</dt>
            <dd className="flex flex-wrap gap-1.5">{s.files.map((f) => (
              <Pill key={f.kind} tone={!f.present ? 'default' : !f.valid ? 'danger' : f.differs ? 'warn' : 'ok'}>
                {f.label}: {!f.present ? 'fehlt' : !f.valid ? 'ungültig' : f.differs ? 'weicht ab' : `aktuell${f.activeVersion != null ? ` (v${f.activeVersion})` : ''}`}
              </Pill>
            ))}</dd>
            {s.seed?.imported.length ? (<><dt className="text-muted">Gestartet mit</dt><dd>{s.seed.imported.length} Datei(en) aus dem Standard ({fmtDateTime(s.seed.at)})</dd></>) : null}
          </dl>
          {s.lastError ? <p role="alert" className="mt-3 text-xs text-danger">{s.lastError}</p> : null}
          {[...s.warnings, ...(s.seed?.warnings ?? []), ...invalid.map((f) => `${f.file} ${f.error ?? 'ist ungültig.'}`)].map((w) => <p key={w} className="mt-2 text-xs text-warn">{w}</p>)}
          {s.foreignOrigin ? (
            <p className="mt-3 text-xs text-warn" data-testid="defaults-foreign-origin">Standard gehört zu einem anderen Datenordner. Aktivierungen hier werden nicht automatisch gesichert; „Jetzt sichern“ überschreibt den Standard mit dem Stand dieses Datenordners.</p>
          ) : null}
          {s.fileNewer && applicable.length ? (
            <div className="mt-3 rounded-lg border border-[#e8cf7a] bg-[#fff6db] p-3 text-xs" data-testid="defaults-file-newer">
              <p className="mb-2 text-warn">Datei neuer als Studio ({applicable.map((f) => f.label).join(', ')}). Übernehmen legt daraus neue aktive Versionen an; die bisherigen bleiben archiviert erhalten.</p>
              <Button size="sm" busy={busy === 'apply'} disabled={!s.canApply || busy != null} onClick={() => run('apply')}>Übernehmen</Button>
            </div>
          ) : null}
          {stale.length ? <p className="mt-3 text-xs text-muted">Der Ordner zeigt einen älteren Stand als das Studio ({stale.map((f) => f.label).join(', ')}). „Jetzt sichern“ schreibt den aktiven Stand.</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" busy={busy === 'snapshot'} disabled={busy != null} onClick={() => run('snapshot')}>Jetzt sichern</Button>
            {note ? <span className="text-xs text-muted">{note}</span> : null}
          </div>
          <ErrorNote error={error} />
        </>
      ) : null}
    </section>
  );
}
