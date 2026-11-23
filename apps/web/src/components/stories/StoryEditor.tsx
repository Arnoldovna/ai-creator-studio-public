'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IG_FIELD_LABEL, IG_FIELD_OF_SLIDE, IG_MEDIA_LABEL, IG_STICKER_KINDS, IG_STICKER_LABEL, IG_STORY_CLIP_MAX_SEC, IG_STORY_CLIP_MIN_SEC, IG_STORY_KIND_LABEL, IG_STORY_KINDS, IG_STORY_SAFE,
  IG_STORY_SIZE, igMediaKey, layoutIgStory, reviewIgStory, type IgMediaInfo, type IgStoryBody, type IgStoryField, type IgStoryMedia,
} from '@studio/core/igStory';
import type { SlideField } from '@studio/core/carousel';
import { api, ApiError, useApi } from '@/lib/api';
import type { IgStoryRenderResult, IgStoryView } from '@/lib/types';
import { MacFontFaces } from '../fonts/fontCss';
import { SlideCanvas } from '../carousel/SlideCanvas';
import { SlopHints } from '../SlopHints';
import { useToast } from '../toast';
import { Button, ErrorNote, Field, MockBadge, Pill, fmtDateTime } from '../ui';
import { CustomFontFaces } from '../video/editor/Stage';

/**
 * One story (Etappe 19): the 9:16 preview with Instagram's covered areas shown, a click on a text edits it in place, the
 * inspector (kind, medium, clip range, layout, texts, sticker note, her notes), problems and hints, the exact PNG/MP4 and
 * the export. Edits stay local until „Speichern“ (⌘S).
 */
const W = 300;
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Media of the same source (a clip/still of the same reel, the same slide …) share their info; only times differ. */
const sourceKey = (k: string | null) => (k ? (k.startsWith('clip:') ? k.split(':').slice(0, 3).join(':') : k.startsWith('frame:') ? k.split(':').slice(0, 2).join(':') : k) : null);

