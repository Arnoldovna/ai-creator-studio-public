import { Suspense } from 'react';
import { CarouselStudio } from '@/components/carousel/CarouselStudio';

export default function KarussellsPage() {
  // useSearchParams (preset from the Content Lab) needs a Suspense boundary
  return (
    <Suspense fallback={<p className="hint">Lade …</p>}>
      <CarouselStudio />
    </Suspense>
  );
}
