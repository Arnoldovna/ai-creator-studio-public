'use client';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IG_STORY_KIND_LABEL, IG_STORY_KINDS, type IgStoryKind } from '@studio/core/igStory';
import { api, useApi } from '@/lib/api';
import type { Project, IgStoryCreateResult, IgStoryList, IgStoryView } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, MockBadge, PageHeader, Pill, fmtDateTime } from '../ui';
import { StoryEditor } from './StoryEditor';

/**
 * Stories (Etappe 19): from material she already has – a finished reel, a carousel, a concept, a photo, a note – the studio
 * suggests 3–5 stories in the look of „Meine Marke“ (cost shown first). She edits them on the story, renders PNG/MP4 and
 * exports a ZIP with notes for the stickers she sets in Instagram. Nothing is posted.
 */
type SourceKind = 'render' | 'carousel' | 'concept' | 'image' | 'note';
const SOURCE_LABEL: Record<SourceKind, string> = { render: 'Fertiges Reel', carousel: 'Karussell', concept: 'Konzept', image: 'Foto', note: 'Eigene Notiz' };
const usd = (x: number | null | undefined) => (x == null ? '—' : x === 0 ? 'kostenlos' : `ca. $${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`);

export function StoryStudio() {
  const params = useSearchParams();
  const toast = useToast();
  const projects = useApi<Project[]>('/api/projects');
  const personal = (projects.data ?? []).filter((p) => p.kind === 'PERSONAL_CONTENT');
  const [projectId, setProjectId] = useState<string | null>(params.get('project'));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default selection once projects load
    if (!projectId && personal.length) setProjectId(personal[0]!.id);
  }, [personal, projectId]);
  const list = useApi<IgStoryList>(projectId ? `/api/projects/${projectId}/stories` : null);
  const [openId, setOpenId] = useState<string | null>(params.get('story'));
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => { dirty.current = d; }, []);
  const mayLeave = () => !dirty.current || confirm('Ungespeicherte Änderungen an der offenen Story verwerfen?');
  const preset = params.get('source') && params.get('project') === projectId ? { kind: params.get('source') as SourceKind, id: params.get('id') } : null;

  async function exportZip(ids: string[]) {
    if (!projectId || !ids.length) return;
    setBusy('export');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/stories/export?ids=${ids.map(encodeURIComponent).join(',')}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'stories.zip';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast(`ZIP mit ${ids.length} Story/Stories heruntergeladen.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="appear">
      <PageHeader
        eyebrow="STORIES · AUS VORHANDENEM MATERIAL"
        title="Stories aus dem,"
        accent="was schon da ist."
        lead="Fertiges Reel, Karussell, Konzept, Foto oder Notiz → 3–5 Story-Vorschläge im Look von „Meine Marke“ (9:16, Text nur im sicheren Bereich) → auf der Story anpassen → PNG oder Clip (≤ 15 s) → ZIP mit Notizen für die Sticker, die du in Instagram setzt. Gepostet wird nichts."
      />
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="Projekt" htmlFor="story-project">
          <select id="story-project" className="field w-72" value={projectId ?? ''} onChange={(e) => { if (mayLeave()) { setProjectId(e.target.value); setOpenId(null); setSelected([]); } }}>
            {personal.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
        </Field>
        {projects.data && !personal.length ? <Pill tone="warn">Noch kein eigenes Projekt – unter „Overview“ anlegen.</Pill> : null}
      </div>
      <ErrorNote error={error} />
      {projectId && list.data ? (
        <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="grid min-w-0 content-start gap-4">
            <NewStories key={`${projectId}-${preset?.kind ?? ''}-${preset?.id ?? ''}`} projectId={projectId} list={list.data} preset={preset}
              onCreated={async (ids) => { await list.reload(); setSelected(ids); if (ids[0] && mayLeave()) setOpenId(ids[0]); }} />
            <section className="panel min-w-0" aria-label="Deine Stories">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="m-0 mr-auto text-sm font-bold">Deine Stories</h2>
                <Button size="sm" variant="primary" busy={busy === 'export'} disabled={!selected.length} onClick={() => void exportZip(selected)} data-testid="stories-export">
                  {selected.length ? `${selected.length} exportieren (ZIP)` : 'Auswahl exportieren'}
                </Button>
              </div>
              {list.data.stories.length ? (
                <ul className="grid min-w-0 gap-1.5" data-testid="story-list">
                  {list.data.stories.map((s) => (
                    <li key={s.id} className="flex min-w-0 items-start gap-2">
                      <input type="checkbox" className="mt-2.5" aria-label={`„${s.title}“ für den Export auswählen`} checked={selected.includes(s.id)}
                        onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))} data-testid="story-select" />
                      <button type="button" onClick={() => { if (s.id !== openId && mayLeave()) setOpenId(s.id); }} aria-current={openId === s.id ? 'true' : undefined}
                        className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-left text-xs ${openId === s.id ? 'border-accent bg-[#f5f7f0]' : 'border-line hover:bg-[#f7f8f3]'}`} data-testid="story-item">
                        <span className="block truncate font-semibold">{s.title}</span>
                        <span className="block break-words text-muted">{IG_STORY_KIND_LABEL[s.kind]} · {s.mode === 'clip' ? 'Clip' : 'Standbild'} · {s.source.label} · {fmtDateTime(s.updatedAt)}{s.onBoard ? ' · auf dem Board' : ''}</span>
                        {s.mock ? <span className="ml-1"><MockBadge mock /></span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="hint m-0">Noch keine – oben Material wählen.</p>}
              <EmptyStory projectId={projectId} onCreated={async (id) => { await list.reload(); if (mayLeave()) setOpenId(id); }} />
            </section>
          </div>
          <div className="min-w-0">
            {openId ? (
              <StoryEditor key={openId} projectId={projectId} storyId={openId} onChanged={() => void list.reload()} onExport={() => void exportZip([openId])}
                onDeleted={async () => { setOpenId(null); setSelected((cur) => cur.filter((x) => x !== openId)); await list.reload(); }} onDirtyChange={onDirtyChange} />
            ) : <Empty>Wähle links eine Story oder lass dir welche vorschlagen.</Empty>}
          </div>
        </div>
      ) : list.error ? <ErrorNote error={list.error} /> : null}
    </div>
  );
}

