'use client';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CAROUSEL_FORMATS, FRAMEWORK_IDS, FRAMEWORKS, TEMPLATE_IDS, TEMPLATES, type FrameworkId, type TemplateId } from '@studio/core/carousel';
import { api, useApi } from '@/lib/api';
import type { CarouselList, CarouselView, Project } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, MockBadge, PageHeader, Pill, fmtDateTime } from '../ui';
import { CarouselEditor } from './CarouselEditor';

/**
 * Karussells (Etappe 18): one idea – a concept, a script, a finished reel or her own note – becomes a carousel in the look of
 * „Meine Marke“. She picks the structure, generates (cost shown first), edits on the slide, compares looks, exports PNGs.
 */
type SourceKind = 'concept' | 'script' | 'render' | 'note';
const SOURCE_LABEL: Record<SourceKind, string> = { concept: 'Konzept', script: 'Skript', render: 'Fertiges Reel', note: 'Eigene Notiz' };
const usd = (x: number | null | undefined) => (x == null ? '—' : x === 0 ? 'kostenlos' : `ca. $${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`);

export function CarouselStudio() {
  const params = useSearchParams();
  const projects = useApi<Project[]>('/api/projects');
  const personal = (projects.data ?? []).filter((p) => p.kind === 'PERSONAL_CONTENT');
  const [projectId, setProjectId] = useState<string | null>(params.get('project'));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default selection once projects load
    if (!projectId && personal.length) setProjectId(personal[0]!.id);
  }, [personal, projectId]);
  const list = useApi<CarouselList>(projectId ? `/api/projects/${projectId}/carousels` : null);
  const [openId, setOpenId] = useState<string | null>(params.get('carousel'));
  // review fix: switching carousel/project or opening a new one never drops unsaved edits silently
  const dirty = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => { dirty.current = d; }, []);
  const mayLeave = () => !dirty.current || confirm('Ungespeicherte Änderungen am offenen Karussell verwerfen?');
  const preset = params.get('source') && params.get('project') === projectId ? { kind: params.get('source') as SourceKind, id: params.get('id') } : null;

  return (
    <div className="appear">
      <PageHeader
        eyebrow="KARUSSELLS · EINE IDEE, MEHRERE LOOKS"
        title="Aus einer Idee"
        accent="ein Karussell."
        lead="Konzept, Skript, fertiges Reel oder eigene Notiz → Aufbau wählen → Slides im Look von „Meine Marke“ → direkt auf der Slide anpassen → Looks vergleichen → als PNGs exportieren. Jede Änderung ist eine neue Version; gepostet wird nichts."
      />
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Projekt" htmlFor="carousel-project">
          <select id="carousel-project" className="field w-72" value={projectId ?? ''} onChange={(e) => { if (mayLeave()) { setProjectId(e.target.value); setOpenId(null); } }}>
            {personal.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </Field>
        {projects.data && !personal.length ? <Pill tone="warn">Noch kein eigenes Projekt – unter „Overview“ anlegen.</Pill> : null}
      </div>
      {projectId && list.data ? (
        <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="grid content-start gap-4">
            <NewCarousel key={`${projectId}-${preset?.kind ?? ''}-${preset?.id ?? ''}`} projectId={projectId} list={list.data} preset={preset}
              onCreated={async (id) => { if (mayLeave()) setOpenId(id); await list.reload(); }} />
            <section className="panel" aria-label="Deine Karussells">
              <h2 className="mb-2 text-sm font-bold">Deine Karussells</h2>
              {list.data.carousels.length ? (
                <ul className="grid gap-1.5" data-testid="carousel-list">
                  {list.data.carousels.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => { if (c.id !== openId && mayLeave()) setOpenId(c.id); }} aria-current={openId === c.id ? 'true' : undefined}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${openId === c.id ? 'border-accent bg-[#f5f7f0]' : 'border-line hover:bg-[#f7f8f3]'}`}>
                        <span className="block font-semibold">{c.title}</span>
                        <span className="text-muted">{c.source.label} · {c.slides} Slides · v{c.version} · {TEMPLATES[c.templateId].name} · {fmtDateTime(c.updatedAt)}</span>
                        {c.mock ? <span className="ml-1"><MockBadge mock /></span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="hint m-0">Noch keins – oben eine Idee wählen.</p>}
            </section>
          </div>
          <div className="min-w-0">
            {openId ? (
              <CarouselEditor key={openId} projectId={projectId} carouselId={openId} onChanged={() => void list.reload()} onDeleted={async () => { setOpenId(null); await list.reload(); }} onDirtyChange={onDirtyChange} />
            ) : <Empty>Wähle links ein Karussell oder erstelle ein neues.</Empty>}
          </div>
        </div>
      ) : list.error ? <ErrorNote error={list.error} /> : null}
    </div>
  );
}

function NewCarousel({ projectId, list, preset, onCreated }: { projectId: string; list: CarouselList; preset: { kind: SourceKind; id: string | null } | null; onCreated: (id: string) => Promise<void> }) {
  const toast = useToast();
  const [kind, setKind] = useState<SourceKind>(preset?.kind ?? (list.sources.concepts.length ? 'concept' : 'note'));
  const items = kind === 'concept' ? list.sources.concepts : kind === 'script' ? list.sources.scripts : kind === 'render' ? list.sources.renders : [];
  const [itemId, setItemId] = useState<string>(preset?.id ?? '');
  const chosen = items.some((x) => x.id === itemId) ? itemId : items[0]?.id ?? '';
  const [note, setNote] = useState('');
  const [framework, setFramework] = useState<FrameworkId>('problem_weg_ergebnis');
  const [slideCount, setSlideCount] = useState<string>('');
  const [format, setFormat] = useState<'portrait' | 'square'>('portrait');
  const [templateId, setTemplateId] = useState<TemplateId>('klar');
  const [estimate, setEstimate] = useState(list.estimate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = kind === 'note' ? { kind, text: note } : { kind, id: chosen };
  const ready = kind === 'note' ? note.trim().length >= 10 : !!chosen;
  const request = { source, framework, slideCount: slideCount ? Number(slideCount) : null, format, templateId };
  const key = JSON.stringify(request);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const t = setTimeout(() => {
      void api<{ estimate: CarouselList['estimate'] }>(`/api/projects/${projectId}/carousels?estimate=1`, { method: 'POST', json: { ...request, estimate: true } })
        .then((r) => { if (live) setEstimate(r.estimate); }).catch(() => undefined);
    }, 400);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the request
  }, [key, ready, projectId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const v = await api<CarouselView>(`/api/projects/${projectId}/carousels`, { method: 'POST', json: request });
      toast(`Karussell erstellt${v.version.mock ? ' (Mock)' : ''} – ${v.version.body.slides.length} Slides.`);
      await onCreated(v.carousel.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!list.available) return <section className="panel"><p className="hint m-0">{list.reason}</p></section>;
  const f = FRAMEWORKS[framework];
  return (
    <section className="panel" aria-label="Neues Karussell" data-testid="carousel-new">
      <h2 className="mb-2 text-sm font-bold">Neues Karussell</h2>
      <fieldset className="mb-2">
        <legend className="label">Quelle</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Quelle">
          {(Object.keys(SOURCE_LABEL) as SourceKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${kind === k ? 'border-accent bg-[#eef6dc] font-semibold' : 'border-line'}`}>{SOURCE_LABEL[k]}</button>
          ))}
        </div>
      </fieldset>
      {kind === 'note' ? (
        <Field label="Deine Notiz (Idee, Stichpunkte, eigener Text)" htmlFor="carousel-note" hint="Zahlen und Erfahrungen nur, wenn sie stimmen – das Studio erfindet nichts dazu.">
          <textarea id="carousel-note" rows={5} className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      ) : items.length ? (
        <Field label={SOURCE_LABEL[kind]} htmlFor="carousel-item">
          <select id="carousel-item" className="field" value={chosen} onChange={(e) => setItemId(e.target.value)}>
            {items.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </Field>
      ) : <p className="hint">Keine {SOURCE_LABEL[kind]}-Quelle in diesem Projekt.</p>}
      <Field label="Aufbau" htmlFor="carousel-framework" hint={f.description}>
        <select id="carousel-framework" className="field" value={framework} onChange={(e) => setFramework(e.target.value as FrameworkId)}>
          {FRAMEWORK_IDS.map((id) => <option key={id} value={id}>{FRAMEWORKS[id].name}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Slides" htmlFor="carousel-count">
          <select id="carousel-count" className="field" value={slideCount} onChange={(e) => setSlideCount(e.target.value)}>
            <option value="">auto</option>
            {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Format" htmlFor="carousel-format">
          <select id="carousel-format" className="field" value={format} onChange={(e) => setFormat(e.target.value as 'portrait' | 'square')}>
            <option value="portrait">4:5</option><option value="square">1:1</option>
          </select>
        </Field>
        <Field label="Layout" htmlFor="carousel-template">
          <select id="carousel-template" className="field" value={templateId} onChange={(e) => setTemplateId(e.target.value as TemplateId)}>
            {TEMPLATE_IDS.map((t) => <option key={t} value={t}>{TEMPLATES[t].name}</option>)}
          </select>
        </Field>
      </div>
      <p className="hint mt-2" data-testid="carousel-estimate">Modell: {estimate.label} · {usd(estimate.estCostUsd)}{estimate.worstCaseUsd ? ` (höchstens $${estimate.worstCaseUsd.toFixed(3)})` : ''} · {CAROUSEL_FORMATS[format].label}</p>
      <Button variant="primary" className="mt-2 w-full" busy={busy} disabled={!ready} onClick={create} data-testid="carousel-create">✳ Karussell erstellen</Button>
      <ErrorNote error={error} />
    </section>
  );
}
