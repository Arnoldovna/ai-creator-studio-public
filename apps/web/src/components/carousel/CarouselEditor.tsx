'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CAROUSEL_MAX_SLIDES, CAROUSEL_MIN_SLIDES, changeKind, emptySlide, fieldLabel, layoutCarousel, moveSlide, reviewCarousel, SLIDE_FIELDS, SLIDE_KIND_LABEL, SLIDE_KINDS,
  TEMPLATE_IDS, TEMPLATES, type CarouselBody, type CarouselImageInfo, type Slide, type SlideField, type SlideKind, type TemplateId,
} from '@studio/core/carousel';
import { api, ApiError, useApi } from '@/lib/api';
import type { CarouselRenderResult, CarouselView } from '@/lib/types';
import { ChatButton, useChatScope } from '../chat/ChatProvider';
import { MacFontFaces } from '../fonts/fontCss';
import { SlopHints } from '../SlopHints';
import { useToast } from '../toast';
import { Button, ErrorNote, Field, MockBadge, Pill, fmtDateTime } from '../ui';
import { CustomFontFaces } from '../video/editor/Stage';
import { SlideCanvas } from './SlideCanvas';

/**
 * The carousel editor (Etappe 18): slide strip (drag or Alt+←/→ to reorder), a big slide where a click on a text edits it in
 * place, an inspector (kind, surface, texts, image from her library), problems and hints (overflow blocks the export),
 * caption, checklist, three other looks side by side, the exact PNG render and the ZIP export. Edits stay local until
 * „Speichern“ makes them a new version; the chat (⌘K) proposes changes that become a version on „Übernehmen“.
 */
const ORIGIN_LABEL = { agent: 'KI-Entwurf', user_edit: 'deine Änderung', variant: 'anderer Look', chat: 'Chat' } as const;
const BIG = 432;

