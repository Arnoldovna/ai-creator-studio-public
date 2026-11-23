'use client';
import { useState } from 'react';
import { DIMENSION_LABELS, HEX, ObservationDimension } from '@studio/core/schemas';
import { api } from '@/lib/api';
import type { Observation, ReferenceWithAnalysis } from '@/lib/types';
import { useToast } from '../toast';
import { AdoptButton, AdoptColor } from '../brand/Adopt';
import { Button, Empty, MockBadge, Pill, Swatches } from '../ui';


export function ReviewQueue({ refs, reload }: { refs: ReferenceWithAnalysis[]; reload: () => Promise<void> }) {
  const [onlyPending, setOnlyPending] = useState(true);
  const analyzed = refs.filter((r) => r.analysis && (!onlyPending || r.observations.some((o) => o.decision === 'pending')));
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="hint m-0 max-w-2xl">
          Nur von dir bestätigte KI-Beobachtungen fließen in die Style Bible. Du kannst jede Beobachtung umformulieren, auch bestätigte – das KI-Original bleibt gespeichert.
          „observed“ = direkt sichtbar, „interpreted“ = Deutung. Abgelehnte Vorschläge und deine Kommentare bleiben als Feedback gespeichert.
        </p>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> nur offene Vorschläge
        </label>
      </div>
      {!analyzed.length ? (
        <Empty>{onlyPending ? 'Keine offenen Vorschläge. Starte in der Bibliothek eine „KI-Analyse“ für eine Referenz.' : 'Noch keine Analysen vorhanden.'}</Empty>
      ) : null}
      <div className="grid gap-5">
        {analyzed.map((r) => <AnalysisCard key={r.id} r={r} onlyPending={onlyPending} reload={reload} />)}
      </div>
    </>
  );
}

function AnalysisCard({ r, onlyPending, reload }: { r: ReferenceWithAnalysis; onlyPending: boolean; reload: () => Promise<void> }) {
  const a = r.analysis!;
  const obs = r.observations.filter((o) => !onlyPending || o.decision === 'pending');
  const mock = a.provider === 'mock';
  return (
    <section className="panel" data-testid="analysis-card">
      <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
        <div>
          <div className="overflow-hidden rounded-xl bg-[#eceee4]">
            {r.kind === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element -- authenticated local media route
              <img src={`/api/media/${r.id}`} alt="" className="w-full object-cover" />
            ) : (
              <video src={`/api/media/${r.id}`} muted controls className="w-full" />
            )}
          </div>
          {r.keyframes.length ? (
            <div className="mt-2 grid grid-cols-3 gap-1" aria-label="Keyframes">
              {r.keyframes.map((k) => (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated local media route
                <img key={k.id} src={`/api/media/${k.id}`} alt={`Keyframe ${k.timestampSec}s`} title={`${k.timestampSec}s`} className="aspect-video w-full rounded object-cover" />
              ))}
            </div>
          ) : null}
          <p className="mt-2 truncate text-xs font-bold">{r.name}</p>
          <div className="mt-1 flex flex-wrap gap-1"><MockBadge mock={mock} /><Pill>{a.model}</Pill></div>
          <p className="mt-1 text-[10px] text-muted">{a.promptVersion}</p>
        </div>
        <div className="min-w-0">
          <p className="mb-3 text-sm leading-relaxed">{a.analysis.summary}</p>
          <dl className="mb-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[110px_1fr]">
            <dt className="text-muted">Farbcharakter</dt>
            <dd className="flex flex-wrap items-center gap-2">{a.analysis.colorCharacter.description} <Swatches colors={a.analysis.colorCharacter.dominantColors} size={16} /></dd>
            <dt className="text-muted">Typografie</dt><dd>{a.analysis.typography.visible ? a.analysis.typography.description : 'nicht sichtbar'}</dd>
            <dt className="text-muted">Komposition</dt><dd>{a.analysis.composition}</dd>
            <dt className="text-muted">Licht</dt><dd>{a.analysis.lighting}</dd>
            <dt className="text-muted">Texturen</dt><dd>{a.analysis.textures}</dd>
            <dt className="text-muted">Ästhetik</dt><dd>{a.analysis.aesthetic.join(' · ') || '—'}</dd>
          </dl>
          {a.analysis.uncertainties.length ? (
            <div className="note"><strong>Unsicherheiten:</strong> {a.analysis.uncertainties.join(' · ')}</div>
          ) : null}
          <h3 className="mt-5 mb-2 text-sm font-bold">Vorschläge ({obs.length})</h3>
          <ul className="grid gap-2">
            {obs.map((o) => <ObservationRow key={o.id} o={o} reload={reload} />)}
          </ul>
        </div>
      </div>
    </section>
  );
}

const DIMENSIONS = ObservationDimension.options;
const colorsText = (colors: string[]) => colors.join(', ');
const parseColors = (text: string) => text.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);

