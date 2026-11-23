'use client';
import { useState } from 'react';
import { lintBoundaries } from '@studio/core/strategyLint';
import { NO_GO_CATEGORY_LABEL } from '@studio/core/strategy';
import { api } from '@/lib/api';
import type { StrategyGateView } from '@/lib/types';
import { Button, ErrorNote, Pill } from '../ui';
import { announceGateChange } from './gateEvents';

export type GateKind = 'concept' | 'script' | 'copy' | 'storyboard' | 'edit_plan';
export const gatePath = (kind: GateKind, id: string) => `/api/strategy/gate/${kind}/${id}`;
export const LEGACY_LABEL = 'ohne Strategie-Bezug (vor Etappe 9)';
export const OVERRIDDEN_LABEL = 'Bewusst freigegeben';
export const LINT_LIMIT_NOTE = 'Die Prüfung findet nur typische Wörter. Umschreibungen erkennt sie nicht, deshalb fragst du dich hier selbst.';

type Blocker = StrategyGateView['blockers'][number];
type Finding = StrategyGateView['findings'][number];

/** „Bewusst trotzdem“ for one lint finding (client projects). The server checks the reason (≥ 10 characters) and stores it on the gate. */
export function OverrideForm({ kind, id, blocker, onDone }: { kind: GateKind; id: string; blocker: Blocker; onDone: (v: StrategyGateView) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!blocker.overridable) return null;
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = { type: 'lint', fingerprint: blocker.fingerprint, reason };
      onDone(await api<StrategyGateView>(`${gatePath(kind, id)}/override`, { method: 'POST', json: body }));
      announceGateChange();
      setOpen(false);
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Bewusst trotzdem (Begründung, mind. 10 Zeichen)</Button>;
  return (
    <div className="mt-1 grid gap-1.5" data-testid="override-form">
      <input className="field py-1.5 text-xs" aria-label="Begründung" placeholder="Warum ist das hier trotzdem in Ordnung?" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" busy={busy} onClick={submit}>Bewusst freigeben</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setError(null); }}>Abbrechen</Button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

/** Blockers with their override actions; the primary action stays disabled while this list is not empty. */
export function BlockerList({ kind, id, view, onChange }: { kind: GateKind; id: string; view: StrategyGateView; onChange: (v: StrategyGateView) => void }) {
  if (!view.blockers.length) return null;
  return (
    <div className="mt-2" data-testid="gate-blockers">
      <div className="text-[11px] font-semibold text-danger">Freigabe blockiert</div>
      <ul className="grid gap-1.5">
        {view.blockers.map((b) => (
          <li key={`${b.type}-${b.key}`} className="text-xs">
            <span className="text-danger">{b.message}</span>
            <OverrideForm kind={kind} id={id} blocker={b} onDone={onChange} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Field text with the finding's match marked (local only: the excerpt in messages masks own terms). */
function Highlight({ text, f }: { text: string; f: Finding }) {
  if (f.end <= f.start || f.end > text.length) return null;
  return (
    <span className="block text-muted">
      {text.slice(Math.max(0, f.start - 40), f.start)}<mark>{text.slice(f.start, f.end)}</mark>{text.slice(f.end, f.end + 40)}
    </span>
  );
}

/** Lint findings of the object: masked excerpt, local highlight, override state. */
export function FindingList({ view, texts }: { view: StrategyGateView; texts?: Record<string, string> }) {
  if (!view.findings.length) return null;
  return (
    <ul className="mt-2 grid gap-1 text-xs" data-testid="lint-findings">
      {view.findings.map((f) => (
        <li key={`${f.field}-${f.fingerprint}`}>
          <Pill tone={f.overridden ? 'default' : 'warn'}>{NO_GO_CATEGORY_LABEL[f.category]}</Pill> {f.message}
          {f.overridden ? <span className="ml-1 text-muted">· {OVERRIDDEN_LABEL}</span> : null}
          {texts?.[f.field] != null ? <Highlight text={texts[f.field]!.normalize('NFC')} f={f} /> : null}
        </li>
      ))}
    </ul>
  );
}

/** Deliberate releases on this piece, with their reason. */
export function OverrideList({ view }: { view: StrategyGateView }) {
  if (!view.overrides.length) return null;
  return (
    <ul className="mt-2 grid gap-0.5 text-[11px] text-muted" data-testid="gate-overrides">
      {view.overrides.map((o) => (
        <li key={o.id}>
          {OVERRIDDEN_LABEL}: Grenze ({NO_GO_CATEGORY_LABEL[o.category]})
          {o.reason ? <> – „{o.reason}“</> : null} · {o.at.slice(0, 10)}
        </li>
      ))}
    </ul>
  );
}

/**
 * Live marker next to an input (hook, overlay text): the keyword categories only. Own sensitive terms are checked
 * by the server at approval (they never come to this check).
 */
export function LintMarker({ text, projectKind }: { text: string; projectKind: 'PERSONAL_CONTENT' | 'UGC_CLIENT' }) {
  // Etappe 10: no boundary hints in her own projects (Carola 19.11.), only in client work
  const hits = text.trim() && projectKind === 'UGC_CLIENT' ? lintBoundaries([{ field: 'x', text }], { projectKind, terms: [] }) : [];
  if (!hits.length) return null;
  return (
    <span className="ml-1 text-[11px] text-warn" data-testid="lint-marker">
      ⚠ Grenze berührt: {[...new Set(hits.map((h) => NO_GO_CATEGORY_LABEL[h.category]))].join(', ')}
    </span>
  );
}
