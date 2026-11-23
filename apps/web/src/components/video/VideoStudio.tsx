'use client';
import { useEffect, useRef, useState } from 'react';
import { fmtBytes, fmtDuration, FOOTAGE_ORIGIN_LABEL, type FootageOrigin } from '@studio/core/media';
import { api, useApi } from '@/lib/api';
import type { FootageList, Project } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, PageHeader, Pill } from '../ui';
import { AiBroll } from './AiBroll';
import { EditPlanner } from './EditPlanner';
import { EditorShell, type OpenRequest } from './editor/EditorShell';
import { TranscriptEditor } from './TranscriptEditor';
import { VideoJobs } from './VideoJobs';

const LAST_PROJECT_KEY = 'video-studio:last-project';
const PROBE_LABEL = { probed: null, probe_failed: 'ffprobe konnte die Datei nicht lesen', probe_unavailable: 'ffprobe nicht installiert – Metadaten fehlen' } as const;
type PrepareStatus = FootageList['items'][number]['prepare']['status'];
const PREPARE_LABEL: Record<PrepareStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'default' } | null> = {
  ready: { label: 'vorbereitet', tone: 'ok' }, queued: { label: 'Vorbereitung wartet …', tone: 'warn' }, running: { label: 'wird vorbereitet …', tone: 'warn' },
  failed: { label: 'Vorbereitung fehlgeschlagen', tone: 'danger' }, none: { label: 'nicht vorbereitet', tone: 'default' }, outdated: { label: 'Vorbereitung veraltet', tone: 'default' }, unsupported: null,
};

/** Upload with progress: the body is the raw file (streamed to disk on the server), metadata in the query string. */
function uploadRaw(url: string, file: File, onProgress: (pct: number) => void): Promise<{ duplicate?: boolean; asset?: { id: string } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status < 300) {
        try { return resolve(JSON.parse(xhr.responseText) as { duplicate?: boolean; asset?: { id: string } }); } catch { return resolve({}); }
      }
      let msg = `HTTP ${xhr.status}`;
      try {
        const d = JSON.parse(xhr.responseText) as { error?: string; issues?: { message: string }[] };
        msg = [d.error, ...(d.issues ?? []).map((i) => i.message)].filter(Boolean).join(': ') || msg;
      } catch { /* not JSON */ }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Upload abgebrochen (Netzwerk).'));
    xhr.send(file);
  });
}

