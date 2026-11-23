'use client';
import { useRef, useState } from 'react';
import { DIMENSION_LABELS, RatingDimensions } from '@studio/core/schemas';
import { splitList } from '@studio/core/text';
import { api } from '@/lib/api';
import { extractPalette } from '@/lib/imagePalette';
import type { ReferenceWithAnalysis } from '@/lib/types';
import { useToast } from '../toast';
import { AdoptButton, AdoptColor } from '../brand/Adopt';
import { Button, Empty, ErrorNote, Field, Pill, RatingScale, Swatches } from '../ui';

const MAX = 60 * 1024 * 1024;
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];
const STATUS: Record<string, { label: string; tone: 'default' | 'warn' | 'ok' }> = {
  uploaded: { label: 'neu', tone: 'default' },
  analyzed: { label: 'analysiert', tone: 'default' },
  review_required: { label: 'Review offen', tone: 'warn' },
  reviewed: { label: 'geprüft', tone: 'ok' },
};

export function ReferenceLibrary({ refs, loading, reload, onReview }: { refs: ReferenceWithAnalysis[]; loading: boolean; reload: () => Promise<void>; onReview: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  async function ingest(files: File[]) {
    let n = 0;
    for (const file of files) {
      if (!ACCEPT.includes(file.type)) { toast(`Übersprungen: ${file.name} (Typ nicht unterstützt)`); continue; }
      if (file.size > MAX) { toast(`Übersprungen: ${file.name} (über 60 MB)`); continue; }
      setUploading(file.name);
      try {
        const fd = new FormData();
        fd.set('file', file);
        fd.set('palette', JSON.stringify(await extractPalette(file)));
        const res = await api<{ duplicate: boolean }>('/api/references', { method: 'POST', body: fd });
        if (res.duplicate) toast(`${file.name} ist bereits in der Bibliothek.`);
        else n++;
      } catch (e) {
        toast(`Fehler bei ${file.name}: ${(e as Error).message}`);
      }
    }
    setUploading(null);
    await reload();
    if (n) toast(`${n} Referenz${n === 1 ? '' : 'en'} gespeichert.`);
  }

  async function analyze(id: string) {
    setAnalyzing(id);
    try {
      const r = await api<{ observations: unknown[]; mock: boolean }>(`/api/references/${id}/analyze`, { method: 'POST' });
      toast(`${r.observations.length} Vorschläge${r.mock ? ' (Mock)' : ''} – bitte prüfen.`);
      await reload();
    } catch (e) {
      toast(`Analyse fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setAnalyzing(null);
    }
  }

  const shown = filter ? refs.filter((r) => [r.name, ...r.tags, ...r.likes].join(' ').toLowerCase().includes(filter.toLowerCase())) : refs;
  const current = refs.find((r) => r.id === editing) ?? null;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label="Referenzdateien hochladen"
        data-testid="dropzone"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void ingest([...e.dataTransfer.files]); }}
        className={`mb-10 flex cursor-pointer items-center gap-4 rounded-xl border border-dashed p-6 transition ${drag ? 'border-accent bg-[#eef6dc]' : 'border-[#a9c46e] bg-[#f5f7f0] hover:bg-[#eef6dc]'}`}
      >
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-[#e6f1cc] text-3xl text-accent">+</div>
        <div>
          <strong className="text-[15px]">{uploading ? `Lade hoch: ${uploading} …` : 'Bilder und Videos hier ablegen'}</strong>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[#5b6450]">oder klicken, um Dateien auszuwählen · PNG, JPEG, WEBP, GIF, MP4, WEBM, MOV (max. 60 MB je Datei). Bildfarben werden lokal im Browser berechnet.</p>
        </div>
        <input ref={input} type="file" multiple hidden accept={ACCEPT.join(',')} data-testid="file-input" onChange={(e) => { void ingest([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-xl font-bold">Reference Library</h2>
        <div className="flex items-center gap-2">
          <input className="field w-56" placeholder="Filtern nach Name, Tag, Merkmal" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Referenzen filtern" />
          <Pill>{refs.length} gespeicherte Referenzen</Pill>
        </div>
      </div>

      {current ? <ReferenceEditor key={current.id} reference={current} onClose={() => setEditing(null)} reload={reload} /> : null}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
        {loading && !refs.length ? <Empty>Lade …</Empty> : null}
        {!loading && !shown.length ? <Empty>{refs.length ? 'Kein Treffer für den Filter.' : 'Noch keine Referenzen. Lade Bilder, Designposter, Fotos oder Videos hoch und markiere, was du magst.'}</Empty> : null}
        {shown.map((r) => {
          const pending = r.observations.filter((o) => o.decision === 'pending').length;
          const st = STATUS[r.status] ?? STATUS.uploaded!;
          return (
            <article key={r.id} className="min-w-0 overflow-hidden rounded-xl border border-line bg-card" data-testid="reference-card">
              <div className="grid aspect-[4/3] place-items-center overflow-hidden bg-[#eceee4]">
                {r.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated local media route
                  <img src={`/api/media/${r.id}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <video src={`/api/media/${r.id}`} muted playsInline preload="metadata" controls className="h-full w-full object-cover" />
                )}
              </div>
              <div className="p-3">
                <div className="mb-1.5 truncate text-xs font-bold" title={r.name}>{r.name}</div>
                <div className="mb-2 flex flex-wrap gap-1"><Pill tone={st.tone}>{st.label}</Pill>{r.kind === 'video' ? <Pill>Video</Pill> : null}</div>
                <div className="min-h-[30px] text-[10px] leading-normal text-muted">{r.notes?.slice(0, 55) || r.likes.slice(0, 3).join(' · ') || 'Noch nicht bewertet'}</div>
                <div className="my-2"><Swatches colors={r.palette} /></div>
                <div className="grid gap-1.5">
                  <Button size="sm" onClick={() => setEditing(r.id)}>Bewerten ↗</Button>
                  <Button size="sm" variant="ghost" busy={analyzing === r.id} onClick={() => analyze(r.id)}>✳ {r.analysis ? 'Neu analysieren' : 'KI-Analyse'}</Button>
                  {pending ? <Button size="sm" variant="primary" onClick={onReview}>{pending} Vorschläge prüfen</Button> : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function ReferenceEditor({ reference: r, onClose, reload }: { reference: ReferenceWithAnalysis; onClose: () => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const [notes, setNotes] = useState(r.notes);
  const [source, setSource] = useState(r.source);
  const [likes, setLikes] = useState(r.likes.join(', '));
  const [dislikes, setDislikes] = useState(r.dislikes.join(', '));
  const [tags, setTags] = useState(r.tags.join(', '));
  const [ratings, setRatings] = useState<Record<string, number>>(r.ratings as Record<string, number>);
  // Etappe 16: may this image appear IN her videos? (absent = only inspiration)
  const [usage, setUsage] = useState<'' | 'own' | 'licensed' | 'generated'>(r.usage?.origin ?? '');
  const [usageSource, setUsageSource] = useState(r.usage?.source ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    try {
      const usageJson = r.kind === 'image' ? { usage: usage ? { origin: usage, source: usageSource.trim() } : null } : {};
      await api(`/api/references/${r.id}`, { method: 'PATCH', json: { notes: notes.trim(), source: source.trim(), likes: splitList(likes), dislikes: splitList(dislikes), tags: splitList(tags), ratings, ...usageJson } });
      await reload();
      toast('Bewertung gespeichert.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirm(`Referenz „${r.name}“ und die gespeicherte Mediendatei löschen?`)) return;
    try {
      await api(`/api/references/${r.id}`, { method: 'DELETE' });
      onClose();
      await reload();
      toast('Referenz gelöscht.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="panel mb-6" aria-label="Referenz bewerten" data-testid="reference-editor">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="m-0 text-base font-bold">Referenz bewerten</h3>
        <Button size="sm" onClick={onClose}>Schließen ×</Button>
      </div>
      <p className="hint">{r.name}</p>
      <div className="grid gap-x-6 lg:grid-cols-2">
        <div>
          <Field label="Was gefällt dir oder was möchtest du NICHT übernehmen?" htmlFor="refNotes">
            <textarea id="refNotes" rows={3} className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="z. B. der mutige Typo-Kontrast, aber nicht die grellen Übergänge" />
          </Field>
          <Field label="Quelle / Credit (optional)" htmlFor="refSource">
            <input id="refSource" className="field" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Link oder Urheber:in" />
          </Field>
          {r.kind === 'image' ? (
            <div className="mb-3 rounded-lg border border-line p-2" data-testid="reference-usage">
              <Field label="Im Video einblenden?" htmlFor="refUsage">
                <select id="refUsage" className="field" value={usage} onChange={(e) => setUsage(e.target.value as typeof usage)}>
                  <option value="">Nein – nur Inspiration</option>
                  <option value="own">Ja: mein eigenes Foto/Bild</option>
                  <option value="licensed">Ja: lizenziert (Quelle nötig)</option>
                  <option value="generated">Ja: KI-generiert (wird im Video gekennzeichnet)</option>
                </select>
              </Field>
              {usage === 'licensed' || usage === 'generated' ? (
                <Field label={usage === 'licensed' ? 'Lizenz / Quelle (Pflicht)' : 'Werkzeug / Herkunft (optional)'} htmlFor="refUsageSource">
                  <input id="refUsageSource" className="field" value={usageSource} onChange={(e) => setUsageSource(e.target.value)} placeholder={usage === 'licensed' ? 'z. B. Lizenz, Link, Fotograf:in' : 'z. B. Bildgenerator, Datum'} />
                </Field>
              ) : null}
              <p className="hint m-0">Fremde Referenzen bleiben Inspiration. Nur eigene oder lizenzierte Bilder (mit Quelle) lassen sich im Editor einblenden; KI-generierte bekommen das KI-Label.</p>
            </div>
          ) : null}
          <Field label="Mag ich · Merkmale (kommagetrennt)" htmlFor="refLikes">
            <input id="refLikes" className="field" value={likes} onChange={(e) => setLikes(e.target.value)} placeholder="Editorial Typo, warme Schatten, Makroaufnahmen" />
          </Field>
          <Field label="Mag ich nicht · Anti-Patterns" htmlFor="refDislikes">
            <input id="refDislikes" className="field" value={dislikes} onChange={(e) => setDislikes(e.target.value)} placeholder="überladene Untertitel, harte Neonfilter" />
          </Field>
          <Field label="Tags" htmlFor="refTags">
            <input id="refTags" className="field" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="poster, film still, knitwear" />
          </Field>
        </div>
        <div>
          <span className="label">Manuelle Stilbewertung (1 = passt nicht zu mir · 5 = genau mein Stil)</span>
          <div className="grid gap-2">
            {RatingDimensions.map((d) => (
              <div key={d} className="flex items-center justify-between gap-3">
                <span className="text-xs text-[#343b2d]">{DIMENSION_LABELS[d]}</span>
                <RatingScale label={`Bewertung ${DIMENSION_LABELS[d]}`} itemLabel={DIMENSION_LABELS[d]} value={ratings[d] ?? null} onChange={(n) => setRatings((cur) => {
                  const next = { ...cur };
                  if (n == null) delete next[d];
                  else next[d] = n;
                  return next;
                })} />
              </div>
            ))}
          </div>
          {r.palette.length ? (<><span className="label">Technische Farbstichprobe</span><Swatches colors={r.palette} size={28} /></>) : null}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="reference-adopt">
            <span className="text-muted">Ins Design System:</span>
            {r.palette.map((c) => <AdoptColor key={c} hex={c} referenceId={r.id} />)}
            {r.kind === 'image' ? <AdoptButton label="→ Bildlook" testId="adopt-reference" json={{ kind: 'reference', referenceId: r.id }} /> : null}
          </div>
        </div>
      </div>
      <ErrorNote error={error} />
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="primary" busy={busy} onClick={save}>Merkmale speichern</Button>
        <Button variant="danger" onClick={remove}>Referenz löschen</Button>
      </div>
    </section>
  );
}
