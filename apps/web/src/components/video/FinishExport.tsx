'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { FinishState } from '@/lib/types';
import { Button, ErrorNote, Pill } from '../ui';

/**
 * Etappe 17: „Für CapCut exportieren“. One click: (editor) renders the current draft revision if needed, makes the clean
 * video (no burned text, AI label kept when needed), the cover and optionally the text layer with alpha, then downloads the
 * ZIP with SRTs, text sheet, guide and caption. Client projects: only approved renders (the server refuses, the reason is
 * shown). QA „Fehlende Wörter prüfen“ re-transcribes the render (whisper.cpp only) and lists words that are not heard;
 * a click jumps there in the editor. Nothing is changed automatically.
 */
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
type Opts = { images: boolean; alpha: boolean; words: boolean };

export interface DraftExport {
  projectId: string; scriptId: string | null;
  /** Saves pending edits and returns the revision the server has. */
  flush: () => Promise<number>;
  hasImages: boolean; hasGraphics: boolean;
  /** Why the draft cannot be exported right now (problems, conflict) – the button is disabled with it. */
  disabledReason: string | null;
  /** Called after the editor's one click queued a render (the render list refreshes). */
  onRenderQueued?: () => void;
}

const needed = (s: FinishState, o: Opts) => [s.options.images && !o.images ? 'clean_noimg' : 'clean', 'cover', ...(o.alpha && s.options.alpha ? ['alpha'] : [])] as (keyof FinishState['files'])[];
export const packageUrl = (renderId: string, o: Opts) => `/api/renders/${renderId}/package?images=${o.images ? 1 : 0}&alpha=${o.alpha ? 1 : 0}&words=${o.words ? 1 : 0}`;

