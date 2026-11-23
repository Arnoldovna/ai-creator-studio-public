'use client';
import { useState } from 'react';
import { splitLines, splitList } from '@studio/core/text';
import { api, useApi } from '@/lib/api';
import type { Project, ProjectView } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, PageHeader, Pill } from '../ui';

const blank = { title: '', kind: 'UGC_CLIENT' as Project['kind'], description: '', clientName: '', product: '', briefing: '', claims: '', deliverables: '', brandNotes: '' };
type FormState = typeof blank;

const toForm = (p: Project): FormState => ({
  title: p.title, kind: p.kind, description: p.description, clientName: p.client?.clientName ?? '', product: p.client?.product ?? '',
  briefing: p.client?.briefing ?? '', claims: p.client?.productClaims.join('\n') ?? '', deliverables: p.client?.deliverables.join('\n') ?? '', brandNotes: p.client?.brandNotes ?? '',
});
const toPayload = (f: FormState) => ({
  title: f.title, kind: f.kind, description: f.description,
  client: f.kind === 'UGC_CLIENT' ? { clientName: f.clientName, product: f.product, briefing: f.briefing, productClaims: splitLines(f.claims, 40), deliverables: splitList(f.deliverables, 40), brandNotes: f.brandNotes } : null,
});

export function Projects() {
  const toast = useToast();
  const { data, error, reload } = useApi<ProjectView[]>('/api/projects');
  const [form, setForm] = useState<FormState>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const kindLocked = !!editing && !!data?.find((p) => p.id === editing)?.kindLocked;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (editing) await api(`/api/projects/${editing}`, { method: 'PATCH', json: toPayload(form) });
      else await api('/api/projects', { method: 'POST', json: toPayload(form) });
      toast(editing ? 'Projekt aktualisiert.' : 'Projekt angelegt.');
      setForm(blank); setEditing(null);
      await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function remove(p: Project) {
    if (!confirm(`Projekt „${p.title}“ inkl. Briefings, Konzepten, Skripten, Analytics und Selbstchecks löschen?`)) return;
    try { await api(`/api/projects/${p.id}`, { method: 'DELETE' }); await reload(); toast('Projekt gelöscht.'); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="appear">
      <PageHeader eyebrow="06 / UGC PROJECTS" title="Projekte & Kunden." accent="Mit klaren Claims." lead="Zwei Projekttypen: PERSONAL_CONTENT für deinen eigenen Kanal und UGC_CLIENT mit Kundenbriefing, freigegebenen Produktclaims und Deliverables. Eigene Brand-Styles pro Kunde, Revisionsrunden und Lieferungen folgen in Release 5." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="panel self-start">
          <h2 className="mb-1 text-lg font-bold">{editing ? 'Projekt bearbeiten' : 'Neues Projekt'}</h2>
          <Field label="Titel" htmlFor="pTitle"><input id="pTitle" className="field" value={form.title} onChange={set('title')} placeholder="z. B. Kunde X · Herbstkampagne" /></Field>
          <Field label="Typ" htmlFor="pKind" hint={kindLocked ? 'Typ fest: Das Projekt hat schon Briefings, Konzepte, Skripte oder Schnittpläne. Für den anderen Typ ein neues Projekt anlegen.' : undefined}><select id="pKind" className="field" value={form.kind} onChange={set('kind')} disabled={kindLocked}><option value="UGC_CLIENT">UGC_CLIENT</option><option value="PERSONAL_CONTENT">PERSONAL_CONTENT</option></select></Field>
          <Field label="Beschreibung" htmlFor="pDesc"><textarea id="pDesc" rows={2} className="field" value={form.description} onChange={set('description')} /></Field>
          {form.kind === 'UGC_CLIENT' ? (
            <>
              <div className="grid gap-x-3 sm:grid-cols-2">
                <Field label="Kunde" htmlFor="pClient"><input id="pClient" className="field" value={form.clientName} onChange={set('clientName')} /></Field>
                <Field label="Produkt" htmlFor="pProduct"><input id="pProduct" className="field" value={form.product} onChange={set('product')} /></Field>
              </div>
              <Field label="Kundenbriefing" htmlFor="pBrief"><textarea id="pBrief" rows={3} className="field" value={form.briefing} onChange={set('briefing')} /></Field>
              <Field label="Freigegebene Produktclaims (einer pro Zeile)" htmlFor="pClaims" hint="Nur diese Aussagen darf der UGC Scriptwriter als Produktclaims verwenden."><textarea id="pClaims" rows={3} className="field" value={form.claims} onChange={set('claims')} /></Field>
              <Field label="Deliverables (kommagetrennt)" htmlFor="pDeliv"><input id="pDeliv" className="field" value={form.deliverables} onChange={set('deliverables')} placeholder="2× Reel 30s, 1× Hook-Variante, Rohmaterial" /></Field>
              <Field label="Brand-Hinweise" htmlFor="pBrand"><textarea id="pBrand" rows={2} className="field" value={form.brandNotes} onChange={set('brandNotes')} /></Field>
            </>
          ) : null}
          <ErrorNote error={err ?? error} />
          <div className="mt-5 flex gap-2">
            <Button variant="primary" busy={busy} onClick={save}>{editing ? 'Speichern' : 'Projekt anlegen'}</Button>
            {editing ? <Button onClick={() => { setEditing(null); setForm(blank); }}>Abbrechen</Button> : null}
          </div>
        </section>
        <div className="grid content-start gap-3">
          {!data?.length ? <Empty>Noch keine Projekte.</Empty> : null}
          {data?.map((p) => (
            <article key={p.id} className="rounded-xl border border-line bg-card p-5" data-testid="project-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 text-base font-bold">{p.title}</h3>
                <Pill tone={p.kind === 'UGC_CLIENT' ? 'warn' : 'ok'}>{p.kind}</Pill>
              </div>
              {p.description ? <p className="hint mt-2">{p.description}</p> : null}
              {p.client ? (
                <dl className="mt-2 grid grid-cols-[110px_1fr] gap-y-1 text-xs">
                  <dt className="text-muted">Kunde</dt><dd>{p.client.clientName || '—'} · {p.client.product || '—'}</dd>
                  <dt className="text-muted">Claims</dt><dd>{p.client.productClaims.length ? p.client.productClaims.join(' · ') : <span className="text-warn">keine freigegebenen Claims</span>}</dd>
                  <dt className="text-muted">Deliverables</dt><dd>{p.client.deliverables.join(' · ') || '—'}</dd>
                </dl>
              ) : null}
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => { setEditing(p.id); setForm(toForm(p)); }}>Bearbeiten</Button>
                <Button size="sm" variant="danger" onClick={() => remove(p)}>Löschen</Button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
