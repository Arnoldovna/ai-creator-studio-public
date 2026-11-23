import { Suspense } from 'react';
import { StoryStudio } from '@/components/stories/StoryStudio';

export default function StoriesPage() {
  // useSearchParams (preset from the carousel editor or the board) needs a Suspense boundary
  return (
    <Suspense fallback={<p className="hint">Lade …</p>}>
      <StoryStudio />
    </Suspense>
  );
}
