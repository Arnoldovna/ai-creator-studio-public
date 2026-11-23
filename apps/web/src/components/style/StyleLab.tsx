'use client';
import { useState } from 'react';
import { useApi } from '@/lib/api';
import type { ReferenceWithAnalysis } from '@/lib/types';
import { PageHeader } from '../ui';
import { ReferenceLibrary } from './ReferenceLibrary';
import { ReviewQueue } from './ReviewQueue';
import { StyleBibleEditor } from './StyleBibleEditor';

const TABS = [
  { id: 'library', label: 'Referenzbibliothek' },
  { id: 'review', label: 'KI-Analyse & Review' },
  { id: 'bible', label: 'Style Bible & Voice' },
] as const;
export type StyleTab = (typeof TABS)[number]['id'];

export function StyleLab({ initialTab }: { initialTab: StyleTab }) {
  const [tab, setTab] = useState<StyleTab>(initialTab);
  const refs = useApi<ReferenceWithAnalysis[]>('/api/references');
  const pending = refs.data?.reduce((n, r) => n + r.observations.filter((o) => o.decision === 'pending').length, 0) ?? 0;
  return (
    <div className="appear">
      <PageHeader
        eyebrow="01 / STYLE LAB · LEARN YOUR AESTHETIC"
        title="Deine Referenzen."
        accent="Deine Handschrift."
        lead="Sammle Fotos, Poster, Typografie, Video-Stills und Clips. Markiere selbst, was dir gefällt – und prüfe jeden KI-Vorschlag, bevor er in deine Style Bible gelangt. Fremde Referenzen sind Inspiration, keine Kopiervorlage."
        right={
          <div className="text-right text-5xl font-semibold tracking-tighter text-[#737b68]" data-testid="ref-count">
            {String(refs.data?.length ?? 0).padStart(2, '0')}
            <span className="block text-[9px] tracking-[0.08em] font-mono text-muted">REFERENZEN</span>
          </div>
        }
      />
      <div role="tablist" className="mb-6 flex flex-wrap gap-2 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              window.history.replaceState(null, '', `?tab=${t.id}`);
            }}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[13px] font-semibold ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}
            {t.id === 'review' && pending ? <span className="ml-2 rounded-full bg-warn px-1.5 text-[10px] text-[#ffffff]">{pending}</span> : null}
          </button>
        ))}
      </div>
      {refs.error ? <p className="text-danger">{refs.error}</p> : null}
      {tab === 'library' && <ReferenceLibrary refs={refs.data ?? []} loading={refs.loading} reload={refs.reload} onReview={() => setTab('review')} />}
      {tab === 'review' && <ReviewQueue refs={refs.data ?? []} reload={refs.reload} />}
      {tab === 'bible' && <StyleBibleEditor />}
    </div>
  );
}
