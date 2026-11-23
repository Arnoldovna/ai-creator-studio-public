import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { checkAccess, SESSION_COOKIE } from '@/server/auth';
import { getShellStatus } from '@/server/services/status';
import { Sidebar } from '@/components/Sidebar';
import { ToastProvider } from '@/components/toast';
import { ChatProvider } from '@/components/chat/ChatProvider';

export const dynamic = 'force-dynamic';

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const access = checkAccess({ host: h.get('host'), cookie: (await cookies()).get(SESSION_COOKIE)?.value, authorization: h.get('authorization') });
  if (!access.ok) {
    if (process.env.STUDIO_ACCESS_TOKEN) redirect('/login');
    return <main className="p-10 text-sm">Zugriff verweigert: {access.reason}</main>;
  }
  const { provider: config, budget } = await getShellStatus();
  const mock = config.active === 'mock';
  const label = mock ? `Kein LLM aktiv. ${config.reason ?? ''}` : config.active === 'openrouter' ? 'OpenRouter · Model Router' : `${config.active} · ${config.model}`;
  return (
    <ToastProvider>
      <ChatProvider mock={mock}>
      <div className="min-h-screen md:grid md:grid-cols-[254px_minmax(0,1fr)]">
        <Sidebar providerLabel={label} mock={mock} />
        <main className="min-w-0">
          {mock ? (
            <div className="border-b border-[#e8cf7a] bg-[#fff6db] px-[clamp(20px,5vw,74px)] py-2 text-[11px] text-warn">
              Demo-/Mock-Modus: Agenten liefern deterministische Platzhalter, keine echte KI-Analyse. {config.reason}
            </div>
          ) : null}
          {budget.warn ? (
            <div role="alert" className="border-b border-[#f0b4ad] bg-[#fdecea] px-[clamp(20px,5vw,74px)] py-2 text-[11px] text-danger">
              {budget.blocked ? 'Monatsbudget erreicht – kostenpflichtige KI-Aufrufe sind gesperrt.' : `Budget-Warnung: ${Math.round(budget.fraction * 100)} % verbraucht`} ({budget.spentUsd.toFixed(2)} / {budget.limitUsd} USD).
            </div>
          ) : null}
          <div className="mx-auto max-w-[1420px] px-[clamp(18px,5vw,74px)] pt-12 pb-24">{children}</div>
        </main>
      </div>
      </ChatProvider>
    </ToastProvider>
  );
}
