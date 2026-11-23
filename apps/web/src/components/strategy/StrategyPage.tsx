'use client';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { BUNDLE_KIND_LABEL, parseStrategyDocument, SEND_MODE_LABEL, type BundleKind, type SendMode } from '@studio/core/contextDoc';
import { PHASE_LABEL } from '@studio/core/strategy';
import { api, useApi } from '@/lib/api';
import type { ContextImportPreview, ContextOverview, ContextVersionView } from '@/lib/types';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, PageHeader, Pill } from '../ui';
import { ChatButton, useChatScope } from '../chat/ChatProvider';
import { MarkdownView } from './MarkdownView';
import { SOURCE_LABEL, StatusChip } from './shared';

/**
 * Strategie-Seite (Etappe 11): Dateien ablegen oder Text einfügen → Vorschau → Übernehmen. Pro Dokument (Strategie,
 * Profil, jede Quelle) Lesen, Bearbeiten (ein Editor für das ganze Dokument) und Versionen. „Das liest die KI“ zeigt
 * den exakten Text, der an die Modelle geht. Keine Freigabe-Schritte: Übernehmen und Speichern machen aktiv.
 */

type Doc = ContextVersionView;
type DocTab = { id: string; label: string; kind: Doc['kind']; doc: Doc | null; sourceKey: string | null };
const SEND_MODES = Object.keys(SEND_MODE_LABEL) as SendMode[];
const BUNDLE_KINDS = Object.keys(BUNDLE_KIND_LABEL) as BundleKind[];

export function StrategyPage() {
  const ctx = useApi<ContextOverview>('/api/context');
  useChatScope({ scope: 'strategy', label: 'Strategie', onApplied: () => ctx.reload() });
  const [tab, setTab] = useState('strategy');
  const data = ctx.data;

  const tabs: DocTab[] = [
    { id: 'strategy', label: 'Strategie', kind: 'strategy', doc: data?.active.strategy ?? null, sourceKey: null },
    { id: 'profile', label: 'Profil', kind: 'profile', doc: data?.active.profile ?? null, sourceKey: null },
    ...(data?.sources ?? []).map((s) => ({ id: `source:${s.sourceKey}`, label: s.label, kind: 'source' as const, doc: s, sourceKey: s.sourceKey })),
  ];
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;

  return (
    <div className="appear">
      <PageHeader
        eyebrow="00 / STRATEGIE · ERST DIE RICHTUNG"
        title="Strategie zuerst."
        accent="Dann der Inhalt."
        lead="Deine Strategie (JSON), dein Profil (Markdown) und Quellen wie Interviews als ganze Dokumente. Ablegen, prüfen, übernehmen – danach sofort aktiv und vollständig für die KI lesbar. Jede Änderung legt eine neue Version an; frühere bleiben in der Historie."
        right={
          <div className="grid justify-items-end gap-3">
          <ChatButton />
          <div className="text-right" data-testid="phase">
            <div className="font-mono text-[10px] tracking-[0.08em] text-muted">PHASE (JETZT)</div>
            <div className="text-lg font-semibold">{PHASE_LABEL[data?.phase ?? 'private_trial']}</div>
            <div className="mt-2 font-mono text-[10px] tracking-[0.08em] text-muted">FERNZIEL</div>
            <div className="hint max-w-[240px]" data-testid="long-term-goal">{data?.longTermGoal || 'noch nicht festgelegt (Feld „longTermGoal“)'}</div>
          </div>
          </div>
        }
      />
      <ErrorNote error={ctx.error} />
      <ContextImport onApplied={() => void ctx.reload()} />
      <div role="tablist" aria-label="Dokumente" className="mt-8 mb-6 flex flex-wrap gap-2 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={current.id === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-[13px] font-semibold ${current.id === t.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}{t.doc?.kind === 'source' ? ` · ${SEND_MODE_LABEL[t.doc.document.sendMode]}` : ''}
          </button>
        ))}
      </div>
      {data ? (
        <DocumentPanel key={`${current.id}-${current.doc?.id ?? 'none'}`} tab={current} versions={data.versions} onChanged={() => void ctx.reload()} />
      ) : null}
      {data ? <AiTextPanel ai={data.ai} /> : null}
    </div>
  );
}

