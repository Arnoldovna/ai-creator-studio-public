'use client';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/api';
import type { AiBrollState, EditState } from '@/lib/types';
import { useToast } from '../toast';
import { Button, ErrorNote, Pill } from '../ui';

type Gen = AiBrollState['generations'][number];
const STATUS: Record<Gen['status'], { label: string; tone: 'default' | 'mock' | 'warn' | 'ok' | 'danger' }> = {
  quoted: { label: 'geschätzt · wartet auf Freigabe', tone: 'warn' },
  queued: { label: 'freigegeben · wartet', tone: 'default' },
  running: { label: 'läuft bei Higgsfield', tone: 'default' },
  review: { label: 'fertig · bitte prüfen', tone: 'warn' },
  approved: { label: 'geprüft · freigegeben', tone: 'ok' },
  rejected: { label: 'abgelehnt', tone: 'default' },
  failed: { label: 'fehlgeschlagen', tone: 'danger' },
  cancelled: { label: 'abgebrochen', tone: 'default' },
};

/**
 * Generated B-roll (Release 3, Etappe 7): opt-in per project, quote, per-clip credit approval, asset review,
 * then a new EDL version. Nothing here spends credits without the explicit approval button.
 */
export function AiBroll({ projectId, onPlansChanged }: { projectId: string; onPlansChanged: () => void }) {
  const toast = useToast();
  const state = useApi<AiBrollState>(`/api/projects/${projectId}/ai-broll`);
  const edit = useApi<EditState>(`/api/projects/${projectId}/edit-plans`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [budgetInput, setBudgetInput] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, { model: string; durationSec: number; resolution: '720p' | '1080p' | null }>>({});
  const [maxCredits, setMaxCredits] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [targetPlan, setTargetPlan] = useState<Record<string, string>>({});
  const { reload } = state;
  const live = (state.data?.generations ?? []).some((g) => g.status === 'queued' || g.status === 'running');

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [live, reload]);

  const d = state.data;
  if (!d) return <section className="panel mb-4"><h2 className="text-base font-semibold">KI-B-Roll</h2><ErrorNote error={state.error} /></section>;

  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await reload();
      if (done) toast(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const st = d.status;
  const statusPill = st.state === 'disabled' ? <Pill>aus</Pill>
    : st.mode === 'mock' ? <Pill tone="mock">MOCK · keine echten Credits, Testbild statt Video</Pill>
    : st.state === 'ready' ? <Pill tone="ok">Higgsfield-CLI bereit{st.credits != null ? ` · Guthaben ${st.credits} Credits` : ''}</Pill>
    : st.state === 'needs_login' ? <Pill tone="warn">Einrichtung nötig</Pill> : <Pill tone="danger">nicht verfügbar</Pill>;
  const usable = st.state === 'ready';
  const b = d.budget;
  const plans = edit.data?.plans ?? [];

  return (
    <section className="panel mb-4" data-testid="ai-broll">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">KI-B-Roll</h2>
        {statusPill}
      </div>
      <p className="mt-1 text-[13px] text-muted">
        Optional: kurze generierte Zwischenbilder aus freigegebenen Asset-Briefs des Storyboards. Nie für Produktszenen, immer mit dem Label „KI-generierte Bildelemente“ im Video.
        Jeder Clip kostet Higgsfield-Credits und startet erst nach deiner Freigabe; fehlgeschlagene Jobs werden nicht automatisch wiederholt.
      </p>
      {st.reason ? <p className="mt-2 text-[13px] text-warn">{st.reason}</p> : null}

      {st.state !== 'disabled' ? (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-card2 p-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!d.optIn} onChange={(e) => void act('optin', () => api(`/api/projects/${projectId}/ai-broll`, { method: 'POST', json: { action: 'opt-in', enabled: e.target.checked, creditBudget: Number(budgetInput ?? d.optIn?.creditBudget ?? 0) } }))} />
              Für dieses Projekt KI-B-Roll erlauben
            </label>
            {d.optIn ? (
              <>
                <label className="text-sm" htmlFor="ab-budget">Projektbudget (Credits)</label>
                <input id="ab-budget" className="field w-28" type="number" min={0} value={budgetInput ?? String(d.optIn.creditBudget)} onChange={(e) => setBudgetInput(e.target.value)} />
                <Button size="sm" busy={busy === 'budget'} disabled={budgetInput == null} onClick={() => void act('budget', async () => {
                  await api(`/api/projects/${projectId}/ai-broll`, { method: 'POST', json: { action: 'opt-in', enabled: true, creditBudget: Number(budgetInput) } });
                  setBudgetInput(null);
                }, 'Projektbudget gespeichert.')}>Speichern</Button>
              </>
            ) : null}
            <span className="text-[12px] text-muted" data-testid="ai-broll-budget">
              Monat: {b.monthCommitted} / {b.monthLimit} Credits gebunden{b.monthLimit <= 0 ? ' (HIGGSFIELD_MONTHLY_CREDITS nicht gesetzt)' : ''} · Projekt: {b.projectCommitted} / {b.projectLimit}
            </span>
          </div>

          {d.optIn ? (
            d.briefs.length ? (
              <ul className="mt-3 grid gap-2">
                {d.briefs.map((br) => {
                  const c = choice[br.briefId] ?? { model: d.models[0]!.id, durationSec: d.models[0]!.durations[0]!, resolution: d.models[0]!.resolutions[0] ?? null };
                  const model = d.models.find((m) => m.id === c.model) ?? d.models[0]!;
                  return (
                    <li key={br.briefId} className="rounded-lg border border-line p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>Szene {br.sceneIndex + 1}</strong>
                        <span className="text-muted">Skript v{br.scriptVersion} · {br.purpose}</span>
                        {br.blocked ? <Pill tone="warn">{br.blocked}</Pill> : null}
                      </div>
                      <p className="mt-1 text-[13px]">Prompt aus dem Storyboard: „{br.prompt}“</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <select aria-label="Modell" className="field w-auto" value={c.model} onChange={(e) => {
                          const m = d.models.find((x) => x.id === e.target.value)!;
                          setChoice({ ...choice, [br.briefId]: { ...c, model: m.id, durationSec: m.durations[0]!, resolution: m.resolutions[0] ?? null } });
                        }}>
                          {d.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </select>
                        <select aria-label="Dauer" className="field w-auto" value={c.durationSec} onChange={(e) => setChoice({ ...choice, [br.briefId]: { ...c, durationSec: Number(e.target.value) } })}>
                          {model.durations.map((s) => <option key={s} value={s}>{s} s</option>)}
                        </select>
                        {model.resolutions.length ? (
                          <select aria-label="Auflösung" className="field w-auto" value={c.resolution ?? model.resolutions[0]} onChange={(e) => setChoice({ ...choice, [br.briefId]: { ...c, resolution: e.target.value as '720p' | '1080p' } })}>
                            {model.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        ) : <span className="text-[12px] text-muted">Auflösung vom Modell vorgegeben</span>}
                        <Button size="sm" disabled={!usable || !!br.blocked} busy={busy === `q-${br.briefId}`} onClick={() => void act(`q-${br.briefId}`,
                          () => api(`/api/projects/${projectId}/ai-broll`, { method: 'POST', json: { action: 'quote', storyboardId: br.storyboardId, briefIndex: br.briefIndex, ...c } }),
                          'Kosten geschätzt – noch nichts ausgegeben.')}>Kosten schätzen</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="mt-3 text-[13px] text-muted">Keine freigegebenen KI-Asset-Briefs. Sie entstehen im Storyboard eines freigegebenen Skripts und werden dort freigegeben.</p>
          ) : null}

          {d.generations.length ? (
            <ul className="mt-3 grid gap-2" data-testid="generations">
              {d.generations.map((g) => {
                const s = STATUS[g.status];
                const max = maxCredits[g.id] ?? String(g.quotedCredits);
                const planOptions = plans.filter((p) => p.scriptId === g.scriptId);
                return (
                  <li key={g.id} className="rounded-lg border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>Szene {g.sceneIndex + 1}</strong>
                      <span className="text-muted">{d.models.find((m) => m.id === g.params.model)?.label} · {g.params.durationSec} s · {g.params.resolution ?? 'Auflösung vom Modell'}</span>
                      <Pill tone={s.tone}>{s.label}</Pill>
                      {g.mock ? <Pill tone="mock">MOCK</Pill> : null}
                    </div>
                    <p className="mt-1 text-[12px] text-muted">
                      Schätzung {g.quotedCredits} Credits{g.approvedMaxCredits != null ? ` · freigegeben bis ${g.approvedMaxCredits}` : ''}
                      {g.creditsCharged != null ? ` · verbucht ${g.creditsCharged} (laut Schätzung; Erstattungen bei Fehlern sind nicht dokumentiert)` : ''}
                    </p>
                    {g.error ? <p className="mt-1 text-[13px] text-danger">{g.error}</p> : null}

                    {g.status === 'quoted' ? (
                      <div className="mt-2 grid gap-2">
                        <label className="flex items-center gap-2">
                          <span>Höchstens</span>
                          <input aria-label="Freigegebene Credits" className="field w-24" type="number" min={g.quotedCredits} value={max} onChange={(e) => setMaxCredits({ ...maxCredits, [g.id]: e.target.value })} />
                          <span>Credits</span>
                        </label>
                        <label className="flex items-start gap-2 text-[13px]">
                          <input type="checkbox" checked={!!confirmed[g.id]} onChange={(e) => setConfirmed({ ...confirmed, [g.id]: e.target.checked })} />
                          Ich gebe für diesen einen Clip bis zu {max} Higgsfield-Credits frei. Der Job wird nicht automatisch wiederholt; bei einem Fehler können die Credits trotzdem verbraucht sein.
                        </label>
                        <div><Button size="sm" variant="primary" disabled={!confirmed[g.id] || !usable} busy={busy === `a-${g.id}`} onClick={() => void act(`a-${g.id}`,
                          () => api(`/api/generations/${g.id}/approve`, { method: 'POST', json: { approvedMaxCredits: Number(max) } }), 'Freigegeben – der Clip wird erzeugt.')}>Credits freigeben und erzeugen</Button></div>
                      </div>
                    ) : null}

                    {(g.status === 'queued' || g.status === 'running') && g.job ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-[13px]">{g.job.progressNote || 'wartet'}{g.job.progress != null ? ` · ${Math.round(g.job.progress * 100)} %` : ''}</span>
                        <Button size="sm" variant="ghost" busy={busy === `c-${g.id}`} onClick={() => void act(`c-${g.id}`, () => api(`/api/video-jobs/${g.job!.id}/cancel`, { method: 'POST' }),
                          'Abgebrochen. Ein schon gestarteter Higgsfield-Job kann dort weiterlaufen.')}>Abbrechen</Button>
                      </div>
                    ) : null}

                    {g.asset && (g.status === 'review' || g.status === 'approved') ? (
                      <video className="mt-2 max-h-[360px] rounded-lg bg-[#1f2617]" src={`/api/media/${g.asset.id}`} controls preload="metadata" />
                    ) : null}

                    {g.status === 'review' ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="primary" busy={busy === `r-${g.id}`} onClick={() => void act(`r-${g.id}`, () => api(`/api/generations/${g.id}/review`, { method: 'POST', json: { decision: 'approve' } }), 'Clip freigegeben.')}>Clip freigeben</Button>
                        <input aria-label="Begründung" className="field w-64" placeholder="Was passt nicht? (für Ablehnen)" value={notes[g.id] ?? ''} onChange={(e) => setNotes({ ...notes, [g.id]: e.target.value })} />
                        <Button size="sm" variant="ghost" busy={busy === `x-${g.id}`} onClick={() => void act(`x-${g.id}`, () => api(`/api/generations/${g.id}/review`, { method: 'POST', json: { decision: 'reject', note: notes[g.id] ?? '' } }), 'Clip abgelehnt und gelöscht.')}>Ablehnen</Button>
                      </div>
                    ) : null}

                    {g.status === 'approved' && g.asset ? (
                      planOptions.length ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <select aria-label="Schnittplan" className="field w-auto" value={targetPlan[g.id] ?? planOptions[0]!.id} onChange={(e) => setTargetPlan({ ...targetPlan, [g.id]: e.target.value })}>
                            {planOptions.map((p) => <option key={p.id} value={p.id}>Schnittplan v{p.version} ({p.status === 'approved' ? 'freigegeben' : 'Entwurf'})</option>)}
                          </select>
                          <Button size="sm" busy={busy === `p-${g.id}`} onClick={() => void act(`p-${g.id}`, async () => {
                            await api(`/api/edit-plans/${targetPlan[g.id] ?? planOptions[0]!.id}/add-generated`, { method: 'POST', json: { generationId: g.id } });
                            await edit.reload();
                            onPlansChanged();
                          }, 'Neue Schnittplan-Version mit dem Clip angelegt – bitte prüfen und freigeben.')}>In neue Schnittplan-Version übernehmen</Button>
                        </div>
                      ) : <p className="mt-2 text-[13px] text-muted">Erst einen Schnittplan für dieses Skript speichern, dann den Clip übernehmen.</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
      <ErrorNote error={error} />
    </section>
  );
}
