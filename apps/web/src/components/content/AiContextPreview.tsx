'use client';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { ErrorNote, Pill } from '../ui';

export interface AiPreview {
  text: string;
  strategyVersionId: string | null;
  profileVersionId: string | null;
  labels: { strategy: string | null; profile: string | null; sources: string | null };
  sizeWarning: string | null;
  confidentialRouting: boolean;
  confidentialBlocked: string | null;
  mock: boolean;
  note: string | null;
}

const SEEN_KEY = 'studio.aiContextPreview.seen';

/**
 * „Was an die KI geht“: the strategy/profile text the agents for this subject receive (same projection as the
 * request). Open on the first view, collapsed afterwards (per browser; works without storage too).
 */
export function AiContextPreview({ subject }: { subject: { projectId: string } | { conceptId: string } | { scriptId: string } }) {
  const [key, id] = Object.entries(subject)[0] as [string, string];
  const preview = useApi<AiPreview>(`/api/strategy/ai-preview?${key}=${encodeURIComponent(id)}`);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let seen = false;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === '1';
      if (!seen) window.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // storage blocked: stays open
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from browser storage after mount
    if (seen) setOpen(false);
  }, []);
  const p = preview.data;
  const labels = p ? [p.labels.strategy, p.labels.profile, p.labels.sources].filter(Boolean).join(' · ') : '';
  return (
    <details
      className="mt-4 rounded-lg border border-line bg-[#f8f9f4] p-3 text-xs"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      data-testid="ai-context-preview"
    >
      <summary className="cursor-pointer font-bold">Was an die KI geht{labels ? ` · ${labels}` : ''}</summary>
      {p ? (
        <div className="mt-2 grid gap-2">
          <div className="flex flex-wrap gap-1.5">
            {p.mock ? <Pill tone="mock">Mock-Modus: es wird nichts gesendet.</Pill> : null}
            {p.confidentialRouting ? <Pill tone="ok">Kundenprojekt: nur Modelle ohne Datenspeicherung.</Pill> : null}
            {p.confidentialBlocked ? <Pill tone="warn">Derzeit kein Modell freigegeben</Pill> : null}
          </div>
          {p.confidentialBlocked ? (
            <p className="m-0 text-warn" data-testid="confidential-blocked">
              KI-Aufrufe für dieses Kundenprojekt werden abgelehnt, es wird nichts gesendet: {p.confidentialBlocked}. Freigabe über CONFIDENTIAL_ALLOWED_FAMILIES (siehe Einstellungen).
            </p>
          ) : null}
          {p.note ? <p className="hint m-0">{p.note}</p> : null}
          {p.sizeWarning ? <p className="m-0 text-warn">{p.sizeWarning}</p> : null}
          {p.text ? (
            <>
              <pre className="max-h-64 overflow-auto rounded border border-line bg-white p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words">{p.text}</pre>
              <p className="hint m-0">Inhaltlich identisch mit dem, was an das Modell geht: das vollständige aktive Strategie- und Profil-Dokument und die Quellen mit „Immer mitsenden“ – als Daten, nicht als Anweisung.</p>
            </>
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={preview.error} />
    </details>
  );
}