export function FinishExport({ renderId: initialId, draft, onSeek, staleNote, compact }: {
  renderId: string | null; draft?: DraftExport; onSeek?: (t: number) => void; staleNote?: string | null; compact?: boolean;
}) {
  /** The render the running export belongs to (its package is that render's, whatever the editor shows meanwhile). */
  const [exportId, setExportId] = useState<string | null>(null);
  const [state, setState] = useState<FinishState | null>(null);
  const [opts, setOpts] = useState<Opts>({ images: true, alpha: false, words: true });
  const [pending, setPending] = useState<Opts | null>(null);
  const [busy, setBusy] = useState(false);
  // follows the editor's current render – but never while an export runs
  const renderId = pending || busy ? exportId : initialId ?? exportId;

  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    try {
      const s = await api<FinishState>(`/api/renders/${id}/finish`);
      setState(s);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch the state of the render shown
    if (renderId) void load(renderId);
  }, [renderId, load]);

  /** Starts the finish job; returns the id of the job THIS export waits for (null = the server said every file is ready). */
  const start = useCallback(async (id: string, o: Opts) => {
    const r = await api<{ job: { id: string } | null }>(`/api/renders/${id}/finish`, { method: 'POST', json: { images: o.images, alpha: o.alpha } });
    return r.job?.id ?? null;
  }, []);

  /** The running export: its options and the finish job it waits for (an older job of the render is never its outcome). */
  const run = useRef<{ opts: Opts; jobId: string | null; retried: boolean } | null>(null);

  // one poll at a time (chained timeouts), stopped by cleanup – a slow request can never start a second download
  const running = !!pending || (state?.job && !state.job.done) || (state?.qa.job && !state.qa.job.done);
  useEffect(() => {
    if (!running || !renderId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (err: string | null) => { run.current = null; setPending(null); if (err) setError(err); };
    const tick = async () => {
      const s = await load(renderId);
      if (stopped) return;
      const r = run.current;
      if (!s && r) return finish(null); // the error is shown by load
      if (s && r) {
        if (s.status === 'failed' || s.status === 'cancelled') return finish('Der Render ist fehlgeschlagen – erst den Schnitt neu rendern.');
        const mine = r.jobId && s.job?.id === r.jobId ? s.job : null;
        const waiting = s.status === 'rendering' || (s.job && !s.job.done); // the package needs the finished render and job
        if (!waiting) {
          if (mine && (mine.status === 'failed' || mine.status === 'cancelled')) return finish(mine.error ?? 'Paket fehlgeschlagen.');
          const missing = needed(s, r.opts).filter((k) => !s.files[k]);
          if (!missing.length) {
            const url = packageUrl(renderId, r.opts);
            stopped = true;
            finish(null);
            setReady(url);
            const a = document.createElement('a');
            a.href = url;
            a.download = '';
            a.click();
            return;
          }
          // a file is still missing (another job finished, a file went stale): ask once more, then give up with a message
          if (r.retried) return finish('Das Paket ist unvollständig geblieben – bitte erneut „Für CapCut exportieren“.');
          r.retried = true;
          try { r.jobId = await start(renderId, r.opts); } catch (e) { return finish((e as Error).message); }
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), 1000);
    };
    timer = setTimeout(() => void tick(), 1000);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [running, renderId, load, start]);

  async function exportNow() {
    setBusy(true);
    setError(null);
    setReady(null);
    const o = { ...opts };
    try {
      let id = renderId;
      let jobId: string | null = null;
      if (draft) {
        const revision = await draft.flush();
        const out = await api<{ render: { id: string }; finish: { job: { id: string } | null } }>(`/api/projects/${draft.projectId}/edit-draft/finish`, { method: 'POST', json: { scriptId: draft.scriptId, revision, images: o.images, alpha: o.alpha } });
        id = out.render.id;
        jobId = out.finish.job?.id ?? null;
        draft.onRenderQueued?.();
      } else if (id) {
        jobId = await start(id, o);
      }
      if (id) {
        run.current = { opts: o, jobId, retried: false };
        setExportId(id);
        await load(id);
        setPending(o);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function qa() {
    if (!renderId) return;
    setError(null);
    try {
      await api(`/api/renders/${renderId}/qa`, { method: 'POST' });
      await load(renderId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // the editor exports the draft as it is now: its options, not those of an older render shown below
  const hasImages = draft ? draft.hasImages : state?.options.images ?? false;
  const canAlpha = draft ? draft.hasGraphics : state?.options.alpha ?? false;
  const blocked = draft ? draft.disabledReason : !renderId ? 'Noch kein Render.' : state?.blocker ?? null;
  const job = state?.job && !state.job.done ? state.job : null;
  const waitingForRender = pending && state?.status === 'rendering';
  const qaJob = state?.qa.job && !state.qa.job.done ? state.qa.job : null;
  const result = state?.qa.result ?? null;

  return (
    <div className={`grid gap-2 text-xs ${compact ? '' : 'rounded-lg border border-line p-3'}`} data-testid="finish-export">
      {!compact ? <strong>Für CapCut exportieren</strong> : null}
      {!compact ? <p className="hint m-0">Video ohne eingebrannte Texte (das KI-Label bleibt, wenn KI-Material drin ist), Untertitel als SRT, Texte mit Zeiten und Stil zum Nachbauen, Cover und eine kurze Anleitung – als ZIP.</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        {hasImages ? (
          <label className="flex items-center gap-1"><input type="checkbox" checked={opts.images} onChange={(e) => setOpts((o) => ({ ...o, images: e.target.checked }))} data-testid="finish-images" /> Bilder im Video einblenden</label>
        ) : null}
        <label className="flex items-center gap-1" title={canAlpha ? undefined : 'Kein Hook/Overlay im Schnitt (oder FFmpeg ohne libass)'}>
          <input type="checkbox" checked={opts.alpha && canAlpha} disabled={!canAlpha} onChange={(e) => setOpts((o) => ({ ...o, alpha: e.target.checked }))} data-testid="finish-alpha" /> Text-Ebene mit Transparenz (.mov, groß)
        </label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={opts.words} onChange={(e) => setOpts((o) => ({ ...o, words: e.target.checked }))} data-testid="finish-words" /> Wort-für-Wort-Untertitel</label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" busy={busy || !!pending} disabled={!!blocked} title={blocked ?? undefined} onClick={() => void exportNow()} data-testid="finish-start">Für CapCut exportieren</Button>
        {ready ? <a className="underline" href={ready} download data-testid="finish-download">ZIP herunterladen</a> : null}
        {blocked ? <span className="text-muted" data-testid="finish-blocked">{blocked}</span> : null}
      </div>
      {waitingForRender ? <p className="hint m-0" data-testid="finish-progress">Render läuft – danach entsteht das Paket …</p> : null}
      {job ? (
        <div className="grid gap-1" data-testid="finish-progress">
          <div className="h-2 overflow-hidden rounded bg-card2" role="progressbar" aria-label="Paket-Fortschritt" aria-valuenow={Math.round((job.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-lime" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
          </div>
          <span className="text-muted">{job.status === 'queued' ? 'wartet auf den Worker' : job.progressNote || 'Paket wird erstellt …'}</span>
        </div>
      ) : null}
      {opts.alpha && canAlpha ? <p className="hint m-0">Ob CapCut die Transparenz übernimmt, hängt von der Version ab (nicht geprüft). DaVinci Resolve und Final Cut lesen ProRes 4444.</p> : null}
      {state?.projectKind === 'UGC_CLIENT' ? <p className="hint m-0">Kundenprojekt: Die Anleitung im Paket erinnert an „Anzeige“ in der Caption.</p> : null}
      <ErrorNote error={error} />

      {renderId && state && state.status !== 'rendering' ? (
        <div className="grid gap-1 border-t border-line pt-2" data-testid="qa-missing">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!state.qa.available || !!qaJob} busy={!!qaJob} title={state.qa.reason ?? undefined} onClick={() => void qa()} data-testid="qa-start">Fehlende Wörter prüfen</Button>
            {!state.qa.available ? <span className="text-muted" data-testid="qa-reason">{state.qa.reason}</span> : <span className="text-muted">Transkribiert den Render neu (lokal) und vergleicht mit den behaltenen Sätzen. Nur Hinweise, nichts wird geändert.</span>}
          </div>
          {qaJob ? <span className="text-muted">{qaJob.progressNote || 'Prüfung läuft …'}</span> : null}
          {state.qa.job?.status === 'failed' ? <p className="m-0 text-danger">{state.qa.job.error}</p> : null}
          {result ? (
            <div data-testid="qa-result">
              <p className="m-0">{result.findings.length ? `${result.findings.length} Stelle(n), an denen Wörter fehlen könnten` : 'Keine fehlenden Wörter gefunden.'} <span className="text-muted">({result.matched} von {result.expected} Wörtern wiedererkannt{result.skippedClips.length ? `; Clip ${result.skippedClips.join(', ')} ohne Transkript nicht geprüft` : ''})</span></p>
              {staleNote ? <p className="hint m-0">{staleNote}</p> : null}
              {result.findings.length ? (
                <ul className="m-0 grid gap-1 pl-0" aria-label="Fehlende Wörter">
                  {result.findings.map((f, i) => (
                    <li key={i} className="list-none">
                      <button type="button" className="underline disabled:no-underline" disabled={!onSeek} onClick={() => onSeek?.(f.startSec)} data-testid="qa-finding">
                        {fmt(f.startSec)} „{f.text}“
                      </button>
                      {f.atCut ? <> <Pill tone="warn">am Schnitt – evtl. abgeschnitten</Pill></> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