export function CarouselEditor({ projectId, carouselId, onChanged, onDeleted, onDirtyChange }: { projectId: string; carouselId: string; onChanged: () => void; onDeleted: () => Promise<void>; onDirtyChange?: (dirty: boolean) => void }) {
  const toast = useToast();
  const base = `/api/projects/${projectId}/carousels/${carouselId}`;
  const view = useApi<CarouselView>(base);
  const [draft, setDraft] = useState<CarouselBody | null>(null);
  const [sel, setSel] = useState(0);
  const [field, setField] = useState<SlideField | null>(null);
  const [editing, setEditing] = useState<SlideField | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<CarouselRenderResult | null>(null);
  const dragFrom = useRef<number | null>(null);

  const v = view.data;
  const body = draft ?? v?.version.body ?? null;
  const dirty = draft !== null;
  // review fix: the studio asks before an in-app switch would drop unsaved edits
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const images = useMemo(() => new Map<string, CarouselImageInfo>((v?.images ?? []).map((i) => [i.id, { kind: 'image', usage: i.usage, mime: i.mime, name: i.name }])), [v]);
  const layouts = useMemo(() => (body && v ? layoutCarousel(body, v.look, images) : []), [body, v, images]);
  const review = useMemo(() => (body && v ? reviewCarousel(body, v.look, images, v.rules) : null), [body, v, images]);
  const slide = body?.slides[Math.min(sel, (body?.slides.length ?? 1) - 1)] ?? null;
  const idx = body ? Math.min(sel, body.slides.length - 1) : 0;

  const update = useCallback((fn: (b: CarouselBody) => CarouselBody) => setDraft((d) => fn(structuredClone(d ?? view.data!.version.body))), [view.data]);
  const setSlide = (i: number, patch: Partial<Slide>) => update((b) => ({ ...b, slides: b.slides.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const setFieldText = (i: number, f: SlideField, text: string) => {
    if (f.startsWith('item:')) {
      const n = Number(f.slice(5));
      update((b) => ({ ...b, slides: b.slides.map((s, k) => (k === i ? { ...s, items: s.items.map((x, j) => (j === n ? text : x)) } : s)) }));
    } else setSlide(i, { [f]: text } as Partial<Slide>);
  };
  const fieldText = (s: Slide, f: SlideField) => (f.startsWith('item:') ? s.items[Number(f.slice(5))] ?? '' : (s[f as 'title' | 'body' | 'attribution'] ?? ''));

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || !view.data) return true;
    const sent = draft;
    setBusy('save');
    setError(null);
    try {
      const r = await api<CarouselView>(base, { method: 'PUT', json: { baseVersionId: view.data.version.id, body: sent } });
      view.setData(r);
      // review fix: edits typed while the request ran stay (they now build on the new version)
      setDraft((cur) => (cur === sent ? null : cur));
      setRendered(null);
      onChanged();
      toast(`Gespeichert – Version ${r.version.version}.`);
      return true;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${e.message} Deine ungespeicherten Änderungen bleiben hier stehen.` : (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }, [draft, view, base, onChanged, toast]);

  // the chat sees what she sees: unsaved edits are saved first; an applied proposal reloads the version
  useChatScope(v ? { scope: `carousel:${carouselId}`, label: 'Karussell', beforeSend: async () => { if (!(await save())) throw new Error('Speichern fehlgeschlagen'); }, onApplied: async () => { setDraft(null); setRendered(null); await view.reload(); onChanged(); } } : null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  if (view.error) return <ErrorNote error={view.error} />;
  if (!v || !body || !slide || !review) return <p className="hint">Lade Karussell …</p>;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= body.slides.length || from === to) return;
    update((b) => ({ ...b, slides: moveSlide(b.slides, from, to) }));
    setSel(to);
  };
  const addSlide = (kind: SlideKind) => {
    if (body.slides.length >= CAROUSEL_MAX_SLIDES) return;
    update((b) => ({ ...b, slides: [...b.slides.slice(0, idx + 1), emptySlide(kind, b.slides), ...b.slides.slice(idx + 1)] }));
    setSel(idx + 1);
  };
  const removeSlide = () => {
    if (body.slides.length <= CAROUSEL_MIN_SLIDES) return;
    update((b) => ({ ...b, slides: b.slides.filter((_, k) => k !== idx) }));
    setSel(Math.max(0, idx - 1));
  };

  async function chooseVariant(templateId: TemplateId) {
    if (dirty && !(await save())) return;
    setBusy(`variant-${templateId}`);
    try {
      const cur = await api<CarouselView>(base);
      const r = await api<CarouselView>(`${base}/variant`, { method: 'POST', json: { baseVersionId: cur.version.id, templateId } });
      view.setData(r);
      setRendered(null);
      onChanged();
      toast(`Look „${TEMPLATES[templateId].name}“ übernommen – Version ${r.version.version}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function renderPngs() {
    if (dirty && !(await save())) return;
    setBusy('render');
    setError(null);
    try {
      setRendered(await api<CarouselRenderResult>(`${base}/render`, { method: 'POST', json: {} }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function exportZip() {
    if (dirty && !(await save())) return;
    setBusy('export');
    setError(null);
    try {
      const res = await fetch(`${base}/export`, { cache: 'no-store' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'karussell.zip';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast('ZIP mit den Slides und der Caption heruntergeladen.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    if (!confirm('Dieses Karussell mit allen Versionen löschen?')) return;
    await api(base, { method: 'DELETE' });
    await onDeleted();
  }

  const look = v.look;
  const fonts = [look.title, look.body];
  const slideIssues = review.issues.filter((i) => i.slide === idx + 1);
  const slideSlop = review.slop.filter((s) => s.slide === idx + 1);
  const captionIssues = review.issues.filter((i) => i.slide == null);
  const errors = review.issues.filter((i) => i.level === 'error');
  const editLayout = layouts[idx]!;
  const editEl = editing ? editLayout.elements.find((e) => e.type === 'text' && e.field === editing) : null;
  const k = BIG / editLayout.width;
  const others = TEMPLATE_IDS.filter((t) => t !== body.templateId).slice(0, 3);
  const usable = v.images.filter((i) => i.usable);

  return (
    <div className="grid gap-5" data-testid="carousel-editor">
      <MacFontFaces names={fonts.filter((t) => t.mac).map((t) => t.assName)} />
      <CustomFontFaces enabled={fonts.some((t) => t.custom)} fontsKey={fonts.filter((t) => t.custom).map((t) => t.assName).join('|')} />
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 mr-2 text-xl font-bold">{v.carousel.title}</h2>
        <span data-testid="carousel-version"><Pill>v{v.version.version} · {ORIGIN_LABEL[v.version.origin]}</Pill></span>
        <MockBadge mock={v.version.mock} />
        <Pill>{v.carousel.source.label}</Pill>
        {dirty ? <Pill tone="warn">ungespeichert</Pill> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <ChatButton />
          <Link href={`/stories?project=${encodeURIComponent(projectId)}&source=carousel&id=${encodeURIComponent(carouselId)}`} className="inline-flex items-center rounded-lg border border-line px-3 py-2 text-xs font-medium hover:bg-[#f2f4ec]" data-testid="carousel-to-stories">Stories daraus →</Link>
          <Button variant="primary" busy={busy === 'save'} disabled={!dirty} onClick={() => void save()} data-testid="carousel-save">Speichern (neue Version)</Button>
          {dirty ? <Button variant="ghost" onClick={() => { setDraft(null); setEditing(null); }}>Verwerfen</Button> : null}
          <Button variant="danger" size="sm" onClick={remove}>Löschen</Button>
        </div>
      </header>
      <ErrorNote error={error} />
      {v.lookWarnings.length ? <p className="hint m-0 text-warn">{v.lookWarnings.join(' ')}</p> : null}

      {/* slide strip: click = select, drag or Alt+←/→ = reorder */}
      <div className="flex gap-2 overflow-x-auto pb-1" role="listbox" aria-label="Slides (Ziehen oder Alt+Pfeil zum Umsortieren)" data-testid="slide-strip">
        {layouts.map((l, i) => (
          <button key={body.slides[i]!.id} type="button" role="option" aria-selected={i === idx} draggable
            onClick={() => { setSel(i); setEditing(null); setField(null); }}
            onDragStart={() => { dragFrom.current = i; }} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragFrom.current != null) move(dragFrom.current, i); dragFrom.current = null; }}
            onKeyDown={(e) => {
              if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); move(i, i + (e.key === 'ArrowLeft' ? -1 : 1)); }
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setSel(Math.max(0, Math.min(body.slides.length - 1, i + (e.key === 'ArrowLeft' ? -1 : 1)))); }
            }}
            className={`shrink-0 rounded-md border-2 p-0.5 ${i === idx ? 'border-accent' : 'border-transparent'} ${review.issues.some((x) => x.slide === i + 1 && x.level === 'error') ? 'ring-2 ring-danger' : ''}`}
            data-testid="slide-thumb" aria-label={`Slide ${i + 1} ${SLIDE_KIND_LABEL[body.slides[i]!.kind]}`}>
            <SlideCanvas layout={l} look={look} width={96} testId="slide-thumb-canvas" />
            <span className="block text-center text-[10px] text-muted">{i + 1} · {SLIDE_KIND_LABEL[body.slides[i]!.kind]}</span>
          </button>
        ))}
        <div className="grid shrink-0 content-center gap-1">
          <select aria-label="Slide hinzufügen" className="field py-1 text-[11px]" value="" disabled={body.slides.length >= CAROUSEL_MAX_SLIDES} onChange={(e) => { if (e.target.value) addSlide(e.target.value as SlideKind); }}>
            <option value="">+ Slide …</option>
            {SLIDE_KINDS.map((x) => <option key={x} value={x}>{SLIDE_KIND_LABEL[x]}</option>)}
          </select>
          <div className="flex gap-1">
            <Button size="sm" onClick={() => move(idx, idx - 1)} disabled={idx === 0} aria-label="Slide nach links">←</Button>
            <Button size="sm" onClick={() => move(idx, idx + 1)} disabled={idx >= body.slides.length - 1} aria-label="Slide nach rechts">→</Button>
            <Button size="sm" variant="danger" onClick={removeSlide} disabled={body.slides.length <= CAROUSEL_MIN_SLIDES} aria-label="Slide entfernen">✕</Button>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)]">
        {/* the big slide: a click on a text edits it in place */}
        <div className="relative" style={{ width: BIG }}>
          <SlideCanvas layout={editLayout} look={look} width={BIG} testId="slide-big" selectedField={field}
            onFieldClick={(f) => { setField(f); setEditing(f); }} className="rounded-lg border border-line" />
          {editing && editEl && editEl.type === 'text' ? (
            <textarea autoFocus data-testid="slide-inline-editor" aria-label={`${fieldLabel(editing)} von Slide ${idx + 1}`}
              className="absolute z-10 resize-none rounded border-2 border-accent bg-white/90 p-1 text-[13px] leading-snug text-ink shadow-lg"
              style={{ left: editEl.box.x0 * k - 4, top: editEl.box.y0 * k - 4, width: (editEl.box.x1 - editEl.box.x0) * k + 8, minHeight: Math.max(48, (editEl.box.y1 - editEl.box.y0) * k + 8) }}
              value={fieldText(slide, editing)} onChange={(e) => setFieldText(idx, editing, e.target.value)}
              onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); setEditing(null); } }} />
          ) : null}
          <p className="hint mt-1">Klick auf einen Text bearbeitet ihn direkt (Esc = fertig). Vorschau im Browser – exakt ist „PNG rendern“.</p>
        </div>

        <aside className="grid content-start gap-3" aria-label={`Slide ${idx + 1} bearbeiten`} data-testid="slide-inspector">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Typ" htmlFor="slide-kind">
              <select id="slide-kind" className="field" value={slide.kind} onChange={(e) => update((b) => ({ ...b, slides: b.slides.map((s, j) => (j === idx ? changeKind(s, e.target.value as SlideKind) : s)) }))}>
                {SLIDE_KINDS.map((x) => <option key={x} value={x}>{SLIDE_KIND_LABEL[x]}</option>)}
              </select>
            </Field>
            <Field label="Fläche" htmlFor="slide-tone">
              <select id="slide-tone" className="field" value={slide.tone} onChange={(e) => setSlide(idx, { tone: e.target.value as Slide['tone'] })}>
                <option value="default">wie das Layout</option><option value="accent">Akzent (hervorheben)</option>
              </select>
            </Field>
          </div>
          {SLIDE_FIELDS[slide.kind].includes('image') ? (
            <Field label="Bild aus deiner Bibliothek" htmlFor="slide-image" hint="Nur eigene oder lizenzierte Bilder (mit Quelle) oder KI-Bilder – diese bekommen „KI-generiert“ auf die Slide.">
              <select id="slide-image" className="field" value={slide.imageId ?? ''} onChange={(e) => setSlide(idx, { imageId: e.target.value || null })}>
                <option value="">– kein Bild –</option>
                {usable.map((i) => <option key={i.id} value={i.id}>{i.name}{i.usage?.origin === 'generated' ? ' (KI-generiert)' : i.usage?.origin === 'licensed' ? ' (lizenziert)' : ''}</option>)}
              </select>
              {!usable.length ? <p className="hint mt-1">Noch kein Bild freigegeben – im Style Lab unter „Im Video einblenden?“ festlegen.</p> : null}
            </Field>
          ) : null}
          {SLIDE_FIELDS[slide.kind].includes('title') ? (
            <Field label="Titel" htmlFor="slide-title"><input id="slide-title" className="field" value={slide.title} maxLength={140} onChange={(e) => setSlide(idx, { title: e.target.value })} onFocus={() => setField('title')} /></Field>
          ) : null}
          {SLIDE_FIELDS[slide.kind].includes('body') ? (
            <Field label={slide.kind === 'quote' ? 'Zitat' : 'Text'} htmlFor="slide-body"><textarea id="slide-body" rows={4} className="field" value={slide.body} maxLength={600} onChange={(e) => setSlide(idx, { body: e.target.value })} onFocus={() => setField('body')} /></Field>
          ) : null}
          {SLIDE_FIELDS[slide.kind].includes('items') ? (
            <fieldset className="grid gap-1.5">
              <legend className="label">{slide.kind === 'before_after' ? 'Die beiden Seiten' : 'Punkte'}</legend>
              {slide.kind === 'before_after' ? (
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1].map((n) => <input key={n} aria-label={`Bezeichnung ${n + 1}`} className="field py-1 text-[11px]" value={slide.pairLabels[n]} maxLength={24} onChange={(e) => setSlide(idx, { pairLabels: (n === 0 ? [e.target.value, slide.pairLabels[1]] : [slide.pairLabels[0], e.target.value]) as Slide['pairLabels'] })} />)}
                </div>
              ) : null}
              {slide.items.map((it, n) => (
                <div key={n} className="flex gap-1">
                  <input aria-label={`Punkt ${n + 1}`} className="field" value={it} maxLength={160} onChange={(e) => setFieldText(idx, `item:${n}`, e.target.value)} onFocus={() => setField(`item:${n}`)} />
                  {slide.kind === 'list' ? <Button size="sm" variant="ghost" aria-label={`Punkt ${n + 1} entfernen`} onClick={() => setSlide(idx, { items: slide.items.filter((_, j) => j !== n) })}>✕</Button> : null}
                </div>
              ))}
              {slide.kind === 'list' && slide.items.length < 6 ? <Button size="sm" onClick={() => setSlide(idx, { items: [...slide.items, ''] })}>+ Punkt</Button> : null}
            </fieldset>
          ) : null}
          {SLIDE_FIELDS[slide.kind].includes('attribution') ? (
            <Field label="Quelle des Zitats (optional)" htmlFor="slide-attr" hint="Nur echte, belegte Zitate – sonst leer lassen (dann ist es dein Satz).">
              <input id="slide-attr" className="field" value={slide.attribution} maxLength={80} onChange={(e) => setSlide(idx, { attribution: e.target.value })} />
            </Field>
          ) : null}
          {slideIssues.length ? (
            <ul className="m-0 grid gap-1 p-0 text-[11px]" data-testid="slide-issues">
              {slideIssues.map((x, n) => <li key={n} className={`list-none rounded border px-2 py-1 ${x.level === 'error' ? 'border-[#f0b4ad] bg-[#fdecea] text-danger' : 'border-[#e8cf7a] bg-[#fff6db] text-warn'}`}>{x.level === 'error' ? 'Problem' : 'Hinweis'}: {x.message}</li>)}
            </ul>
          ) : null}
          {slideSlop.map((s) => <SlopHints key={s.field} hints={s.hints} testId="slide-slop" />)}
        </aside>
      </div>

      <section className="panel" aria-label="Caption">
        <h3 className="mb-2 text-sm font-bold">Caption</h3>
        <textarea aria-label="Caption" rows={6} className="field" value={body.caption} maxLength={2200} onChange={(e) => update((b) => ({ ...b, caption: e.target.value }))} data-testid="carousel-caption" />
        <SlopHints text={body.caption} where="caption" testId="caption-slop" />
        <Field label="Alt-Text" htmlFor="carousel-alt"><input id="carousel-alt" className="field" value={body.altText} maxLength={500} onChange={(e) => update((b) => ({ ...b, altText: e.target.value }))} /></Field>
        {captionIssues.length ? <ul className="mt-2 grid gap-1 p-0 text-[11px]">{captionIssues.map((x, n) => <li key={n} className={`list-none ${x.level === 'error' ? 'text-danger' : 'text-warn'}`}>{x.message}</li>)}</ul> : null}
        {review.requiredLabels.length ? <p className="hint mt-1">Kennzeichnung „{review.requiredLabels.join(' · ')}“ steht am Anfang und wird beim Speichern immer gesetzt (KI-Bild auf Slide {review.aiSlides.join(', ')}).</p> : null}
        <details className="mt-3 text-xs" data-testid="carousel-checklist">
          <summary className="cursor-pointer font-semibold">Checkliste ({review.checklist.filter((c) => c.ok).length}/{review.checklist.length})</summary>
          <ul className="mt-1 grid gap-0.5 p-0">{review.checklist.map((c) => <li key={c.id} className="list-none">{c.ok ? '✓' : '○'} {c.text}</li>)}</ul>
        </details>
      </section>

      <section className="panel" aria-label="Andere Looks" data-testid="carousel-variants">
        <h3 className="mb-1 text-sm font-bold">Dieselben Texte in anderen Looks</h3>
        <p className="hint mb-3">Farben und Schriften aus „Meine Marke“, eigenes Layout je Look. Wählen = neue Version.</p>
        <div className="grid gap-4 md:grid-cols-3">
          {others.map((t) => {
            const alt = layoutCarousel({ ...body, templateId: t }, look, images);
            return (
              <div key={t} className="grid min-w-0 content-start gap-2 rounded-lg border border-line p-2" data-testid={`variant-${t}`}>
                <div><strong className="block text-xs">{TEMPLATES[t].name}</strong><span className="text-[10px] text-muted">{TEMPLATES[t].description}</span></div>
                <div className="flex gap-1.5 overflow-hidden">
                  <SlideCanvas layout={alt[0]!} look={look} width={112} testId="variant-slide" />
                  <div className="grid content-start gap-1.5">{alt.slice(1, 3).map((l) => <SlideCanvas key={l.index} layout={l} look={look} width={52} testId="variant-slide" />)}</div>
                </div>
                <Button size="sm" busy={busy === `variant-${t}`} onClick={() => void chooseVariant(t)} data-testid={`variant-choose-${t}`}>Diesen Look wählen</Button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel" aria-label="Export">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 mr-auto text-sm font-bold">Bilder & Export</h3>
          <Button busy={busy === 'render'} onClick={() => void renderPngs()} data-testid="carousel-render">PNG rendern (exakt)</Button>
          <Button variant="primary" busy={busy === 'export'} disabled={errors.length > 0} onClick={() => void exportZip()} data-testid="carousel-export">ZIP exportieren</Button>
        </div>
        {errors.length ? <p className="hint mt-2 text-danger" data-testid="carousel-export-blocked">Export erst ohne Probleme: {errors.map((e) => e.message).join(' · ')}</p> : <p className="hint mt-2">ZIP: 01.png … {String(body.slides.length).padStart(2, '0')}.png, caption.txt{review.aiSlides.length ? ', KENNZEICHNUNG.txt' : ''}. Gepostet wird nichts.</p>}
        {rendered ? (
          <div className="mt-3">
            {rendered.render.warnings.length ? <p className="hint text-warn" data-testid="carousel-font-warnings">{rendered.render.warnings.join(' · ')}</p> : <p className="hint">Gerendert {fmtDateTime(rendered.render.at)} mit FFmpeg + libass (Schriften wie im Video), keine Schrift-Warnung.</p>}
            <div className="flex gap-2 overflow-x-auto" data-testid="carousel-pngs">
              {rendered.render.files.map((f) => (
                // eslint-disable-next-line @next/next/no-img-element -- private, generated PNGs
                <img key={f.key} src={`${base}/slides/${f.n}?version=${rendered.versionId}&k=${f.key.slice(0, 12)}`} alt={`Slide ${f.n} (PNG)`} width={160} className="rounded border border-line" />
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <details className="text-xs text-muted">
        <summary className="cursor-pointer">Versionen ({v.versions.length})</summary>
        <ul className="mt-1 grid gap-0.5 p-0">{v.versions.map((x) => <li key={x.id} className="list-none">v{x.version} · {ORIGIN_LABEL[x.origin]} · {TEMPLATES[x.templateId as TemplateId]?.name ?? x.templateId} · {fmtDateTime(x.createdAt)}{x.status === 'active' ? ' · aktiv' : ''}</li>)}</ul>
        {v.version.warnings.length ? <><div className="mt-2 font-semibold">Hinweise zum Entwurf</div><ul className="grid gap-0.5 p-0">{v.version.warnings.map((w, n) => <li key={n} className="list-none">{w}</li>)}</ul></> : null}
      </details>
    </div>
  );
}
