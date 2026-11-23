'use client';
import { useMemo } from 'react';
import { SLOP_KIND_LABEL, slopHints, type SlopHint, type SlopWhere } from '@studio/core/slopLint';

/**
 * Quiet anti-slop hints under a text (Etappe 15). Non-blocking: nothing is changed or refused; labels such as
 * „Anzeige“, „KI-generiert“ or #ad are never reported (fixed exception list in core).
 */
export function SlopHints({ text, where, hints, testId = 'slop-hints' }: { text?: string; where?: SlopWhere; hints?: readonly SlopHint[]; testId?: string }) {
  const list = useMemo(() => hints ?? (text && where ? slopHints(text, where) : []), [hints, text, where]);
  if (!list.length) return null;
  return (
    <details className="mt-1 text-[11px] text-muted" data-testid={testId}>
      <summary className="cursor-pointer select-none">Stil-Hinweis{list.length > 1 ? `e (${list.length})` : ''} · nicht blockierend</summary>
      <ul className="mt-1 grid gap-0.5">
        {list.slice(0, 6).map((h, i) => (
          <li key={`${h.kind}-${h.start}-${i}`}>
            <span className="font-semibold">{SLOP_KIND_LABEL[h.kind]}:</span> „{h.excerpt}“ – {h.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
