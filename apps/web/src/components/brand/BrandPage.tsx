'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COLOR_ROLE_LABELS, COLOR_ROLES, DesignSystem, TEMPO_LABELS, TRANSITION_LABELS, TYPE_ROLE_LABELS, TYPE_ROLES, fontLabel, type ContrastCheck,
  type DesignSystem as Design,
} from '@studio/core/designSystem';
import { api, useApi } from '@/lib/api';
import type { DesignState, DirectorSuggestion } from '@/lib/types';
import { useToast } from '../toast';
import { Button, ErrorNote, Field, fmtDateTime, MockBadge, PageHeader, Pill } from '../ui';
import { ColorsSection, GuidelinesSection, ImagerySection, MotionSection, PresetsSection, ProvenanceSection, TypeSection, WordsSection, type Setter } from './BrandSections';
import { FontFaces } from './StagePreview';
import { MacFontFaces } from '../fonts/fontCss';
import { ChatButton, useChatScope } from '../chat/ChatProvider';

type Proposal = { kind: 'derive' | 'ai'; before: Design; after: Design; notes: string[]; checks?: ContrastCheck[]; mock?: boolean; suggestionId?: string; createdAt?: string; uncertainties?: string[] };
type DesignSuggestionRec = Extract<DirectorSuggestion, { kind: 'design' }>;

/**
 * „Meine Marke – einmal festlegen, überall genutzt“ (Etappe 14). Everything is edited in place; „Speichern“ makes it
 * the active Style Bible version (the old one stays in the history). Derive and AI only propose: before/after, then
 * „Übernehmen“ puts the proposal into the page, and only „Speichern“ stores it.
 */