function ObservationRow({ o, reload }: { o: Observation; reload: () => Promise<void> }) {
  const toast = useToast();
  const [feedback, setFeedback] = useState(o.feedback);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(o.statement);
  const [dimension, setDimension] = useState(o.dimension);
  const [colors, setColors] = useState(colorsText(o.colors));
  async function patch(json: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/api/observations/${o.id}`, { method: 'PATCH', json });
      await reload();
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const decide = (decision: Observation['decision']) => patch({ decision, feedback });
  const saveEdit = async () => {
    const list = parseColors(colors);
    if (list.some((c) => !HEX.test(c))) return toast('Farben im Format #RRGGBB, durch Komma getrennt.');
    if (!statement.trim()) return toast('Die Beobachtung darf nicht leer sein.');
    if (await patch({ statement: statement.trim(), dimension, colors: list })) setEditing(false);
  };
  const cancelEdit = () => {
    setStatement(o.statement);
    setDimension(o.dimension);
    setColors(colorsText(o.colors));
    setEditing(false);
  };
  const tone = o.decision === 'approved' ? 'ok' : o.decision === 'rejected' ? 'danger' : 'warn';
  return (
    <li className="rounded-xl border border-[#dde2d2] bg-[#f5f7f0] p-3" data-testid="observation">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Pill>{DIMENSION_LABELS[o.dimension as keyof typeof DIMENSION_LABELS] ?? o.dimension}</Pill>
        <Pill tone={o.kind === 'observed' ? 'ok' : 'default'}>{o.kind}</Pill>
        <Pill tone={tone}>{o.decision === 'pending' ? 'offen' : o.decision === 'approved' ? 'bestätigt' : 'abgelehnt'}</Pill>
        {o.original ? <Pill>von dir bearbeitet</Pill> : null}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted" title="Konfidenz laut Analyst">
          <span className="h-1.5 w-16 overflow-hidden rounded bg-line"><span className="block h-full bg-accent-dark" style={{ width: `${Math.round(o.confidence * 100)}%` }} /></span>
          {Math.round(o.confidence * 100)} %
        </span>
      </div>
      {editing ? (
        <div className="my-2 grid gap-2" data-testid="observation-edit">
          <textarea aria-label="Beobachtung" rows={2} maxLength={1000} className="field" value={statement} onChange={(e) => setStatement(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <select aria-label="Dimension" className="field max-w-[180px] py-1.5" value={dimension} onChange={(e) => setDimension(e.target.value)}>
              {DIMENSIONS.map((d) => <option key={d} value={d}>{DIMENSION_LABELS[d]}</option>)}
            </select>
            <input aria-label="Farben (#RRGGBB, durch Komma getrennt)" className="field max-w-xs flex-1 py-1.5 font-mono" placeholder="#D8FB96, #111411" value={colors} onChange={(e) => setColors(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" busy={busy} onClick={saveEdit}>Änderung speichern</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={cancelEdit}>Abbrechen</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="my-1 text-[13px] leading-relaxed">{o.statement}</p>
          <p className="m-0 text-[11px] text-muted">Evidenz: {o.evidence}</p>
          {o.colors.length ? <div className="mt-1"><Swatches colors={o.colors} size={14} /></div> : null}
        </>
      )}
      {o.decision === 'approved' && !editing ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="observation-adopt">
          <span className="text-muted">Ins Design System:</span>
          {o.colors.map((c) => <AdoptColor key={c} hex={c} observationId={o.id} />)}
          <AdoptButton label="→ Leitlinie" testId="adopt-guideline" json={{ kind: 'observation', observationId: o.id, target: 'guideline' }} />
          <AdoptButton label="→ Bildlook" testId="adopt-imagery" json={{ kind: 'observation', observationId: o.id, target: 'imagery' }} />
        </div>
      ) : null}
      {o.original ? (
        <details className="mt-1 text-[11px] text-muted" data-testid="observation-original">
          <summary className="cursor-pointer">KI-Original</summary>
          <p className="m-0">{DIMENSION_LABELS[o.original.dimension as keyof typeof DIMENSION_LABELS] ?? o.original.dimension}: {o.original.statement}</p>
          {o.original.colors.length ? <Swatches colors={o.original.colors} size={12} /> : null}
        </details>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className="field max-w-md flex-1 py-1.5" placeholder="Kommentar (optional)" value={feedback} onChange={(e) => setFeedback(e.target.value)} aria-label="Kommentar zur Beobachtung" />
        <Button size="sm" variant="primary" busy={busy} onClick={() => decide('approved')}>Bestätigen</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => decide('rejected')}>Ablehnen</Button>
        {o.decision !== 'pending' ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide('pending')}>Zurücksetzen</Button> : null}
        {!editing ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Bearbeiten</Button> : null}
      </div>
    </li>
  );
}
