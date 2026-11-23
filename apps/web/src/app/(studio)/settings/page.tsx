import { DefaultsCard } from '@/components/settings/DefaultsCard';
import { ExportButtons } from '@/components/settings/ExportButtons';
import { ReleaseReservation } from '@/components/settings/ReleaseReservation';
import { PageHeader } from '@/components/ui';
import { getRoutingOverview, getStatus } from '@/server/services/status';

export const dynamic = 'force-dynamic';

const Row = ({ k, v, warn }: { k: string; v: React.ReactNode; warn?: boolean }) => (
  <><dt className="text-muted">{k}</dt><dd className={warn ? 'text-warn' : ''}>{v}</dd></>
);

export default async function Settings() {
  const [s, routes] = await Promise.all([getStatus(), getRoutingOverview()]);
  return (
    <div className="appear">
      <PageHeader eyebrow="07 / SETTINGS" title="Einstellungen" accent="und Integrationen." lead="Konfiguration erfolgt serverseitig über .env (siehe .env.example). API-Keys werden nie an den Browser übertragen." />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel">
          <h2 className="mb-3 text-lg font-bold">KI-Provider</h2>
          <dl className="grid grid-cols-[150px_1fr] gap-y-2 text-xs">
            <Row k="Angefordert" v={s.provider.requested} />
            <Row k="Aktiv" v={s.provider.active} warn={s.provider.active === 'mock'} />
            <Row k="Modell" v={s.provider.model} />
            <Row k="Hinweis" v={s.provider.reason ?? '—'} warn={Boolean(s.provider.reason)} />
            <Row k="Monatsbudget" v={`${s.provider.monthlyBudgetUsd} USD (Warnung ab ${Math.round(s.provider.budgetWarnFraction * 100)} %)`} />
            <Row k="Verbraucht" v={`${s.budget.spentUsd.toFixed(4)} USD`} />
            <Row k="Reserviert" v={`${s.budget.reservedUsd.toFixed(4)} USD (Obergrenze laufender Aufrufe)`} />
            <Row k="Gebunden" v={`${(s.budget.spentUsd + s.budget.reservedUsd).toFixed(4)} USD (${Math.round(s.budget.fraction * 100)} % des Budgets)`} warn={s.budget.warn} />
            <Row k="Max. pro Modellvergleich" v={`${s.provider.evalMaxUsdPerRun} USD (Model Lab, nur mit Freigabe)`} />
            <Row
              k="Vertrauliche Daten"
              v={
                <span data-testid="confidential-routing">
                  Kundenprojekte (eigene Inhalte samt Strategie/Profil gehen an jedes Modell):{' '}
                  {s.provider.confidentialAllowedFamilies.length ? `nur an ${s.provider.confidentialAllowedFamilies.join(', ')} (ZDR ohne Speicherung)` : 'an kein kostenpflichtiges Modell (CONFIDENTIAL_ALLOWED_FAMILIES leer)'}
                  {s.provider.active === 'mock' ? ' · Mock-Modus: es wird nichts gesendet.' : s.confidentialBlocked ? ` · Derzeit gesperrt: ${s.confidentialBlocked}. Diese KI-Aufrufe werden abgelehnt.` : ''}
                </span>
              }
              warn={s.provider.active !== 'mock' && Boolean(s.confidentialBlocked)}
            />
          </dl>
          {s.counts.orphanedReservations.length ? (
            <div className="mt-3 rounded-lg border border-[#e8cf7a] bg-[#fff6db] p-3 text-xs" data-testid="orphaned-reservations">
              <p className="mb-2 text-warn">Diese Aufrufe liefen, als die App beendet wurde. Ob sie berechnet wurden, ist unbekannt – ihr Höchstbetrag bleibt deshalb vom Budget abgezogen. Erst nach Prüfung der Abrechnung beim Anbieter freigeben und den tatsächlich berechneten Betrag eintragen.</p>
              <ul className="grid gap-1">{s.counts.orphanedReservations.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2"><span>{r.createdAt.slice(0, 16).replace('T', ' ')} · {r.purpose} · bis {r.amountUsd.toFixed(4)} USD</span><ReleaseReservation id={r.id} amountUsd={r.amountUsd} /></li>
              ))}</ul>
            </div>
          ) : null}
          <p className="hint mt-3">Kostenpflichtige Provider werden nur aktiv, wenn API-Key <em>und</em> <code>AI_MONTHLY_BUDGET_USD &gt; 0</code> gesetzt sind. Kosten: von OpenRouter gemeldet, sonst aus Tokens berechnet, sonst konservativ als Obergrenze geschätzt.</p>
        </section>
        <section className="panel">
          <h2 className="mb-3 text-lg font-bold">Infrastruktur</h2>
          <dl className="grid grid-cols-[150px_1fr] gap-y-2 text-xs">
            <Row k="Speicher" v={s.storage.note} />
            <Row k="Supabase" v={`${s.supabase.configured ? 'URL gesetzt' : 'nicht konfiguriert'} · Adapter ${s.supabase.adapter}`} warn />
            <Row k="FFmpeg" v={s.ffmpeg.available ? `${s.ffmpeg.version}${s.ffmpeg.ffprobe ? '' : ' · ffprobe fehlt'}` : 'nicht verfügbar (brew install ffmpeg)'} warn={!s.ffmpeg.available || !s.ffmpeg.ffprobe} />
            <Row k="Untertitel" v={s.ffmpeg.subtitles ? 'einbrennen möglich (libass)' : 'einbrennen nicht verfügbar – FFmpeg ohne libass'} warn={!s.ffmpeg.subtitles} />
            <Row k="Transkription" v={s.transcription.mode === 'mock' ? 'MOCK (TRANSCRIPTION=mock)' : s.transcription.available ? `whisper.cpp lokal · ${s.transcription.model}` : s.transcription.reason} warn={!s.transcription.available || s.transcription.mode === 'mock'} />
            <Row k="KI-B-Roll (Higgsfield)" v={s.higgsfield.state === 'disabled' ? 'aus (HIGGSFIELD=cli oder mock)' : `${s.higgsfield.mode === 'mock' ? 'MOCK · keine echten Credits' : s.higgsfield.state === 'ready' ? `CLI bereit${s.higgsfield.credits != null ? ` · Guthaben ${s.higgsfield.credits}` : ''}` : s.higgsfield.reason ?? 'nicht verfügbar'} · Monat ${s.counts.creditsCommitted} / ${s.higgsfield.monthLimit} Credits gebunden`} warn={s.higgsfield.state !== 'ready' && s.higgsfield.state !== 'disabled' || s.higgsfield.mode === 'mock'} />
            <Row k="Video-Worker" v={`im App-Prozess · ${s.counts.mediaJobs.running} läuft · ${s.counts.mediaJobs.queued} wartet`} />
            <Row k="Zugangsschutz" v={s.auth.accessToken ? 'STUDIO_ACCESS_TOKEN aktiv' : 'nur localhost (kein Token gesetzt)'} />
            <Row k="n8n-Endpunkte" v={s.auth.jobToken ? 'aktiv (STUDIO_JOB_TOKEN gesetzt)' : 'deaktiviert (STUDIO_JOB_TOKEN fehlt)'} warn={!s.auth.jobToken} />
            <Row k="Instagram API" v="nicht angebunden – manueller Import (Release 4)" warn />
            <Row k="Higgsfield" v="nicht angebunden (Release 3, nur nach Budgetfreigabe)" warn />
          </dl>
          <ExportButtons />
        </section>
        <DefaultsCard />
        <section className="panel lg:col-span-2" data-testid="routing-table">
          <h2 className="mb-1 text-lg font-bold">Model Router</h2>
          <p className="hint mb-3">{s.provider.active === 'openrouter' ? 'Aktive Auswahl pro Aufgabe.' : s.provider.active === 'mock' ? 'Vorschau: So würde der Router mit OpenRouter wählen – im Mock-Modus wird nichts kostenpflichtig aufgerufen.' : `Vorschau: Aufrufe gehen aktuell fest an ${s.provider.active} (${s.provider.model}), nicht über den Router.`} Grundlage: öffentliche Benchmarks (arena.ai, untere Konfidenzgrenze), Preise und Datenschutz – ab 5 echten Bewertungen im <a className="text-accent underline" href="/model-lab">Model Lab</a> auch deine eigenen Vergleiche.</p>
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] text-muted"><tr><th className="py-1">Aufgabe</th><th>Wahl</th><th>≈ Kosten</th><th>Fallbacks</th><th>Kundenprojekte (vertraulich)</th><th>Begründung</th></tr></thead>
            <tbody>{routes.map((r) => (
              <tr key={r.useCase} className="border-t border-line align-top">
                <td className="py-1.5 pr-2">{r.label}{r.agent ? '' : <span className="text-muted"> (Agent geplant)</span>}</td>
                <td className="pr-2 font-bold">{r.chosen?.label ?? '—'}{r.preferred ? <span className="text-accent"> · festgelegt</span> : null}</td>
                <td className="pr-2">{r.chosen ? `$${r.chosen.estCostUsd.toFixed(4)}` : '—'}</td>
                <td className="pr-2 text-muted">{r.fallbacks.join(', ') || '—'}</td>
                <td className="pr-2">{r.confidentialChoice ?? <span className="text-warn" title={r.confidentialReason ?? undefined}>gesperrt</span>}</td>
                <td className="text-[#343b2d]">{r.reasons[0]}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
        <section className="panel lg:col-span-2">
          <h2 className="mb-3 text-lg font-bold">Letzte Agentenläufe</h2>
          {s.counts.recentRuns.length ? (
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] text-muted"><tr><th className="py-1">Zeit</th><th>Agent</th><th>Provider</th><th>Modell</th><th>Grund</th><th>Prompt</th><th>Status</th><th>Kosten</th></tr></thead>
              <tbody>{s.counts.recentRuns.map((r) => (
                <tr key={r.id} className="border-t border-line"><td className="py-1.5">{r.createdAt.slice(0, 19).replace('T', ' ')}</td><td>{r.agent}</td><td>{r.provider}</td><td>{r.model}</td><td className="max-w-[260px] text-muted">{r.routing ? (r.routing.mode === 'routed' ? `${r.routing.attempt ? `Fallback #${r.routing.attempt} · ` : ''}${r.routing.reasons[0] ?? ''}` : r.routing.mode === 'mock' ? 'Mock (Router-Wahl nur Vorschau)' : 'fester Provider (ohne Router)') : '—'}</td><td>{r.promptVersion}</td><td className={r.status === 'failed' ? 'text-danger' : ''}>{r.status}{r.error ? `: ${r.error}` : ''}</td><td>{r.costEstimateUsd == null ? '—' : `$${r.costEstimateUsd.toFixed(4)}${r.costSource === 'worst_case' ? ' (Obergrenze)' : ''}`}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="hint">Noch keine Läufe.</p>}
        </section>
      </div>
    </div>
  );
}
