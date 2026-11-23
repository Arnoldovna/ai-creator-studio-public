'use client';
import { useState } from 'react';
import { EVAL_CRITERIA_LABELS, EVAL_INPUT_KIND, type EvalCriterion } from '@studio/core/router';
import { splitLines } from '@studio/core/text';
import { api, useApi } from '@/lib/api';
import type { ContextOverview, EvalOverview, EvalRating, EvalRun } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, MockBadge, PageHeader, Pill, RatingScale } from '../ui';

interface Quote { mock: boolean; worstTotalUsd: number; estTotalUsd: number }
type UseCaseId = EvalRun['useCase'];
const STATE_INPUT_HINT: Partial<Record<EvalRun['input']['kind'], string>> = {
  style: 'Verglichen wird mit deinem aktuellen Style-Formular und den bestätigten Beobachtungen – wie beim Button im Style Lab.',
  voice: 'Verglichen wird mit deinen gespeicherten eigenen Texten (Beispiel im Voice-Formular und Voice-Guide).',
  growth: 'Verglichen wird mit deinen eigenen Messwerten; Kundenprojekte sind ausgeschlossen.',
  design: 'Verglichen wird mit deinen bestätigten Beobachtungen, der Style Bible und „Meine Marke“ – wie beim Knopf „KI-Vorschlag“.',
  chat: 'Verglichen wird deine letzte Nachricht im Studio-Chat (mit Verlauf, auf dem aktuellen Stand der Seite); Kundenprojekte sind ausgeschlossen. Nichts wird übernommen.',
  story: 'Verglichen wird dein letzter Dramaturgie-Vorschlag im Editor (gleiche Sätze, gleiche Ziel-Länge, aktueller Stand von Strategie und Meine Marke); nur eigene Projekte. Nichts wird übernommen.',
  carousel: 'Verglichen wird die Quelle deines letzten Karussells (gleicher Aufbau, gleiche Slide-Zahl, aktueller Stand von Voice und Meine Marke); nur eigene Projekte. Nichts wird gespeichert.',
  ig_story: 'Verglichen wird die Quelle deiner letzten Story-Vorschläge (gleiches Material, aktueller Stand von Voice und Meine Marke); nur eigene Projekte. Nichts wird gespeichert.',
  week: 'Verglichen wird „Woche füllen“ für die aktuelle Woche (gleiches Board, gleicher Rhythmus, gleiches Material). Nichts landet auf dem Board.',
};
const usd = (x: number | null | undefined) => (x == null ? '—' : `$${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`);

