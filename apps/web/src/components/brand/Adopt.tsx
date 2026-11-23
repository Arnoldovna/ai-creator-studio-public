'use client';
import { useState } from 'react';
import { COLOR_ROLE_LABELS, COLOR_ROLES, type ColorRole } from '@studio/core/designSystem';
import { api } from '@/lib/api';
import { useToast } from '../toast';
import { Button } from '../ui';

/**
 * „Ins Design System übernehmen“ (Etappe 14) from the Style Lab. Each action saves a new active Style Bible version
 * with the changed „Meine Marke“ and records where the token came from (observation, reference or palette).
 */
async function adopt(json: Record<string, unknown>) {
  return api<{ version: { version: number } }>('/api/design-system/adopt', { method: 'POST', json });
}

/** A colour → pick a role → saved. */
export function AdoptColor({ hex, observationId, referenceId, onDone }: { hex: string; observationId?: string; referenceId?: string; onDone?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<ColorRole>('accent');
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button type="button" className="inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink" onClick={() => setOpen(true)} data-testid="adopt-color" title={`${hex} ins Design System übernehmen`}>
        <span className="inline-block h-3 w-3 rounded-full border border-line" style={{ background: hex }} aria-hidden />
        {hex} → Marke
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-line bg-card p-1 text-[11px]" data-testid="adopt-color-form">
      <span className="inline-block h-4 w-4 rounded border border-line" style={{ background: hex }} aria-hidden />
      <label className="sr-only" htmlFor={`role-${hex}-${observationId ?? referenceId ?? 'p'}`}>Farbrolle für {hex}</label>
      <select id={`role-${hex}-${observationId ?? referenceId ?? 'p'}`} className="field py-1 text-[11px]" value={role} onChange={(e) => setRole(e.target.value as ColorRole)} aria-label={`Farbrolle für ${hex}`}>
        {COLOR_ROLES.map((r) => <option key={r} value={r}>{COLOR_ROLE_LABELS[r].label}</option>)}
      </select>
      <Button size="sm" variant="primary" busy={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await adopt({ kind: 'color', hex, role, ...(observationId ? { observationId } : {}), ...(referenceId ? { referenceId } : {}) });
          toast(`${hex} ist jetzt „${COLOR_ROLE_LABELS[role].label}“ in Meine Marke (Style Bible v${r.version.version}).`);
          setOpen(false);
          onDone?.();
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>Ins Design System</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Abbrechen</Button>
    </span>
  );
}

/** A confirmed observation → guideline or image look; a reference → image look. */
export function AdoptButton({ label, json, testId, onDone }: { label: string; json: Record<string, unknown>; testId: string; onDone?: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" variant="ghost" busy={busy} data-testid={testId} onClick={async () => {
      setBusy(true);
      try {
        const r = await adopt(json);
        toast(`In Meine Marke übernommen (Style Bible v${r.version.version}).`);
        onDone?.();
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setBusy(false);
      }
    }}>{label}</Button>
  );
}
