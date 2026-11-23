'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV = [
  { href: '/', label: 'Overview', icon: '◎', ready: true },
  { href: '/woche', label: 'Woche', icon: '▦', ready: true },
  { href: '/strategy', label: 'Strategie', icon: '◇', ready: true },
  { href: '/meine-marke', label: 'Meine Marke', icon: '◐', ready: true },
  { href: '/style-lab', label: 'Style Lab', icon: '▧', ready: true },
  { href: '/content-lab', label: 'Content Lab', icon: '✎', ready: true },
  { href: '/karussells', label: 'Karussells', icon: '▤', ready: true },
  { href: '/stories', label: 'Stories', icon: '▯', ready: true },
  { href: '/video-studio', label: 'Video Studio', icon: '▶', ready: true },
  { href: '/analytics', label: 'Rückblick', icon: '↗', ready: true },
  { href: '/ugc-projects', label: 'UGC Projects', icon: '◈', ready: true },
  { href: '/model-lab', label: 'Model Lab', icon: '⚖', ready: true },
  { href: '/settings', label: 'Settings', icon: '⚙', ready: true },
] as const;

export function Sidebar({ providerLabel, mock }: { providerLabel: string; mock: boolean }) {
  const path = usePathname();
  return (
    <aside className="flex flex-col border-line bg-sidebar px-4 py-6 max-md:border-b md:sticky md:top-0 md:h-screen md:overflow-y-auto md:border-r">
      <div className="mx-1 mb-8 flex items-center gap-3 max-md:mb-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-lime text-base font-medium text-olive-ink" aria-hidden>C</div>
        <div>
          <strong className="text-[15px] font-medium tracking-[-0.01em]">Creator Studio</strong>
          <small className="block font-mono text-[10px] text-muted">lokal · Release 3</small>
        </div>
      </div>
      <div className="mx-4 mb-3 text-[10px] font-semibold tracking-[0.08em] font-mono text-[#737b68] max-md:hidden">WORKSPACE</div>
      <nav aria-label="Hauptnavigation" className="grid gap-1 max-md:flex max-md:overflow-x-auto">
        {NAV.map((n) => {
          const active = n.href === '/' ? path === '/' : path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-lg px-4 py-3 text-[13px] whitespace-nowrap ${active ? 'bg-lime font-medium text-olive-ink' : 'text-[#454d3d] hover:bg-[#f2f4ec] hover:text-ink'}`}
            >
              <span className="w-6 text-center text-base text-muted" aria-hidden>{n.icon}</span>
              {n.label}
              {!n.ready ? <span className="ml-auto rounded-full border border-line px-1.5 py-0.5 text-[9px] text-muted">geplant</span> : null}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto grid gap-3 pt-6 max-md:hidden">
        <div className="rounded-xl border border-[#dde2d2] p-3 text-[10px] tracking-wider text-[#454d3d]">
          <span className={`mr-1.5 inline-block h-[7px] w-[7px] rounded-full ${mock ? 'bg-warn' : 'bg-accent'}`} />
          {mock ? 'MOCK-MODUS' : 'KI AKTIV'}
          <small className="mt-1.5 block text-[11px] tracking-normal text-muted">{providerLabel}</small>
        </div>
        <a href="/api/export" className="rounded-lg border border-[#dde2d2] bg-[#f2f4ec] px-4 py-2.5 text-center text-xs font-bold">↓ Daten als JSON exportieren</a>
      </div>
    </aside>
  );
}
