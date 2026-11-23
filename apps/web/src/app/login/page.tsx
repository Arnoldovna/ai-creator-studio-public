export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form method="post" action="/api/auth/login" className="panel w-full max-w-sm">
        <div className="eyebrow">AI CREATOR STUDIO</div>
        <h1 className="mb-2 text-2xl font-bold">Anmelden</h1>
        <p className="hint">Dieses Studio ist mit <code>STUDIO_ACCESS_TOKEN</code> geschützt.</p>
        <label className="label" htmlFor="token">Zugangstoken</label>
        <input id="token" name="token" type="password" required className="field" autoComplete="current-password" />
        {error ? <p className="mt-2 text-xs text-danger">Token ungültig.</p> : null}
        <button className="mt-5 w-full rounded-lg bg-lime px-4 py-2.5 text-xs font-medium text-olive-ink">Anmelden</button>
      </form>
    </main>
  );
}
