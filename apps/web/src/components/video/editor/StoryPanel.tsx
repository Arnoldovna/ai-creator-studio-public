'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BEAT_ROLE_COLOR, BEAT_ROLE_LABEL, beatRhythmNote, beatSec, HOOK_FORMULAS, moveBeat, STORY_TARGET_SEC, STORY_ZOOM_LABEL, toggleBeat,
  type StorySelection,
} from '@studio/core/story';
import { buildTimeline, mapSpan, type Timeline } from '@studio/core/timeline';
import { api } from '@/lib/api';
import type { StoryApplyResult, StoryList, StoryPlanView } from '@/lib/types';
import { SlopHints } from '../../SlopHints';
import { Button, ErrorNote, Field, Pill } from '../../ui';

/**
 * KI-Dramaturgie in the editor (Etappe 16): „Dramaturgie vorschlagen“ with the cost shown first, the beat list (reorder by
 * drag or Alt+↑/↓, deselect), the „Warum“ per beat (pillar, her cut rhythm), the hook options as a grid of up to six exact
 * stills (FFmpeg frame of the proposed cut with that hook in her preset), and the suggested overlays, images and zooms.
 * „Übernehmen“ applies the selection as a normal draft change (⌘Z); single ghosts are applied on their own.
 */
const usd = (x: number | null | undefined) => (x == null ? '–' : x === 0 ? '0 $' : `≈ ${x < 0.01 ? x.toFixed(4) : x.toFixed(3)} $`);
const OVERLAY_LABEL = { keyword: 'Keyword', lower_third: 'Bauchbinde', arrow: 'Pfeil' } as const;

/** Story items on the current cut's output timeline (where their sentences are now). */
export interface StoryTrack {
  beats: { id: string; n: number; label: string; color: string; outStart: number; outEnd: number; selected: boolean }[];
  ghosts: { id: string; kind: 'overlay' | 'image' | 'zoom'; label: string; outStart: number; outEnd: number; selected: boolean }[];
}

export interface StoryHooks {
  /** Saves the draft and returns the revision she sees (the apply checks it). */
  flush: () => Promise<number>;
  /** After an apply: takes over the new draft revision as an undo step. */
  adopt: () => Promise<void>;
  onNotice: (text: string) => void;
}

