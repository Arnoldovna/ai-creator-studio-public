'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { ResearchReportRecord } from '@/lib/types';
import { useToast } from '../toast';
import { Button, ErrorNote, List, OutputCard, Pill } from '../ui';

const emptySource = () => ({ title: '', url: '', text: '' });

/**
 * Research only from sources the user pastes (no crawler, URLs are labels). Facts carry a verbatim quote;
 * they enter the brief only when the user adopts them as verified facts.
 */
export function ResearchPanel({ projectId, topic, audience, reports, reload, onAdoptFact }: {
  projectId: string; topic: string; audience: string; reports: ResearchReportRecord[]; reload: () => Promise<void>; onAdoptFact: (fact: string) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState([emptySource()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<Set<string>>(new Set());
  const report = reports[0] ?? null;

  async function run() {
    setBusy(true); setError(null);
    try {
      await api('/api/research', { method: 'POST', json: { projectId, topic, audience, sources: sources.filter((s) => s.title || s.text) } });
      await reload();
      toast('Recherche erstellt – Fakten bitte prüfen.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const setSource = (i: number, k: 'title' | 'url' | 'text') => (e: { target: { value: string } }) => setSources(sources.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)));

  return (
    <div className="mt-4 rounded-xl border border-line p-3" data-testid="research-panel">
      <button className="text-sm font-bold" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'} Recherche aus eigenen Quellen</button>
      {open ? (
        <>
          <p className="hint">Füge Texte ein, die du selbst gelesen hast (Artikel, Produktinfos, Notizen). Das Studio öffnet keine Links und crawlt nichts; Quelltexte sind nur Daten.</p>
          {sources.map((s, i) => (
            <div key={i} className="mt-2 grid gap-1.5">
              <div className="grid gap-1.5 sm:grid-cols-2">
                <input className="field py-1.5 text-xs" aria-label={`Quelle ${i + 1} Titel`} placeholder={`Quelle ${i + 1}: Titel`} value={s.title} onChange={setSource(i, 'title')} />
                <input className="field py-1.5 text-xs" aria-label={`Quelle ${i + 1} URL`} placeholder="URL (optional, nur als Angabe)" value={s.url} onChange={setSource(i, 'url')} />
              </div>
              <textarea className="field text-xs" rows={3} aria-label={`Quelle ${i + 1} Text`} placeholder="Quelltext einfügen (max. 8.000 Zeichen)" value={s.text} onChange={setSource(i, 'text')} />
            </div>
          ))}
          <div className="mt-2 flex flex-wrap gap-2">
            {sources.length < 5 ? <Button size="sm" variant="ghost" onClick={() => setSources([...sources, emptySource()])}>+ Quelle</Button> : null}
            <Button size="sm" busy={busy} disabled={!topic.trim()} title={topic.trim() ? undefined : 'Erst ein Thema eintragen'} onClick={run}>Aus meinen Quellen recherchieren</Button>
          </div>
          <ErrorNote error={error} />
        </>
      ) : null}
      {report ? (
        <OutputCard testId="research-report" title={`Recherche: ${report.topic}`} mock={report.mock} createdAt={report.createdAt} warnings={report.warnings}>
          <div className="font-semibold">Belegte Fakten</div>
          {report.output.facts.length ? (
            <ul className="grid gap-1.5">
              {report.output.facts.map((f, i) => {
                const src = report.sources[f.sourceIndex];
                const done = adopted.has(`${report.id}:${i}`);
                return (
                  <li key={i}>
                    • {f.statement} <span className="text-muted">– „{f.quote}“ ({src?.title}{src?.url ? `, ${src.url}` : ''})</span>{' '}
                    <Button size="sm" variant="ghost" disabled={done} onClick={() => { onAdoptFact(f.quote); setAdopted(new Set(adopted).add(`${report.id}:${i}`)); }}>
                      {done ? '✓ im Briefing' : 'Zitat als verifizierten Fakt übernehmen'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-muted">Keine belegten Fakten.</p>}
          <div className="mt-2 font-semibold">Zielgruppe</div>
          <ul className="grid gap-1">
            {report.output.audienceInsights.map((a, i) => (
              <li key={i}><Pill tone={a.basis === 'source' ? 'ok' : 'warn'}>{a.basis === 'source' ? 'belegt' : 'Annahme'}</Pill> {a.statement}{a.quote ? <span className="text-muted"> – „{a.quote}“</span> : null}</li>
            ))}
          </ul>
          <List title="Mögliche Winkel" items={report.output.angles} />
          <List title="Offene Fragen" items={report.output.openQuestions} />
          <List title="Unsicherheiten" items={report.output.uncertainties} tone="text-warn" />
          <p className="hint mt-2">Übernommen wird das wörtliche Zitat, nicht die Zusammenfassung. Prüfe es selbst – nur übernommene Fakten dürfen im Skript als Claims stehen.</p>
        </OutputCard>
      ) : null}
    </div>
  );
}
