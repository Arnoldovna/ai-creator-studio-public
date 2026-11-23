'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '../ui';

/** Frees budget held by a crashed call; the user enters what the provider's bill shows, which is booked as spend. */
export function ReleaseReservation({ id, amountUsd }: { id: string; amountUsd: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" busy={busy} onClick={async () => {
        const answer = window.prompt(`Was hat der Anbieter laut Abrechnung für diesen Aufruf berechnet (USD)? 0, falls nichts. Der Betrag wird als Ausgabe gebucht, die Reservierung über bis zu ${amountUsd.toFixed(4)} USD entfällt.`, amountUsd.toFixed(4));
        if (answer == null) return;
        const chargedUsd = Number(answer.replace(',', '.'));
        if (!Number.isFinite(chargedUsd) || chargedUsd < 0) return setError('Bitte einen Betrag ab 0 eingeben.');
        setBusy(true);
        setError(null);
        try {
          await api(`/api/budget/reservations/${id}`, { method: 'DELETE', json: { chargedUsd } });
          router.refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>Freigeben</Button>
      {error ? <span className="text-danger">{error}</span> : null}
    </span>
  );
}
