'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PeaksFile } from '@studio/core/derived';
import { EditClip, LOUDNESS, type EditDraftBody, type LoudnessPreset, type ZoomKind } from '@studio/core/edit';
import type { CutSuggestion } from '@studio/core/cuts';
import { SUBTITLE_Y, type Placement, type Slot } from '@studio/core/overlayLayout';
import { lookFit, subtitleAnimationOf, TEXT_LIMIT, type OverlayKind } from '@studio/core/overlays';
import { SUBTITLE_MODE_LABELS, SUBTITLE_MODES, type SubtitleMode } from '@studio/core/textAnim';
import {
  acceptSuggestions, addOverlayAt, addOverlayForRange, applyPacing, keepClearOfLabel, buildTimelineView, cutOutputRange, cutWords, moveClip, outputToSource, PACING_PRESETS, phraseOf, removeClip, removeCut,
  removeOverlay, retimeOverlay, safeSuggestions, setHook, sourceSnapTargets, sourceToOutputNearest, splitAt, suggestionApplied, trimClip, updateOverlay, wordsOutputRange,
  addImageAt, removeImage, retimeImage, updateImage,
  FRAME_SEC, type CutWord, type PacingInput, type PacingPreset,
} from '@studio/core/timelineView';
import { transcriptWords, type TranscriptBody } from '@studio/core/transcript';
import { api, useApi } from '@/lib/api';
import type { EditDraftView, EditorMedia, EditState, TranscriptView } from '@/lib/types';
import { useToast } from '../../toast';
import { Button, ErrorNote, Field, fmtDateTime, Pill } from '../../ui';
import { OverlayInspector } from './OverlayInspector';
import { Stage, type ExactView } from './Stage';
import type { ElementRef } from './StageGraphics';
import { Timeline, type GhostSuggestion } from './Timeline';
import { TranscriptPanel, type TranscriptAction } from './TranscriptPanel';
import { usePlayback } from './usePlayback';
import { useDraft, type SaveStatus } from './useDraft';
import { ChatButton, useChatScope } from '../../chat/ChatProvider';
import { singleSelection, storyTrack, StoryPanel, useStory } from './StoryPanel';
import { IMAGE_USAGE_LABEL } from '@studio/core/imageLayer';
import { FinishExport } from '../FinishExport';

/**
 * Video editor (Etappe 12/13): stage, timeline, transcript and the working draft with autosave. Opens with the footage she
 * just uploaded as a Freier Schnitt. Rendering takes a snapshot of the draft (an EditPlan version) and renders it;
 * client projects only save that version here and keep their approval in the classic view.
 * Etappe 13: hook and overlays are created here (playhead or transcript), placed on the stage, retimed on the timeline and
 * edited in the inspector; filler/pause suggestions are ghost blocks she accepts or rejects; „Standbild prüfen“ and
 * „Exakte Vorschau“ come from FFmpeg with the render's own ASS path.
 */
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const SAVE_LABEL: Record<SaveStatus, string> = { loading: 'lädt …', saved: 'gespeichert', dirty: 'ungespeichert …', saving: 'speichert …', error: 'nicht gespeichert', conflict: 'Konflikt' };
const ZOOM_LABEL: Record<ZoomKind, string> = { none: 'kein Zoom', push_in: 'Push-in (langsam rein)', push_out: 'Push-out (langsam raus)', punch_in: 'Punch-in (näher)' };
const RENDER_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'default' }> = {
  rendering: { label: 'rendert …', tone: 'warn' }, pending_review: { label: 'fertig', tone: 'ok' }, approved: { label: 'freigegeben', tone: 'ok' },
  rejected: { label: 'abgelehnt', tone: 'danger' }, failed: { label: 'fehlgeschlagen', tone: 'danger' }, cancelled: { label: 'abgebrochen', tone: 'default' },
};

export interface OpenRequest { assetId: string; nonce: number }

export function EditorShell({ projectId, projectKind, openRequest, onOpenHandled, onOpenClassic, onChanged }: {
  projectId: string; projectKind: 'PERSONAL_CONTENT' | 'UGC_CLIENT'; openRequest: OpenRequest | null; onOpenHandled: () => void; onOpenClassic: () => void; onChanged: () => void;
}) {
  const state = useApi<EditState>(`/api/projects/${projectId}/edit-plans`);
  const scripts = state.data?.scripts ?? [];
  const personal = projectKind === 'PERSONAL_CONTENT';
  const [choice, setChoice] = useState<string | null | undefined>(undefined);
  // personal: Freier Schnitt by default; client: the approved (or newest) script
  const scriptId = choice !== undefined ? choice : personal ? null : (scripts.find((s) => s.status === 'approved') ?? scripts[0])?.id ?? null;
  const ready = personal || (state.data != null && scriptId != null);

  return (
    <section className="panel mb-4" data-testid="video-editor" aria-label="Video-Editor">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-lg font-bold">Editor</h2>
        <Field label="Grundlage" htmlFor="ed-base">
          <select id="ed-base" className="field w-auto" value={scriptId ?? '__free'} onChange={(e) => setChoice(e.target.value === '__free' ? null : e.target.value)}>
            {personal ? <option value="__free">Freier Schnitt (ohne Skript)</option> : null}
            {scripts.map((s) => <option key={s.id} value={s.id}>Skript v{s.version}{s.status === 'approved' ? ' (freigegeben)' : s.status === 'draft' ? ' (Entwurf)' : ''}</option>)}
          </select>
        </Field>
        {!personal ? <p className="hint m-0 max-w-md">Kundenprojekt: Hier schneiden und als Version speichern. Freigabe und Render laufen weiter über die <button type="button" className="underline" onClick={onOpenClassic}>Klassische Ansicht</button>.</p> : null}
        {ready ? <ChatButton className="ml-auto" /> : null}
      </div>
      {!personal && state.data && !scripts.length ? <p className="hint">Kundenprojekte brauchen ein Skript (Content Lab). Freier Schnitt gibt es nur für eigenen Content.</p> : null}
      {ready ? <DraftEditor fonts={state.data?.fonts ?? []} reloadFonts={state.reload} key={`${projectId}-${scriptId ?? 'free'}`} projectId={projectId} scriptId={scriptId} openRequest={openRequest} onOpenHandled={onOpenHandled} onOpenClassic={onOpenClassic} onChanged={onChanged} /> : null}
    </section>
  );
}

