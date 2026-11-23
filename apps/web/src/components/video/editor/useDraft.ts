'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EditDraftBody } from '@studio/core/edit';
import { SUBTITLE_Y } from '@studio/core/overlayLayout';
import { api, ApiError } from '@/lib/api';
import type { EditDraftView } from '@/lib/types';

/**
 * The working draft in the browser (Etappe 12, E7): load, undo/redo, debounced autosave with the revision check.
 * Every change goes through `apply` (one undo step); a drag previews with `preview` and becomes one step on `commit`.
 * The server answers each save with the problems (lenient), the look and the media state; the body she is editing is
 * never replaced by the answer, so typing during a save loses nothing.
 */
export type SaveStatus = 'loading' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
const AUTOSAVE_MS = 700;
const HISTORY = 100;
/** A new draft: fonts of „Meine Marke“, subtitles at the recommended height (Etappe 13, see `SUBTITLE_Y`). */
export const emptyBody = (): EditDraftBody => EditDraftBody.parse({ clips: [], look: { fontSource: 'design' }, subtitleY: SUBTITLE_Y.recommended });

export function useDraft(projectId: string, scriptId: string | null) {
  const [view, setView] = useState<EditDraftView | null>(null);
  const [body, setBody] = useState<EditDraftBody | null>(null);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [hist, setHistState] = useState<{ past: EditDraftBody[]; future: EditDraftBody[] }>({ past: [], future: [] });
  // the history lives in a ref (no side effects inside state updaters); the state only renders the buttons
  const histRef = useRef(hist);
  const setHist = useCallback((h: { past: EditDraftBody[]; future: EditDraftBody[] }) => { histRef.current = h; setHistState(h); }, []);
  const revision = useRef(0);
  const bodyRef = useRef<EditDraftBody | null>(null);
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragBase = useRef<EditDraftBody | null>(null);
  const consent = useRef('');
  const base = `/api/projects/${projectId}/edit-draft`;
  const query = `?scriptId=${encodeURIComponent(scriptId ?? '')}`;

  const save = useCallback(async (opts: { keepalive?: boolean } = {}) => {
    if (saving.current) await saving.current;
    if (!dirty.current || !bodyRef.current) return;
    // review fix (Etappe 13): during a drag or live text edit the uncommitted preview is never stored – the state it
    // started from is; the preview is saved once it is committed (a cancel then needs no save at all)
    const sent = dragBase.current ?? bodyRef.current;
    dirty.current = false;
    setStatus('saving');
    const p = (async () => {
      try {
        const v = await api<EditDraftView>(base, { method: 'PUT', keepalive: opts.keepalive, json: { scriptId, revision: revision.current, body: sent, clientConsentNote: consent.current } });
        revision.current = v.draft?.revision ?? revision.current;
        consent.current = v.draft?.clientConsentNote ?? consent.current;
        setView(v);
        setError(null);
        setStatus(dirty.current ? 'dirty' : 'saved');
      } catch (e) {
        dirty.current = true;
        setError((e as Error).message);
        setStatus(e instanceof ApiError && e.status === 409 ? 'conflict' : 'error');
      }
    })();
    saving.current = p;
    await p;
    saving.current = null;
  }, [base, scriptId]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setStatus((s) => (s === 'conflict' ? s : 'dirty'));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  }, [save]);

  /** Loads the draft; a base without draft starts from its latest saved version (or empty) and is stored at once. */
  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const v = await api<EditDraftView>(`${base}${query}`);
      if (v.draft) {
        revision.current = v.draft.revision;
        consent.current = v.draft.clientConsentNote;
        bodyRef.current = v.draft.body;
        setBody(v.draft.body);
        setView(v);
        setStatus('saved');
      } else {
        const start = v.latestPlan?.body ? EditDraftBody.parse(v.latestPlan.body) : emptyBody();
        const created = await api<EditDraftView>(base, { method: 'PUT', json: { scriptId, revision: 0, body: start, basePlanId: v.latestPlan?.id ?? null } });
        revision.current = created.draft!.revision;
        bodyRef.current = created.draft!.body;
        setBody(created.draft!.body);
        setView(created);
        setStatus('saved');
      }
      dirty.current = false;
      setHist({ past: [], future: [] });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }, [base, query, scriptId, setHist]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  /** Polls the server state (preparation, transcription, render) without touching the body. */
  const refresh = useCallback(async () => {
    try {
      const v = await api<EditDraftView>(`${base}${query}`);
      setView((old) => (old ? { ...v, draft: old.draft && v.draft ? { ...v.draft, body: old.draft.body } : v.draft, issues: dirty.current ? old.issues : v.issues } : v));
      if (v.draft && v.draft.revision !== revision.current && !dirty.current && !saving.current) {
        // changed elsewhere (e.g. footage deleted) while nothing is pending here: take it over
        revision.current = v.draft.revision;
        bodyRef.current = v.draft.body;
        setBody(v.draft.body);
      }
    } catch { /* the next poll tries again */ }
  }, [base, query]);

  const set = useCallback((next: EditDraftBody, record: boolean) => {
    const prev = bodyRef.current;
    if (!prev || next === prev) return;
    if (record) setHist({ past: [...histRef.current.past.slice(-HISTORY + 1), dragBase.current ?? prev], future: [] });
    dragBase.current = null;
    bodyRef.current = next;
    setBody(next);
    schedule();
  }, [schedule, setHist]);

  /** One undoable change. */
  const apply = useCallback((fn: (b: EditDraftBody) => EditDraftBody) => {
    if (bodyRef.current) set(fn(bodyRef.current), true);
  }, [set]);
  /** Live preview while dragging (no history step, not saved yet). */
  const preview = useCallback((fn: (b: EditDraftBody) => EditDraftBody) => {
    const cur = bodyRef.current;
    if (!cur) return;
    dragBase.current ??= cur;
    const next = fn(dragBase.current);
    bodyRef.current = next;
    setBody(next);
  }, []);
  /** Ends a drag: the previewed state becomes one undo step and is saved. */
  const commit = useCallback(() => {
    const start = dragBase.current, cur = bodyRef.current;
    if (!start || !cur) return;
    dragBase.current = null;
    if (start === cur) return;
    setHist({ past: [...histRef.current.past.slice(-HISTORY + 1), start], future: [] });
    schedule();
  }, [schedule, setHist]);
  const cancelPreview = useCallback(() => {
    if (!dragBase.current) return;
    bodyRef.current = dragBase.current;
    setBody(dragBase.current);
    dragBase.current = null;
  }, []);

  const undo = useCallback(() => {
    const h = histRef.current, prev = h.past[h.past.length - 1], cur = bodyRef.current;
    if (!prev || !cur) return;
    setHist({ past: h.past.slice(0, -1), future: [cur, ...h.future] });
    bodyRef.current = prev;
    setBody(prev);
    schedule();
  }, [schedule, setHist]);
  const redo = useCallback(() => {
    const h = histRef.current, next = h.future[0], cur = bodyRef.current;
    if (!next || !cur) return;
    setHist({ past: [...h.past, cur], future: h.future.slice(1) });
    bodyRef.current = next;
    setBody(next);
    schedule();
  }, [schedule, setHist]);

  /** Saves now (before rendering); returns the stored revision. */
  const flush = useCallback(async () => {
    // a pending preview (drag, live text) is what she sees: it becomes a step before saving
    if (dragBase.current) commit();
    if (timer.current) clearTimeout(timer.current);
    await save();
    if (dirty.current) throw new Error('Der Entwurf konnte nicht gespeichert werden.');
    return revision.current;
  }, [save, commit]);

  /**
   * Etappe 15: the stored draft changed through „Übernehmen“ in the chat (a new revision on the server). It replaces the
   * body she sees, and the state before goes onto the undo stack, so ⌘Z takes the chat change back (saved as the next
   * revision). Pending local changes are saved first by the chat (`flush`), so nothing of hers is overwritten.
   */
  const adoptRemote = useCallback(async () => {
    // review fix: never overwrite edits that are not saved yet (typed during the apply request, a failed save)
    if (dirty.current || saving.current || dragBase.current) {
      setStatus('conflict');
      setError('Der Chat hat den Entwurf geändert, während hier noch Änderungen offen waren – neu laden oder deine Fassung behalten.');
      return;
    }
    const v = await api<EditDraftView>(`${base}${query}`);
    if (!v.draft) return;
    if (dirty.current || saving.current || dragBase.current) {
      setStatus('conflict');
      setError('Der Chat hat den Entwurf geändert, während hier noch Änderungen offen waren – neu laden oder deine Fassung behalten.');
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    const prev = bodyRef.current;
    revision.current = v.draft.revision;
    consent.current = v.draft.clientConsentNote;
    if (prev && prev !== v.draft.body) setHist({ past: [...histRef.current.past.slice(-HISTORY + 1), prev], future: [] });
    bodyRef.current = v.draft.body;
    dirty.current = false;
    setBody(v.draft.body);
    setView(v);
    setStatus('saved');
  }, [base, query, setHist]);

  /** After a conflict: keep her version (store it over the newer one) or take the stored one. */
  const resolveConflict = useCallback(async (keepMine: boolean) => {
    const v = await api<EditDraftView>(`${base}${query}`);
    revision.current = v.draft?.revision ?? 0;
    if (keepMine) {
      setStatus('dirty');
      dirty.current = true;
      await save();
    } else {
      await load();
    }
  }, [base, query, save, load]);

  // review fix: a pending change is never dropped silently – saved when the tab is hidden or closed (keepalive, so the
  // browser lets the request finish), when the editor unmounts (base switch, other view), and leaving with unsaved or
  // refused changes asks first
  useEffect(() => {
    const onHide = () => { if (dirty.current) void save({ keepalive: true }); };
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirty.current) e.preventDefault(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [save]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (dirty.current) void save({ keepalive: true });
  }, [save]);

  return {
    view, body, status, error,
    canUndo: hist.past.length > 0, canRedo: hist.future.length > 0,
    apply, preview, commit, cancelPreview, undo, redo, flush, refresh, reload: load, resolveConflict, adoptRemote,
  };
}
