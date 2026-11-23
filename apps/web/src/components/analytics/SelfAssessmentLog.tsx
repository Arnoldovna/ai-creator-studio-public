'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { Project, SelfAssessmentList } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, Pill, RatingScale } from '../ui';

const KIND_LABEL = { publication: 'Veröffentlichungen', edit_plan: 'Schnittpläne', render: 'Renders' } as const;
const EMPTY = { subject: 'session', projectId: '', pillarId: '', joy: null as number | null, comfort: null as number | null, offCamera: true, finished: '', note: '' };

/**
 * Quick self-check: how much joy, how comfortable on camera, finished or not. Also for sessions without a video.
 * The note stays in the private file on this machine. Nothing here changes a strategy, style or voice version.
 */
export function SelfAssessmentLog({ data, projects, reload }: { data: SelfAssessmentList | null; projects: Project[]; reload: () => Promise<unknown> }) {
  const toast = useToast();
  const [f, setF] = useState(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const subject = f.subject === 'session' ? null : (data?.subjects.find((s) => `${s.kind}:${s.id}` === f.subject) ?? null);
  const pillarName = (id: string | null) => (id ? (data?.pillars.find((p) => p.id === id)?.name ?? id) : null);
  const projectTitle = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.title ?? null) : null);
  // client work carries none of her pillars; a piece with a pillar of its own shows it read only
  const isClient = subject ? subject.client : projects.find((p) => p.id === f.projectId)?.kind === 'UGC_CLIENT';
  const pillarPick = !isClient && !subject?.pinned;

  async function save() {
    if (f.joy == null) { setErr('Bitte Freude 1–5 wählen.'); return; }
    if (subject && f.finished === '') { setErr('Bitte angeben, ob es fertig ist.'); return; }
    setBusy('save'); setErr(null);
    try {
      await api('/api/self-assessments', {
        method: 'POST',
        json: {
          projectId: subject ? subject.projectId : f.projectId || null,
          subject: subject ? { kind: subject.kind, id: subject.id } : { kind: 'session' },
          pillarId: pillarPick ? f.pillarId || null : null, joy: f.joy, cameraComfort: f.offCamera ? null : f.comfort,
          finished: subject ? f.finished === 'ja' : null, note: f.note,
        },
      });
      setF(EMPTY);
      await reload();
      toast('Selbstcheck gespeichert.');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function del(id: string) {
    if (!confirm('Eintrag samt Notiz löschen?')) return;
    setBusy(id);
    try { await api(`/api/self-assessments/${id}`, { method: 'DELETE' }); await reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="panel" data-testid="self-assessment">
      <h2 className="mb-1 text-lg font-bold">Selbstcheck</h2>
      <p className="hint">Wie war es für dich? Kurz festhalten, auch ohne Video. Nur für dich, ohne Bewertung.</p>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Wofür?" htmlFor="saSubject">
          <select id="saSubject" className="field" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value, finished: '' })}>
            <option value="session">Session ohne Video</option>
            {(['publication', 'edit_plan', 'render'] as const).map((k) => {
              const items = data?.subjects.filter((s) => s.kind === k) ?? [];
              return items.length ? (
                <optgroup key={k} label={KIND_LABEL[k]}>
                  {items.map((s) => <option key={s.id} value={`${s.kind}:${s.id}`}>{s.label}</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
        </Field>
        {subject ? (
          <Field label="Projekt" htmlFor="saProject"><input id="saProject" className="field" readOnly value={projectTitle(subject.projectId) ?? '—'} /></Field>
        ) : (
          <Field label="Projekt (optional)" htmlFor="saProject">
            <select id="saProject" className="field" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
              <option value="">– ohne Projekt –</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </Field>
        )}
        {isClient ? (
          <Field label="Säule" htmlFor="saPillar" hint="Kundenprojekte haben keine Säule.">
            <input id="saPillar" className="field" readOnly value="—" />
          </Field>
        ) : subject?.pinned ? (
          <Field label="Säule" htmlFor="saPillar" hint="Kommt aus dem Stück.">
            <input id="saPillar" className="field" readOnly value={pillarName(subject.pillarId) ?? 'ohne Säule'} />
          </Field>
        ) : (
          <Field label="Säule (optional)" htmlFor="saPillar">
            <select id="saPillar" className="field" value={f.pillarId} onChange={(e) => setF({ ...f, pillarId: e.target.value })}>
              <option value="">– keine Angabe –</option>
              {data?.pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {subject ? (
          <Field label="Fertig?" htmlFor="saFinished">
            <select id="saFinished" className="field" value={f.finished} onChange={(e) => setF({ ...f, finished: e.target.value })}>
              <option value="">– bitte wählen –</option>
              <option value="ja">ja</option>
              <option value="nein">nein</option>
            </select>
          </Field>
        ) : <div />}
        <div className="mt-3">
          <span className="label">Freude</span>
          <RatingScale label="Freude" itemLabel="Freude" value={f.joy} onChange={(n) => setF({ ...f, joy: n })} />
        </div>
        <div className="mt-3">
          <span className="label">Sicherheit vor der Kamera</span>
          <RatingScale label="Sicherheit vor der Kamera" itemLabel="Sicherheit" value={f.offCamera ? null : f.comfort} onChange={(n) => setF({ ...f, comfort: n, offCamera: n == null })} />
          <label className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
            <input type="checkbox" checked={f.offCamera} onChange={(e) => setF({ ...f, offCamera: e.target.checked, comfort: e.target.checked ? null : f.comfort })} /> nicht vor der Kamera
          </label>
        </div>
      </div>
      <Field label="Notiz (optional)" htmlFor="saNote" hint="Gespeichert im Studio (im Backup-Export enthalten); geht an keine KI.">
        <textarea id="saNote" rows={2} className="field" value={f.note} maxLength={1000} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </Field>
      <Button variant="primary" className="mt-4" busy={busy === 'save'} onClick={save}>Selbstcheck speichern</Button>
      <ErrorNote error={err} />

      <div className="mt-6 mb-2 flex items-center justify-between"><h3 className="m-0 text-sm font-bold">Einträge</h3><Pill>{data?.entries.length ?? 0}</Pill></div>
      {!data?.entries.length ? <Empty>Noch keine Einträge.</Empty> : null}
      <ul className="grid gap-2" aria-label="Selbstcheck-Einträge">
        {data?.entries.slice(0, 30).map((x) => (
          <li key={x.id} className="rounded-lg border border-line bg-card p-3 text-xs" data-testid="self-assessment-entry">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <b>{x.assessedAt.slice(0, 10)} · {x.subjectLabel}</b>
              <Button size="sm" variant="ghost" busy={busy === x.id} onClick={() => del(x.id)} aria-label="Eintrag löschen">×</Button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Pill>Freude {x.joy}/5</Pill>
              <Pill>{x.cameraComfort == null ? 'nicht vor der Kamera' : `Kamera ${x.cameraComfort}/5`}</Pill>
              {x.finished != null ? <Pill>{x.finished ? 'fertig' : 'nicht fertig'}</Pill> : null}
              {pillarName(x.pillarId) ? <Pill>Säule {pillarName(x.pillarId)}</Pill> : null}
              {projectTitle(x.projectId) ? <Pill>{projectTitle(x.projectId)}</Pill> : null}
            </div>
            {x.note ? <p className="m-0 mt-1.5 text-muted"><span className="sr-only">Notiz: </span>{x.note}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