function DraftEditor({ projectId, scriptId, openRequest, onOpenHandled, onOpenClassic, onChanged, fonts, reloadFonts }: { projectId: string; scriptId: string | null; openRequest: OpenRequest | null; onOpenHandled: () => void; onOpenClassic: () => void; onChanged: () => void; fonts: readonly { ref: string; label: string }[]; reloadFonts: () => Promise<void> }) {
  const toast = useToast();
  const d = useDraft(projectId, scriptId);
  const v = d.view;
  const [notice, setNotice] = useState<string | null>(null);
  // Etappe 16: KI-Dramaturgie (personal Freier Schnitt only); „Übernehmen“ comes back as an undo step like the chat
  const story = useStory(projectId, scriptId, v?.projectKind === 'PERSONAL_CONTENT' && scriptId == null, { flush: d.flush, adopt: d.adoptRemote, onNotice: setNotice });
  // Etappe 15: the chat of this editor sees the saved draft (flushed first) and its „Übernehmen“ comes back as an undo step
  useChatScope({
    scope: `editor:${projectId}`, label: 'Video-Editor', scriptId,
    // a failed save (conflict, network) stops the chat: it must never answer or apply on a state she does not see
    beforeSend: async () => { await d.flush(); },
    onApplied: async (r) => {
      if (r.kind === 'edit_draft' || r.kind === 'story') await d.adoptRemote();
      if (r.kind === 'story') await story.reload();
    },
  });
  const body = d.body;
  const media = useMemo(() => v?.media ?? [], [v?.media]);
  const mediaMap = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  const personal = v?.projectKind === 'PERSONAL_CONTENT';
  const [transcripts, setTranscripts] = useState<Map<string, { id: string; body: TranscriptBody; source: string }>>(new Map());
  const [peaks, setPeaks] = useState<Map<string, PeaksFile | null>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [mark, setMark] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [zones, setZones] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [el, setEl] = useState<ElementRef | null>(null);
  const [exact, setExact] = useState<ExactView>(null);
  /** Revision the exact view was made from (it is closed when the draft changes) and whether the editor is still mounted. */
  const exactRev = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [exactBusy, setExactBusy] = useState<string | null>(null);
  const [exactError, setExactError] = useState<string | null>(null);
  const [frameFontWarnings, setFrameFontWarnings] = useState<string[]>([]);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [suggestionCache, setSuggestionCache] = useState<Map<string, CutSuggestion[]>>(new Map());
  const root = useRef<HTMLDivElement>(null);

  // transcript bodies (untrusted, display only) and waveform peaks of the project's media, loaded when they change
  const transcriptKey = media.map((m) => `${m.id}:${m.transcript?.id ?? ''}`).join('|');
  useEffect(() => {
    let live = true;
    for (const m of media) {
      if (!m.transcript || transcripts.get(m.id)?.id === m.transcript.id) continue;
      void api<TranscriptView | null>(`/api/footage/${m.id}/transcript`).then((t) => {
        if (live && t) setTranscripts((old) => new Map(old).set(m.id, { id: t.id, body: t.body, source: t.source }));
      }).catch(() => undefined);
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the transcript versions
  }, [transcriptKey]);
  const peaksKey = media.map((m) => `${m.id}:${m.derived?.preparedAt ?? ''}`).join('|');
  useEffect(() => {
    let live = true;
    for (const m of media) {
      if (!m.derived || peaks.has(m.id)) continue;
      if (!m.derived.peaks) { void Promise.resolve().then(() => live && setPeaks((old) => new Map(old).set(m.id, null))); continue; }
      void api<PeaksFile & { hasAudio: boolean }>(`/api/footage/${m.id}/peaks`).then((p) => {
        if (live) setPeaks((old) => new Map(old).set(m.id, p.hasAudio ? p : null));
      }).catch(() => undefined);
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the preparation state
  }, [peaksKey]);

  // poll while something runs in the background (preparation, transcription, pause scan, render)
  const running = media.some((m) => m.prepare.status === 'queued' || m.prepare.status === 'running' || m.transcribing || m.scanning) || (v?.renders ?? []).some((r) => r.status === 'rendering');
  const { refresh } = d;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh(), 1500);
    return () => clearInterval(id);
  }, [running, refresh]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onChanged();
    wasRunning.current = running;
  }, [running, onChanged]);

  // footage not prepared yet (e.g. uploaded before Etappe 12): start it once when the editor opens
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const m of media) {
      if (m.prepare.status !== 'none' && m.prepare.status !== 'outdated') continue;
      if (asked.current.has(m.id)) continue;
      asked.current.add(m.id);
      void api(`/api/footage/${m.id}/prepare`, { method: 'POST' }).then(() => refresh()).catch(() => undefined);
    }
  }, [media, refresh]);

  const silences = useMemo(() => new Map(media.flatMap((m) => (m.silences ? [[m.id, m.silences] as const] : []))), [media]);
  const look = v?.look ?? null;
  // Etappe 16b: word-by-word subtitles (her choice in the cut, else the subtitle role's default; null = lines)
  const subtitleAnim = useMemo(() => (body ? subtitleAnimationOf(body, look) : null), [body, look]);
  const view = useMemo(() => buildTimelineView(body ?? { clips: [] }, {
    transcripts: new Map([...transcripts].map(([k, x]) => [k, { body: x.body, fillerPrompt: media.find((m) => m.id === k)?.transcript?.fillerPrompt ?? false }])),
    silences, fit: lookFit(look), subtitleWords: subtitleAnim?.wordsPerLine ?? null,
  }), [body, transcripts, silences, look, media, subtitleAnim]);
  const assetIds = useMemo(() => (body?.clips ?? []).map((c) => c.assetId), [body]);
  const pb = usePlayback(view.timeline);

  // the footage she just uploaded (or picked in the library) goes into the cut once
  const handled = useRef<number | null>(null);
  const refreshTries = useRef(new Map<number, number>());
  const { apply } = d;
  useEffect(() => {
    if (!openRequest || handled.current === openRequest.nonce || !body || d.status === 'loading') return;
    const m = mediaMap.get(openRequest.assetId);
    if (!m) {
      // the editor's media list may not have the new footage yet: refresh (a few times at most)
      const tries = (refreshTries.current.get(openRequest.nonce) ?? 0) + 1;
      refreshTries.current.set(openRequest.nonce, tries);
      if (tries <= 3) void refresh();
      return;
    }
    handled.current = openRequest.nonce;
    onOpenHandled(); // one request goes into one draft only (switching the base later does not add it again)
    if (!m.durationSec || !m.hasVideo) return;
    const clip = EditClip.parse({ assetId: m.id, inSec: 0, outSec: Math.round(m.durationSec * 1000) / 1000 });
    const was = body.clips.length;
    apply((b) => ({ ...b, clips: [...b.clips, clip] }));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one notice per request
    setNotice(was ? `„${m.name}“ wurde hinten angehängt (Strg/⌘+Z macht es rückgängig).` : null);
  }, [openRequest, body, mediaMap, apply, d.status, onOpenHandled, refresh]);

  const snapTargets = useCallback((assetId: string) => {
    const tr = transcripts.get(assetId);
    return sourceSnapTargets({ words: tr ? transcriptWords(tr.body) : [], silences: silences.get(assetId) ?? [], durationSec: mediaMap.get(assetId)?.durationSec ?? null });
  }, [transcripts, silences, mediaMap]);

  // Etappe 13: filler and pause suggestions per clip (side-effect free GET; refetched when the clip, transcript or scan changes)
  const clipKeyOf = useCallback((c: { assetId: string; inSec: number; outSec: number }) => {
    const m = mediaMap.get(c.assetId);
    return `${c.assetId}:${c.inSec}:${c.outSec}:${m?.transcript?.id ?? ''}:${m?.silences?.length ?? -1}`;
  }, [mediaMap]);
  const clipKeys = (body?.clips ?? []).map(clipKeyOf).join('|');
  useEffect(() => {
    let live = true;
    // review fix: debounced, so a trim drag (a new In/Out on every move) does not send one request per pointer move
    const timer = setTimeout(() => {
      for (const c of body?.clips ?? []) {
        const key = clipKeyOf(c);
        const m = mediaMap.get(c.assetId);
        if (suggestionCache.has(key) || !m?.transcript || !m.silences) continue;
        const q = new URLSearchParams({ assetId: c.assetId, inSec: String(c.inSec), outSec: String(c.outSec), scriptId: scriptId ?? '' });
        void api<{ status: string; suggestions: CutSuggestion[] }>(`/api/projects/${projectId}/cut-suggestions?${q}`).then((r) => {
          if (live) setSuggestionCache((old) => new Map([...old].slice(-100)).set(key, r.status === 'ready' ? r.suggestions : []));
        }).catch(() => undefined);
      }
    }, 400);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the clips and their transcript/scan versions
  }, [clipKeys]);
  /** Pending suggestions per clip: not yet applied (no cut over them), not rejected, not blocked by a client claim. */
  const pending = useMemo(() => (body?.clips ?? []).map((c, i) => (suggestionCache.get(clipKeyOf(c)) ?? [])
    .filter((x) => !x.blocked && !rejected.has(`${i}:${x.id}`) && !suggestionApplied(c.cuts, x))), [body, suggestionCache, clipKeyOf, rejected]);
  const ghosts = useMemo<GhostSuggestion[]>(() => pending.flatMap((list, i) => list.flatMap((x) => {
    const a = sourceToOutputNearest(view.timeline, i, x.startSec), b = sourceToOutputNearest(view.timeline, i, x.endSec);
    return a != null && b != null && b - a > 0.02 ? [{ id: `${i}:${x.id}`, clip: i, outStart: a, outEnd: b, kind: x.kind, word: x.word, safe: x.safe, note: x.note }] : [];
  })), [pending, view.timeline]);

  const seek = useCallback((t: number) => pb.seek(t, assetIds), [pb, assetIds]);
  const togglePlay = useCallback(() => (pb.playing ? pb.pause() : pb.play(assetIds)), [pb, assetIds]);
  const clipUnderPlayhead = () => outputToSource(view.timeline, pb.t)?.clip ?? null;

  const split = useCallback(() => {
    const r = body ? splitAt(body, pb.t) : null;
    if (!r) { setNotice('Hier lässt sich nicht teilen (zu nah am Anfang oder Ende eines Clips).'); return; }
    apply(() => r.body);
    setSelected(r.index);
  }, [body, pb.t, apply]);
  const cutMarked = useCallback(() => {
    if (mark.in == null || mark.out == null) return false;
    apply((b) => {
      const r = cutOutputRange(b, mark.in!, mark.out!);
      setNotice(`${r.removedClips ? `${r.removedClips} Clip(s) ganz entfernt.` : `Bereich ${fmt(Math.min(mark.in!, mark.out!))}–${fmt(Math.max(mark.in!, mark.out!))} herausgeschnitten.`}${r.capped ? ` ${r.capped} kurze Vorschlags-Schnitte entfernt (höchstens 40 Schnitte je Clip).` : ''}`);
      return r.body;
    });
    seek(Math.min(mark.in, mark.out));
    setMark({ in: null, out: null });
    return true;
  }, [mark, apply, seek]);
  const trimToPlayhead = useCallback((edge: 'in' | 'out') => {
    const p = outputToSource(view.timeline, pb.t);
    if (!p || !body) return;
    const dur = mediaMap.get(body.clips[p.clip]!.assetId)?.durationSec ?? null;
    apply((b) => trimClip(b, p.clip, edge, p.srcSec, dur).body);
    setSelected(p.clip);
  }, [view.timeline, pb.t, body, mediaMap, apply]);

  // ---------- Etappe 13: hook, overlays, transcript selection, suggestions, exact preview ----------
  const hookSlot: Slot = look?.hookSlot ?? 'upper';
  const overlaySlot: Slot = look?.overlaySlot ?? 'center';
  const wordAt = useCallback((t: number) => {
    const p = outputToSource(view.timeline, t);
    const c = p ? body?.clips[p.clip] : null;
    const tr = c ? transcripts.get(c.assetId) : null;
    if (!p || !tr) return '';
    const w = transcriptWords(tr.body).find((x) => x.startSec <= p.srcSec + 0.05 && x.endSec >= p.srcSec - 0.05);
    return w ? phraseOf([w.text]) : '';
  }, [view.timeline, body, transcripts]);
  const addAtPlayhead = useCallback((kind: OverlayKind | 'hook') => {
    if (!body) return;
    if (kind === 'hook') {
      if (body.hook) { setEl({ type: 'hook' }); seek(0); return; }
      const scripted = v?.script;
      apply((b) => setHook(b, scripted
        ? { source: 'selected', variantIndex: null, text: scripted.selectedHook, slot: hookSlot }
        : { source: 'free', variantIndex: null, text: wordAt(pb.t) || 'Dein Hook', slot: hookSlot }));
      setEl({ type: 'hook' });
      seek(0);
      return;
    }
    const word = kind === 'keyword' || kind === 'lower_third' ? wordAt(pb.t) : '';
    const text = kind === 'keyword' ? (word || 'Keyword').slice(0, TEXT_LIMIT.keyword) : kind === 'lower_third' ? 'Dein Name · Thema' : '';
    const r = addOverlayAt(body, pb.t, { kind, text, slot: overlaySlot });
    if ('error' in r) { setNotice(r.error); return; }
    apply(() => r.body);
    setEl({ type: 'overlay', clip: r.clip, index: r.index });
  }, [body, v?.script, apply, hookSlot, overlaySlot, wordAt, pb.t, seek]);
  const removeEl = useCallback((ref: ElementRef) => {
    apply((b) => (ref.type === 'hook' ? setHook(b, null) : ref.type === 'image' ? removeImage(b, ref.clip, ref.index) : removeOverlay(b, ref.clip, ref.index)));
    setEl(null);
  }, [apply]);
  const placePatch = (pl: Placement) => (pl.slot ? { slot: pl.slot, pos: undefined } : { pos: pl.pos });
  const onPlace = useCallback((ref: ElementRef, pl: Placement | null, phase: 'preview' | 'commit' | 'cancel') => {
    if (phase === 'cancel') { d.cancelPreview(); return; }
    if (phase === 'commit') { d.commit(); return; }
    if (!pl) return;
    d.preview((b) => (ref.type === 'hook' ? setHook(b, placePatch(pl)) : ref.type === 'image' ? (pl.pos ? updateImage(b, ref.clip, ref.index, { pos: pl.pos }) : b) : updateOverlay(b, ref.clip, ref.index, placePatch(pl))));
  }, [d]);
  const onElementDrag = useCallback((ref: ElementRef, a: number, b: number, edge: 'move' | 'start' | 'end', phase: 'preview' | 'commit' | 'cancel') => {
    if (phase === 'cancel') { d.cancelPreview(); return; }
    if (phase === 'commit') { d.commit(); return; }
    d.preview((x) => (ref.type === 'hook' ? setHook(x, { endSec: b }) : ref.type === 'image' ? retimeImage(x, ref.clip, ref.index, a, b, edge) : retimeOverlay(x, ref.clip, ref.index, a, b, edge)));
  }, [d]);
  const onTranscript = useCallback((action: TranscriptAction, words: CutWord[]) => {
    if (!body) return;
    const range = wordsOutputRange(view.timeline, words);
    if (!range) return;
    if (action === 'cut') {
      apply((b) => {
        const r = cutWords(b, words);
        setNotice(r.cuts || r.removedClips ? `„${phraseOf(words.map((w) => w.text)).slice(0, 40)}“ herausgeschnitten (Strg/⌘+Z macht es rückgängig).` : 'Hier gab es nichts zu schneiden.');
        return r.body;
      });
      seek(range.a);
      return;
    }
    const text = phraseOf(words.map((w) => w.text));
    if (action === 'hook') {
      if (text.length > TEXT_LIMIT.free_hook) { setNotice(`Ein Hook hat höchstens ${TEXT_LIMIT.free_hook} Zeichen – kürzer markieren.`); return; }
      apply((b) => setHook(b, { source: 'free', variantIndex: null, text, slot: b.hook?.slot ?? hookSlot }));
      setEl({ type: 'hook' });
      seek(0);
      return;
    }
    const r = addOverlayForRange(body, range.a, range.b, { kind: action, text, slot: overlaySlot });
    if ('error' in r) { setNotice(r.error); return; }
    apply(() => r.body);
    setEl({ type: 'overlay', clip: r.clip, index: r.index });
    seek(range.a);
  }, [body, view.timeline, apply, seek, hookSlot, overlaySlot]);
  const decide = useCallback((ids: string[], decision: 'accept' | 'reject') => {
    if (!ids.length) return;
    if (decision === 'reject') { setRejected((old) => new Set([...old, ...ids])); return; }
    const byClip = new Map<number, CutSuggestion[]>();
    for (const id of ids) {
      const [ci, ...rest] = id.split(':');
      const i = Number(ci), sid = rest.join(':');
      const x = pending[i]?.find((y) => y.id === sid);
      if (x) byClip.set(i, [...(byClip.get(i) ?? []), x]);
    }
    let refused = 0, added = 0;
    apply((b) => {
      let out = b;
      for (const [i, list] of byClip) {
        const r = acceptSuggestions(out, i, list, silences.get(out.clips[i]?.assetId ?? '') ?? []);
        out = r.body;
        refused += r.refused;
        added += r.added;
      }
      return out;
    });
    setNotice(`${added} Vorschlag${added === 1 ? '' : 'e'} als Schnitt übernommen${refused ? `, ${refused} nicht (zu nah an einem anderen Schnitt – dort von Hand schneiden)` : ''}. Strg/⌘+Z macht es rückgängig.`);
  }, [pending, apply, silences]);
  // review fix: a selection whose element is gone (undo, clip removed or moved) is dropped
  const elGone = !!el && !!body && (el.type === 'hook' ? !body.hook : el.type === 'image' ? !body.clips[el.clip]?.images?.[el.index] : !body.clips[el.clip]?.overlays[el.index]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears a stale reference
    if (elGone) setEl(null);
  }, [elGone]);
  const safeIds = useMemo(() => pending.flatMap((list, i) => safeSuggestions(list).map((x) => `${i}:${x.id}`)), [pending]);

  // ---------- Etappe 16: dramaturgy track and library images ----------
  const storyImages = story.data?.images ?? [];
  const [picker, setPicker] = useState(false);
  const aspects = useRef(new Map<string, number>());
  const addImage = useCallback((referenceId: string) => {
    if (!body) return;
    const r = addImageAt(body, pb.t, { referenceId, aspect: aspects.current.get(referenceId) ?? 1, durationSec: 3 });
    if ('error' in r) { setNotice(r.error); return; }
    apply(() => r.body);
    setEl({ type: 'image', clip: r.clip, index: r.index });
    setPicker(false);
  }, [body, pb.t, apply]);
  const track = useMemo(() => storyTrack(story.plan, story.selection, body), [story.plan, story.selection, body]);
  const { setSelection: setStorySelection, selection: storySel, apply: applyStory } = story;
  const onStoryGhost = useCallback((kind: 'overlay' | 'image' | 'zoom', id: string, decision: 'accept' | 'reject') => {
    if (decision === 'accept') { void applyStory(singleSelection(kind, id), `ghost-${id}`); return; }
    if (!storySel) return;
    const key = kind === 'overlay' ? 'overlayIds' : kind === 'image' ? 'imageIds' : 'zoomBeatIds';
    setStorySelection({ ...storySel, [key]: storySel[key].filter((x) => x !== id) });
  }, [applyStory, storySel, setStorySelection]);

  async function exactPreview() {
    setExactBusy('preview');
    setExactError(null);
    try {
      pb.pause();
      const revision = await d.flush();
      const r = await api<{ status: 'ready' | 'queued'; key: string; job: { id: string } | null }>(`/api/projects/${projectId}/edit-draft/preview`, { method: 'POST', json: { scriptId } });
      if (r.status === 'queued' && r.job) {
        for (const deadline = Date.now() + 15 * 60_000; ;) {
          if (!mounted.current) return; // editor closed: stop polling (the job finishes and stays cached)
          if (Date.now() > deadline) throw new Error('Die Vorschau dauert ungewöhnlich lange – unter „Video-Jobs“ nachsehen.');
          await new Promise((res) => setTimeout(res, 800));
          const j = await api<{ status: string; error: string | null }>(`/api/video-jobs/${r.job.id}`);
          if (j.status === 'succeeded') break;
          if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error ?? 'Vorschau fehlgeschlagen');
        }
      }
      if (!mounted.current) return;
      exactRev.current = revision;
      setExact({ kind: 'video', url: `/api/projects/${projectId}/edit-draft/preview?key=${r.key}` });
    } catch (e) {
      setExactError((e as Error).message);
    } finally {
      setExactBusy(null);
    }
  }
  async function stillCheck() {
    setExactBusy('still');
    setExactError(null);
    try {
      pb.pause();
      const revision = await d.flush();
      const q = new URLSearchParams({ t: pb.t.toFixed(3), scriptId: scriptId ?? '', r: String(revision) });
      const res = await fetch(`/api/projects/${projectId}/edit-draft/frame?${q}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Standbild fehlgeschlagen (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      // Etappe 16b: libass's font check of this frame (a chosen face it did not take)
      try { setFrameFontWarnings(JSON.parse(decodeURIComponent(res.headers.get('x-font-warnings') ?? '%5B%5D')) as string[]); } catch { setFrameFontWarnings([]); }
      exactRev.current = revision;
      setExact((old) => { if (old?.kind === 'image') URL.revokeObjectURL(old.url); return { kind: 'image', url, t: Number(res.headers.get('x-frame-time') ?? pb.t) }; });
    } catch (e) {
      setExactError((e as Error).message);
    } finally {
      setExactBusy(null);
    }
  }
  /** Frame check of the first and last frame WITH hook, overlays, subtitles and label (Etappe 13, Skills-Review): FFmpeg frames. */
  const [edgeFrames, setEdgeFrames] = useState<{ start: string; end: string; revision: number } | null>(null);
  async function edgeCheck() {
    setExactBusy('edges');
    setExactError(null);
    try {
      const revision = await d.flush();
      const get = async (t: number) => {
        const res = await fetch(`/api/projects/${projectId}/edit-draft/frame?${new URLSearchParams({ t: String(t), scriptId: scriptId ?? '', r: String(revision) })}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Standbild fehlgeschlagen (${res.status})`);
        return URL.createObjectURL(await res.blob());
      };
      const [start, end] = [await get(0), await get(view.durationSec)];
      setEdgeFrames((old) => { if (old) { URL.revokeObjectURL(old.start); URL.revokeObjectURL(old.end); } return { start, end, revision }; });
    } catch (e) {
      setExactError((e as Error).message);
    } finally {
      setExactBusy(null);
    }
  }
  // a change of the draft makes the checked frames outdated: back to the proxy thumbnails
  useEffect(() => {
    if (edgeFrames && v?.draft && v.draft.revision !== edgeFrames.revision && d.status === 'saved') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- invalidates frames of an older revision
      setEdgeFrames((old) => { if (old) { URL.revokeObjectURL(old.start); URL.revokeObjectURL(old.end); } return null; });
    }
  }, [edgeFrames, v?.draft, d.status]);
  // review fix: a changed draft closes the FFmpeg view (it would show an outdated, seemingly verified picture)
  useEffect(() => {
    if (exact && v?.draft && exactRev.current != null && v.draft.revision !== exactRev.current && d.status === 'saved') {
      setExact((old) => { if (old?.kind === 'image') URL.revokeObjectURL(old.url); return null; });
    }
  }, [exact, v?.draft, d.status]);
  const closeExact = useCallback(() => setExact((old) => { if (old?.kind === 'image') URL.revokeObjectURL(old.url); return null; }), []);

  // keyboard: only when the editor has the focus (or nothing has), never while typing in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      const inside = !!root.current && (root.current.contains(document.activeElement) || document.activeElement === document.body);
      if (!inside) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) d.redo(); else d.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); d.redo(); return; }
      if (mod || e.altKey) return;
      if (e.key === ' ' && tag !== 'BUTTON') { e.preventDefault(); togglePlay(); }
      else if (k === 'k') pb.pause();
      else if (k === 'l') pb.play(assetIds, pb.playing && pb.rate > 0 ? Math.min(2, pb.rate + 0.5) : 1);
      else if (k === 'j') pb.playReverse(assetIds, pb.playing && pb.rate < 0 ? Math.min(4, -pb.rate * 2) : 1);
      else if (k === 'i') setMark((m) => ({ ...m, in: pb.t }));
      else if (k === 'o') setMark((m) => ({ ...m, out: pb.t }));
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); pb.pause(); seek(pb.t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : FRAME_SEC)); }
      else if (k === 's') split();
      else if (k === 't') addAtPlayhead('keyword');
      else if (k === 'q') trimToPlayhead('in');
      else if (k === 'w') trimToPlayhead('out');
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (cutMarked()) return;
        if (el && !elGone) removeEl(el);
        else if (selected != null) { apply((b) => removeClip(b, selected)); setSelected(null); }
      } else if (e.key === 'Escape') { setMark({ in: null, out: null }); setSelected(null); setEl(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [d, pb, assetIds, togglePlay, seek, split, trimToPlayhead, cutMarked, selected, apply, el, elGone, removeEl, addAtPlayhead]);

  function pacing(preset: PacingPreset) {
    if (!body) return;
    const inputs = new Map<string, PacingInput>(media.map((m) => [m.id, { transcript: transcripts.get(m.id)?.body ?? null, silences: m.silences, protectedRanges: v?.protectedRanges[m.id] }]));
    const r = applyPacing(body, preset, inputs);
    if (!r.added && !r.removed) { setNotice(r.skipped ? 'Für Pacing fehlen Transkript und Pausen-Messung (läuft noch oder nicht verfügbar).' : 'Nichts zu kürzen.'); return; }
    apply(() => r.body);
    setNotice(`Pacing „${PACING_PRESETS[preset].label}“: ${r.added} Schnitte${r.removed ? ` (${r.removed} vorherige Vorschlags-Schnitte ersetzt)` : ''}${r.skipped ? `, ${r.skipped} Clip(s) ohne Transkript/Pausen übersprungen` : ''}${r.capped ? `, ${r.capped} kurze Pausen ausgelassen (höchstens 40 Schnitte je Clip)` : ''}. Strg/⌘+Z macht es rückgängig.`);
  }

  async function render(mode: 'render' | 'save') {
    setBusy(mode);
    setError(null);
    try {
      pb.pause();
      const revision = await d.flush();
      const out = await api<{ plan: { version: number } }>(`/api/projects/${projectId}/edit-draft/render`, { method: 'POST', json: { scriptId, revision, mode } });
      toast(mode === 'render' ? `Version v${out.plan.version} gespeichert, Render läuft.` : `Version v${out.plan.version} gespeichert – Freigabe in der Klassischen Ansicht.`);
      await d.refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!v || !body) return <div className="hint" data-testid="editor-loading">{d.status === 'error' ? <ErrorNote error={d.error} /> : 'Editor lädt …'}</div>;
  const sel = selected != null ? body.clips[selected] : null;
  const selMedia = sel ? mediaMap.get(sel.assetId) : null;
  const first = view.timeline.segments[0], last = view.timeline.segments[view.timeline.segments.length - 1];
  const errors = v.issues?.errors ?? [], warnings = v.issues?.warnings ?? [];
  const burn = body.subtitles === 'burn';
  const update = (fn: (b: EditDraftBody) => EditDraftBody) => apply(fn);
  const renderBlocked = !body.clips.length || errors.length > 0 || d.status === 'conflict' || d.status === 'error';

  return (
    <div ref={root} className="grid min-w-0 grid-cols-1 gap-3" data-testid="editor">
      {d.status === 'conflict' ? (
        <div className="rounded-lg border border-[#f0b4ad] bg-[#fdecea] p-3 text-xs text-danger" role="alert" data-testid="draft-conflict">
          Der Entwurf wurde in einem anderen Fenster geändert. <Button size="sm" onClick={() => void d.resolveConflict(false)}>Andere Fassung laden</Button> <Button size="sm" onClick={() => void d.resolveConflict(true)}>Meine Fassung behalten</Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs" role="toolbar" aria-label="Schnitt-Werkzeuge">
        <Button size="sm" onClick={() => seek(0)} aria-label="Zum Anfang">⏮</Button>
        <Button size="sm" onClick={() => { pb.pause(); seek(pb.t - FRAME_SEC); }} aria-label="Ein Bild zurück">◀︎</Button>
        <Button size="sm" variant="primary" onClick={togglePlay} data-testid="play" aria-label={pb.playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'}>{pb.playing ? '❚❚ Pause' : '▶ Abspielen'}</Button>
        <Button size="sm" onClick={() => { pb.pause(); seek(pb.t + FRAME_SEC); }} aria-label="Ein Bild vor">▶︎</Button>
        <Button size="sm" onClick={() => seek(view.durationSec)} aria-label="Zum Ende">⏭</Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <Button size="sm" onClick={split} title="Clip am Playhead teilen (S)">Teilen (S)</Button>
        <Button size="sm" onClick={() => setMark((m) => ({ ...m, in: pb.t }))} title="Bereichsanfang (I)">In (I)</Button>
        <Button size="sm" onClick={() => setMark((m) => ({ ...m, out: pb.t }))} title="Bereichsende (O)">Out (O)</Button>
        <Button size="sm" disabled={mark.in == null || mark.out == null} onClick={() => cutMarked()} title="Markierten Bereich herausschneiden (Entf)">Bereich schneiden</Button>
        <span className="mx-1 h-5 w-px bg-line" />
        <span role="group" aria-label="Text und Grafik am Playhead" className="flex flex-wrap items-center gap-1">
          <Button size="sm" onClick={() => addAtPlayhead('keyword')} disabled={!body.clips.length} data-testid="add-keyword" title="Keyword am Playhead (T)">+ Keyword (T)</Button>
          <Button size="sm" onClick={() => addAtPlayhead('lower_third')} disabled={!body.clips.length} data-testid="add-lower-third">+ Bauchbinde</Button>
          <Button size="sm" onClick={() => addAtPlayhead('arrow')} disabled={!body.clips.length} data-testid="add-arrow">+ Pfeil</Button>
          <Button size="sm" onClick={() => addAtPlayhead('hook')} disabled={!body.clips.length} data-testid="add-hook">{body.hook ? 'Hook bearbeiten' : '+ Hook'}</Button>
          {personal ? (
            <span className="relative">
              <Button size="sm" onClick={() => setPicker((x) => !x)} disabled={!body.clips.length} aria-expanded={picker} data-testid="add-image" title="Eigenes oder lizenziertes Bild aus der Bibliothek am Playhead einblenden">+ Bild</Button>
              {picker ? (
                <div className="absolute top-8 left-0 z-40 w-72 rounded-lg border border-line bg-card p-2 shadow-lg" role="dialog" aria-label="Bild aus der Bibliothek" data-testid="image-picker">
                  {storyImages.length ? (
                    <div className="grid grid-cols-3 gap-1">
                      {storyImages.map((im) => (
                        <button key={im.id} type="button" className="grid gap-0.5 rounded border border-line p-0.5 text-left text-[10px]" onClick={() => addImage(im.id)} data-testid="image-pick" title={`${im.name} · ${IMAGE_USAGE_LABEL[im.origin]}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element -- her own library image */}
                          <img src={`/api/media/${im.id}`} alt={im.name} className="aspect-square w-full rounded object-cover" onLoad={(e) => { const t = e.currentTarget; if (t.naturalWidth && t.naturalHeight) aspects.current.set(im.id, t.naturalWidth / t.naturalHeight); }} />
                          <span className="truncate">{im.origin === 'generated' ? 'KI · gekennzeichnet' : im.origin === 'licensed' ? 'lizenziert' : 'eigen'}</span>
                        </button>
                      ))}
                    </div>
                  ) : <p className="hint m-0">Noch kein Bild freigegeben. In der Bibliothek (Style Lab) beim Bild „Im Video einblenden?“ auf „eigenes Foto“ oder „lizenziert“ stellen – fremde Referenzen bleiben Inspiration.</p>}
                </div>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="mx-1 h-5 w-px bg-line" />
        <Button size="sm" disabled={!d.canUndo} onClick={d.undo} title="Rückgängig (⌘/Strg+Z)">↶ Rückgängig</Button>
        <Button size="sm" disabled={!d.canRedo} onClick={d.redo} title="Wiederholen (⇧⌘/Strg+Shift+Z)">↷ Wiederholen</Button>
        <span className="ml-auto flex items-center gap-2">
          <span className={`text-[11px] ${d.status === 'error' || d.status === 'conflict' ? 'text-danger' : 'text-muted'}`} role="status" data-testid="save-status">Entwurf: {SAVE_LABEL[d.status]}</span>
        </span>
      </div>
      {notice ? <p className="hint m-0 text-warn" role="status" data-testid="editor-notice">{notice} <button type="button" className="underline" onClick={() => setNotice(null)}>ok</button></p> : null}
      {d.status === 'error' ? <ErrorNote error={d.error} /> : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)_300px]">
        <div className="grid w-[300px] content-start gap-2">
          <Stage view={view} t={pb.t} look={look} media={media} assetIds={assetIds} activeAsset={pb.activeAsset ?? assetIds[0] ?? null} register={pb.register} showZones={zones} subtitlesOn={burn} subtitleY={body.subtitleY} subtitleAnim={subtitleAnim} playing={pb.playing} height={533}
            selected={el} onSelect={setEl} onPlace={onPlace} onRemove={removeEl} exact={exact} onCloseExact={closeExact}
            onSize={(ref, size) => apply((b) => keepClearOfLabel(ref.type === 'hook' ? setHook(b, { size }) : ref.type === 'image' ? updateImage(b, ref.clip, ref.index, { size: size ?? 'M' }) : updateOverlay(b, ref.clip, ref.index, { size }), lookFit(look)))} />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Exakte Prüfung über FFmpeg">
            <Button size="sm" busy={exactBusy === 'still'} disabled={!body.clips.length || !!exactBusy} onClick={() => void stillCheck()} data-testid="still-check" title="Ein Bild am Playhead über denselben FFmpeg+ASS-Weg wie der Render">Standbild prüfen</Button>
            <Button size="sm" busy={exactBusy === 'preview'} disabled={!body.clips.length || !!exactBusy} onClick={() => void exactPreview()} data-testid="exact-preview" title="Ganzer Schnitt in 540×960 über denselben FFmpeg+ASS-Weg wie der Render">Exakte Vorschau</Button>
          </div>
          <ErrorNote error={exactError} />
          {frameFontWarnings.length ? <ul className="m-0 list-disc pl-5 text-xs text-warn" data-testid="frame-font-warnings">{frameFontWarnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
          <label className="flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={zones} onChange={(e) => setZones(e.target.checked)} /> Schutzzonen (Instagram-Oberfläche, ungefähr; KI-Label oben)</label>
          {first && last ? (
            <div className="grid w-[200px] grid-cols-2 gap-2" data-testid="frame-check" aria-label="Frame-Check: erstes und letztes Bild">
              {[{ label: 'Startbild', clip: first.clip, src: first.srcIn }, { label: 'Endbild', clip: last.clip, src: Math.max(last.srcIn, last.srcOut - FRAME_SEC) }].map((f) => {
                const id = body.clips[f.clip]?.assetId;
                const m = id ? mediaMap.get(id) : null;
                return (
                  <figure key={f.label} className="m-0">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a private PNG blob from the studio's own API */}
                    {edgeFrames ? <img src={f.label === 'Startbild' ? edgeFrames.start : edgeFrames.end} alt={`${f.label} mit Text und Label (FFmpeg)`} className="aspect-[9/16] w-full rounded bg-black object-cover" data-testid="edge-frame" />
                      : m?.derived ? <video key={`${id}-${f.src.toFixed(3)}`} className="aspect-[9/16] w-full rounded bg-black object-cover" src={`/api/media/${id}?variant=proxy#t=${f.src.toFixed(3)}`} preload="metadata" muted playsInline aria-label={`${f.label} bei ${fmt(f.src)} der Aufnahme`} />
                      : <div className="grid aspect-[9/16] w-full place-items-center rounded bg-[#2d3626] text-[10px] text-white/60">…</div>}
                    <figcaption className="text-[10px] text-muted">{f.label} · {fmt(f.src)}{edgeFrames ? ' · FFmpeg' : ''}</figcaption>
                  </figure>
                );
              })}
              <Button size="sm" className="col-span-2" busy={exactBusy === 'edges'} disabled={!!exactBusy} onClick={() => void edgeCheck()} data-testid="edge-check" title="Erstes und letztes Bild mit Hook, Overlays, Untertiteln und KI-Label über FFmpeg">Start/Ende mit Text prüfen</Button>
            </div>
          ) : null}
        </div>

        <div className="grid min-w-0 content-start gap-3">
          {personal && !scriptId ? <StoryPanel projectId={projectId} scriptId={scriptId} story={story} onSeek={seek} body={body} revision={v.draft?.revision ?? 0} /> : null}
          <div className="rounded-lg border border-line p-3" data-testid="pacing">
            <h3 className="m-0 mb-1 text-sm font-bold">Pacing</h3>
            <p className="hint m-0 mb-2">Ein Klick kürzt Pausen (und sichere Füllwörter) über die gemessenen Pausen und das Transkript. Ergebnis sind normale Schnitte – einzeln entfernbar, rückgängig mit ⌘/Strg+Z. Manuelle Schnitte bleiben.</p>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(PACING_PRESETS) as PacingPreset[]).map((k) => <Button key={k} size="sm" title={PACING_PRESETS[k].hint} onClick={() => pacing(k)}>{PACING_PRESETS[k].label}</Button>)}
            </div>
          </div>

          {el?.type === 'image' && body.clips[el.clip]?.images?.[el.index] ? (() => {
            const im = body.clips[el.clip]!.images![el.index]!;
            const vi = view.images.find((x) => x.clip === el.clip && x.index === el.index);
            const lib = storyImages.find((x) => x.id === im.referenceId);
            return (
              <div className="rounded-lg border border-line p-3 text-xs" data-testid="image-inspector">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>Bild</strong><span className="text-muted">{lib ? `${lib.name} · ${IMAGE_USAGE_LABEL[lib.origin]}` : 'nicht (mehr) als nutzbar markiert'}</span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => removeEl(el)}>Entfernen</Button>
                </div>
                <div className="mt-1 flex flex-wrap items-end gap-3">
                  <span className="text-muted">{vi ? `${fmt(vi.startSec)}–${fmt(vi.endSec)} im Schnitt (Block in der Zeitleiste ziehen)` : 'liegt in einem Schnitt'}</span>
                  <Field label="Größe" htmlFor="img-size">
                    <select id="img-size" className="field w-auto" value={im.size} onChange={(e) => apply((b) => updateImage(b, el.clip, el.index, { size: e.target.value as 'S' | 'M' | 'L' }))}>
                      <option value="S">S</option><option value="M">M</option><option value="L">L</option>
                    </select>
                  </Field>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={im.fade} onChange={(e) => apply((b) => updateImage(b, el.clip, el.index, { fade: e.target.checked }))} /> Ein-/Ausblenden (150 ms)</label>
                  {im.pos ? <button type="button" className="underline" onClick={() => apply((b) => updateImage(b, el.clip, el.index, { pos: undefined }))}>zur Mitte</button> : null}
                </div>
                <p className="hint m-0 mt-1">Liegt unter Text, Hook, Untertiteln und dem KI-Label (wie im Render). Auf der Bühne ziehen platziert es; über dem KI-Label geht nicht.</p>
              </div>
            );
          })() : el && el.type !== 'image' ? (
            <OverlayInspector key={el.type === 'hook' ? 'hook' : `${el.clip}-${el.index}`} body={body} view={view} sel={el} presets={look?.presets ?? []} defaultPresetName={look?.design?.presetName ?? null} fonts={fonts} onFontsAdded={reloadFonts}
              personal={personal} script={v.script ? { selectedHook: v.script.selectedHook, hookVariants: v.script.hookVariants } : null} issues={{ errors, warnings }}
              onApply={(fn) => apply((b) => keepClearOfLabel(fn(b), lookFit(look)))} onPreview={(fn) => d.preview((b) => keepClearOfLabel(fn(b), lookFit(look)))} onCommit={d.commit} onSelect={setEl} onSeek={seek} />
          ) : null}

          {ghosts.length ? (
            <div className="rounded-lg border border-line p-3 text-xs" data-testid="suggestions">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-sm font-bold">Vorschläge: Füllwörter und Pausen</h3>
                <span className="text-muted">{ghosts.length} offen · in der Zeitleiste als gestrichelte Blöcke</span>
                <Button size="sm" className="ml-auto" disabled={!safeIds.length} onClick={() => decide(safeIds, 'accept')} data-testid="accept-safe">Alle sicheren annehmen ({safeIds.length})</Button>
                <Button size="sm" variant="ghost" onClick={() => decide(ghosts.map((g) => g.id), 'reject')} data-testid="reject-all">Alle ablehnen</Button>
              </div>
              <p className="hint m-0 mt-1">Nichts wird von selbst geschnitten. „also“, „ja“, „genau“, „sozusagen“ gehören zu deiner Sprechweise: Sie sind nie „sicher“ und werden nur geschnitten, wenn du den einzelnen Vorschlag annimmst.</p>
              <ul className="m-0 mt-2 grid max-h-40 gap-1 overflow-y-auto pl-0" aria-label="Offene Vorschläge">
                {ghosts.slice(0, 40).map((g) => (
                  <li key={g.id} className="flex items-center gap-2" data-testid="suggestion-item">
                    <button type="button" className="font-mono underline" onClick={() => seek(Math.max(0, g.outStart - 0.5))}>{fmt(g.outStart)}</button>
                    <Pill tone={g.kind === 'weak_filler' ? 'warn' : 'default'}>{g.kind === 'pause' ? `Pause ${(g.outEnd - g.outStart).toFixed(1)} s` : g.kind === 'weak_filler' ? `„${g.word}“ · deine Sprechweise` : g.kind === 'sound' ? 'Laut' : `Füllwort „${g.word}“`}</Pill>
                    {g.safe && g.kind !== 'weak_filler' ? <span className="text-ok">sicher</span> : g.note ? <span className="truncate text-muted" title={g.note}>{g.note}</span> : null}
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" onClick={() => decide([g.id], 'accept')}>Annehmen</Button>
                      <Button size="sm" variant="ghost" onClick={() => decide([g.id], 'reject')}>Ablehnen</Button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {sel && selected != null ? (
            <div className="rounded-lg border border-line p-3 text-xs" data-testid="clip-inspector">
              <div className="flex flex-wrap items-center gap-2">
                <strong>Clip {selected + 1}</strong><span className="text-muted">{selMedia?.name ?? 'Footage fehlt'}</span>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { apply((b) => removeClip(b, selected)); setSelected(null); }}>Clip entfernen</Button>
              </div>
              <div className="mt-1 flex flex-wrap items-end gap-3">
                {(['in', 'out'] as const).map((edge) => (
                  <Field key={`${edge}-${selected}-${sel[edge === 'in' ? 'inSec' : 'outSec']}`} label={edge === 'in' ? 'In (s)' : 'Out (s)'} htmlFor={`ed-${edge}`}>
                    <input id={`ed-${edge}`} className="field w-24" type="number" step={0.01} min={0} max={selMedia?.durationSec ?? undefined} defaultValue={sel[edge === 'in' ? 'inSec' : 'outSec']}
                      onBlur={(e) => { const x = Number(e.target.value); if (Number.isFinite(x)) apply((b) => trimClip(b, selected, edge, x, selMedia?.durationSec ?? null).body); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                  </Field>
                ))}
                <Field label="Zoom" htmlFor="ed-zoom">
                  <select id="ed-zoom" className="field w-auto" value={sel.zoom.kind} onChange={(e) => update((b) => ({ ...b, clips: b.clips.map((c, i) => (i === selected ? { ...c, zoom: { ...c.zoom, kind: e.target.value as ZoomKind, punchOnCuts: e.target.value === 'push_in' || e.target.value === 'push_out' ? false : c.zoom.punchOnCuts } } : c)) }))}>
                    {(Object.keys(ZOOM_LABEL) as ZoomKind[]).map((z) => <option key={z} value={z}>{ZOOM_LABEL[z]}</option>)}
                  </select>
                </Field>
                {v.script ? (
                  <Field label="Szene" htmlFor="ed-scene">
                    <select id="ed-scene" className="field w-auto" value={sel.sceneIndex ?? ''} onChange={(e) => update((b) => ({ ...b, clips: b.clips.map((c, i) => (i === selected ? { ...c, sceneIndex: e.target.value === '' ? null : Number(e.target.value) } : c)) }))}>
                      <option value="">– wählen –</option>
                      {v.script.scenes.map((s, i) => <option key={i} value={i}>Szene {i + 1}: {s.dialogue.slice(0, 40)}</option>)}
                    </select>
                  </Field>
                ) : null}
              </div>
              {sel.cuts.length ? (
                <ul className="mt-2 grid gap-1" aria-label="Schnitte in diesem Clip">
                  {sel.cuts.map((c, k) => (
                    <li key={`${c.startSec}-${c.endSec}`} className="flex items-center gap-2" data-testid="inspector-cut">
                      <span className="font-mono">{c.startSec.toFixed(2)}–{c.endSec.toFixed(2)} s</span>
                      <Pill>{c.reason === 'manual' ? 'manuell' : c.reason === 'pause' ? 'Pause' : `Füllwort${c.word ? ` „${c.word}“` : ''}`}</Pill>
                      <Button size="sm" variant="ghost" onClick={() => apply((b) => removeCut(b, selected, k))}>Wiederherstellen</Button>
                    </li>
                  ))}
                </ul>
              ) : <p className="hint mt-2 mb-0">Keine Schnitte in diesem Clip.</p>}
              <p className="hint mt-2 mb-0">Hook und Overlays: am Playhead anlegen (oben) oder im Transkript Wörter markieren, auf der Bühne anklicken und ziehen, Text und Stil im Inspector.</p>
            </div>
          ) : !el ? <p className="hint m-0">Clip in der Zeitleiste anklicken, um ihn zu bearbeiten. Ränder ziehen kürzt, Clip ziehen sortiert um. Text oder Grafik auf der Bühne anklicken, um sie zu bearbeiten.</p> : null}

          <div className="flex flex-wrap items-end gap-3 text-xs">
            <Field label="Untertitel" htmlFor="ed-subs">
              <select id="ed-subs" className="field w-auto" value={body.subtitles} disabled={!v.capabilities.subtitles && body.subtitles !== 'burn'} onChange={(e) => update((b) => ({ ...b, subtitles: e.target.value as 'off' | 'burn' }))}>
                <option value="off">aus</option><option value="burn">einbrennen</option>
              </select>
            </Field>
            <Field label="Darstellung" htmlFor="ed-submode">
              <select id="ed-submode" className="field w-auto" value={body.subtitleMode ?? ''} data-testid="subtitle-mode" disabled={body.subtitles !== 'burn'}
                onChange={(e) => update((b) => ({ ...b, subtitleMode: (e.target.value || undefined) as SubtitleMode | undefined }))}>
                <option value="">{look?.design?.subtitleMode ? `wie Meine Marke (${SUBTITLE_MODE_LABELS[look.design.subtitleMode]})` : 'wie Meine Marke (Zeilen)'}</option>
                {SUBTITLE_MODES.map((m) => <option key={m} value={m}>{SUBTITLE_MODE_LABELS[m]}</option>)}
              </select>
            </Field>
            {subtitleAnim?.mode === 'karaoke' ? (
              <Field label="Wörter je Zeile" htmlFor="ed-subwords">
                <select id="ed-subwords" className="field w-auto" value={subtitleAnim.wordsPerLine} onChange={(e) => update((b) => ({ ...b, subtitleWords: Number(e.target.value) }))}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
            ) : null}
            <Field label={`Untertitel-Höhe ${Math.round((body.subtitleY ?? SUBTITLE_Y.legacy) * 100)} %${body.subtitleY == null ? ' (alter Standard)' : ''}`} htmlFor="ed-suby">
              <span className="flex items-center gap-2">
                <input id="ed-suby" type="range" min={SUBTITLE_Y.min * 100} max={SUBTITLE_Y.max * 100} step={1} value={Math.round((body.subtitleY ?? SUBTITLE_Y.legacy) * 100)} data-testid="subtitle-y"
                  aria-valuetext={`Unterkante der Untertitel bei ${Math.round((body.subtitleY ?? SUBTITLE_Y.legacy) * 100)} % der Bildhöhe`}
                  onChange={(e) => d.preview((b) => ({ ...b, subtitleY: Number(e.target.value) / 100 }))} onPointerUp={d.commit} onKeyUp={d.commit} onBlur={d.commit} />
                {body.subtitleY !== SUBTITLE_Y.recommended ? <button type="button" className="underline" onClick={() => update((b) => ({ ...b, subtitleY: SUBTITLE_Y.recommended }))} title="Über der Instagram-Bildunterschrift und unter dem unteren Overlay-Platz">Empfohlen ({SUBTITLE_Y.recommended * 100} %)</button> : null}
              </span>
            </Field>
            <Field label="Lautheit" htmlFor="ed-loud">
              <select id="ed-loud" className="field w-auto" value={body.loudness} onChange={(e) => update((b) => ({ ...b, loudness: e.target.value as LoudnessPreset }))}>
                {(Object.keys(LOUDNESS) as (keyof typeof LOUDNESS)[]).map((k) => <option key={k} value={k}>{LOUDNESS[k].label}</option>)}
                <option value="off">aus (Originalpegel)</option>
              </select>
            </Field>
            {!v.capabilities.subtitles ? <p className="hint m-0 max-w-xs">Untertitel, Hook und Overlays brauchen FFmpeg mit libass.</p> : null}
          </div>
          <p className="hint m-0" data-testid="editor-look">Look: {look?.label ?? '–'} · <Link href="/meine-marke" className="underline">Meine Marke</Link></p>

          {errors.length || warnings.length ? (
            <div className="rounded-lg border border-line p-3 text-xs" data-testid="draft-issues">
              {errors.length ? <><strong className="text-danger">Vor dem Rendern lösen</strong><ul className="mt-1 mb-2 list-disc pl-5 text-danger">{errors.map((x) => <li key={x}>{x}</li>)}</ul></> : null}
              {warnings.length ? <><strong className="text-warn">Hinweise</strong><ul className="mt-1 mb-0 list-disc pl-5 text-warn">{warnings.map((x) => <li key={x}>{x}</li>)}</ul></> : null}
            </div>
          ) : null}

          <div className="rounded-lg border border-line p-3 text-xs" data-testid="editor-render">
            <div className="flex flex-wrap items-center gap-2">
              {personal
                ? <Button variant="primary" busy={busy === 'render'} disabled={renderBlocked} onClick={() => void render('render')} data-testid="render-draft">Rendern</Button>
                : <Button variant="primary" busy={busy === 'save'} disabled={renderBlocked} onClick={() => void render('save')}>Als Version speichern</Button>}
              <span className="text-muted">{view.clips.length} Clips · {view.durationSec.toFixed(1)} s{v.snapshot ? ` · zuletzt als v${v.snapshot.version} gespeichert` : ''}</span>
            </div>
            {personal ? <p className="hint mt-1 mb-0">Rendern speichert den aktuellen Stand als unveränderliche Version und rendert ihn in 1080×1920 (FFmpeg). Der Entwurf bleibt zum Weiterarbeiten.</p> : null}
            <ErrorNote error={error} />
            {v.renders.length ? (
              <ul className="mt-2 grid gap-2" aria-label="Letzte Renders">
                {v.renders.map((r) => (
                  <li key={r.id} className="rounded border border-line p-2" data-testid="editor-render-item">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>v{r.planVersion ?? '?'}</strong>
                      <Pill tone={RENDER_STATUS[r.status]?.tone ?? 'default'}>{RENDER_STATUS[r.status]?.label ?? r.status}</Pill>
                      <span className="text-muted">{fmtDateTime(r.createdAt)}</span>
                      {r.storagePath ? <a className="ml-auto underline" href={`/api/media/${r.id}`} download={`schnitt-v${r.planVersion ?? ''}.mp4`}>Download</a> : null}
                    </div>
                    {r.status === 'rendering' && r.job ? (
                      <div className="mt-1 h-2 overflow-hidden rounded bg-card2" role="progressbar" aria-label="Renderfortschritt" aria-valuenow={Math.round((r.job.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-full bg-lime" style={{ width: `${Math.round((r.job.progress ?? 0) * 100)}%` }} />
                      </div>
                    ) : null}
                    {r.error && r.status !== 'cancelled' ? <p className="mt-1 mb-0 text-danger">{r.error}</p> : null}
                    {r.storagePath ? <video className="mt-2 max-h-72 rounded" src={`/api/media/${r.id}`} controls preload="metadata" /> : null}
                    {r.status === 'pending_review' && personal ? <p className="hint m-0">Fertig – Download und Veröffentlichung gehen sofort. Die Prüfung ist optional (Klassische Ansicht).</p> : null}
                    {!personal && r.storagePath ? (
                      <details className="mt-1"><summary className="cursor-pointer">Für CapCut exportieren</summary><FinishExport renderId={r.id} compact /></details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {personal ? (() => {
            // Etappe 17: the render of the revision she sees (if any), else the newest finished one (QA results, stale note)
            const current = v.snapshot && v.draft && v.snapshot.revision === v.draft.revision ? v.renders.find((r) => r.editPlanId === v.snapshot!.planId && r.status !== 'failed' && r.status !== 'cancelled') ?? null : null;
            const shown = current ?? v.renders.find((r) => r.storagePath) ?? null;
            return (
              <FinishExport renderId={shown?.id ?? null} onSeek={seek}
                staleNote={shown && shown !== current ? `Geprüft wurde Render v${shown.planVersion ?? '?'}; der Entwurf hat sich seitdem geändert – die Zeiten können abweichen.` : null}
                draft={{
                  projectId, scriptId, flush: d.flush,
                  hasImages: body.clips.some((c) => (c.images?.length ?? 0) > 0),
                  hasGraphics: v.capabilities.subtitles && (body.hook != null || body.clips.some((c) => c.overlays.length > 0)),
                  disabledReason: renderBlocked ? 'Erst die Probleme im Entwurf lösen (siehe oben).' : null,
                  onRenderQueued: () => { void d.refresh(); onChanged(); },
                }} />
            );
          })() : null}
        </div>

        <div className="h-[420px] lg:col-span-2 2xl:col-span-1 2xl:h-auto 2xl:max-h-[760px]">
        <TranscriptPanel view={view} transcripts={transcripts} media={media} t={pb.t} onSeek={seek} transcription={v.transcription} onAction={onTranscript} hookAllowed={!v.script} />
        </div>
      </div>

      <Timeline view={view} t={pb.t} media={mediaMap} peaks={peaks} snapTargets={snapTargets} selected={selected} mark={mark} subtitlesOn={burn}
        onSeek={seek} onScrubStart={pb.pause} onSelect={setSelected}
        onTrimPreview={(i, edge, src) => d.preview((b) => trimClip(b, i, edge, src, mediaMap.get(b.clips[i]!.assetId)?.durationSec ?? null).body)}
        onTrimCommit={d.commit} onTrimCancel={d.cancelPreview}
        onTrimStep={(i, edge, delta) => apply((b) => trimClip(b, i, edge, (edge === 'in' ? b.clips[i]!.inSec : b.clips[i]!.outSec) + delta, mediaMap.get(b.clips[i]!.assetId)?.durationSec ?? null).body)}
        onMove={(from, to) => { apply((b) => moveClip(b, from, Math.max(0, Math.min(b.clips.length - 1, to)))); setSelected(Math.max(0, Math.min(body.clips.length - 1, to))); }}
        selectedEl={el} onSelectEl={setEl} onElementDrag={onElementDrag} suggestions={ghosts} onSuggestion={(id, dec) => decide([id], dec)}
        story={track} onStoryGhost={onStoryGhost} />

      <details className="text-[11px] text-muted">
        <summary className="cursor-pointer">Tastatur</summary>
        <p className="m-0 mt-1 leading-6">T legt ein Keyword am Playhead an · Text/Grafik auf der Bühne: ziehen (Alt = ohne Einrasten), Pfeiltasten verschieben (Shift: weiter), Entf entfernt · Transkript: Shift+Klick markiert · Leertaste abspielen/pausieren · J/K/L rückwärts/stopp/vorwärts (mehrfach = schneller) · ←/→ ein Bild (Shift: 1 s) · I/O Bereich markieren, Entf schneidet ihn heraus · S teilt am Playhead · Q/W kürzt Anfang/Ende des Clips bis zum Playhead · Entf ohne Bereich entfernt den gewählten Clip · ⌘/Strg+Z rückgängig, ⇧⌘/Strg+Shift+Z wiederholen · in der Zeitleiste: Tab zu Clip oder Rand, ←/→ verschiebt einen Rand um ein Bild, Alt+←/→ sortiert den Clip um.</p>
      </details>
      <p className="hint m-0">Zuletzt geändert {v.draft ? fmtDateTime(v.draft.updatedAt) : '–'} · Wiedergabe über den Proxy (540×960); exakt sind Standbild, Exakte Vorschau und Render. <button type="button" className="underline" onClick={onOpenClassic} data-testid="classic-fallback">Klassische Ansicht (Fallback)</button> {clipUnderPlayhead() != null ? `Playhead in Clip ${clipUnderPlayhead()! + 1}.` : ''}</p>
    </div>
  );
}

export type { EditorMedia, EditDraftView };