export function ModelLab() {
  const toast = useToast();
  const { data, error, reload } = useApi<EvalOverview>('/api/eval');
  const [useCase, setUseCase] = useState<EvalRun['useCase']>('reference_image_analysis');
  const [referenceId, setReferenceId] = useState('');
  const [conceptId, setConceptId] = useState('');
  const [scriptId, setScriptId] = useState('');
  const [researchId, setResearchId] = useState('');
  const [brief, setBrief] = useState({ projectId: '', topic: '', audience: '', facts: '', pillarId: '' });
  // optional pillar of the active strategy, as in the Content Lab (Etappe 10: no gate)
  const context = useApi<ContextOverview>('/api/context');
  const pillars = context.data?.pillars ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const uc = data?.useCases.find((u) => u.useCase === useCase);
  const inputKind = EVAL_INPUT_KIND[useCase];
  // The server lists only inputs it accepts (no client data, script gates applied).
  const scripts = data?.scripts.filter((s) => s.useCases.includes(useCase)) ?? [];
  /** The id that is shown is the id that is sent – a stale choice falls back to the first valid option. */
  const pick = (id: string, options: { id: string }[]) => (options.some((o) => o.id === id) ? id : options[0]?.id ?? '');
  const refs = data?.references.filter((r) => (useCase === 'reference_video_analysis' ? r.kind === 'video' : r.kind === 'image')) ?? [];
  const refId = pick(referenceId, refs), scrId = pick(scriptId, scripts), resId = pick(researchId, data?.researchReports ?? []);
  const openRun = data?.runs.find((r) => r.id === openRunId) ?? null;
  const names = new Map(data?.registry.map((m) => [m.id, m.label]) ?? []);
  const label = (id: string) => names.get(id) ?? id;

  /** Any change to task, input or models invalidates the quote and the approval. */
  const invalidate = () => { setQuote(null); setApproved(false); };
  function chooseUseCase(u: UseCaseId) { setUseCase(u); setPicked([]); invalidate(); }
  function toggle(id: string) {
    invalidate();
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 3 ? p : [...p, id]));
  }
  function target() {
    if (!uc || !data) return null;
    if (useCase === 'content_strategy')
      return { useCase, input: { kind: 'brief', brief: { projectId: brief.projectId || data.projects[0]?.id, topic: brief.topic, audience: brief.audience, verifiedFacts: splitLines(brief.facts, 20), pillarId: brief.pillarId || null } } };
    if (useCase === 'ugc_scriptwriting') return { useCase, input: { kind: 'concept', conceptId: pick(conceptId, data.concepts) } };
    if (inputKind === 'script') return { useCase, input: { kind: 'script', scriptId: scrId } };
    if (inputKind === 'research') return { useCase, input: { kind: 'research', reportId: resId } };
    if (inputKind === 'style' || inputKind === 'voice' || inputKind === 'growth' || inputKind === 'design' || inputKind === 'chat' || inputKind === 'story' || inputKind === 'carousel' || inputKind === 'ig_story' || inputKind === 'week') return { useCase, input: { kind: inputKind } };
    return { useCase, input: { kind: 'reference', referenceId: refId } };
  }

  async function getQuote() {
    setBusy(true); setErr(null);
    try { setQuote(await api<Quote>('/api/eval/quote', { method: 'POST', json: { ...target(), modelIds: picked } })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setErr(null);
    try {
      const r = await api<EvalRun>('/api/eval/runs', { method: 'POST', json: { ...target(), modelIds: picked, approvedMaxUsd: approved && quote ? quote.worstTotalUsd : 0 } });
      await reload();
      setOpenRunId(r.id);
      invalidate();
      toast(`Vergleich fertig${r.mock ? ' (Mock)' : ''}: ${r.results.filter((x) => !x.error).length}/${r.results.length} Modelle.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function setPreference(u: string, modelId: string | null) {
    try {
      await api('/api/eval/preferences', { method: 'PUT', json: { useCase: u, modelId } });
      await reload();
      toast(modelId ? 'Bevorzugtes Modell gespeichert.' : 'Automatische Auswahl aktiv.');
    } catch (e) { setErr((e as Error).message); }
  }

  if (error) return <ErrorNote error={error} />;
  if (!data || !uc) return <p className="hint">Lade …</p>;

  return (
    <div className="appear" data-testid="model-lab">
      <PageHeader
        eyebrow="08 / MODEL LAB"
        title="Modelle vergleichen,"
        accent="selbst entscheiden."
        lead="Dieselbe Aufgabe mit 2–3 Modellen auf deinen eigenen Inhalten. Deine Bewertungen fließen ab 5 pro Modell in die Router-Auswahl ein – Mock-Ergebnisse nie. Vergleiche ändern keine Studio-Daten."
        right={data.mock ? <Pill tone="mock">MOCK – kostenlos, Platzhalter-Ausgaben</Pill> : <Pill tone="warn">ECHTE KI – kostenpflichtig</Pill>}
      />

      <section className="panel mb-4" data-testid="eval-setup">
        <h2 className="mb-3 text-lg font-bold">Neuer Vergleich</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid content-start gap-3">
            <Field label="Aufgabe" htmlFor="uc">
              <select id="uc" className="field" value={useCase} onChange={(e) => chooseUseCase(e.target.value as EvalRun['useCase'])}>
                {data.useCases.map((u) => <option key={u.useCase} value={u.useCase}>{u.label}</option>)}
              </select>
            </Field>
            {useCase === 'reference_image_analysis' || useCase === 'reference_video_analysis' ? (
              <Field label="Referenz" htmlFor="ref" hint={refs.length ? undefined : 'Erst im Style Lab eine passende Referenz hochladen.'}>
                <select id="ref" className="field" value={refId} onChange={(e) => { setReferenceId(e.target.value); invalidate(); }}>
                  {refs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </Field>
            ) : inputKind === 'script' ? (
              <Field label="Skriptversion" htmlFor="script" hint={scripts.length ? 'Skripte aus Kundenprojekten sind für Vergleiche gesperrt und nicht aufgeführt.' : 'Erst im Content Lab ein Skript für ein eigenes Projekt schreiben.'}>
                <select id="script" className="field" value={scrId} onChange={(e) => { setScriptId(e.target.value); invalidate(); }}>
                  {scripts.map((x) => <option key={x.id} value={x.id}>v{x.version} · {x.hook.slice(0, 60)}</option>)}
                </select>
              </Field>
            ) : inputKind === 'research' ? (
              <Field label="Quellen aus Recherche" htmlFor="research" hint={data.researchReports.length ? 'Die eingefügten Quellen werden erneut ausgewertet (Kundenprojekte nicht aufgeführt).' : 'Erst im Content Lab eine Recherche für ein eigenes Projekt erstellen.'}>
                <select id="research" className="field" value={resId} onChange={(e) => { setResearchId(e.target.value); invalidate(); }}>
                  {data.researchReports.map((r) => <option key={r.id} value={r.id}>{r.topic}</option>)}
                </select>
              </Field>
            ) : STATE_INPUT_HINT[inputKind] ? (
              <p className="hint" data-testid="eval-state-input">{STATE_INPUT_HINT[inputKind]}</p>
            ) : useCase === 'ugc_scriptwriting' ? (
              <Field label="Konzept" htmlFor="concept" hint={data.concepts.length ? undefined : 'Erst im Content Lab Konzepte erstellen.'}>
                <select id="concept" className="field" value={pick(conceptId, data.concepts)} onChange={(e) => { setConceptId(e.target.value); invalidate(); }}>
                  {data.concepts.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </Field>
            ) : (
              <>
                <Field label="Projekt" htmlFor="proj" hint="Kundenprojekte sind für Vergleiche gesperrt (vertrauliche Kundendaten).">
                  <select id="proj" className="field" value={brief.projectId || data.projects[0]?.id || ''} onChange={(e) => { setBrief({ ...brief, projectId: e.target.value }); invalidate(); }}>
                    {data.projects.map((p) => <option key={p.id} value={p.id}>{p.title}{p.kind === 'UGC_CLIENT' ? ' (Kunde)' : ''}</option>)}
                  </select>
                </Field>
                {data.projects.find((p) => p.id === (brief.projectId || data.projects[0]?.id))?.kind === 'PERSONAL_CONTENT' ? (
                  <Field label="Säule (optional)" htmlFor="lab-pillar" hint={pillars.length ? 'Aus deiner aktiven Strategie.' : 'Keine Säulen in der aktiven Strategie – der Vergleich läuft ohne Säule.'}>
                    <select id="lab-pillar" className="field" value={brief.pillarId} onChange={(e) => { setBrief({ ...brief, pillarId: e.target.value }); invalidate(); }}>
                      <option value="">– keine Säule –</option>
                      {pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </Field>
                ) : null}
                <Field label="Thema" htmlFor="topic"><input id="topic" className="field" value={brief.topic} onChange={(e) => { setBrief({ ...brief, topic: e.target.value }); invalidate(); }} /></Field>
                <Field label="Zielgruppe" htmlFor="aud"><input id="aud" className="field" value={brief.audience} onChange={(e) => { setBrief({ ...brief, audience: e.target.value }); invalidate(); }} /></Field>
                <Field label="Verifizierte Fakten (eine pro Zeile)" htmlFor="facts"><textarea id="facts" rows={2} className="field" value={brief.facts} onChange={(e) => { setBrief({ ...brief, facts: e.target.value }); invalidate(); }} /></Field>
              </>
            )}
          </div>

          <div>
            <div className="mb-2 text-xs font-bold">Modelle (2–3 wählen)</div>
            <ul className="grid gap-1.5" aria-label="Modelle">
              {uc.models.map((m) => (
                <li key={m.id}>
                  <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${m.eligible ? 'border-line' : 'border-line opacity-50'}`} title={m.reason ?? undefined}>
                    <input type="checkbox" disabled={!m.eligible || (!picked.includes(m.id) && picked.length >= 3)} checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                    <span className="font-bold">{label(m.id)}</span>
                    {uc.routerChoice === m.id ? <Pill tone="ok">Router-Wahl</Pill> : null}
                    {uc.preferred === m.id ? <Pill>festgelegt</Pill> : null}
                    <span className="ml-auto text-muted">{m.eligible ? `≈ ${usd(m.estCostUsd)} · max ${usd(m.worstCaseCostUsd)}` : m.reason}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
          {data.mock ? (
            <span className="text-muted">Mock-Modus: keine Kosten, alle Modelle liefern denselben Platzhalter – nur zum Testen der Abläufe.</span>
          ) : quote ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
              Ich gebe Kosten bis {usd(quote.worstTotalUsd)} frei (erwartet ≈ {usd(quote.estTotalUsd)}, Limit pro Vergleich {usd(data.evalMaxUsdPerRun)}).
            </label>
          ) : (
            <Button size="sm" busy={busy} disabled={picked.length < 2} onClick={getQuote}>Kosten berechnen</Button>
          )}
          <Button variant="primary" busy={busy} disabled={picked.length < 2 || (!data.mock && !approved)} onClick={run}>Vergleich starten</Button>
        </div>
        <ErrorNote error={err} />
      </section>

      {openRun ? <RunView key={openRun.id} run={openRun} ratings={data.ratings} criteria={data.useCases.find((u) => u.useCase === openRun.useCase)?.criteria ?? []} label={label} reload={reload} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel">
          <h2 className="mb-3 text-lg font-bold">Bisherige Vergleiche</h2>
          {data.runs.length ? (
            <ul className="grid gap-1.5 text-xs">
              {data.runs.map((r) => (
                <li key={r.id}>
                  <button className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left ${r.id === openRunId ? 'border-accent' : 'border-line'}`} onClick={() => setOpenRunId(r.id)}>
                    <MockBadge mock={r.mock} />
                    <span className="font-bold">{data.useCases.find((u) => u.useCase === r.useCase)?.label}</span>
                    <span className="truncate text-muted">{r.input.label}</span>
                    <span className="ml-auto text-muted">{r.createdAt.slice(0, 16).replace('T', ' ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty>Noch keine Vergleiche.</Empty>}
        </section>

        <section className="panel" data-testid="preferences">
          <h2 className="mb-1 text-lg font-bold">Bevorzugtes Modell pro Aufgabe</h2>
          <p className="hint mb-3">Festgelegt = der Router nimmt dieses Modell, solange Budget und Datenschutz es erlauben. Bewertungen zählen ab {data.minRatings} echten (nicht-Mock) Bewertungen pro Modell.</p>
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] text-muted"><tr><th className="py-1">Aufgabe</th><th>Router-Wahl</th><th>Festlegen</th><th>Deine Bewertungen</th></tr></thead>
            <tbody>
              {data.useCases.map((u) => (
                <tr key={u.useCase} className="border-t border-line align-top">
                  <td className="py-1.5 pr-2">{u.label}</td>
                  <td className="pr-2">{u.routerChoice ? label(u.routerChoice) : '—'}{u.preferred && u.preferred === u.routerChoice ? <span className="text-accent"> · festgelegt</span> : null}</td>
                  <td className="pr-2">
                    <select aria-label={`Bevorzugtes Modell für ${u.label}`} className="field w-auto px-2 py-1 text-[11px]" value={u.preferred ?? ''} onChange={(e) => setPreference(u.useCase, e.target.value || null)}>
                      <option value="">automatisch</option>
                      {u.models.filter((m) => m.eligible || m.id === u.preferred).map((m) => <option key={m.id} value={m.id}>{label(m.id)}</option>)}
                    </select>
                  </td>
                  <td className="text-muted">
                    {u.models.filter((m) => m.ratings.n || m.ratings.mockN).map((m) => (
                      <div key={m.id}>{label(m.id)}: {m.ratings.n} echt{m.ratings.mean != null ? ` · Ø ${Math.round(m.ratings.mean * 100)} %` : ''}{m.ratings.mockN ? ` · ${m.ratings.mockN} Mock` : ''}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function RunView({ run, ratings, criteria, label, reload }: { run: EvalRun; ratings: EvalRating[]; criteria: EvalCriterion[]; label: (id: string) => string; reload: () => Promise<void> }) {
  return (
    <section className="panel mb-4" data-testid="eval-run">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-lg font-bold">Ergebnis: {run.input.label}</h2>
        <MockBadge mock={run.mock} />
        {run.mock ? <span className="text-[11px] text-warn">Mock-Bewertungen beeinflussen den Router nicht.</span> : null}
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${run.results.length}, minmax(0, 1fr))` }}>
        {run.results.map((r) => (
          <article key={`${run.id}:${r.modelId}`} className="min-w-0 rounded-xl border border-line bg-card2 p-3" data-testid="eval-result">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <strong className="text-sm">{label(r.modelId)}</strong>
              <span className="text-[11px] text-muted">{usd(r.costUsd)} · {r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)} s` : '—'}</span>
            </div>
            {r.error ? <p className="text-xs text-danger">{r.error}</p> : <OutputView useCase={run.useCase} output={r.output} />}
            {!r.error ? <RatingForm run={run} modelId={r.modelId} criteria={criteria} existing={ratings.find((x) => x.evalRunId === run.id && x.modelId === r.modelId) ?? null} reload={reload} /> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * For agents whose result is `{ value | suggestion, warnings }`: headline texts, list items with their evidence
 * (quote / basis) and every integrity signal (studio warnings, failed caption lint, unverified numbers) –
 * so factuality is rated on what the studio checked, not on a count.
 */
function GenericOutput({ output }: { output: Record<string, unknown> }) {
  const v = (output.value ?? output.suggestion ?? output) as Record<string, unknown>;
  const warnings = Array.isArray(output.warnings) ? (output.warnings as string[]) : [];
  const lintFails = Array.isArray(v.lint) ? (v.lint as { level: string; message: string }[]).filter((l) => l.level === 'fail').map((l) => l.message) : [];
  const texts = Object.entries(v).filter(([, x]) => typeof x === 'string' && x.trim()).slice(0, 4) as [string, string][];
  const lists = Object.entries(v).filter(([k, x]) => Array.isArray(x) && k !== 'lint') as [string, unknown[]][];
  const item = (x: unknown): string | null => {
    if (typeof x === 'string') return x;
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    const main = [o.statement, o.issue, o.trait, o.shot, o.intent, o.change, o.pattern].find((t) => typeof t === 'string');
    if (typeof main !== 'string') return null;
    const tag = typeof o.basis === 'string' ? `[${o.basis === 'source' ? 'belegt' : 'Annahme'}] ` : typeof o.severity === 'string' ? `[${o.severity}] ` : '';
    const quote = typeof o.quote === 'string' && o.quote ? ` – „${o.quote}“` : typeof o.evidenceQuote === 'string' ? ` – „${o.evidenceQuote}“` : '';
    return `${tag}${main}${quote}`;
  };
  return (
    <div className="grid gap-1 text-[11px]">
      {texts.map(([k, x]) => <p key={k}><span className="text-muted">{k}:</span> {x.length > 400 ? `${x.slice(0, 400)} …` : x}</p>)}
      {lists.map(([k, xs]) => {
        const items = xs.map(item).filter((x): x is string => !!x);
        return items.length
          ? <div key={k}><span className="text-muted">{k} ({xs.length}):</span><ul className="ml-3 list-disc">{items.slice(0, 6).map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          : <p key={k} className="text-muted">{k}: {xs.length}</p>;
      })}
      {[...lintFails, ...warnings].map((w) => <p key={w} className="text-warn">⚠ {w}</p>)}
    </div>
  );
}

/** Compact, readable view of each agent's output; full JSON on demand. */
function OutputView({ useCase, output }: { useCase: EvalRun['useCase']; output: unknown }) {
  const o = output as Record<string, unknown>;
  let body: React.ReactNode = null;
  if (useCase === 'reference_image_analysis' || useCase === 'reference_video_analysis') {
    const obs = (o.observations as { dimension: string; statement: string; confidence: number }[] | undefined) ?? [];
    body = (
      <>
        <p className="mb-2 text-xs">{String(o.summary ?? '')}</p>
        <ul className="grid gap-1 text-[11px] text-[#343b2d]">{obs.map((x, i) => <li key={i}><span className="text-muted">[{x.dimension} · {Math.round(x.confidence * 100)} %]</span> {x.statement}</li>)}</ul>
      </>
    );
  } else if (useCase === 'content_strategy') {
    const concepts = (o.concepts as { title: string; hook: string; angle: string }[] | undefined) ?? [];
    body = <ol className="grid list-decimal gap-2 pl-4 text-[11px]">{concepts.map((c, i) => <li key={i}><strong>{c.title}</strong><div className="text-[#343b2d]">Hook: {c.hook}</div><div className="text-muted">{c.angle}</div></li>)}</ol>;
  } else if (useCase !== 'ugc_scriptwriting') {
    body = <GenericOutput output={o} />;
  } else {
    const scenes = (o.scenes as { startSecond: number; endSecond: number; dialogue: string }[] | undefined) ?? [];
    body = (
      <>
        <p className="mb-2 text-xs"><strong>Hook:</strong> {String(o.selectedHook ?? '')}</p>
        <ul className="grid gap-1 text-[11px] text-[#343b2d]">{scenes.map((s, i) => <li key={i}><span className="text-muted">{s.startSecond}–{s.endSecond}s</span> {s.dialogue}</li>)}</ul>
        <p className="mt-2 text-xs"><strong>CTA:</strong> {String(o.cta ?? '')}</p>
      </>
    );
  }
  return (
    <div>
      {body}
      <details className="mt-2 text-[10px] text-muted"><summary>Vollständige Ausgabe (JSON)</summary><pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(output, null, 2)}</pre></details>
    </div>
  );
}

function RatingForm({ run, modelId, criteria, existing, reload }: { run: EvalRun; modelId: string; criteria: EvalCriterion[]; existing: EvalRating | null; reload: () => Promise<void> }) {
  const toast = useToast();
  const [ratings, setRatings] = useState<Partial<Record<EvalCriterion, number>>>(existing?.ratings ?? {});
  const [correction, setCorrection] = useState(existing?.correction ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api(`/api/eval/runs/${run.id}/ratings`, { method: 'POST', json: { modelId, ratings, correction } });
      await reload();
      toast('Bewertung gespeichert.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3 border-t border-line pt-3" data-testid="rating-form">
      <div className="grid gap-1.5">
        {criteria.map((c) => (
          <div key={c} className="flex items-center justify-between gap-2 text-[11px]">
            <span>{EVAL_CRITERIA_LABELS[c]}</span>
            <RatingScale label={`${EVAL_CRITERIA_LABELS[c]} für ${modelId}`} itemLabel={EVAL_CRITERIA_LABELS[c]} value={ratings[c] ?? null} size="sm" onChange={(n) => setRatings({ ...ratings, [c]: n ?? undefined })} />
          </div>
        ))}
      </div>
      <textarea rows={2} aria-label="Korrektur / Notiz" placeholder="Korrektur oder Notiz (optional)" className="field mt-2 text-[11px]" value={correction} onChange={(e) => setCorrection(e.target.value)} />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" busy={busy} disabled={!Object.keys(ratings).length} onClick={save}>{existing ? 'Bewertung aktualisieren' : 'Bewertung speichern'}</Button>
        {existing ? <span className="text-[10px] text-muted">Score {Math.round(existing.score * 100)} %</span> : null}
      </div>
      <ErrorNote error={err} />
    </div>
  );
}
