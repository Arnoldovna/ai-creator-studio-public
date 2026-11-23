import Link from 'next/link';
import { getStatus } from '@/server/services/status';
import { weekSummary } from '@/server/services/board';

export const dynamic = 'force-dynamic';

const Card = ({ n, label, href }: { n: string | number; label: string; href: string }) => (
  <Link href={href} className="panel block hover:border-[#c9de9a]">
    <div className="text-4xl font-semibold tracking-tight text-[#454d3d]">{n}</div>
    <div className="mt-1 text-[11px] tracking-wider text-muted uppercase">{label}</div>
  </Link>
);

export default async function Overview() {
  const s = await getStatus();
  const w = await weekSummary();
  const c = s.counts;
  const steps = [
    { done: c.references > 0, text: 'Referenzen hochladen und bewerten', href: '/style-lab' },
    { done: c.approvedObservations > 0, text: 'KI-Beobachtungen prüfen (bestätigen/ablehnen)', href: '/style-lab?tab=review' },
    { done: c.approvedStyle != null, text: 'Style Bible erstellen (Speichern macht sie aktiv)', href: '/style-lab?tab=bible' },
    { done: c.concepts > 0, text: 'Briefing → drei Konzepte', href: '/content-lab' },
    { done: c.scripts > 0, text: 'Konzept wählen → UGC-Skript', href: '/content-lab' },
    { done: c.snapshots > 0, text: 'Veröffentlichung + Insights manuell erfassen', href: '/analytics' },
  ];
  return (
    <div className="appear">
      <div className="eyebrow">00 / OVERVIEW</div>
      <h1 className="mb-4 text-[clamp(30px,3.6vw,54px)] leading-[1.05] font-medium tracking-[-0.035em]">
        Dein Studio.<br /><em className="font-medium text-muted not-italic">Dein Kreislauf.</em>
      </h1>
      <p className="mb-10 max-w-2xl text-sm leading-7 text-[#5b6450]">
        References → Style Bible & Voice → Konzepte → Skript → (Video, später) → Veröffentlichung → Insights → nächste Idee.
      </p>
      <Link href="/woche" className="panel mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 hover:border-[#c9de9a]" data-testid="overview-week">
        <div>
          <div className="text-[11px] tracking-wider text-muted uppercase">Deine Woche · {w.label}</div>
          <div className="mt-1 text-lg font-semibold text-[#454d3d]">
            {w.planned} Hauptpost{w.planned === 1 ? '' : 's'} geplant{w.stories ? ` · ${w.stories} Stor${w.stories === 1 ? 'y' : 'ies'}` : ''}{w.posted ? ` · ${w.posted} gepostet` : ''}
          </div>
          <div className="text-[11px] text-muted">{w.postsPerWeek != null ? `Dein Rhythmus: ${w.postsPerWeek} pro Woche – nur Orientierung, ohne Pflicht.` : 'Ohne festen Rhythmus – plane, wie es passt.'}</div>
        </div>
        <span className="ml-auto text-sm font-semibold text-accent">Zum Wochenboard →</span>
      </Link>
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card n={c.references} label="Referenzen" href="/style-lab" />
        <Card n={c.pendingObservations} label="Offene KI-Vorschläge" href="/style-lab?tab=review" />
        <Card n={c.approvedStyle ? `v${c.approvedStyle}` : '—'} label="Freigegebene Style Bible" href="/style-lab?tab=bible" />
        <Card n={c.scripts} label="Skriptversionen" href="/content-lab" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel">
          <h2 className="mb-3 text-lg font-bold">Nächste Schritte</h2>
          <ol className="grid gap-2">
            {steps.map((st) => (
              <li key={st.text}>
                <Link href={st.href} className="flex items-center gap-3 text-sm hover:text-accent">
                  <span className={`grid h-5 w-5 place-items-center rounded-full border text-[10px] ${st.done ? 'border-lime bg-lime text-olive-ink' : 'border-line text-muted'}`}>{st.done ? '✓' : ''}</span>
                  {st.text}
                </Link>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel">
          <h2 className="mb-3 text-lg font-bold">Systemstatus</h2>
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-xs">
            <dt className="text-muted">KI-Provider</dt>
            <dd>{s.provider.active === 'mock' ? <span className="text-warn">Mock ({s.provider.reason})</span> : s.provider.active === 'openrouter' ? 'OpenRouter · Model Router' : `${s.provider.active} · ${s.provider.model}`}</dd>
            <dt className="text-muted">Budget (Monat)</dt>
            <dd className={s.budget.warn ? 'text-warn' : ''}>{s.budget.spentUsd.toFixed(2)} / {s.budget.limitUsd} USD</dd>
            <dt className="text-muted">FFmpeg</dt>
            <dd>{s.ffmpeg.available ? s.ffmpeg.version : <span className="text-warn">nicht verfügbar</span>}</dd>
            <dt className="text-muted">Speicher</dt>
            <dd>{s.storage.note}</dd>
            <dt className="text-muted">Supabase</dt>
            <dd className="text-warn">{s.supabase.adapter}</dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
