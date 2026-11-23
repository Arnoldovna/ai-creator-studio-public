'use client';
import { useEffect, useRef, useState } from 'react';
import { addCuts, type CutSuggestion } from '@studio/core/cuts';
import type { CutRange } from '@studio/core/edit';
import { api } from '@/lib/api';
import type { CutSuggestionsView } from '@/lib/types';
import { Button, Pill } from '../ui';

const KIND_LABEL: Record<CutSuggestion['kind'], string> = { filler: 'Füllwort', weak_filler: 'Füllwort?', pause: 'Pause', sound: 'Laut' };
const MAX_CUTS = 40;
const sec = (n: number) => n.toFixed(2).replace('.', ',');

/** The clip already has a cut that covers this suggestion. */
const taken = (cuts: readonly CutRange[], s: CutSuggestion) => cuts.some((c) => c.startSec <= s.startSec + 0.001 && c.endSec >= s.endSec - 0.001);

/**
 * Filler and pause suggestions for one clip (Etappe 8). Nothing is pre-checked: the user picks single
 * suggestions or explicitly takes all safe ones; they become cuts of the draft and reach the video only after
 * save, approval and render review. ▶ plays the place in the clip player (0,5 s before to 0,5 s after).
 */
export function CutSuggestions({ projectId, scriptId, clip, onAccept, onPreview }: {
  projectId: string;
  /** The plan's script: its verified claims are protected as in the save gate. null = free cut. */
  scriptId: string | null;
  clip: { assetId: string; inSec: number; outSec: number; cuts: CutRange[] };
  onAccept: (cuts: CutRange[], notice: string) => void;
  onPreview: (fromSec: number, toSec: number) => void;
}) {
  const [data, setData] = useState<CutSuggestionsView | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [sounds, setSounds] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `${clip.assetId}|${clip.inSec}|${clip.outSec}|${sounds ? 1 : 0}|${scriptId ?? ''}`;

  /** `poll`: a background refresh while a scan runs – keeps the picks that still exist and shows no busy state. */
  async function load(poll = false) {
    if (!poll) { setBusy(true); setError(null); } // a poll must not wipe an accept error
    try {
      const q = new URLSearchParams({ assetId: clip.assetId, inSec: String(clip.inSec), outSec: String(clip.outSec), sounds: sounds ? '1' : '0', scriptId: scriptId ?? '' });
      const next = await api<CutSuggestionsView>(`/api/projects/${projectId}/cut-suggestions?${q}`);
      setData(next);
      setLoadedFor(key);
      const ids = new Set(next.suggestions.map((s) => s.id));
      setPicked((p) => (poll ? new Set([...p].filter((id) => ids.has(id))) : new Set()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (!poll) setBusy(false);
    }
  }
  // the interval always calls the latest `load`, i.e. with the clip's current In/Out, take and script
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  // while a scan (or the transcription with its scan) runs: look again every 2 s
  const running = data?.scanRunning ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void loadRef.current(true), 2000);
    return () => clearInterval(t);
  }, [running]);

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/footage/${clip.assetId}/silence-scan`, { method: 'POST' });
      await load();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function accept(list: CutSuggestion[]) {
    if (!list.length) return;
    const { cuts, joined, refused } = addCuts(clip.cuts, list.map((s) => ({ startSec: s.startSec, endSec: s.endSec, reason: s.reason, word: s.word })), clip, data?.silences ?? []);
    if (cuts.length > MAX_CUTS) return setError(`Höchstens ${MAX_CUTS} Schnitte pro Clip – bitte weniger Vorschläge auswählen.`);
    const why = 'weniger als 0,2 s neben einem anderen Schnitt, und dazwischen ist keine gemessene Stille (dort kann ein Wortende liegen) – bitte anhören und bei Bedarf von Hand schneiden';
    if (refused === list.length) return setError(`Nicht übernommen: ${why}.`);
    setError(null);
    setPicked(new Set());
    const accepted = list.length - refused;
    onAccept(cuts, `${accepted} Vorschlag${accepted === 1 ? '' : 'e'} als Schnitt übernommen${joined ? `, ${joined}× mit einem Nachbarschnitt über Stille zusammengelegt` : ''}${refused ? `; ${refused} nicht übernommen: ${why}` : ''} – wirkt erst nach Speichern, Freigeben und Render-Prüfung.`);
  }

  const stale = data != null && loadedFor !== key;
  const open = (data?.suggestions ?? []).filter((s) => !taken(clip.cuts, s));
  const safe = open.filter((s) => s.safe);
  const chosen = open.filter((s) => picked.has(s.id) && !s.blocked);

  return (
    <div className="rounded-lg border border-line p-2" data-testid="cut-suggestions">
      <div className="flex flex-wrap items-center gap-2">
        <strong>Füllwörter &amp; Pausen</strong>
        <span className="text-muted">Vorschläge aus Transkript und gemessener Stille – nichts ist vorausgewählt.</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={sounds} onChange={(e) => setSounds(e.target.checked)} />
          unbenannte Laute zeigen (unsicher)
        </label>
        <Button size="sm" busy={busy} onClick={() => void load()}>{data ? 'Neu laden' : 'Vorschläge laden'}</Button>
      </div>
      {stale ? <p className="hint text-warn">In/Out oder Auswahl geändert – Vorschläge neu laden.</p> : null}
      {error ? <p role="alert" className="mt-1 text-danger">{error}</p> : null}
      {data ? (
        <div className="mt-2 grid gap-1">
          {data.status === 'no_audio' ? <p className="hint">Dieses Footage hat keine Tonspur.</p> : null}
          {data.status === 'no_transcript' ? <p className="hint">{data.scanRunning ? 'Transkription läuft …' : 'Erst den Clip transkribieren (Footage-Liste oben).'}</p> : null}
          {data.scanError && !data.scanRunning ? (
            <p className="hint flex flex-wrap items-center gap-2 text-danger" role="alert">
              Pausen-Messung fehlgeschlagen: {data.scanError}{data.status === 'ready' ? ' – die Vorschläge nutzen noch die ältere Messung.' : ''}
              {data.status === 'ready' ? <Button size="sm" busy={busy} onClick={() => void scan()}>Erneut messen</Button> : null}
            </p>
          ) : null}
          {data.status === 'no_scan' ? (
            <p className="hint flex flex-wrap items-center gap-2">
              {data.scanRunning ? 'Pausen werden gemessen …' : data.scanError ? 'Ohne Pausen-Messung gibt es keine Vorschläge.' : 'Für diesen Clip sind die Pausen noch nicht gemessen.'}
              {!data.scanRunning ? <Button size="sm" busy={busy} onClick={() => void scan()}>{data.scanError ? 'Erneut messen' : 'Pausen messen'}</Button> : null}
            </p>
          ) : null}
          {data.transcript?.source === 'mock' ? (
            <p className="hint text-warn" data-testid="mock-transcript-note">Demo-Transkript (Mock-Modus): Platzhaltertext, keine echte Spracherkennung. Füllwort-Vorschläge daraus sind nicht aussagekräftig; nur die gemessenen Pausen sind echt.</p>
          ) : data.transcript && !data.transcript.fillerPrompt ? (
            <p className="hint text-warn">Transkript v{data.transcript.version} wurde ohne Füllwort-Prompt erstellt: whisper lässt „ähm“ dann oft weg oder schreibt es als Wort. Für Füllwort-Vorschläge den Clip neu transkribieren.</p>
          ) : null}
          {data.status === 'ready' && !data.dtw ? <p className="hint text-warn">Ohne DTW-Wortzeiten sind alle Füllwort-Vorschläge unsicher (bitte anhören).</p> : null}
          {data.status === 'ready' && data.untimedSegments ? <p className="hint">{data.untimedSegments} korrigierte Sätze ohne Wortzeiten: dort gibt es keine Füllwort-Vorschläge.</p> : null}
          {data.status === 'ready' && data.skippedFillers ? <p className="hint">{data.skippedFillers} Füllwort{data.skippedFillers === 1 ? '' : 'e'} ohne hörbare Lücke im Ton – nicht vorgeschlagen, bei Bedarf manuell schneiden.</p> : null}
          {data.clientProject ? <p className="hint text-warn">Kundenprojekt: Schnitte verändern gesprochene Aussagen. Sätze mit Kunden-Claims werden nicht automatisch gekürzt.</p> : null}
          {data.status === 'ready' && data.scan ? <p className="hint">Stille gemessen unter {String(data.scan.noiseDb).replace('.', ',')} dB (20 dB unter dem Mittel des Clips) · Vorschläge aus Transkript v{data.transcript?.version}, derselben Version wie die Untertitel.</p> : null}
          {data.status === 'ready' && !data.suggestions.length ? <p className="hint">Keine Vorschläge in diesem Clip.</p> : null}
          {data.suggestions.length ? (
            <ul className="grid gap-1" aria-label="Schnittvorschläge">
              {data.suggestions.map((s) => {
                const done = taken(clip.cuts, s);
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-2" data-testid="cut-suggestion">
                    <input type="checkbox" aria-label={`Vorschlag ${KIND_LABEL[s.kind]} ${sec(s.startSec)}–${sec(s.endSec)} s auswählen`} disabled={done || !!s.blocked}
                      checked={done || picked.has(s.id)} onChange={(e) => setPicked((p) => {
                        const n = new Set(p);
                        if (e.target.checked) n.add(s.id); else n.delete(s.id);
                        return n;
                      })} />
                    <Pill tone={s.kind === 'pause' ? 'default' : 'warn'}>{KIND_LABEL[s.kind]}{s.word ? `: „${s.word}“` : ''}</Pill>
                    <span>{sec(s.startSec)}–{sec(s.endSec)} s ({sec(s.endSec - s.startSec)} s)</span>
                    <Pill tone={s.confidence === 'high' ? 'ok' : 'warn'}>{s.confidence === 'high' ? 'sicher' : 'unsicher'}</Pill>
                    <Button size="sm" variant="ghost" onClick={() => onPreview(s.startSec - 0.5, s.endSec + 0.5)}>▶ anhören</Button>
                    {done ? <span className="text-muted">übernommen</span> : null}
                    {s.blocked ? <span className="text-danger">{s.blocked}</span> : s.note ? <span className="text-muted">{s.note}</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {open.length ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!chosen.length || stale} onClick={() => accept(chosen)}>Ausgewählte übernehmen ({chosen.length})</Button>
              <Button size="sm" disabled={!safe.length || stale} onClick={() => accept(safe)}>Alle sicheren übernehmen ({safe.length})</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