function EmptyStory({ projectId, onCreated }: { projectId: string; onCreated: (id: string) => Promise<void> }) {
  const [kind, setKind] = useState<IgStoryKind>('bts');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
      <Field label="Leere Story" htmlFor="story-empty-kind">
        <select id="story-empty-kind" className="field py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value as IgStoryKind)}>
          {IG_STORY_KINDS.map((k) => <option key={k} value={k}>{IG_STORY_KIND_LABEL[k]}</option>)}
        </select>
      </Field>
      <Button size="sm" busy={busy} onClick={async () => {
        setBusy(true);
        setError(null);
        try { const v = await api<IgStoryView>(`/api/projects/${projectId}/stories/manual`, { method: 'POST', json: { kind } }); await onCreated(v.story.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>+ Leere Story</Button>
      <ErrorNote error={error} />
    </div>
  );
}

function NewStories({ projectId, list, preset, onCreated }: { projectId: string; list: IgStoryList; preset: { kind: SourceKind; id: string | null } | null; onCreated: (ids: string[]) => Promise<void> }) {
  const toast = useToast();
  const firstKind: SourceKind = preset?.kind ?? (list.sources.renders.length ? 'render' : list.sources.carousels.length ? 'carousel' : list.sources.concepts.length ? 'concept' : 'note');
  const [kind, setKind] = useState<SourceKind>(firstKind);
  const items = kind === 'render' ? list.sources.renders : kind === 'carousel' ? list.sources.carousels : kind === 'concept' ? list.sources.concepts : kind === 'image' ? list.sources.images : [];
  const [itemId, setItemId] = useState<string>(preset?.id ?? '');
  const chosen = items.some((x) => x.id === itemId) ? itemId : items[0]?.id ?? '';
  const [note, setNote] = useState('');
  const [count, setCount] = useState(4);
  const [estimate, setEstimate] = useState(list.estimate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = kind === 'note' ? { kind, text: note } : { kind, id: chosen };
  const ready = kind === 'note' ? note.trim().length >= 10 : !!chosen;
  const request = { source, count };
  const key = JSON.stringify(request);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const t = setTimeout(() => {
      void api<{ estimate: IgStoryList['estimate'] }>(`/api/projects/${projectId}/stories?estimate=1`, { method: 'POST', json: { ...request, estimate: true } })
        .then((r) => { if (live) setEstimate(r.estimate); }).catch(() => undefined);
    }, 400);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the request
  }, [key, ready, projectId]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<IgStoryCreateResult>(`/api/projects/${projectId}/stories`, { method: 'POST', json: request });
      toast(`${r.ids.length} Story-Vorschläge${r.mock ? ' (Mock)' : ''} erstellt.`);
      await onCreated(r.ids);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!list.available) return <section className="panel"><p className="hint m-0">{list.reason}</p></section>;
  return (
    <section className="panel" aria-label="Neue Stories" data-testid="story-new">
      <h2 className="mb-2 text-sm font-bold">Stories vorschlagen lassen</h2>
      <fieldset className="mb-2">
        <legend className="label">Material</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Material">
          {(Object.keys(SOURCE_LABEL) as SourceKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${kind === k ? 'border-accent bg-[#eef6dc] font-semibold' : 'border-line'}`}>{SOURCE_LABEL[k]}</button>
          ))}
        </div>
      </fieldset>
      {kind === 'note' ? (
        <Field label="Deine Notiz" htmlFor="story-note" hint="Erfahrungen und Zahlen nur, wenn sie stimmen – das Studio erfindet nichts dazu.">
          <textarea id="story-note" rows={4} className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      ) : items.length ? (
        <Field label={SOURCE_LABEL[kind]} htmlFor="story-item">
          <select id="story-item" className="field" value={chosen} onChange={(e) => setItemId(e.target.value)}>
            {items.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </Field>
      ) : <p className="hint">Kein Material dieser Art {kind === 'image' ? '(Fotos brauchen eine Angabe „eigen/lizenziert/KI“ im Style Lab)' : 'in diesem Projekt'}.</p>}
      <Field label="Wie viele Vorschläge" htmlFor="story-count">
        <select id="story-count" className="field" value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {[3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      <p className="hint mt-2" data-testid="story-estimate">Modell: {estimate.label} · {usd(estimate.estCostUsd)}{estimate.worstCaseUsd ? ` (höchstens $${estimate.worstCaseUsd.toFixed(3)})` : ''}</p>
      <Button variant="primary" className="mt-2 w-full" busy={busy} disabled={!ready} onClick={create} data-testid="story-create">✳ Stories vorschlagen</Button>
      <ErrorNote error={error} />
    </section>
  );
}
