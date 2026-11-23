'use client';
import { useState } from 'react';
import { api, useApi } from '@/lib/api';
import type { TranscriptView } from '@/lib/types';
import { useToast } from '../toast';
import { Button, ErrorNote, Pill } from '../ui';

const SOURCE = { whisper: 'whisper.cpp', mock: 'MOCK · kein echtes Transkript', user_edit: 'von dir korrigiert' } as const;
const t = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;

/** Human gate: the user reads and corrects the transcript; every save is a new version. */
export function TranscriptEditor({ assetId, onSaved }: { assetId: string; onSaved: () => void }) {
  const toast = useToast();
  const tr = useApi<TranscriptView | null>(`/api/footage/${assetId}/transcript`);
  const [texts, setTexts] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = tr.data;
  if (!data) return <ErrorNote error={tr.error} />;
  const values = texts ?? data.body.segments.map((s) => s.text);
  const dirty = texts != null && texts.some((x, i) => x !== data.body.segments[i]?.text);

  return (
    <div className="mt-2 grid gap-2 rounded-lg bg-card2 p-3" data-testid="transcript-editor">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Transkript v{data.version}</strong>
        <Pill tone={data.source === 'mock' ? 'mock' : 'default'}>{SOURCE[data.source]}{data.source === 'mock' && data.version > 1 ? ' · korrigiert' : ''}{data.model ? ` · ${data.model}` : ''}</Pill>
        <span className="text-muted">Gesprochenes kann Fehler enthalten – bitte prüfen und korrigieren. Der Text wird nur verglichen und angezeigt.</span>
      </div>
      {data.body.segments.length ? (
        <ol className="grid gap-1">
          {data.body.segments.map((s, i) => (
            <li key={i} className="grid grid-cols-[88px_1fr] items-start gap-2">
              <span className="pt-2 font-mono text-[10px] text-muted">{t(s.startSec)}–{t(s.endSec)}</span>
              <textarea aria-label={`Segment ${i + 1}`} className="field min-h-0 py-1.5" rows={1} value={values[i]} maxLength={2000}
                onChange={(e) => setTexts(values.map((v, j) => (j === i ? e.target.value : v)))} />
            </li>
          ))}
        </ol>
      ) : <p className="text-muted">Keine Sprache erkannt.</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!dirty} busy={busy} onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api(`/api/transcripts/${data.id}`, { method: 'POST', json: { texts: values } });
            setTexts(null);
            await tr.reload();
            onSaved();
            toast('Korrektur als neue Version gespeichert.');
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}>Korrektur speichern</Button>
        {dirty ? <Button size="sm" variant="ghost" onClick={() => setTexts(null)}>Verwerfen</Button> : null}
      </div>
      <ErrorNote error={error} />
    </div>
  );
}