export function useStory(projectId: string, scriptId: string | null, enabled: boolean, hooks: StoryHooks) {
  const [data, setData] = useState<StoryList | null>(null);
  const [selection, setSelection] = useState<StorySelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const planId = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await api<StoryList>(`/api/projects/${projectId}/edit-draft/story?scriptId=${scriptId ?? ''}`);
      setData(r);
      const plan = r.plans[0] ?? null;
      if (plan && plan.id !== planId.current) {
        planId.current = plan.id;
        setSelection(plan.lastSelection?.beats ? plan.lastSelection : plan.defaultSelection);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, scriptId, enabled]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const plan: StoryPlanView | null = data?.plans[0] ?? null;
  const hooksRef = useRef(hooks);
  useEffect(() => { hooksRef.current = hooks; });
  /** Applies `s` (the panel's selection, or a single ghost) as ONE draft change (⌘Z in the editor). */
  const apply = useCallback(async (s: StorySelection, what: string) => {
    if (!plan) return;
    setBusy(what);
    setError(null);
    try {
      const revision = await hooksRef.current.flush();
      const r = await api<StoryApplyResult>(`/api/projects/${projectId}/edit-draft/story/${plan.id}/apply`, { method: 'POST', json: { scriptId, revision, selection: s } });
      await hooksRef.current.adopt();
      hooksRef.current.onNotice(`Dramaturgie übernommen (Stand ${r.revision}): ${r.changes.map((c) => c.label).join(', ')}.${r.warnings.length ? ` Hinweise: ${r.warnings.join(' ')}` : ''} Strg/⌘+Z macht es rückgängig.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [plan, projectId, scriptId, load]);
  return { data, plan, selection, setSelection, error, setError, busy, setBusy, reload: load, apply, flush: () => hooksRef.current.flush() };
}
export type StoryState = ReturnType<typeof useStory>;

/** Output span of sentences n..m on the current cut (null when they are not in it). */
export function sentenceSpan(plan: StoryPlanView, body: { clips: readonly { assetId: string; inSec: number; outSec: number }[] }, tl: Timeline, from: number, to: number) {
  const a = plan.body.sentences[from - 1], b = plan.body.sentences[to - 1];
  if (!a || !b) return null;
  const i = body.clips.findIndex((c) => c.assetId === a.assetId && a.endSec > c.inSec + 0.05 && a.startSec < c.outSec - 0.05);
  if (i < 0) return null;
  const c = body.clips[i]!;
  return mapSpan(tl, i, Math.max(c.inSec, a.startSec), Math.min(c.outSec, b.assetId === a.assetId ? b.endSec : a.endSec));
}

/** Items already applied to the draft (single ghosts disappear once applied). */
const appliedIds = (plan: StoryPlanView) => new Set(plan.applied.flatMap((a) => [...a.selection.overlayIds, ...a.selection.imageIds, ...a.selection.zoomBeatIds.map((z) => `z${z}`)]));

export function storyTrack(plan: StoryPlanView | null, sel: StorySelection | null, body: { clips: readonly { assetId: string; inSec: number; outSec: number }[] } | null): StoryTrack | null {
  if (!plan || !sel || !body) return null;
  const tl = buildTimeline(body.clips);
  const chosen = new Set(sel.beats ?? plan.body.beats.map((b) => b.id));
  const done = appliedIds(plan);
  const beats = plan.body.beats.flatMap((b, i) => {
    const sp = sentenceSpan(plan, body, tl, b.from, b.to);
    return sp ? [{ id: b.id, n: i + 1, label: `${i + 1} · ${BEAT_ROLE_LABEL[b.role]}`, color: BEAT_ROLE_COLOR[b.role], outStart: sp.startSec, outEnd: sp.endSec, selected: chosen.has(b.id) }] : [];
  });
  const ghosts: StoryTrack['ghosts'] = [];
  for (const o of plan.body.overlays) {
    const sp = done.has(o.id) ? null : sentenceSpan(plan, body, tl, o.sentence, o.sentence);
    if (sp) ghosts.push({ id: o.id, kind: 'overlay', label: `${OVERLAY_LABEL[o.kind]}${o.text ? ` „${o.text}“` : ''}`, outStart: sp.startSec, outEnd: Math.min(sp.endSec, sp.startSec + 2.5), selected: sel.overlayIds.includes(o.id) });
  }
  for (const im of plan.body.images) {
    const sp = done.has(im.id) ? null : sentenceSpan(plan, body, tl, im.sentence, im.sentence);
    if (sp) ghosts.push({ id: im.id, kind: 'image', label: 'Bild', outStart: sp.startSec, outEnd: Math.min(sp.endSec, sp.startSec + 3), selected: sel.imageIds.includes(im.id) });
  }
  for (const b of plan.body.beats) {
    if (b.zoom === 'none' || done.has(`z${b.id}`)) continue;
    const sp = sentenceSpan(plan, body, tl, b.from, b.to);
    if (sp) ghosts.push({ id: b.id, kind: 'zoom', label: STORY_ZOOM_LABEL[b.zoom], outStart: sp.startSec, outEnd: sp.endSec, selected: sel.zoomBeatIds.includes(b.id) });
  }
  return { beats, ghosts };
}

export interface StoryPanelProps {
  projectId: string;
  scriptId: string | null;
  story: StoryState;
  onSeek: (t: number) => void;
  body: { clips: readonly { assetId: string; inSec: number; outSec: number }[] };
  /** Draft revision (the hook stills are drawn from the saved draft: a new revision gives new stills). */
  revision: number;
}

export function StoryPanel({ projectId, scriptId, story, onSeek, body, revision }: StoryPanelProps) {
  const { data, plan, selection: sel, setSelection, error, setError, busy, setBusy, apply } = story;
  const [target, setTarget] = useState<number>(STORY_TARGET_SEC.default);
  const [withBeats, setWithBeats] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const tl = useMemo(() => buildTimeline(body.clips), [body.clips]);

  async function propose() {
    setBusy('propose');
    setError(null);
    try {
      await story.flush();
      await api(`/api/projects/${projectId}/edit-draft/story`, { method: 'POST', json: { scriptId, targetSec: target } });
      await story.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  if (!data) return error ? <ErrorNote error={error} /> : null;
  if (!data.available) return <p className="hint m-0" data-testid="story-unavailable">KI-Dramaturgie: {data.reason}</p>;
  const est = data.estimate;
  const ordered = plan && sel ? [...(sel.beats ?? plan.body.beats.map((b) => b.id)).map((id) => plan.body.beats.find((b) => b.id === id)!).filter(Boolean), ...plan.body.beats.filter((b) => !(sel.beats ?? []).includes(b.id) && sel.beats != null)] : [];
  const chosen = new Set(sel?.beats ?? plan?.body.beats.map((b) => b.id) ?? []);
  const mv = (id: string, d: number) => sel && setSelection(moveBeat(sel, id, (sel.beats ?? []).indexOf(id) + d));
  const onRowKey = (id: string) => (e: ReactKeyboardEvent<HTMLLIElement>) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    mv(id, e.key === 'ArrowUp' ? -1 : 1);
  };
  const onDrop = (id: string) => (e: ReactDragEvent) => {
    e.preventDefault();
    if (!sel?.beats || !dragId || dragId === id) return;
    setSelection(moveBeat(sel, dragId, sel.beats.indexOf(id)));
    setDragId(null);
  };
  const toggle = (key: 'overlayIds' | 'imageIds' | 'zoomBeatIds', id: string) => sel && setSelection({ ...sel, [key]: sel[key].includes(id) ? sel[key].filter((x) => x !== id) : [...sel[key], id] });
  const frameUrl = (hookId: string) => `/api/projects/${projectId}/edit-draft/frame?${new URLSearchParams({ storyId: plan!.id, hook: hookId, t: '0.6', scriptId: scriptId ?? '', r: String(revision) })}`;
  const sentence = (n: number) => plan?.body.sentences[n - 1]?.text ?? '';

  return (
    <div className="rounded-lg border border-line p-3 text-xs" data-testid="story-panel">
      <div className="flex flex-wrap items-end gap-2">
        <h3 className="m-0 text-sm font-bold">Dramaturgie</h3>
        <Field label="Ziel-Länge (s)" htmlFor="story-target">
          <input id="story-target" type="number" className="field w-20" min={STORY_TARGET_SEC.min} max={STORY_TARGET_SEC.max} value={target} onChange={(e) => setTarget(Math.max(STORY_TARGET_SEC.min, Math.min(STORY_TARGET_SEC.max, Math.round(Number(e.target.value) || STORY_TARGET_SEC.default))))} />
        </Field>
        <Button size="sm" variant="primary" busy={busy === 'propose'} disabled={!!busy} onClick={() => void propose()} data-testid="story-propose"
          title="Ein Lauf des Edit Directors auf deinem Transkript, deiner Strategie und Meine Marke">Dramaturgie vorschlagen</Button>
        <span className="text-muted" data-testid="story-estimate">{est.mode === 'mock' ? 'MOCK · kostenlos, regelbasiert' : `${est.label} · ${usd(est.estCostUsd)} (höchstens ${usd(est.worstCaseUsd)})`}</span>
      </div>
      <ErrorNote error={error} />
      {!plan ? <p className="hint m-0 mt-2">Aus dem Transkript entsteht ein Vorschlag: Beats (Hook, Kontext, Wendung, Payoff, CTA), bis zu sechs Hook-Ideen und passende Overlays in deinem Stil. Nichts ändert sich, bis du übernimmst.</p> : sel ? (
        <div className="mt-2 grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {plan.mock ? <Pill tone="mock">MOCK · kein LLM</Pill> : <Pill>{plan.model}{plan.costUsd != null ? ` · ${usd(plan.costUsd)}` : ''}</Pill>}
            {plan.stale ? <Pill tone="danger">Transkript geändert – neu vorschlagen</Pill> : null}
            <span className="text-muted">{plan.body.summary}</span>
          </div>
          {plan.body.warnings.length ? <details className="text-warn" data-testid="story-warnings"><summary className="cursor-pointer">{plan.body.warnings.length} Hinweis(e) zum Vorschlag</summary><ul className="m-0 mt-1 list-disc pl-5">{plan.body.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details> : null}

          <section aria-label="Beats">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <strong>Beats</strong>
              <label className="flex items-center gap-1"><input type="checkbox" checked={withBeats} onChange={(e) => setWithBeats(e.target.checked)} data-testid="story-with-beats" /> Schnitt aus den Beats bauen</label>
              <span className="text-muted">Ziehen oder Alt+↑/↓ stellt um, Häkchen wählt ab.</span>
            </div>
            <ol className="m-0 grid gap-1 pl-0" data-testid="story-beats">
              {ordered.map((b) => {
                const n = plan.body.beats.indexOf(b) + 1;
                const on = chosen.has(b.id);
                const sp = sentenceSpan(plan, body, tl, b.from, b.to);
                return (
                  <li key={b.id} tabIndex={0} draggable={on} onDragStart={() => setDragId(b.id)} onDragOver={(e) => e.preventDefault()} onDrop={onDrop(b.id)} onKeyDown={onRowKey(b.id)}
                    className={`flex flex-wrap items-start gap-2 rounded border border-line p-1.5 ${on ? '' : 'opacity-50'} ${dragId === b.id ? 'ring-2 ring-lime' : ''}`} data-testid="story-beat" data-beat={b.id} data-selected={on}
                    aria-label={`Beat ${n}: ${BEAT_ROLE_LABEL[b.role]}, Satz ${b.from}–${b.to}${on ? '' : ', abgewählt'}`}>
                    <input type="checkbox" checked={on} onChange={() => setSelection(toggleBeat(sel, b.id, plan.body))} aria-label={`Beat ${n} ${on ? 'abwählen' : 'wieder aufnehmen'}`} data-testid="story-beat-toggle" />
                    <span className="cursor-grab select-none text-muted" aria-hidden>⋮⋮</span>
                    <span className="rounded px-1.5 font-semibold text-[#1d2416]" style={{ background: BEAT_ROLE_COLOR[b.role] }}>{n} · {BEAT_ROLE_LABEL[b.role]}</span>
                    <button type="button" className="font-mono underline" disabled={!sp} onClick={() => sp && onSeek(sp.startSec)} title={sp ? 'Zu dieser Stelle im Schnitt' : 'Nicht im aktuellen Schnitt'}>Satz {b.from}{b.to !== b.from ? `–${b.to}` : ''} · {beatSec(b, plan.body.sentences).toFixed(1)} s</button>
                    <span className="min-w-0 flex-1 truncate" title={plan.body.sentences.slice(b.from - 1, b.to).map((s) => s.text).join(' ')}>{sentence(b.from)}</span>
                    {on && sel.beats ? <span className="flex gap-0.5"><Button size="sm" variant="ghost" aria-label={`Beat ${n} nach oben`} onClick={() => mv(b.id, -1)}>↑</Button><Button size="sm" variant="ghost" aria-label={`Beat ${n} nach unten`} onClick={() => mv(b.id, 1)}>↓</Button></span> : null}
                    <p className="hint m-0 w-full" data-testid="story-why">Warum: {b.why || '–'} · {beatRhythmNote(b, plan.body.sentences, data.motion, data.pillars)}</p>
                  </li>
                );
              })}
            </ol>
          </section>

          {plan.body.hooks.length ? (
            <section aria-label="Hook-Optionen">
              <div className="mb-1 flex flex-wrap items-center gap-2"><strong>Hook</strong><span className="text-muted">Standbilder über FFmpeg (exakt wie im Render), Klick wählt.</span>
                <button type="button" className="underline" onClick={() => setSelection({ ...sel, hookId: null })} aria-pressed={sel.hookId == null}>keinen Hook übernehmen</button></div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Hook wählen" data-testid="story-hooks">
                {plan.body.hooks.map((h, i) => (
                  <button key={h.id} type="button" role="radio" aria-checked={sel.hookId === h.id} onClick={() => setSelection({ ...sel, hookId: h.id })}
                    className={`grid content-start gap-1 rounded border p-1 text-left ${sel.hookId === h.id ? 'border-lime ring-2 ring-lime' : 'border-line'}`} data-testid="story-hook" data-hook={h.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a private PNG from the studio's own frame endpoint */}
                    <img src={frameUrl(h.id)} alt={`Standbild mit Hook ${i + 1}: ${h.text}`} loading="lazy" className="aspect-[9/16] w-full rounded bg-black object-cover" data-testid="story-hook-still" />
                    <span className="font-semibold">{i + 1}. {h.text}</span>
                    <span className="text-muted">{HOOK_FORMULAS[h.formula]} · {h.source === 'quote' ? `Zitat aus Satz ${h.sentence}` : 'neu formuliert'}</span>
                    {h.notes.length ? <span className="text-warn" title={h.notes.join(' ')}>Kein Zitat – prüfen, dass nichts behauptet wird, was du nicht sagst.</span> : null}
                    <SlopHints hints={h.lint} testId="story-hook-slop" />
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {plan.body.overlays.length || plan.body.images.length || plan.body.beats.some((b) => b.zoom !== 'none') ? (
            <section aria-label="Vorgeschlagene Overlays, Bilder und Zooms" data-testid="story-extras">
              <div className="mb-1 flex flex-wrap items-center gap-2"><strong>Overlays, Bilder, Zooms</strong><span className="text-muted">in der Zeitleiste als Geisterblöcke</span>
                <Button size="sm" variant="ghost" onClick={() => setSelection({ ...sel, overlayIds: plan.body.overlays.map((o) => o.id), imageIds: plan.body.images.map((x) => x.id), zoomBeatIds: plan.body.beats.filter((b) => b.zoom !== 'none').map((b) => b.id) })}>alle annehmen</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelection({ ...sel, overlayIds: [], imageIds: [], zoomBeatIds: [] })} data-testid="story-extras-none">alle ablehnen</Button></div>
              <ul className="m-0 grid gap-1 pl-0">
                {plan.body.overlays.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-2" data-testid="story-overlay">
                    <input type="checkbox" checked={sel.overlayIds.includes(o.id)} onChange={() => toggle('overlayIds', o.id)} aria-label={`${OVERLAY_LABEL[o.kind]} ${o.text} annehmen`} />
                    <Pill>{OVERLAY_LABEL[o.kind]}</Pill><span>{o.text ? `„${o.text}“` : ''} bei Satz {o.sentence}</span>{o.presetId ? <span className="text-muted">Stil „{o.presetId}“</span> : null}
                    <SlopHints text={o.text} where="overlay" testId="story-overlay-slop" />
                  </li>
                ))}
                {plan.body.images.map((im) => (
                  <li key={im.id} className="flex flex-wrap items-center gap-2" data-testid="story-image">
                    <input type="checkbox" checked={sel.imageIds.includes(im.id)} onChange={() => toggle('imageIds', im.id)} aria-label="Bild annehmen" />
                    {/* eslint-disable-next-line @next/next/no-img-element -- her own library image */}
                    <img src={`/api/media/${im.referenceId}`} alt="" className="h-8 w-8 rounded object-cover" />
                    <span>Bild bei Satz {im.sentence}</span><span className="text-muted">{data.images.find((x) => x.id === im.referenceId)?.origin === 'generated' ? 'KI-generiert, wird gekennzeichnet' : 'eigen/lizenziert'}</span>
                  </li>
                ))}
                {plan.body.beats.filter((b) => b.zoom !== 'none').map((b) => (
                  <li key={`z${b.id}`} className="flex items-center gap-2" data-testid="story-zoom">
                    <input type="checkbox" checked={sel.zoomBeatIds.includes(b.id)} onChange={() => toggle('zoomBeatIds', b.id)} aria-label={`Zoom in Beat ${plan.body.beats.indexOf(b) + 1} annehmen`} />
                    <Pill>Zoom</Pill><span>{STORY_ZOOM_LABEL[b.zoom]} in Beat {plan.body.beats.indexOf(b) + 1}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {plan.body.tempo.preset ? <p className="hint m-0">Tempo: {plan.body.tempo.preset === 'brisk' ? 'zügig' : plan.body.tempo.preset === 'calm' ? 'ruhig' : 'normal'} – {plan.body.tempo.note} (Pacing-Knöpfe oben; Füllwörter wie „also“, „ja“, „genau“ bleiben deine Stimme).</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" busy={busy === 'apply'} disabled={!!busy || plan.stale || (withBeats && !chosen.size)} onClick={() => void apply({ ...sel, beats: withBeats ? sel.beats ?? plan.body.beats.map((b) => b.id) : null }, 'apply')} data-testid="story-apply">Übernehmen</Button>
            <span className="text-muted">{withBeats ? `${chosen.size} Beat(s) als Clips` : 'Clips bleiben'}{sel.hookId ? ', Hook' : ''}{sel.overlayIds.length ? `, ${sel.overlayIds.length} Overlay(s)` : ''}{sel.imageIds.length ? `, ${sel.imageIds.length} Bild(er)` : ''}{sel.zoomBeatIds.length ? `, ${sel.zoomBeatIds.length} Zoom(s)` : ''} – als normale Änderung, ⌘Z macht sie rückgängig.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Applies a single ghost (overlay, image or zoom) of the story right away, without touching the clips. */
export function singleSelection(kind: 'overlay' | 'image' | 'zoom', id: string): StorySelection {
  return { beats: null, hookId: null, overlayIds: kind === 'overlay' ? [id] : [], imageIds: kind === 'image' ? [id] : [], zoomBeatIds: kind === 'zoom' ? [id] : [] };
}
