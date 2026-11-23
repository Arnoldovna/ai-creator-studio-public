'use client';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { HEX } from '@studio/core/schemas';

type Variant = 'primary' | 'subtle' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-lime border-lime text-olive-ink',
  subtle: 'bg-[#f2f4ec] border-[#dde2d2] text-ink',
  danger: 'bg-[#fdecea] border-[#f0b4ad] text-danger',
  ghost: 'bg-transparent border-transparent text-muted hover:text-ink',
};

export function Button({ variant = 'subtle', size = 'md', className = '', busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border font-medium transition hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${size === 'sm' ? 'px-2.5 py-1.5 text-[11px]' : 'px-4 py-2.5 text-xs'} ${variants[variant]} ${className}`}
    >
      {busy ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function PageHeader({ eyebrow, title, accent, lead, right }: { eyebrow: string; title: string; accent?: string; lead?: ReactNode; right?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-6">
      <div className="max-w-3xl">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="m-0 mb-4 text-[clamp(30px,3.6vw,54px)] leading-[1.05] font-medium tracking-[-0.035em]">
          {title}
          {accent ? (<><br /><em className="font-medium text-muted not-italic">{accent}</em></>) : null}
        </h1>
        {lead ? <p className="m-0 max-w-[675px] text-sm leading-7 text-[#5b6450]">{lead}</p> : null}
      </div>
      {right}
    </header>
  );
}

export function Pill({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'mock' | 'warn' | 'ok' | 'danger' }) {
  const t = {
    default: 'bg-[#f2f4ec] border-[#dde2d2] text-[#454d3d]',
    mock: 'bg-[#fff6db] border-[#e8cf7a] text-warn',
    warn: 'bg-[#fff6db] border-[#e8cf7a] text-warn',
    ok: 'bg-[#eef6dc] border-[#c9de9a] text-accent',
    danger: 'bg-[#fdecea] border-[#f0b4ad] text-danger',
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold whitespace-nowrap ${t}`}>{children}</span>;
}

export function MockBadge({ mock }: { mock: boolean }) {
  return mock ? <Pill tone="mock">MOCK · kein LLM</Pill> : <Pill tone="ok">KI-generiert</Pill>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="col-span-full rounded-xl border border-line p-8 text-[13px] leading-relaxed text-[#5b6450]">{children}</div>;
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <p className="hint mt-1">{hint}</p> : null}
    </div>
  );
}

export function Swatches({ colors, size = 21 }: { colors: string[]; size?: number }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {colors.map((c) => (
        <span key={c} title={c} className="rounded-full border border-white/20" style={{ width: size, height: size, background: HEX.test(c) ? c : '#333' }} />
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div role="alert" className="mt-3 rounded-lg border border-[#f0b4ad] bg-[#fdecea] p-3 text-xs text-danger">{error}</div> : null;
}

/** 1–5 scale as an accessible radio group; clicking the selected value clears it. */
export function RatingScale({ label, itemLabel, value, onChange, size = 'md' }: { label: string; itemLabel: string; value: number | null; onChange: (n: number | null) => void; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-[11px]';
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${itemLabel} ${n}`}
          onClick={() => onChange(value === n ? null : n)}
          className={`${dim} rounded-lg border font-bold ${value && value >= n ? 'border-accent bg-[#e6f1cc] text-accent' : 'border-line text-muted'}`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** "2026-11-15T10:42:…" → "2026-11-15 10:42". */
export const fmtDateTime = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** Origin labels for real vs AI footage – one wording for script, shotlist and storyboard. */
export const ORIGIN_LABEL = { real: '◉ Real Footage', generated: 'KI-generiert', hybrid: '◐ Hybrid' } as const;

export function List({ title, items, tone = '' }: { title?: string; items: string[]; tone?: string }) {
  if (!items.length) return null;
  return (
    <>
      {title ? <div className="mt-2 font-semibold">{title}</div> : null}
      <ul className={`grid gap-0.5 ${tone}`}>{items.map((x, i) => <li key={i}>• {x}</li>)}</ul>
    </>
  );
}

/** Shell for any agent result: title, mock badge, time, extra badges, body, warnings. */
export function OutputCard({ testId, title, mock, createdAt, badges, warnings = [], children }: {
  testId: string; title: string; mock: boolean; createdAt: string; badges?: ReactNode; warnings?: string[]; children: ReactNode;
}) {
  return (
    <div className="mt-4 rounded-xl border border-line bg-card2 p-3 text-xs" data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm">{title}</strong>
        <MockBadge mock={mock} />
        {badges}
        <span className="text-muted">{fmtDateTime(createdAt)}</span>
      </div>
      {children}
      <List title="Hinweise" items={warnings} tone="text-warn" />
    </div>
  );
}