export function StoryEditor({ projectId, storyId, onChanged, onDeleted, onExport, onDirtyChange }: { projectId: string; storyId: string; onChanged: () => void; onDeleted: () => Promise<void>; onExport: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const toast = useToast();
  const base = `/api/projects/${projectId}/stories/${storyId}`;
  const view = useApi<IgStoryView>(base);
  const [draft, setDraft] = useState<IgStoryBody | null>(null);
  const [editing, setEditing] = useState<IgStoryField | null>(null);
  const [showSafe, setShowSafe] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<IgStoryRenderResult | null>(null);
  const [boardDate, setBoardDate] = useState(localToday());

  const v = view.data;
  const body = draft ?? v?.story.body ?? null;
  const dirty = draft !== null;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const info = useMemo<IgMediaInfo | null>(() => {
    if (!v || !body || body.media.kind === 'none') return null;
    const key = igMediaKey(body.media);
    if (key === igMediaKey(v.story.body.media)) return v.media;
    return v.options.find((o) => o.key === key)?.info ?? v.options.find((o) => sourceKey(o.key) === sourceKey(key))?.info ?? (sourceKey(key) === sourceKey(igMediaKey(v.story.body.media)) ? v.media : null);
  }, [v, body]);
  const layout = useMemo(() => (v && body ? layoutIgStory(body, v.look, info) : null), [v, body, info]);
  const review = useMemo(() => (v && body && layout ? reviewIgStory(body, layout, v.rules) : null), [v, body, layout]);

  const update = useCallback((fn: (b: IgStoryBody) => IgStoryBody) => setDraft((d) => fn(structuredClone(d ?? view.data!.story.body))), [view.data]);
  const set = (patch: Partial<IgStoryBody>) => update((b) => ({ ...b, ...patch }));

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || !view.data) return true;
    const sent = draft;
    setBusy('save');
    setError(null);
    try {
      const r = await api<IgStoryView>(base, { method: 'PUT', json: { baseRevision: view.data.story.revision, body: sent } });
      view.setData(r);
      setDraft((cur) => (cur === sent ? null : cur));
      setRendered(null);
      onChanged();
      toast(`Gespeichert – Fassung ${r.story.revision}.`);
      return true;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${e.message} Deine ungespeicherten Änderungen bleiben hier stehen.` : (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }, [draft, view, base, onChanged, toast]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  if (view.error) return <ErrorNote error={view.error} />;
  if (!v || !body || !layout || !review) return <p className="hint">Lade Story …</p>;

  async function render() {
    if (dirty && !(await save())) return;
    setBusy('render');
    setError(null);
    try { setRendered(await api<IgStoryRenderResult>(`${base}/render`, { method: 'POST', json: {} })); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  async function exportOne() {
    if (dirty && !(await save())) return;
    onExport();
  }
  async function toBoard() {
    if (dirty && !(await save())) return;
    setBusy('board');
    setError(null);
    try {
      await api('/api/board/items', { method: 'POST', json: { date: boardDate || null, ref: { kind: 'story', id: storyId } } });
      toast('Auf dem Wochenboard eingetragen (nur geplant – gepostet wird nichts).');
      await view.reload();
      onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  async function remove() {
    if (!confirm('Diese Story löschen?')) return;
    await api(base, { method: 'DELETE' });
    await onDeleted();
  }

  const look = v.look;
  const fonts = [look.title, look.body];
  const k = W / IG_STORY_SIZE.width;
  const fieldText = (f: IgStoryField) => body[f];
  const editEl = editing ? layout.elements.find((e) => e.type === 'text' && e.field && IG_FIELD_OF_SLIDE[e.field as 'title' | 'body' | 'attribution'] === editing) : null;
  const errors = review.issues.filter((i) => i.level === 'error');
  const mediaKey = igMediaKey(body.media);
  const chooseMedia = (key: string) => {
    if (!key) return set({ media: { kind: 'none' } });
    const o = v.options.find((x) => x.key === key);
    if (o) set({ media: o.media, fit: o.media.kind === 'carousel_slide' ? 'card' : body.fit });
  };
  const clip = body.media.kind === 'clip' ? body.media : null;
  const setClip = (patch: Partial<Extract<IgStoryMedia, { kind: 'clip' }>>) => clip && set({ media: { ...clip, ...patch } });
  const mediaOptions = v.options.some((o) => o.key === mediaKey) || !mediaKey ? v.options : [{ key: mediaKey, label: `${IG_MEDIA_LABEL[body.media.kind]} (aktuell)`, media: body.media, kind: body.media.kind, ai: !!info?.ai, info: info! }, ...v.options];

  return (
    <div className="grid gap-5" data-testid="story-editor">
      <MacFontFaces names={fonts.filter((t) => t.mac).map((t) => t.assName)} />
      <CustomFontFaces enabled={fonts.some((t) => t.custom)} fontsKey={fonts.filter((t) => t.custom).map((t) => t.assName).join('|')} />
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 mr-2 text-xl font-bold">{v.story.title}</h2>
        <span data-testid="story-revision"><Pill>Fassung {v.story.revision} · {IG_STORY_KIND_LABEL[body.kind]}</Pill></span>
        <MockBadge mock={v.story.mock} />
        <Pill>{v.story.source.label}</Pill>
        {v.onBoard ? <Pill tone="ok">auf dem Wochenboard</Pill> : null}
        {dirty ? <Pill tone="warn">ungespeichert</Pill> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="primary" busy={busy === 'save'} disabled={!dirty} onClick={() => void save()} data-testid="story-save">Speichern</Button>
          {dirty ? <Button variant="ghost" onClick={() => { setDraft(null); setEditing(null); }}>Verwerfen</Button> : null}
          <Button variant="danger" size="sm" onClick={remove}>Löschen</Button>
        </div>
      </header>
      <ErrorNote error={error} />
      {v.lookWarnings.length ? <p className="hint m-0 text-warn">{v.lookWarnings.join(' ')}</p> : null}

      <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)]">
        <div>
          <div className="relative" style={{ width: W }}>
            <SlideCanvas layout={layout} look={look} width={W} testId="story-canvas" label="Story" className="rounded-xl border border-line"
              imageUrl={(key) => `/api/projects/${projectId}/stories/media?key=${encodeURIComponent(key)}`}
              selectedField={editing ? (Object.entries(IG_FIELD_OF_SLIDE).find(([, f]) => f === editing)?.[0] as SlideField) : null}
              onFieldClick={(f) => setEditing(IG_FIELD_OF_SLIDE[f as 'title' | 'body' | 'attribution'] ?? null)} />
            {showSafe ? (
              <>
                <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[3] grid place-items-center rounded-t-xl bg-[repeating-linear-gradient(135deg,rgba(0,0,0,0.18)_0_6px,rgba(0,0,0,0.06)_6px_12px)] text-[9px] font-semibold text-white" style={{ height: IG_STORY_SAFE.top * k }}>Instagram-Leiste (verdeckt)</div>
                <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] grid place-items-center rounded-b-xl bg-[repeating-linear-gradient(135deg,rgba(0,0,0,0.18)_0_6px,rgba(0,0,0,0.06)_6px_12px)] text-[9px] font-semibold text-white" style={{ height: IG_STORY_SAFE.bottom * k }}>Antwortfeld (verdeckt)</div>
              </>
            ) : null}
            {layout.sticker ? (
              <div className="pointer-events-none absolute z-[4] grid place-items-center rounded-lg border-2 border-dashed border-[#4a6116] bg-white/60 px-2 text-center text-[10px] font-semibold text-[#2f3d10]" data-testid="story-sticker-area"
                style={{ left: layout.sticker.x0 * k, top: layout.sticker.y0 * k, width: (layout.sticker.x1 - layout.sticker.x0) * k, height: (layout.sticker.y1 - layout.sticker.y0) * k }}>
                Platz für {IG_STICKER_LABEL[body.sticker.kind]} – in Instagram setzen
              </div>
            ) : null}
            {editing && editEl && editEl.type === 'text' ? (
              <textarea autoFocus data-testid="story-inline-editor" aria-label={`${IG_FIELD_LABEL[editing]} der Story`}
                className="absolute z-10 resize-none rounded border-2 border-accent bg-white/95 p-1 text-[13px] leading-snug text-ink shadow-lg"
                style={{ left: Math.max(0, editEl.box.x0 * k - 4), top: editEl.box.y0 * k - 4, width: Math.min(W, (editEl.box.x1 - editEl.box.x0) * k + 8), minHeight: Math.max(48, (editEl.box.y1 - editEl.box.y0) * k + 8) }}
                value={fieldText(editing)} onChange={(e) => set({ [editing]: e.target.value } as Partial<IgStoryBody>)}
                onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); setEditing(null); } }} />
            ) : null}
          </div>
          <label className="mt-2 flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={showSafe} onChange={(e) => setShowSafe(e.target.checked)} /> Verdeckte Bereiche zeigen</label>
          <p className="hint mt-1 max-w-[300px]">Klick auf einen Text bearbeitet ihn direkt (Esc = fertig). Text bleibt automatisch im sicheren Bereich. Vorschau im Browser – exakt ist „Rendern“.</p>
        </div>

        <aside className="grid content-start gap-3" aria-label="Story bearbeiten" data-testid="story-inspector">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Art" htmlFor="story-kind">
              <select id="story-kind" className="field" value={body.kind} onChange={(e) => set({ kind: e.target.value as IgStoryBody['kind'] })}>
                {IG_STORY_KINDS.map((x) => <option key={x} value={x}>{IG_STORY_KIND_LABEL[x]}</option>)}
              </select>
            </Field>
            <Field label="Textposition" htmlFor="story-pos">
              <select id="story-pos" className="field" value={body.textPos} onChange={(e) => set({ textPos: e.target.value as IgStoryBody['textPos'] })}>
                <option value="top">oben</option><option value="center">Mitte</option><option value="bottom">unten</option>
              </select>
            </Field>
          </div>
          <Field label="Bild oder Clip" htmlFor="story-media" hint="Nur dein Material: Fotos mit Rechte-Angabe, Slides deiner Karussells, Standbilder/Clips fertiger Reels, Clips deines Entwurfs. KI-Material bekommt „KI-generiert“ auf die Story.">
            <select id="story-media" className="field" value={mediaKey ?? ''} onChange={(e) => chooseMedia(e.target.value)} data-testid="story-media">
              <option value="">– nur Farbe –</option>
              {mediaOptions.map((o) => <option key={o.key} value={o.key}>{o.label}{o.ai ? ' (KI)' : ''}</option>)}
            </select>
          </Field>
          {clip ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Start (s)" htmlFor="story-clip-start"><input id="story-clip-start" type="number" step={0.1} min={0} className="field" value={clip.startSec} onChange={(e) => setClip({ startSec: Math.max(0, Number(e.target.value) || 0) })} /></Field>
              <Field label={`Länge (s, höchstens ${IG_STORY_CLIP_MAX_SEC})`} htmlFor="story-clip-dur"><input id="story-clip-dur" type="number" step={0.1} min={IG_STORY_CLIP_MIN_SEC} max={IG_STORY_CLIP_MAX_SEC} className="field" value={clip.durationSec} onChange={(e) => setClip({ durationSec: Math.min(IG_STORY_CLIP_MAX_SEC, Math.max(IG_STORY_CLIP_MIN_SEC, Number(e.target.value) || IG_STORY_CLIP_MIN_SEC)) })} /></Field>
            </div>
          ) : null}
          {body.media.kind !== 'none' ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Darstellung" htmlFor="story-fit">
                <select id="story-fit" className="field" value={body.fit} onChange={(e) => set({ fit: e.target.value as IgStoryBody['fit'] })}>
                  <option value="full">randlos</option><option value="card">als Karte</option>
                </select>
              </Field>
              <Field label="Hintergrund" htmlFor="story-tone">
                <select id="story-tone" className="field" value={body.tone} onChange={(e) => set({ tone: e.target.value as IgStoryBody['tone'] })}>
                  <option value="default">Hintergrundfarbe</option><option value="accent">Hauptfarbe</option>
                </select>
              </Field>
            </div>
          ) : (
            <Field label="Hintergrund" htmlFor="story-tone">
              <select id="story-tone" className="field" value={body.tone} onChange={(e) => set({ tone: e.target.value as IgStoryBody['tone'] })}>
                <option value="default">Hintergrundfarbe</option><option value="accent">Hauptfarbe</option>
              </select>
            </Field>
          )}
          <Field label={IG_FIELD_LABEL.kicker} htmlFor="story-kicker"><input id="story-kicker" className="field" maxLength={40} value={body.kicker} onChange={(e) => set({ kicker: e.target.value })} /></Field>
          <Field label={IG_FIELD_LABEL.title} htmlFor="story-title"><textarea id="story-title" rows={3} className="field" maxLength={140} value={body.title} onChange={(e) => set({ title: e.target.value })} data-testid="story-title" /></Field>
          <Field label={IG_FIELD_LABEL.body} htmlFor="story-body"><textarea id="story-body" rows={2} className="field" maxLength={240} value={body.body} onChange={(e) => set({ body: e.target.value })} /></Field>
          <fieldset className="grid gap-1.5 rounded-lg border border-line p-2">
            <legend className="label px-1">Sticker (setzt du in Instagram)</legend>
            <p className="hint m-0">Das Studio kann keine echten Sticker – es hält eine Fläche frei und schreibt dir auf, was du setzen willst.</p>
            <select aria-label="Sticker-Art" className="field" value={body.sticker.kind} onChange={(e) => set({ sticker: { ...body.sticker, kind: e.target.value as IgStoryBody['sticker']['kind'] } })} data-testid="story-sticker">
              {IG_STICKER_KINDS.map((x) => <option key={x} value={x}>{IG_STICKER_LABEL[x]}</option>)}
            </select>
            {body.sticker.kind !== 'none' ? (
              <>
                <input aria-label="Text im Sticker" className="field" maxLength={120} placeholder="Frage / Text im Sticker" value={body.sticker.prompt} onChange={(e) => set({ sticker: { ...body.sticker, prompt: e.target.value } })} />
                {body.sticker.kind === 'poll' || body.sticker.kind === 'quiz' ? (
                  <input aria-label="Antworten (mit / trennen)" className="field" placeholder="Antworten, mit / getrennt" value={body.sticker.options.join(' / ')}
                    onChange={(e) => set({ sticker: { ...body.sticker, options: e.target.value.split('/').map((x) => x.trim()).filter(Boolean).slice(0, 4) } })} />
                ) : null}
              </>
            ) : null}
          </fieldset>
          <Field label="Deine Notiz zum Posten" htmlFor="story-notes"><textarea id="story-notes" rows={2} className="field" maxLength={400} value={body.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
          {review.issues.length ? (
            <ul className="m-0 grid gap-1 p-0 text-[11px]" data-testid="story-issues">
              {review.issues.map((x, n) => <li key={n} className={`list-none rounded border px-2 py-1 ${x.level === 'error' ? 'border-[#f0b4ad] bg-[#fdecea] text-danger' : 'border-[#e8cf7a] bg-[#fff6db] text-warn'}`}>{x.level === 'error' ? 'Problem' : 'Hinweis'}: {x.message}</li>)}
            </ul>
          ) : null}
          {review.slop.map((s) => <SlopHints key={s.field} hints={s.hints} testId="story-slop" />)}
          {review.ai ? <p className="hint m-0">„KI-generiert“ steht auf der Story (im sicheren Bereich) und wird nie entfernt.</p> : null}
        </aside>
      </div>

      <section className="panel" aria-label="Rendern und Export">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 mr-auto text-sm font-bold">{layout.mode === 'clip' ? 'Clip (MP4) & Export' : 'Bild (PNG) & Export'}</h3>
          <Button busy={busy === 'render'} onClick={() => void render()} data-testid="story-render">{layout.mode === 'clip' ? 'MP4 rendern (exakt)' : 'PNG rendern (exakt)'}</Button>
          <Button variant="primary" disabled={errors.length > 0} onClick={() => void exportOne()} data-testid="story-export">ZIP exportieren</Button>
        </div>
        {errors.length ? <p className="hint mt-2 text-danger" data-testid="story-export-blocked">Export erst ohne Probleme: {errors.map((e) => e.message).join(' · ')}</p> : <p className="hint mt-2">ZIP: {layout.mode === 'clip' ? '01.mp4' : '01.png'}, notizen.txt{review.ai ? ', KENNZEICHNUNG.txt' : ''}{review.stickerNote ? ' (mit Sticker-Notiz)' : ''}. Gepostet wird nichts.</p>}
        {rendered ? (
          <div className="mt-3">
            {rendered.render.warnings.length ? <p className="hint text-warn" data-testid="story-font-warnings">{rendered.render.warnings.join(' · ')}</p> : <p className="hint">Gerendert {fmtDateTime(rendered.render.at)} mit FFmpeg + libass (Schriften wie im Video), keine Schrift-Warnung.</p>}
            <div data-testid="story-output">
              {rendered.render.mime === 'video/mp4'
                ? <video src={`${base}/file?k=${rendered.render.key.slice(0, 12)}`} controls width={180} className="rounded border border-line" aria-label="Story-Clip (MP4)" />
                // eslint-disable-next-line @next/next/no-img-element -- private, generated PNG
                : <img src={`${base}/file?k=${rendered.render.key.slice(0, 12)}`} alt="Story (PNG)" width={180} className="rounded border border-line" />}
            </div>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="Auf das Wochenboard (Tag)" htmlFor="story-board-date">
            <input id="story-board-date" type="date" className="field py-1 text-xs" value={boardDate} onChange={(e) => setBoardDate(e.target.value)} />
          </Field>
          <Button size="sm" busy={busy === 'board'} disabled={v.onBoard} onClick={() => void toBoard()} data-testid="story-to-board">{v.onBoard ? 'Schon auf dem Board' : 'Eintragen'}</Button>
        </div>
      </section>

      {v.story.warnings.length ? (
        <details className="text-xs text-muted"><summary className="cursor-pointer">Hinweise zum Vorschlag ({v.story.warnings.length})</summary>
          <ul className="mt-1 grid gap-0.5 p-0">{v.story.warnings.map((w, n) => <li key={n} className="list-none">{w}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