// ---------- Import ----------
type Choice = { kind?: BundleKind; sendMode?: SendMode; skip?: boolean };

function ContextImport({ onApplied }: { onApplied: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [preview, setPreview] = useState<ContextImportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const form = (next: Record<number, Choice>, list = files, pasted = text) => {
    const f = new FormData();
    for (const file of list) f.append('files', file, file.name);
    if (pasted.trim()) f.append('text', pasted);
    f.append('choices', JSON.stringify(Object.entries(next).map(([index, c]) => ({ index: Number(index), ...c }))));
    return f;
  };
  async function check(next = choices, list = files, pasted = text) {
    if (!list.length && !pasted.trim()) {
      setPreview(null);
      return;
    }
    setBusy('preview');
    setError(null);
    try {
      setPreview(await api<ContextImportPreview>('/api/context/import', { method: 'POST', body: form(next, list, pasted) }));
    } catch (e) {
      setPreview(null);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const next = [...files, ...Array.from(list)].slice(0, 10);
    setFiles(next);
    setChoices({});
    void check({}, next);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    addFiles(e.dataTransfer.files);
  }
  function choose(index: number, c: Choice) {
    const next = { ...choices, [index]: { ...choices[index], ...c } };
    setChoices(next);
    void check(next);
  }
  function reset() {
    setFiles([]);
    setText('');
    setChoices({});
    setPreview(null);
    setError(null);
    if (input.current) input.current.value = '';
  }
  async function apply() {
    setBusy('apply');
    setError(null);
    try {
      const r = await api<{ applied: { label: string; version: number; created: boolean }[] }>('/api/context/import/apply', { method: 'POST', body: form(choices) });
      const created = r.applied.filter((a) => a.created);
      toast(created.length ? `Aktiv: ${created.map((a) => `${a.label} v${a.version}`).join(', ')}` : 'Nichts geändert – alles war schon so aktiv.');
      reset();
      onApplied();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="import-title" data-testid="context-import">
      <h2 id="import-title" className="m-0 text-lg font-bold">Dokumente ablegen</h2>
      <p className="hint mt-1">Strategie als JSON, dazu optional das Strategie-Markdown, dein Profil als Markdown und Quellen (z. B. Interview-Transkripte). Mehrere Dateien auf einmal; nur .json, .md, .txt bis 512 KB. Erst kommt eine Vorschau, gespeichert wird beim Übernehmen.</p>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`mt-4 grid place-items-center rounded-xl border-2 border-dashed p-6 text-center text-sm ${over ? 'border-accent bg-[#f2f4ec]' : 'border-line'}`}
        data-testid="drop-zone"
      >
        <label className="cursor-pointer">
          <span className="font-semibold text-accent underline">Dateien wählen</span> oder hierher ziehen
          <input
            ref={input} type="file" multiple accept=".json,.md,.markdown,.txt,application/json,text/markdown,text/plain"
            className="sr-only" data-testid="context-files" onChange={(e) => addFiles(e.target.files)}
          />
        </label>
        {files.length ? <p className="hint mt-2">{files.map((f) => f.name).join(' · ')}</p> : null}
      </div>
      <label className="label" htmlFor="context-paste">Oder Text einfügen (JSON oder Markdown)</label>
      <textarea id="context-paste" className="field font-mono text-[12px]" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="{ … } oder # Überschrift …" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void check()} busy={busy === 'preview'} disabled={!files.length && !text.trim()}>Prüfen</Button>
        {files.length || text || preview ? <Button variant="ghost" onClick={reset}>Leeren</Button> : null}
      </div>
      <ErrorNote error={error} />
      {preview ? (
        <div className="mt-4 grid gap-3" data-testid="import-preview">
          {preview.items.map((i) => {
            const c = choices[i.index] ?? {};
            return (
              <div key={i.index} className="rounded-xl border border-line p-4 text-xs" data-testid="import-item">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-[13px]">{i.name}</strong>
                  <select aria-label={`Art von ${i.name}`} className="field max-w-[240px] py-1.5 text-xs" value={c.kind ?? i.kind} onChange={(e) => choose(i.index, { kind: e.target.value as BundleKind })}>
                    {BUNDLE_KINDS.map((k) => <option key={k} value={k}>{BUNDLE_KIND_LABEL[k]}</option>)}
                  </select>
                  {'sendMode' in i && i.sendMode ? (
                    <select aria-label={`Schalter für ${i.name}`} className="field max-w-[240px] py-1.5 text-xs" value={c.sendMode ?? i.sendMode} onChange={(e) => choose(i.index, { sendMode: e.target.value as SendMode })}>
                      {SEND_MODES.map((m) => <option key={m} value={m}>{SEND_MODE_LABEL[m]}</option>)}
                    </select>
                  ) : null}
                  {i.detectedBy !== 'choice' ? <span className="text-muted">erkannt am {i.detectedBy === 'name' ? 'Dateinamen' : i.detectedBy === 'header' ? 'Dateikopf' : 'Inhalt'}</span> : null}
                  {i.ok ? <Pill tone="ok">ok</Pill> : <Pill tone="danger">Problem</Pill>}
                </div>
                {'pillars' in i && i.pillars ? <p className="mt-2 text-muted">Säulen: {i.pillars.join(', ')} · Phase {PHASE_LABEL[i.phase ?? 'private_trial']}{i.longTermGoal ? ` · Fernziel: ${i.longTermGoal}` : ''}</p> : null}
                {i.issues.length ? (
                  <ul className="mt-2 grid gap-0.5">
                    {i.issues.map((x, n) => <li key={n} className={x.severity === 'error' ? 'text-danger' : 'text-warn'}>{x.path ? <code>{x.path}</code> : null} {x.message}</li>)}
                  </ul>
                ) : null}
                {i.changes.length ? <ul className="mt-2 grid gap-0.5 text-muted" data-testid="import-changes">{i.changes.map((x) => <li key={x}>→ {x}</li>)}</ul> : null}
              </div>
            );
          })}
          {Object.entries(choices).filter(([, c]) => c.skip).map(([index]) => (
            <p key={index} className="hint m-0">Ausgelassen: {files[Number(index)]?.name ?? 'eingefügter Text'} · <button type="button" className="underline" onClick={() => choose(Number(index), { skip: false })}>doch übernehmen</button></p>
          ))}
          {preview.items.length ? (
            <div className="flex flex-wrap gap-2 text-xs">
              {preview.items.map((i) => <Button key={i.index} size="sm" variant="ghost" onClick={() => choose(i.index, { skip: true })}>„{i.name}“ auslassen</Button>)}
            </div>
          ) : null}
          {preview.problems.map((p) => <p key={p} className="m-0 text-xs text-danger">{p}</p>)}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={apply} busy={busy === 'apply'} disabled={!preview.canApply}>Übernehmen</Button>
            <span className="hint">Übernehmen legt neue aktive Versionen an. Unveränderte Dokumente bleiben, wie sie sind.</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------- One document ----------
type Mode = 'read' | 'edit' | 'versions';

function DocumentPanel({ tab, versions, onChanged }: { tab: DocTab; versions: ContextOverview['versions']; onChanged: () => void }) {
  const [mode, setMode] = useState<Mode>('read');
  const own = versions.filter((v) => v.kind === tab.kind && (tab.kind !== 'source' || v.sourceKey === tab.sourceKey));
  const doc = tab.doc;
  const modes: { id: Mode; label: string }[] = [{ id: 'read', label: 'Lesen' }, { id: 'edit', label: 'Bearbeiten' }, { id: 'versions', label: `Versionen (${own.length})` }];
  return (
    <section className="panel" data-testid={`doc-${tab.kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-lg font-bold">{tab.label}</h2>
        {doc ? <><StatusChip status={doc.status} /><span className="hint" data-testid="doc-version">v{doc.version} · {SOURCE_LABEL[doc.source]} · {doc.createdAt.slice(0, 10)}</span></> : <Pill tone="warn">Noch keine aktive Version</Pill>}
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Ansicht">
          {modes.map((m) => (
            <Button key={m.id} size="sm" variant={mode === m.id ? 'primary' : 'ghost'} role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</Button>
          ))}
        </div>
      </div>
      {doc?.kind === 'source' ? <SourceSwitch doc={doc} onChanged={onChanged} /> : null}
      {doc?.kind === 'strategy' && doc.document.attachment ? <AttachmentSwitch doc={doc} onChanged={onChanged} /> : null}
      <div className="mt-4">
        {mode === 'read' ? (
          doc ? <ReadView doc={doc} /> : (
            <Empty>
              {tab.kind === 'strategy' ? 'Noch keine Strategie. Lege oben deine Strategie-JSON ab – oder schreib sie unter „Bearbeiten“.'
                : tab.kind === 'profile' ? 'Noch kein Profil. Lege oben dein Profil-Markdown ab – oder schreib es unter „Bearbeiten“.' : 'Diese Quelle ist nicht aktiv.'}
            </Empty>
          )
        ) : mode === 'edit' ? (
          <Editor tab={tab} onSaved={() => { setMode('read'); onChanged(); }} />
        ) : (
          <VersionList kind={tab.kind} versions={own} onChanged={onChanged} />
        )}
      </div>
    </section>
  );
}

function ReadView({ doc }: { doc: Doc }) {
  return (
    <>
      <MarkdownView markdown={doc.rendered} testId="doc-read" />
      {doc.kind === 'strategy' && doc.document.attachment ? (
        <details className="mt-6 rounded-xl border border-line p-4">
          <summary className="cursor-pointer text-sm font-bold">Original-Markdown „{doc.document.attachment.name || 'Anhang'}“</summary>
          <div className="mt-3"><MarkdownView markdown={doc.document.attachment.markdown} /></div>
        </details>
      ) : null}
      {doc.kind === 'profile' && doc.document.sensitiveTerms.length ? (
        <p className="hint mt-4">Sensible Begriffe (Grenz-Prüfung in Kundenprojekten): {doc.document.sensitiveTerms.map((t) => t.term).join(', ')}</p>
      ) : null}
    </>
  );
}

type SaveResult = { created: boolean; version: { version: number; label: string } };
const put = (kind: string, json: unknown) => api<SaveResult>(`/api/context/${kind}`, { method: 'PUT', json });

function useSave() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<SaveResult | null>, done?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r) toast(r.created ? `${r.version.label} v${r.version.version} gespeichert und aktiv.` : 'Gespeichert (keine neue Version nötig).');
      done?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function SourceSwitch({ doc, onChanged }: { doc: Extract<Doc, { kind: 'source' }>; onChanged: () => void }) {
  const save = useSave();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={`switch-${doc.sourceKey}`} className="font-semibold">An die KI:</label>
      <select
        id={`switch-${doc.sourceKey}`} className="field max-w-[260px] py-1.5 text-xs" value={doc.document.sendMode} disabled={save.busy}
        onChange={(e) => void save.run(() => put('source', { key: doc.sourceKey, sendMode: e.target.value }), onChanged)}
      >
        {SEND_MODES.map((m) => <option key={m} value={m}>{SEND_MODE_LABEL[m]}</option>)}
      </select>
      <span className="text-muted">{doc.chars.toLocaleString('de-DE')} Zeichen</span>
      <Button
        size="sm" variant="ghost" className="ml-auto"
        onClick={() => void save.run(async () => {
          await api(`/api/context/source?key=${encodeURIComponent(doc.sourceKey)}`, { method: 'DELETE' });
          return null;
        }, onChanged)}
      >
        Quelle entfernen
      </Button>
      <ErrorNote error={save.error} />
    </div>
  );
}

function AttachmentSwitch({ doc, onChanged }: { doc: Extract<Doc, { kind: 'strategy' }>; onChanged: () => void }) {
  const save = useSave();
  const a = doc.document.attachment!;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor="switch-attachment" className="font-semibold">Original-Markdown an die KI:</label>
      <select
        id="switch-attachment" className="field max-w-[260px] py-1.5 text-xs" value={a.sendMode} disabled={save.busy}
        onChange={(e) => void save.run(() => put('strategy', { attachmentSendMode: e.target.value }), onChanged)}
      >
        {SEND_MODES.map((m) => <option key={m} value={m}>{SEND_MODE_LABEL[m]}</option>)}
      </select>
      <span className="text-muted">Die Strategie selbst geht immer vollständig mit; das Original ist meist doppelt.</span>
      <ErrorNote error={save.error} />
    </div>
  );
}

function Editor({ tab, onSaved }: { tab: DocTab; onSaved: () => void }) {
  if (tab.kind === 'strategy') return <StrategyJsonEditor doc={tab.doc?.kind === 'strategy' ? tab.doc : null} onSaved={onSaved} />;
  return <MarkdownEditor tab={tab} onSaved={onSaved} />;
}

const EMPTY_STRATEGY = JSON.stringify({ phase: 'private_trial', longTermGoal: '', summary: '', pillars: [{ id: 'saeule-1', name: 'Säule 1', share: 100 }] }, null, 2);

/** One editor for the whole strategy JSON, validated live with the same parser the server uses. */
function StrategyJsonEditor({ doc, onSaved }: { doc: Extract<Doc, { kind: 'strategy' }> | null; onSaved: () => void }) {
  const initial = useMemo(() => {
    if (!doc) return EMPTY_STRATEGY;
    const rest: Partial<typeof doc.document> = { ...doc.document };
    delete rest.attachment;
    return JSON.stringify(rest, null, 2);
  }, [doc]);
  const [text, setText] = useState(initial);
  const result = useMemo(() => parseStrategyDocument(text), [text]);
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const save = useSave();
  return (
    <div>
      <label className="label mt-0" htmlFor="strategy-json">Strategie (JSON) – das ganze Dokument</label>
      <textarea id="strategy-json" className="field font-mono text-[12px] leading-snug" rows={28} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} data-testid="strategy-json" />
      <div className="mt-2 text-xs" data-testid="json-validation" aria-live="polite">
        {errors.length ? (
          <ul className="grid gap-0.5 text-danger">{errors.map((x, n) => <li key={n}>{x.path ? <code>{x.path}</code> : null} {x.message}</li>)}</ul>
        ) : <span className="text-accent">✓ Gültig{result.document ? ` · ${result.document.pillars.length} Säule(n)` : ''}</span>}
        {warnings.length ? <ul className="mt-1 grid gap-0.5 text-warn">{warnings.map((x, n) => <li key={n}>{x.message}</li>)}</ul> : null}
      </div>
      <p className="hint mt-2">Unbekannte Felder bleiben unter „extras“ erhalten. Das Original-Markdown (Anhang) bleibt beim Speichern unverändert.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={save.busy} disabled={!!errors.length || text === initial} onClick={() => void save.run(() => put('strategy', { json: text }), onSaved)}>Speichern</Button>
        <span className="hint">Speichern legt eine neue Version an und macht sie sofort aktiv.</span>
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

function MarkdownEditor({ tab, onSaved }: { tab: DocTab; onSaved: () => void }) {
  const doc = tab.doc;
  const initialMd = doc && doc.kind !== 'strategy' ? doc.document.markdown : '';
  const initialTitle = doc?.kind === 'source' ? doc.document.title : '';
  const [markdown, setMarkdown] = useState(initialMd);
  const [title, setTitle] = useState(initialTitle);
  const [preview, setPreview] = useState(false);
  const save = useSave();
  const dirty = markdown !== initialMd || title !== initialTitle;
  const submit = () => save.run(() => (tab.kind === 'profile' ? put('profile', { markdown }) : put('source', { key: tab.sourceKey ?? undefined, title, markdown })), onSaved);
  return (
    <div>
      {tab.kind === 'source' ? (
        <>
          <label className="label mt-0" htmlFor="source-title">Titel</label>
          <input id="source-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
        </>
      ) : null}
      <div className="mt-4 mb-2 flex items-center gap-2">
        <label className="text-[11px] font-semibold text-[#454d3d]" htmlFor="doc-markdown">{tab.kind === 'profile' ? 'Profil (Markdown)' : 'Text (Markdown)'}</label>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPreview((p) => !p)}>{preview ? 'Text bearbeiten' : 'Vorschau'}</Button>
      </div>
      {preview ? <div className="rounded-lg border border-line p-4"><MarkdownView markdown={markdown} /></div> : (
        <textarea id="doc-markdown" className="field font-mono text-[12px] leading-snug" rows={24} value={markdown} onChange={(e) => setMarkdown(e.target.value)} data-testid="doc-markdown" />
      )}
      <p className="hint mt-1">{markdown.length.toLocaleString('de-DE')} Zeichen</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={save.busy} disabled={!dirty || !markdown.trim() || (tab.kind === 'source' && !title.trim())} onClick={() => void submit()}>Speichern</Button>
        <span className="hint">Speichern legt eine neue Version an und macht sie sofort aktiv.</span>
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

function VersionList({ kind, versions, onChanged }: { kind: Doc['kind']; versions: ContextOverview['versions']; onChanged: () => void }) {
  const toast = useToast();
  const [viewing, setViewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = useApi<Doc>(viewing ? `/api/context/${kind}/versions/${viewing}` : null);
  async function activate(id: string) {
    setError(null);
    try {
      const v = await api<Doc>(`/api/context/${kind}/versions/${id}/activate`, { method: 'POST' });
      toast(`${v.label} v${v.version} ist wieder aktiv.`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!versions.length) return <Empty>Noch keine Versionen.</Empty>;
  return (
    <div>
      <ul className="grid gap-1" data-testid="version-list">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs">
            <strong>v{v.version}</strong>
            <StatusChip status={v.status} />
            <span className="text-muted">{SOURCE_LABEL[v.source]} · {v.createdAt.slice(0, 16).replace('T', ' ')}</span>
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setViewing(viewing === v.id ? null : v.id)}>{viewing === v.id ? 'Schließen' : 'Ansehen'}</Button>
              {v.status !== 'approved' ? <Button size="sm" onClick={() => void activate(v.id)}>{v.status === 'archived' ? 'Wieder aktivieren' : 'Aktivieren'}</Button> : null}
            </span>
          </li>
        ))}
      </ul>
      <ErrorNote error={error ?? view.error} />
      {viewing && view.data ? <div className="mt-4 rounded-lg border border-line p-4"><MarkdownView markdown={view.data.rendered} /></div> : null}
    </div>
  );
}

// ---------- Transparency ----------
function AiTextPanel({ ai }: { ai: ContextOverview['ai'] }) {
  return (
    <details className="mt-6 rounded-xl border border-line p-4" data-testid="ai-text">
      <summary className="cursor-pointer text-sm font-bold">Das liest die KI</summary>
      <p className="hint mt-2">Genau dieser Text geht als Daten (nicht als Anweisung) an die Content-Agenten deiner eigenen Projekte: die aktive Strategie, das Profil und Quellen mit „{SEND_MODE_LABEL.always}“. Kundenprojekte bekommen nichts davon.</p>
      {ai.agentWarning ? <p className="mt-2 text-xs text-warn">{ai.agentWarning}</p> : null}
      {ai.agentText
        ? <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-line bg-card2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap" data-testid="ai-text-agent">{ai.agentText}</pre>
        : <p className="hint mt-2">Noch nichts – es geht kein persönlicher Kontext an die KI.</p>}
      {ai.chatVoiceText !== ai.agentText ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold">Zusätzlich in Chat und Voice-Analyse ({ai.chatVoiceText.length.toLocaleString('de-DE')} Zeichen)</summary>
          {ai.chatVoiceWarning ? <p className="mt-2 text-xs text-warn">{ai.chatVoiceWarning}</p> : null}
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-line bg-card2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{ai.chatVoiceText}</pre>
        </details>
      ) : null}
    </details>
  );
}
