'use client';
import { useEffect, useState } from 'react';
import { fmtPct, type GrowthInsight, type Rates } from '@studio/core/analytics';
import { api, useApi } from '@/lib/api';
import type { MetricSnapshot, PillarMixView, Project, Publication, SelfAssessmentList, ContextOverview } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, PageHeader, Pill } from '../ui';
import { GrowthPanel } from './GrowthPanel';
import { PillarMix } from './PillarMix';
import { SelfAssessmentLog } from './SelfAssessmentLog';
import { SelfAssessmentTrend } from './SelfAssessmentTrend';

const DISMISSED_KEY = 'studio.reviewHints.dismissed';
function readDismissed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

type Pub = Publication & {
  lineage: { project: string | null; concept: string | null; scriptVersion: number | null; styleVersion: string | null; voiceVersion: string | null; strategy: string };
  snapshots: (MetricSnapshot & { rates: Rates })[];
};
interface Data {
  publications: Pub[];
  insight: GrowthInsight | null;
  linkableScripts: { id: string; version: number; status: string; projectId: string; conceptTitle: string; hook: string }[];
}
const num = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('de-DE'));

export function Analytics() {
  const toast = useToast();
  const { data, error, reload } = useApi<Data>('/api/analytics');
  const projects = useApi<Project[]>('/api/projects');
  const self = useApi<SelfAssessmentList>('/api/self-assessments?weeks=12');
  const mix = useApi<PillarMixView>('/api/strategy/mix?weeks=12');
  const strategy = useApi<ContextOverview>('/api/context');
  // without a readable strategy the phase is „Private Erprobung“ (D7)
  const phase = strategy.data?.phase ?? (strategy.error ? 'private_trial' : null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- per-viewer convenience from localStorage after mount
    setDismissed(readDismissed());
  }, []);
  const hints = (self.data?.reviewHints ?? []).filter((h) => !dismissed.includes(h.id));
  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* private window: dismissed for this view only */ }
  }
  const reloadSelf = () => Promise.all([self.reload(), mix.reload()]);
  const [pub, setPub] = useState({ projectId: '', title: '', format: 'reel', publishedAt: new Date().toISOString().slice(0, 10), permalink: '', scriptVersionId: '', hook: '' });
  const [snap, setSnap] = useState({ publicationId: '', window: '7d', reach: '', views: '', likes: '', comments: '', saves: '', shares: '', follows: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const projectId = pub.projectId || projects.data?.[0]?.id || '';
  const scripts = data?.linkableScripts.filter((s) => s.projectId === projectId) ?? [];

  async function savePub() {
    setBusy('pub'); setErr(null);
    try {
      await api('/api/publications', { method: 'POST', json: { projectId, title: pub.title, format: pub.format, publishedAt: pub.publishedAt, permalink: pub.permalink, scriptVersionId: pub.scriptVersionId || null, hook: pub.hook } });
      setPub({ ...pub, title: '', permalink: '', hook: '', scriptVersionId: '' });
      await Promise.all([reload(), self.reload()]);
      toast('Veröffentlichung erfasst.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function saveSnap() {
    setBusy('snap'); setErr(null);
    const n = (v: string) => (v.trim() === '' ? null : Number(v));
    try {
      const publicationId = snap.publicationId || data?.publications[0]?.id || '';
      for (const [k, v] of Object.entries({ reach: snap.reach, views: snap.views, saves: snap.saves, shares: snap.shares }))
        if (v.trim() === '') throw new Error(`Bitte ${k} eingeben (Pflichtfeld).`);
      await api('/api/snapshots', { method: 'POST', json: { publicationId, window: snap.window, metrics: { reach: n(snap.reach), views: n(snap.views), likes: n(snap.likes), comments: n(snap.comments), saves: n(snap.saves), shares: n(snap.shares), follows: n(snap.follows) } } });
      setSnap({ ...snap, reach: '', views: '', likes: '', comments: '', saves: '', shares: '', follows: '' });
      await reload();
      toast('Echter Messwert gespeichert.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function del(path: string) {
    if (!confirm('Wirklich löschen?')) return;
    try { await api(path, { method: 'DELETE' }); await reload(); } catch (e) { setErr((e as Error).message); }
  }

  const g = data?.insight;
  return (
    <div className="appear">
      <PageHeader
        eyebrow="05 / RÜCKBLICK · WAS SICH GUT ANGEFÜHLT HAT"
        title="Rückblick."
        accent="Freude, Sicherheit, fertige Stücke."
        lead="Halte fest, wie sich Sessions und Stücke angefühlt haben – auch ohne Video. Reichweiten-Zahlen trägst du nur ein, wenn du willst: Es werden keine Daten von Instagram abgerufen, und nichts hier ändert automatisch deine Strategie, Style- oder Voice-Regeln."
      />
      {hints.map((h) => (
        <div key={h.id} className="note mb-4 flex flex-wrap items-center justify-between gap-3" data-testid="review-hint">
          <span><b>{h.text}</b> {h.detail}</span>
          <Button size="sm" variant="ghost" onClick={() => dismiss(h.id)}>Ausblenden</Button>
        </div>
      ))}
      <div className="grid gap-4 lg:grid-cols-2">
        <SelfAssessmentLog data={self.data} projects={projects.data ?? []} reload={reloadSelf} />
        <div className="grid content-start gap-4">
          <SelfAssessmentTrend series={self.data?.series ?? []} />
          <PillarMix mix={mix.data} />
        </div>
      </div>
      <ErrorNote error={self.error ?? mix.error ?? (strategy.error ? `Strategie konnte nicht geladen werden (Phase gilt als „Private Erprobung“): ${strategy.error}` : null)} />
      {phase ? (
      <details key={phase} open={phase === 'public'} className="mt-10" data-testid="reach-section">
        <summary className="cursor-pointer text-xl font-bold">
          {phase === 'private_trial' ? 'Reichweiten-Zahlen (pausiert in der privaten Erprobungsphase)' : 'Reichweiten-Zahlen'}
        </summary>
        <p className="hint mt-2">Trage echte Instagram-Insights manuell ein. Jede Veröffentlichung ist mit Konzept, Hook, Skriptversion, Style-Bible-Version und Säule verknüpft.</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="panel">
          <h2 className="mb-1 text-lg font-bold">1 · Veröffentlichung erfassen</h2>
          <Field label="Projekt" htmlFor="pubProject">
            <select id="pubProject" className="field" value={projectId} onChange={(e) => setPub({ ...pub, projectId: e.target.value, scriptVersionId: '' })}>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </Field>
          <Field label="Beitrag / Reel" htmlFor="pubTitle"><input id="pubTitle" className="field" value={pub.title} onChange={(e) => setPub({ ...pub, title: e.target.value })} placeholder="z. B. Strickmaschinen-Experiment #1" /></Field>
          <Field label="Skriptversion (verknüpft Konzept, Hook, Style & Voice)" htmlFor="pubScript">
            <select id="pubScript" className="field" value={pub.scriptVersionId} onChange={(e) => setPub({ ...pub, scriptVersionId: e.target.value })}>
              <option value="">— ohne Skript —</option>
              {scripts.map((s) => <option key={s.id} value={s.id}>{s.conceptTitle} · v{s.version} ({s.status})</option>)}
            </select>
          </Field>
          <Field label="Hook oder kreativer Ansatz" htmlFor="pubHook"><input id="pubHook" className="field" value={pub.hook} onChange={(e) => setPub({ ...pub, hook: e.target.value })} placeholder={pub.scriptVersionId ? 'leer = gewählter Hook aus dem Skript' : 'z. B. Überraschender Prozessbeginn'} /></Field>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Datum" htmlFor="pubDate"><input id="pubDate" type="date" className="field" value={pub.publishedAt} onChange={(e) => setPub({ ...pub, publishedAt: e.target.value })} /></Field>
            <Field label="Format" htmlFor="pubFormat"><select id="pubFormat" className="field" value={pub.format} onChange={(e) => setPub({ ...pub, format: e.target.value })}><option value="reel">Reel</option><option value="carousel">Carousel</option><option value="photo">Foto</option><option value="story">Story</option></select></Field>
          </div>
          <Field label="Link (optional)" htmlFor="pubLink"><input id="pubLink" className="field" value={pub.permalink} onChange={(e) => setPub({ ...pub, permalink: e.target.value })} placeholder="https://www.instagram.com/reel/…" /></Field>
          <Button variant="primary" className="mt-5 w-full" busy={busy === 'pub'} onClick={savePub}>Veröffentlichung speichern</Button>
        </section>
        <section className="panel">
          <h2 className="mb-1 text-lg font-bold">2 · Insights eintragen</h2>
          <Field label="Veröffentlichung" htmlFor="snapPub">
            <select id="snapPub" className="field" value={snap.publicationId || data?.publications[0]?.id || ''} onChange={(e) => setSnap({ ...snap, publicationId: e.target.value })}>
              {data?.publications.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </Field>
          <Field label="Alter des Beitrags bei Messung" htmlFor="snapWindow"><select id="snapWindow" className="field" value={snap.window} onChange={(e) => setSnap({ ...snap, window: e.target.value })}><option value="24h">ca. 24 Stunden</option><option value="7d">ca. 7 Tage</option><option value="30d">ca. 30 Tage</option></select></Field>
          <div className="grid grid-cols-2 gap-x-3">
            {([['reach', 'Erreichte Accounts *'], ['views', 'Views *'], ['saves', 'Saves *'], ['shares', 'Shares *'], ['likes', 'Likes'], ['comments', 'Kommentare'], ['follows', 'Neue Follower']] as const).map(([k, l]) => (
              <Field key={k} label={l} htmlFor={`m-${k}`}><input id={`m-${k}`} type="number" min={0} className="field" value={snap[k]} onChange={(e) => setSnap({ ...snap, [k]: e.target.value })} /></Field>
            ))}
          </div>
          <Button variant="primary" className="mt-5 w-full" disabled={!data?.publications.length} busy={busy === 'snap'} onClick={saveSnap}>Ergebnis speichern & auswerten</Button>
          {!data?.publications.length ? <p className="hint mt-2">Erst eine Veröffentlichung erfassen.</p> : null}
        </section>
        <section className="panel">
          <h2 className="mb-1 text-lg font-bold">Growth Memory</h2>
          {phase === 'private_trial' ? (
            <p className="hint mt-3">Growth-Hinweise pausiert (private Erprobung). Die Zahlen bleiben gespeichert und gehen nicht in die Ideation ein.</p>
          ) : g ? (
            <>
              <div className="eyebrow mt-3">EXPERIMENT MEMORY</div>
              <div className="text-2xl font-bold text-accent">{g.sampleSize} {g.sampleSize === 1 ? 'Beitrag' : 'vergleichbare Beiträge'}</div>
              <div className="mb-3 text-[11px] text-muted">Messfenster: {g.window}</div>
              <p className="hint">{g.hypothesis}</p>
              <div className="note">{g.caveat} Die Hypothese wird dem Content Strategist nur als Testidee übergeben.</div>
            </>
          ) : <p className="hint mt-3">Noch keine Insights vorhanden. Trage den ersten Beitrag ein.</p>}
        </section>
      </div>
      <ErrorNote error={err ?? error} />
      <div className="mt-10 mb-4 flex items-center justify-between"><h2 className="m-0 text-xl font-bold">Erfasste Beiträge</h2><Pill>{data?.publications.length ?? 0} Beiträge</Pill></div>
      <div className="grid gap-3">
        {!data?.publications.length ? <Empty>Noch keine Veröffentlichungen gespeichert.</Empty> : null}
        {data?.publications.map((p) => (
          <article key={p.id} className="rounded-xl border border-line bg-card p-4" data-testid="publication">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <b className="text-sm">{p.title}</b>
              <div className="flex items-center gap-2"><span className="text-[11px] text-muted">{p.publishedAt.slice(0, 10)} · {p.format}</span><Button size="sm" onClick={() => del(`/api/publications/${p.id}`)}>Entfernen ×</Button></div>
            </div>
            <div className="mb-3 flex flex-wrap gap-1.5">
              <Pill>Projekt: {p.lineage.project ?? '—'}</Pill>
              <Pill>Konzept: {p.lineage.concept ?? '—'}</Pill>
              <Pill>Skript: {p.lineage.scriptVersion ? `v${p.lineage.scriptVersion}` : '—'}</Pill>
              <Pill>Style: {p.lineage.styleVersion ?? '—'}</Pill>
              <Pill>Voice: {p.lineage.voiceVersion ?? '—'}</Pill>
              <Pill>Strategie: {p.lineage.strategy}</Pill>
              {p.hook ? <Pill>Hook: „{p.hook.slice(0, 60)}“</Pill> : null}
            </div>
            {p.snapshots.length ? (
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] text-muted"><tr><th className="py-1">Fenster</th><th>Erreicht</th><th>Views</th><th>Saves/Reach</th><th>Shares/Reach</th><th>Engagement/Reach</th><th>Follows/1k</th><th /></tr></thead>
                <tbody>
                  {p.snapshots.map((s) => (
                    <tr key={s.id} className="border-t border-line">
                      <td className="py-1.5">{s.window}</td><td>{num(s.metrics.reach)}</td><td>{num(s.metrics.views)}</td>
                      <td>{fmtPct(s.rates.savesPerReachPct)}</td><td>{fmtPct(s.rates.sharesPerReachPct)}</td><td>{fmtPct(s.rates.engagementPerReachPct)}</td>
                      <td>{s.rates.followsPer1kReach == null ? '—' : s.rates.followsPer1kReach.toFixed(1).replace('.', ',')}</td>
                      <td className="text-right"><Button size="sm" variant="ghost" onClick={() => del(`/api/snapshots/${s.id}`)}>×</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="hint m-0">Noch keine Messwerte.</p>}
          </article>
        ))}
      </div>
      {phase === 'public' ? <GrowthPanel /> : (
        <p className="note mt-4" data-testid="growth-paused">Growth-Analyse pausiert – Phase wird in der Strategie festgelegt.</p>
      )}
      <div className="note mt-6">Diese Kennzahlen sind nur so verlässlich wie deine Eingaben. Vergleiche nur Beiträge mit gleicher Messdauer und ähnlichen Formaten. Raten nutzen „erreichte Accounts“ als Nenner. Korrelation ist kein Beweis für eine Ursache.</div>
      </details>
      ) : null}
    </div>
  );
}