export function BrandPage() {
  const toast = useToast();
  const { data, error, reload } = useApi<DesignState>('/api/design-system');
  const [draft, setDraft] = useState<Design | null>(null);
  // the version the draft was loaded from (a later reload, e.g. after a font upload, must not move it: stale save → 409)
  const [draftBase, setDraftBase] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server state replaces the draft after load/save
    if (data && !dirty) { setDraft(structuredClone(data.design)); setDraftBase(data.version?.id ?? null); }
  }, [data, dirty]);
  const set: Setter = (fn) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); };
  // Etappe 15: a chat proposal she takes over is a new active version – the page shows it (her unsaved edits stay)
  useChatScope({
    scope: 'brand', label: 'Meine Marke',
    onApplied: async (r) => {
      if (r.kind !== 'design' && r.kind !== 'voice') return;
      if (dirty) toast('Chat-Vorschlag ist aktiv. Deine ungespeicherten Änderungen beziehen sich noch auf die vorige Version – „Änderungen verwerfen“ zeigt den neuen Stand.');
      await reload();
    },
  });
  const customIds = useMemo(() => data?.fonts.filter((f) => f.custom).map((f) => f.ref.slice('custom:'.length)) ?? [], [data]);

  async function act<T>(key: string, fn: () => Promise<T>, after?: (r: T) => void) {
    setBusy(key); setErr(null);
    try { after?.(await fn()); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function save() {
    if (!draft || !data) return;
    const parsed = DesignSystem.safeParse(draft);
    if (!parsed.success) return setErr(`Nicht speicherbar: ${parsed.error.issues.map((i) => `${i.path.join('.')} – ${i.message}`).join('; ')}`);
    await act('save', () => api<{ version: number }>('/api/design-system', { method: 'PUT', json: { design: parsed.data, baseVersionId: draftBase, suggestionId } }), async (v) => {
      setDirty(false); setSuggestionId(null);
      await reload();
      toast(`Gespeichert – Meine Marke ist jetzt aktiv (Style Bible v${v.version}).`);
    });
  }

  if (error) return <ErrorNote error={error} />;
  if (!data || !draft) return <p className="hint">Lade Meine Marke …</p>;
  const lastAi = data.suggestion as (DesignSuggestionRec & { outdated: boolean }) | null;

  return (
    <div className="appear" data-testid="brand-page">
      <FontFaces ids={customIds} />
      <MacFontFaces names={Object.values(draft.typography).flatMap((t) => (t.font.startsWith('mac:') ? [t.font.slice(4)] : []))} />
      <PageHeader
        eyebrow="02 / MEINE MARKE · EINMAL FESTLEGEN, ÜBERALL GENUTZT"
        title="Meine Marke."
        accent="Einmal festlegen, überall genutzt."
        lead={<>Farben, Schriften, Overlay-Stile, Bewegung, Bildlook und deine Wörter – aus dem, was du im <Link href="/style-lab" className="underline">Style Lab</Link> als gut markiert hast. Reel-Overlays, Musterbild und Untertitel nutzen genau diese Werte; Karussells und Stories folgen.</>}
        right={
          <div className="grid justify-items-end gap-2 text-right text-xs" data-testid="brand-version">
            <ChatButton />
            {data.version ? <Pill tone="ok">Style Bible v{data.version.version} · aktiv</Pill> : <Pill tone="warn">noch keine Style Bible</Pill>}
            {data.version ? <div className="mt-1 text-muted">seit {fmtDateTime(data.version.createdAt)}</div> : null}
          </div>
        }
      />
      {data.legacy ? <div className="note mb-4" role="status">Diese Style Bible hat noch kein Design System. Gezeigt wird, was ihre Palette heute im Video ergibt (Farbe 1 = Akzent, Farbe 2 = Fläche). Erst „Speichern“ legt Meine Marke ausdrücklich an; alte Schnitte behalten ihren Look.</div> : null}
      {data.fresh ? <div className="note mb-4" role="status">Noch keine Farben in der Style Bible: Das hier ist ein Startpunkt aus deinen Favoriten. Erst „Speichern“ legt Meine Marke an.</div> : null}

      <div className="z-10 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-card/95 p-3 backdrop-blur md:sticky md:top-0" data-testid="brand-actions">
        <Button variant="primary" busy={busy === 'save'} disabled={!dirty && !data.legacy && !data.fresh} onClick={() => void save()} data-testid="brand-save">Speichern (aktiv machen)</Button>
        <Button variant="ghost" disabled={!dirty || !!busy} onClick={() => { setDirty(false); setSuggestionId(null); setDraft(structuredClone(data.design)); setDraftBase(data.version?.id ?? null); }}>Änderungen verwerfen</Button>
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <Button busy={busy === 'derive'} disabled={!!busy} data-testid="brand-derive" onClick={() => void act('derive', () => api<{ before: Design; after: Design; notes: string[]; checks: ContrastCheck[] }>('/api/design-system/derive', { method: 'POST', json: { design: draft } }), (r) => setProposal({ kind: 'derive', ...r, before: draft }))}>Aus meinen Favoriten ableiten</Button>
        <Button busy={busy === 'ai'} disabled={!!busy} data-testid="brand-suggest" onClick={() => void act('ai', () => api<{ suggestion: DesignSuggestionRec; before: Design }>('/api/design-system/suggest', { method: 'POST', json: { design: draft } }), (r) => {
          setProposal({ kind: 'ai', before: draft, after: r.suggestion.output.design, notes: r.suggestion.warnings, uncertainties: r.suggestion.output.uncertainties, mock: r.suggestion.mock, suggestionId: r.suggestion.id, createdAt: r.suggestion.createdAt });
          toast(r.suggestion.mock ? 'Regelbasierter Vorschlag (MOCK, keine KI) – bitte prüfen.' : 'KI-Vorschlag erstellt – bitte prüfen.');
        })}>KI-Vorschlag</Button>
        {!proposal && lastAi ? <Button size="sm" variant="ghost" onClick={() => setProposal({ kind: 'ai', before: draft, after: lastAi.output.design, notes: lastAi.warnings, uncertainties: lastAi.output.uncertainties, mock: lastAi.mock, suggestionId: lastAi.id, createdAt: lastAi.createdAt })}>Letzten KI-Vorschlag zeigen{lastAi.outdated ? ' (ältere Version)' : ''}</Button> : null}
        {dirty ? <Pill tone="warn">ungespeichert</Pill> : null}
        <nav className="ml-auto flex flex-wrap gap-2 text-[11px] text-muted" aria-label="Abschnitte">
          {[['farben', 'Farben'], ['schriften', 'Schriften'], ['overlays', 'Overlay-Stile'], ['bewegung', 'Bewegung'], ['bildlook', 'Bildlook'], ['woerter', 'Wörter'], ['herkunft', 'Herkunft']].map(([id, l]) => <a key={id} href={`#${id}`} className="hover:text-ink">{l}</a>)}
        </nav>
      </div>
      <ErrorNote error={err} />
      {proposal ? (
        <ProposalPanel p={proposal} onClose={() => setProposal(null)} onAdopt={() => {
          setDraft(structuredClone(proposal.after)); setDirty(true); setSuggestionId(proposal.suggestionId ?? null); setProposal(null);
          toast('Vorschlag übernommen – prüfen und „Speichern“, dann ist er aktiv.');
        }} />
      ) : null}

      <ColorsSection d={draft} set={set} state={data} />
      <TypeSection d={draft} set={set} state={data} reloadFonts={reload} fontsSlot={<FontsManager state={data} reload={reload} />} />
      <PresetsSection d={draft} set={set} specimen={(presetId) => <SpecimenButton design={draft} presetId={presetId} />} />
      <MotionSection d={draft} set={set} state={data} />
      <ImagerySection d={draft} set={set} state={data} />
      <WordsSection d={draft} set={set} state={data} />
      <GuidelinesSection d={draft} set={set} state={data} />
      <ProvenanceSection d={draft} state={data} />
    </div>
  );
}

/** Before/after of a proposal, only the parts that change. */
function ProposalPanel({ p, onClose, onAdopt }: { p: Proposal; onClose: () => void; onAdopt: () => void }) {
  const { before: b, after: a } = p;
  const colorDiff = COLOR_ROLES.filter((r) => b.colors[r].hex !== a.colors[r].hex);
  const typeDiff = TYPE_ROLES.filter((r) => JSON.stringify({ ...b.typography[r], origin: 0 }) !== JSON.stringify({ ...a.typography[r], origin: 0 }));
  const sw = (hex: string) => <span className="inline-block h-5 w-5 rounded border border-black/10 align-middle" style={{ background: hex }} title={hex} />;
  const t = (x: Design['typography'][keyof Design['typography']]) => `${fontLabel(x.font)} · ${x.weight === 'bold' ? 'fett' : 'normal'} · ${x.size}${x.textCase === 'upper' ? ' · VERSALIEN' : x.textCase === 'lower' ? ' · klein' : ''}`;
  const motion = (m: Design['motion']) => `${TEMPO_LABELS[m.tempo]}${m.targetCutSec ? `, ${m.targetCutSec} s` : ''} · ${m.transitions.map((x) => TRANSITION_LABELS[x]).join(', ')}`;
  const rows: [string, React.ReactNode, React.ReactNode][] = [
    ...colorDiff.map((r): [string, React.ReactNode, React.ReactNode] => [COLOR_ROLE_LABELS[r].label, <>{sw(b.colors[r].hex)} {b.colors[r].hex}</>, <>{sw(a.colors[r].hex)} {a.colors[r].hex}</>]),
    ...typeDiff.map((r): [string, React.ReactNode, React.ReactNode] => [TYPE_ROLE_LABELS[r], t(b.typography[r]), t(a.typography[r])]),
    ...(motion(b.motion) !== motion(a.motion) ? [['Bewegung', motion(b.motion), motion(a.motion)] as [string, string, string]] : []),
    ...(b.imagery.keywords.join(', ') !== a.imagery.keywords.join(', ') || b.imagery.temperature !== a.imagery.temperature ? [['Bildlook', `${b.imagery.keywords.join(', ') || '—'} · ${b.imagery.temperature ?? 'offen'}`, `${a.imagery.keywords.join(', ') || '—'} · ${a.imagery.temperature ?? 'offen'}`] as [string, string, string]] : []),
    ...(b.phrases.length !== a.phrases.length ? [['Eigene Wörter', b.phrases.map((x) => x.text).join(', ') || '—', a.phrases.map((x) => x.text).join(', ') || '—'] as [string, string, string]] : []),
    ...(b.guidelines !== a.guidelines ? [['Leitlinien', b.guidelines || '—', a.guidelines || '—'] as [string, string, string]] : []),
  ];
  return (
    <section className="panel mb-4 border-accent" data-testid="brand-proposal" aria-label="Vorschlag">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm">{p.kind === 'derive' ? 'Aus deinen Favoriten abgeleitet (regelbasiert)' : 'Vorschlag des Design Directors'}</strong>
        {p.kind === 'ai' ? <MockBadge mock={!!p.mock} /> : <Pill>deterministisch, keine KI</Pill>}
        {p.createdAt ? <span className="text-xs text-muted">{fmtDateTime(p.createdAt)}</span> : null}
      </div>
      {rows.length ? (
        <table className="w-full text-left text-xs">
          <thead><tr className="text-muted"><th className="py-1 pr-3 font-normal">Token</th><th className="py-1 pr-3 font-normal">Vorher</th><th className="py-1 font-normal">Nachher</th></tr></thead>
          <tbody>{rows.map(([k, x, y]) => <tr key={k} className="border-t border-line align-top"><td className="py-1.5 pr-3 font-semibold">{k}</td><td className="py-1.5 pr-3 whitespace-pre-line">{x}</td><td className="py-1.5 whitespace-pre-line">{y}</td></tr>)}</tbody>
        </table>
      ) : <p className="hint">Der Vorschlag ändert nichts an deinem aktuellen Stand.</p>}
      {[...p.notes, ...(p.uncertainties ?? [])].length ? <ul className="mt-2 list-disc pl-5 text-xs text-warn">{[...p.notes, ...(p.uncertainties ?? [])].map((n) => <li key={n}>{n}</li>)}</ul> : null}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={onAdopt} disabled={!rows.length} data-testid="proposal-adopt">Übernehmen</Button>
        <Button variant="ghost" onClick={onClose}>Verwerfen</Button>
      </div>
    </section>
  );
}

/** „Exaktes Musterbild“: the specimen PNG through FFmpeg + libass (same ASS as the render). */
function SpecimenButton({ design, presetId }: { design: Design; presetId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const last = useRef<string | null>(null);
  useEffect(() => () => { if (last.current) URL.revokeObjectURL(last.current); }, []);
  async function load() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/design-system/specimen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ design, presetId }), cache: 'no-store' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const blob = await res.blob();
      if (last.current) URL.revokeObjectURL(last.current);
      last.current = URL.createObjectURL(blob);
      setUrl(last.current);
      try { setWarnings(JSON.parse(decodeURIComponent(res.headers.get('X-Specimen-Warnings') ?? '%5B%5D')) as string[]); } catch { setWarnings([]); }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid w-[270px] gap-1 text-xs">
      <Button size="sm" busy={busy} onClick={() => void load()} data-testid="specimen-button">Exaktes Musterbild (FFmpeg)</Button>
      {/* eslint-disable-next-line @next/next/no-img-element -- local blob of the rendered specimen */}
      {url ? <img src={url} alt="Exaktes Musterbild 1080×1920" className="w-full rounded-lg border border-line" data-testid="specimen-image" /> : null}
      {warnings.length ? <ul className="list-disc pl-4 text-warn">{warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      <ErrorNote error={err} />
    </div>
  );
}

/** Her own font files: upload (TTF/OTF, ≤ 10 MB, licence note required) and delete. */
function FontsManager({ state, reload }: { state: DesignState; reload: () => Promise<void> }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [license, setLicense] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function upload() {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('license', license);
      const r = await api<{ font: { family: string }; duplicate: boolean }>('/api/fonts', { method: 'POST', body: fd });
      toast(r.duplicate ? `${r.font.family} ist schon da.` : `${r.font.family} hochgeladen – jetzt in den Schriftrollen wählbar.`);
      setFile(null); setLicense('');
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="mt-4 rounded-xl border border-line p-3 text-xs" data-testid="fonts-manager">
      <summary className="cursor-pointer font-semibold">Eigene Schriften ({state.fontFiles.length})</summary>
      <p className="hint">TTF oder OTF, höchstens 10 MB, nur aufrechte Schnitte. Gib an, unter welcher Lizenz du die Schrift nutzen darfst (z. B. „SIL OFL 1.1“). Die Datei bleibt in deinem Datenordner; der Render nutzt sie über libass.</p>
      <ul className="my-2 grid gap-1">
        {state.fontFiles.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2">
            <span style={{ fontFamily: `'studio-font-${f.id}'` }} className="text-base">{f.family}</span>
            <span className="text-muted">{f.name} · Gewicht {f.weight} · Lizenz: {f.license}</span>
            <Button size="sm" variant="ghost" onClick={async () => {
              try { await api(`/api/fonts/${f.id}`, { method: 'DELETE' }); await reload(); } catch (e) { toast((e as Error).message); }
            }}>Löschen</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Schriftdatei" htmlFor="font-file"><input id="font-file" type="file" accept=".ttf,.otf,font/ttf,font/otf" className="field py-1" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Field label="Lizenzvermerk (Pflicht)" htmlFor="font-license"><input id="font-license" className="field py-1" maxLength={500} value={license} onChange={(e) => setLicense(e.target.value)} placeholder="SIL OFL 1.1" /></Field>
        <Button size="sm" variant="primary" busy={busy} disabled={!file || license.trim().length < 3} onClick={() => void upload()}>Hochladen</Button>
      </div>
      <ErrorNote error={err} />
    </details>
  );
}