export function VideoStudio() {
  const toast = useToast();
  const projects = useApi<Project[]>('/api/projects');
  // the last project is remembered per browser (a convenience only; nothing depends on it)
  const [projectId, setProjectIdState] = useState('');
  const setProjectId = (id: string) => {
    setProjectIdState(id);
    try { localStorage.setItem(LAST_PROJECT_KEY, id); } catch { /* storage blocked: fine */ }
  };
  useEffect(() => {
    // Etappe 20: the week board opens the editor of its project (`?project=`)
    const wanted = new URLSearchParams(window.location.search).get('project');
    if (wanted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount (no URL on the server)
      setProjectIdState(wanted);
      return;
    }
    try {
      const last = localStorage.getItem(LAST_PROJECT_KEY);
      if (last) setProjectIdState(last);
    } catch { /* storage blocked */ }
  }, []);
  const [plannerKey, setPlannerKey] = useState(0);
  // Etappe 12: the editor is the default; the classic view stays for scripts and client projects until parity
  const [mode, setMode] = useState<'editor' | 'classic' | null>(null);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  // Etappe 15 fix: the nonce must grow across requests – the editor clears a handled request (null), and a nonce that
  // restarted at 1 matched the one it had already handled, so a second upload was never appended to the cut
  const openNonce = useRef(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const pid = projects.data?.some((p) => p.id === projectId) ? projectId : (projects.data?.[0]?.id ?? '');
  const project = projects.data?.find((p) => p.id === pid) ?? null;
  const footage = useApi<FootageList>(pid ? `/api/projects/${pid}/footage` : null);
  const [origin, setOrigin] = useState<FootageOrigin>('own');
  const [rightsNote, setRightsNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList | null) {
    if (!files?.length || !pid) return;
    setError(null);
    let uploaded = 0, duplicates = 0;
    let lastId: string | null = null;
    try {
      for (const file of Array.from(files)) {
        setProgress(0);
        const q = new URLSearchParams({ name: file.name, origin, rightsConfirmed: origin !== 'own' && confirmed ? '1' : '0', rightsNote: origin === 'own' ? '' : rightsNote });
        try {
          const r = await uploadRaw(`/api/projects/${pid}/footage?${q}`, file, setProgress);
          if (r.duplicate) duplicates++; else uploaded++;
          if (r.asset?.id && !r.duplicate) lastId = r.asset.id;
        } catch (e) {
          throw new Error(`${file.name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
      // Also after a partial failure: the clips before it are stored.
      if (uploaded || duplicates) {
        await footage.reload();
        toast([uploaded ? `${uploaded} Clip(s) hochgeladen` : '', duplicates ? `${duplicates} schon vorhanden` : ''].filter(Boolean).join(' · ') + '.');
      }
      // straight into the editor with the new footage (as a Freier Schnitt in her own projects)
      if (lastId) openInEditor(lastId);
    }
  }
  function openInEditor(assetId: string) {
    setMode('editor');
    setOpenRequest({ assetId, nonce: ++openNonce.current });
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  async function prepare(id: string) {
    try {
      await api(`/api/footage/${id}/prepare`, { method: 'POST' });
      await footage.reload();
    } catch (e) { setError((e as Error).message); }
  }
  async function remove(id: string) {
    try {
      await api(`/api/footage/${id}`, { method: 'DELETE' });
      if (preview === id) setPreview(null);
      await footage.reload();
    } catch (e) { setError((e as Error).message); }
  }

  async function transcribe(id: string) {
    try {
      await api(`/api/footage/${id}/transcribe`, { method: 'POST' });
      await footage.reload();
    } catch (e) { setError((e as Error).message); }
  }
  const transcribing = footage.data?.items.some((a) => a.transcribing || a.prepare.status === 'queued' || a.prepare.status === 'running') ?? false;
  const { reload: reloadFootage } = footage;
  useEffect(() => {
    if (!transcribing) return;
    const t = setInterval(() => void reloadFootage(), 2000);
    return () => clearInterval(t);
  }, [transcribing, reloadFootage]);

  // Etappe 10: own footage carries its rights implicitly (no checkbox); licensed/client footage needs both
  const needsNote = origin !== 'own';
  const ready = !needsNote || (confirmed && rightsNote.trim().length >= 3);
  const canUpload = ready && !!pid && progress == null;
  const blockedReason = !projects.data ? null
    : !pid ? 'Erst ein Projekt anlegen (UGC Projects), dann hierher zurück.'
    : needsNote && !confirmed ? 'Zum Hochladen links bestätigen, dass du die Rechte am Material hast.'
    : needsNote && rightsNote.trim().length < 3 ? 'Bei lizenziertem oder Kundenmaterial links die Quelle angeben.' : null;
  const items = footage.data?.items ?? [];
  const view = mode ?? (project?.kind === 'UGC_CLIENT' ? 'classic' : 'editor');

  return (
    <div className="appear" data-testid="video-studio">
      <PageHeader eyebrow="04 / HYBRID VIDEO" title="Video Studio" accent="echtes Footage zuerst." lead="Hochladen, und der Editor öffnet sich: Proxy, Vorschaubilder, Wellenform und (mit whisper.cpp) das Transkript entstehen automatisch. Schneiden in der Zeitleiste, Pacing mit einem Klick, Rendern direkt aus dem Entwurf. Hook, Overlays und Untertitel brauchen FFmpeg mit libass (ffmpeg-full)." />

      <section className="panel mb-4">
        <h2 className="mb-3 text-lg font-bold">Footage hochladen</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="grid content-start gap-3">
            <Field label="Projekt" htmlFor="vs-project">
              <select id="vs-project" className="field" value={pid} onChange={(e) => setProjectId(e.target.value)}>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.title}{p.kind === 'UGC_CLIENT' ? ' (Kunde)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Herkunft" htmlFor="vs-origin">
              <select id="vs-origin" className="field" value={origin} onChange={(e) => setOrigin(e.target.value as FootageOrigin)}>
                {(['own', 'licensed', 'client'] as const).map((o) => <option key={o} value={o}>{FOOTAGE_ORIGIN_LABEL[o]}</option>)}
              </select>
            </Field>
            {needsNote ? (
              <Field label={origin === 'client' ? 'Quelle (z. B. „Mail der Kundin vom 12.11.“)' : 'Lizenz / Quelle'} htmlFor="vs-note">
                <input id="vs-note" className="field" value={rightsNote} onChange={(e) => setRightsNote(e.target.value)} maxLength={500} />
              </Field>
            ) : null}
            {needsNote ? (
              <label className="flex items-center gap-2 text-[11px] text-muted">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                Ich habe die Rechte an diesem Material{project?.kind === 'UGC_CLIENT' ? ' bzw. die Erlaubnis der Kundin' : ''}. Keine fremden Clips als eigenes Material.
              </label>
            ) : <p className="hint m-0">Eigene Aufnahme: Die Rechte liegen bei dir, keine Bestätigung nötig.</p>}
          </div>
          <div className="grid content-start gap-2">
            <div
              role="button"
              tabIndex={canUpload ? 0 : -1}
              aria-disabled={!canUpload}
              data-testid="footage-dropzone"
              onClick={() => canUpload && fileRef.current?.click()}
              onKeyDown={(e) => { if (canUpload && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); if (canUpload) setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); if (canUpload) void upload(e.dataTransfer.files); }}
              className={`flex items-center gap-4 rounded-xl border border-dashed p-5 transition ${!canUpload ? 'cursor-not-allowed border-line opacity-70' : drag ? 'cursor-pointer border-accent bg-[#eef6dc]' : 'cursor-pointer border-[#a9c46e] bg-[#f5f7f0] hover:bg-[#eef6dc]'}`}
            >
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#e6f1cc] text-2xl text-accent">+</div>
              <div>
                <strong className="text-[15px]">{progress != null ? `Lade hoch … ${progress} %` : 'Videos hier ablegen oder klicken'}</strong>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">MP4, MOV oder WEBM, direkt auf die Platte gestreamt (Limit {footage.data ? fmtBytes(footage.data.limits.perFile) : '…'} pro Datei).</p>
              </div>
              <input ref={fileRef} type="file" hidden accept="video/mp4,video/quicktime,video/webm" multiple disabled={!canUpload} aria-label="Videodateien auswählen" onChange={(e) => void upload(e.target.files)} />
            </div>
            {blockedReason ? <p className="text-[12px] text-warn" data-testid="upload-blocked">{blockedReason}</p> : null}
            {progress != null ? <div className="h-2 overflow-hidden rounded bg-card2" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-lime" style={{ width: `${progress}%` }} /></div> : null}
            <ErrorNote error={error ?? footage.error} />
          </div>
        </div>
      </section>

      <section className="panel mb-4" data-testid="footage-list">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 className="m-0 text-lg font-bold">Footage im Projekt</h2>
          {footage.data ? <span className="text-xs text-muted">{fmtBytes(footage.data.usedBytes)} von {fmtBytes(footage.data.limits.perProject)}</span> : null}
        </div>
        {items.length ? (
          <ul className="grid gap-2 text-xs">
            {items.map((a) => (
              <li key={a.id} className="rounded-xl border border-line p-3" data-testid="footage-item">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{a.name}</strong>
                  <Pill tone={a.origin === 'own' ? 'ok' : 'warn'}>{FOOTAGE_ORIGIN_LABEL[a.origin]}</Pill>
                  <span className="text-muted">
                    {fmtBytes(a.size)}{a.probe ? ` · ${fmtDuration(a.probe.durationSec)} · ${a.probe.displayWidth}×${a.probe.displayHeight}${a.probe.orientation === 'portrait' ? ' (hochkant)' : ''}${a.probe.fps ? ` · ${a.probe.fps} fps` : ''}${a.probe.hasAudio ? '' : ' · ohne Ton'}` : ''}
                  </span>
                  {a.transcript ? <Pill tone={a.transcript.source === 'mock' ? 'mock' : 'ok'}>{a.transcript.source === 'mock' ? `MOCK-Transkript${a.transcript.version > 1 ? ' (korrigiert)' : ''}` : `Transkript v${a.transcript.version}${a.transcript.source === 'user_edit' ? ' (korrigiert)' : ''}`}</Pill> : null}
                  {a.transcribing ? <Pill tone="warn">wird transkribiert …</Pill> : null}
                  {PREPARE_LABEL[a.prepare.status] ? <span data-testid="prepare-status"><Pill tone={PREPARE_LABEL[a.prepare.status]!.tone}>{PREPARE_LABEL[a.prepare.status]!.label}{a.prepare.status === 'running' && a.prepare.progress != null ? ` ${Math.round(a.prepare.progress * 100)} %` : ''}</Pill></span> : null}
                  <span className="ml-auto flex gap-2">
                    {a.prepare.status !== 'unsupported' && a.origin !== 'generated' ? <Button size="sm" variant="ghost" onClick={() => openInEditor(a.id)}>In den Schnitt</Button> : null}
                    {a.prepare.status === 'failed' || a.prepare.status === 'none' || a.prepare.status === 'outdated' ? <Button size="sm" variant="ghost" onClick={() => void prepare(a.id)}>{a.prepare.status === 'failed' ? 'Erneut vorbereiten' : 'Vorbereiten'}</Button> : null}
                    {a.probe?.hasAudio && !a.transcribing ? <Button size="sm" variant="ghost" onClick={() => void transcribe(a.id)}>{a.transcript ? 'Neu transkribieren' : 'Transkribieren'}</Button> : null}
                    {a.transcript ? <Button size="sm" variant="ghost" onClick={() => setOpenTranscript(openTranscript === a.id ? null : a.id)}>{openTranscript === a.id ? 'Transkript schließen' : 'Transkript'}</Button> : null}
                    <Button size="sm" variant="ghost" onClick={() => setPreview(preview === a.id ? null : a.id)}>{preview === a.id ? 'Vorschau schließen' : 'Vorschau'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(a.id)}>Löschen</Button>
                  </span>
                </div>
                {a.rightsNote ? <p className="mt-1 text-muted">Rechte: {a.rightsNote}</p> : null}
                {PROBE_LABEL[a.status] ? <p className="mt-1 text-warn">⚠ {PROBE_LABEL[a.status]}</p> : null}
                {a.prepare.status === 'failed' && a.prepare.error ? <p className="mt-1 text-danger">Vorbereitung: {a.prepare.error}</p> : null}
                {openTranscript === a.id && a.transcript ? <TranscriptEditor key={a.transcript.id} assetId={a.id} onSaved={() => void footage.reload()} /> : null}
                {preview === a.id ? <video className="mt-2 max-h-96 rounded-lg" src={`/api/media/${a.id}`} controls preload="metadata" /> : null}
              </li>
            ))}
          </ul>
        ) : <Empty>Noch kein Footage in diesem Projekt.</Empty>}
      </section>

      {pid ? <AiBroll key={`ab-${pid}`} projectId={pid} onPlansChanged={() => { setPlannerKey((k) => k + 1); void footage.reload(); }} /> : null}

      {pid && project?.kind === 'UGC_CLIENT' ? (
        <div ref={editorRef} className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Ansicht">
          <Button size="sm" variant={view === 'editor' ? 'primary' : 'subtle'} aria-pressed={view === 'editor'} onClick={() => setMode('editor')}>Editor</Button>
          <Button size="sm" variant={view === 'classic' ? 'primary' : 'subtle'} aria-pressed={view === 'classic'} data-testid="view-classic" onClick={() => setMode('classic')}>Klassische Ansicht</Button>
          <span className="hint">Kundenprojekte: Freigabe, Render und Render-Prüfung laufen über die Klassische Ansicht.</span>
        </div>
      ) : pid ? (
        // Etappe 13: eigene Projekte arbeiten im Editor; die Klassische Ansicht bleibt nur als Rückfall (Versionen, alte Pläne)
        <div ref={editorRef} className="mb-3 flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Ansicht">
          {view === 'classic'
            ? <Button size="sm" variant="primary" onClick={() => setMode('editor')} data-testid="view-editor">← Zurück zum Editor</Button>
            : <button type="button" className="text-muted underline" data-testid="view-classic" onClick={() => setMode('classic')}>Klassische Ansicht (Fallback: Versionen, ältere Pläne)</button>}
        </div>
      ) : null}
      {pid && project && view === 'editor' ? <EditorShell key={`ed-${pid}`} projectId={pid} projectKind={project.kind} openRequest={openRequest} onOpenHandled={() => setOpenRequest(null)} onOpenClassic={() => setMode('classic')} onChanged={() => { void footage.reload(); setPlannerKey((k) => k + 1); }} /> : null}
      {pid && view === 'classic' ? <EditPlanner key={`${pid}-${plannerKey}`} projectId={pid} footage={items} /> : null}

      <VideoJobs />

      <section className="panel border-dashed">
        <span className="inline-flex rounded-full border border-[#e8cf7a] bg-[#fff6db] px-2.5 py-1 text-[10px] font-semibold text-warn">NOCH NICHT MÖGLICH</span>
        <ul className="mt-2 list-disc pl-5 text-sm leading-7 text-[#343b2d]" data-testid="not-yet">
          <li>Bild-Einblendungen in Kundenprojekten und animierte Bilder (Kenburns) – eigene Fotos gehen im Freien Schnitt eigener Projekte als ruhendes Bild</li>
          <li>Animierte Untertitel (Wort für Wort) – Untertitel erscheinen als ganze Zeilen</li>
          <li>Weiche Übergänge (Crossfades) zwischen Schnitten – Schnitte sind harte Schnitte mit kurzer Ton-Blende</li>
          <li>„Anzeige“ ins Video einbrennen – die Werbekennzeichnung steht in den Kennzeichnungen und der Caption</li>
        </ul>
      </section>
    </div>
  );
}
