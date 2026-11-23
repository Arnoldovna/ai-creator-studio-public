import { Suspense } from 'react';
import { WeekBoard } from '@/components/week/WeekBoard';

export default function WochePage() {
  return (
    <Suspense fallback={<p className="hint">Lade …</p>}>
      <WeekBoard />
    </Suspense>
  );
}
