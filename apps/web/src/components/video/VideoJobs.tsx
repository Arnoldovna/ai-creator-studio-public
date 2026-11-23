'use client';
import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/api';
import type { VideoJob, VideoJobList } from '@/lib/types';
import { Button, Empty, ErrorNote, fmtDateTime, Pill } from '../ui';

const STATUS: Record<VideoJob['status'], { label: string; tone: 'default' | 'warn' | 'ok' | 'danger' }> = {
  queued: { label: 'wartet', tone: 'default' },
  running: { label: 'läuft', tone: 'warn' },
  succeeded: { label: 'fertig', tone: 'ok' },
  failed: { label: 'fehlgeschlagen', tone: 'danger' },
  cancelled: { label: 'abgebrochen', tone: 'default' },
};
const KIND_LABEL: Record<VideoJob['kind'], string> = { selftest: 'Worker-Test (Testbild, wird nicht gespeichert)', render: 'Rohschnitt rendern', transcribe: 'Transkription (whisper.cpp, lokal)', generate: 'KI-B-Roll (Higgsfield, verbraucht Credits)', silence_scan: 'Pausen messen (FFmpeg, lokal)', prepare: 'Vorbereitung (Proxy, Vorschaubilder, Wellenform)', preview: 'Exakte Vorschau (540×960, FFmpeg)', finish: 'CapCut-Paket (Video ohne Text, Text-Ebene, Cover)', render_qa: 'Fehlende Wörter prüfen (whisper.cpp, lokal)' };
const active = (j: VideoJob) => j.status === 'queued' || j.status === 'running';

/** Background jobs of the video worker: status via polling, cancel in the UI (same API as n8n/scripts). */
export function VideoJobs() {
  const jobs = useApi<VideoJobList>('/api/video-jobs');
  const [seconds, setSeconds] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = jobs.data?.jobs ?? [];
  const polling = list.some(active);
  const { reload } = jobs;

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [polling, reload]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mb-4" data-testid="video-jobs">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-lg font-bold">Hintergrund-Jobs</h2>
        {jobs.data ? <span className="text-xs text-muted">{jobs.data.worker.running} läuft · {jobs.data.worker.queued} wartet · max. {jobs.data.worker.concurrency} gleichzeitig</span> : null}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="vj-seconds" className="text-muted">Worker-Test:</label>
        <select id="vj-seconds" className="field w-auto" value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
          <option value={10}>10 s Testbild</option>
          <option value={60}>1 min Testbild</option>
          <option value={600}>10 min Testbild</option>
        </select>
        <Button size="sm" busy={busy} onClick={() => void run(() => api('/api/video-jobs/selftest', { method: 'POST', json: { seconds } }))}>Test starten</Button>
        <span className="hint">FFmpeg kodiert ein Testbild in 1080×1920 und löscht es danach. Kein KI-Aufruf, keine Kosten.</span>
      </div>
      <ErrorNote error={error ?? jobs.error} />
      {list.length ? (
        <ul className="grid gap-2 text-xs">
          {list.map((j) => (
            <li key={j.id} className="rounded-xl border border-line p-3" data-testid="video-job">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{KIND_LABEL[j.kind]}</strong>
                <Pill tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Pill>
                <span className="text-muted">{fmtDateTime(j.createdAt)}</span>
                {active(j) ? <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void run(() => api(`/api/video-jobs/${j.id}/cancel`, { method: 'POST' }))}>Abbrechen</Button> : null}
              </div>
              {j.status === 'running' ? (
                <div className="mt-2 grid gap-1">
                  <div className="h-2 overflow-hidden rounded bg-card2" role="progressbar" aria-label="Fortschritt" aria-valuenow={j.progress == null ? undefined : Math.round(j.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full bg-lime transition-[width]" style={{ width: `${Math.round((j.progress ?? 0) * 100)}%` }} />
                  </div>
                  {j.progressNote ? <span className="text-muted">{j.progressNote}</span> : null}
                </div>
              ) : null}
              {j.error && j.status !== 'cancelled' ? <p className="mt-1 text-danger">{j.error}</p> : null}
              {j.status === 'succeeded' && j.kind === 'selftest' && j.result ? <p className="mt-1 text-muted">{describeSelftest(j.result)}</p> : null}
            </li>
          ))}
        </ul>
      ) : <Empty>Noch keine Jobs.</Empty>}
    </section>
  );
}

function describeSelftest(r: unknown) {
  const x = r as { seconds?: number; bytes?: number; encodeMs?: number };
  if (typeof x.seconds !== 'number' || typeof x.bytes !== 'number' || typeof x.encodeMs !== 'number') return null;
  return `${x.seconds} s in ${(x.encodeMs / 1000).toFixed(1)} s kodiert (${(x.bytes / 1024 ** 2).toFixed(1)} MB, danach gelöscht).`;
}
