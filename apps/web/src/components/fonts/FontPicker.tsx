'use client';
import { useEffect, useMemo, useState } from 'react';
import { GOOGLE_CATEGORIES, GOOGLE_CATEGORY_LABELS, searchFamilies, type GoogleCategory, type GoogleFamily, type InstalledFace, type InstalledFamily } from '@studio/core/fontCatalog';
import type { FontFace } from '@studio/core/designSystem';
import { macPostscriptName } from '@studio/core/lookBase';
import { api } from '@/lib/api';
import { Button, ErrorNote } from '../ui';
import { cssFontOfRef, googleAlias, GooglePreviewFaces, MacFontFaces } from './fontCss';

/**
 * Etappe 16b: the font library as one picker – the studio list and her own/Google files, the fonts installed on this Mac
 * (search, preview in the face itself) and the Google Fonts catalogue (category filter, preview, one-click „Hinzufügen“
 * that downloads the chosen weights into her fonts with the licence note). Used for the type roles in Meine Marke and for a
 * single element in the editor's inspector.
 */
export interface FontChoice { ref: string; face?: FontFace }
export interface StudioFont { ref: string; label: string }
type SystemList = { source: string; families: InstalledFamily[]; error: string | null };
type GoogleResult = { fetchedAt: string; stale: boolean; total: number; results: GoogleFamily[]; curated: GoogleFamily[]; added: { id: string; family: string; weight: number }[] };

let systemFonts: Promise<SystemList> | null = null;
const loadSystemFonts = (refresh = false) => {
  if (refresh || !systemFonts) systemFonts = api<SystemList>(`/api/fonts/system${refresh ? '?refresh=1' : ''}`).catch((e) => { systemFonts = null; throw e; });
  return systemFonts;
};

const PREVIEW_DEFAULT = 'So sieht dein Hook aus';
/** Characters the Google preview files contain (others fall back to the browser's font). */
const PREVIEW_OK = /[^A-Za-z0-9ÄÖÜäöüß .,:;!?\-–„“"'&()]/g;

export function fontChoiceLabel(choice: FontChoice, studio: readonly StudioFont[]): string {
  const ps = macPostscriptName(choice.ref);
  if (ps) return `${choice.face?.family ?? ps}${choice.face?.style ? ` ${choice.face.style}` : ''} (Mac)`;
  return studio.find((f) => f.ref === choice.ref)?.label ?? choice.ref;
}

export function FontPicker({ value, studioFonts, onChange, onFontsAdded, label, testId, preferWeight = 700, allowInherit }: {
  value: FontChoice | null; studioFonts: readonly StudioFont[]; onChange: (c: FontChoice | null) => void;
  /** After a Google font was added: reload the font list; resolves with the new list (to pick the added face). */
  onFontsAdded?: () => Promise<readonly StudioFont[] | void>;
  label: string; testId: string; preferWeight?: number;
  /** Inspector: „wie die Rolle“ (null) is a choice. */
  allowInherit?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'studio' | 'mac' | 'google'>('studio');
  const [sample, setSample] = useState(PREVIEW_DEFAULT);
  const current = value ? fontChoiceLabel(value, studioFonts) : allowInherit ?? '–';
  return (
    <div className="relative grid gap-1" data-testid={`font-picker-${testId}`}>
      <button type="button" className="field flex items-center justify-between gap-2 py-1 text-left text-xs" aria-expanded={open} aria-label={`${label}: Schrift wählen (aktuell ${current})`} onClick={() => setOpen((o) => !o)} data-testid={`font-picker-${testId}-toggle`}>
        <span className="truncate" style={value ? { fontFamily: cssFontOfRef(value.ref, value.face?.family), fontWeight: value.face?.weight, fontStyle: value.face?.italic ? 'italic' : undefined } : undefined}>{current}</span>
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {value?.ref.startsWith('mac:') ? <MacFontFaces names={[value.ref.slice(4)]} /> : null}
      {open ? (
        <div className="absolute top-full left-0 z-30 mt-1 grid w-[min(560px,92vw)] gap-2 rounded-xl border border-line bg-white p-2 text-xs shadow-lg" role="dialog" aria-label={`${label}: Schrift-Bibliothek`}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
          <div className="flex flex-wrap items-center gap-1" role="tablist">
            {([['studio', 'Studio & eigene'], ['mac', 'Auf dem Mac'], ['google', 'Google Fonts']] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`font-tab-${k}`} onClick={() => setTab(k)}
                className={`rounded-full border px-2.5 py-0.5 ${tab === k ? 'border-accent bg-[#eef6dc] font-semibold' : 'border-line'}`}>{l}</button>
            ))}
            <input aria-label="Vorschau-Text" className="field ml-auto w-44 py-0.5 text-xs" maxLength={40} value={sample} onChange={(e) => setSample(e.target.value)} />
          </div>
          {tab === 'studio' ? (
            <ul className="grid max-h-64 gap-0.5 overflow-auto">
              {allowInherit ? <li><button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-black/5" onClick={() => { onChange(null); setOpen(false); }}>{allowInherit}</button></li> : null}
              {studioFonts.map((f) => (
                <li key={f.ref}>
                  <button type="button" className={`flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left hover:bg-black/5 ${value?.ref === f.ref ? 'bg-[#eef6dc]' : ''}`} onClick={() => { onChange({ ref: f.ref }); setOpen(false); }}>
                    <span className="truncate text-base" style={{ fontFamily: cssFontOfRef(f.ref) }}>{sample || f.label}</span>
                    <span className="shrink-0 text-muted">{f.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : tab === 'mac' ? (
            <MacTab sample={sample} value={value} onPick={(c) => { onChange(c); setOpen(false); }} />
          ) : (
            <GoogleTab sample={sample} preferWeight={preferWeight} studioFonts={studioFonts} onFontsAdded={onFontsAdded} onPick={(c) => { onChange(c); setOpen(false); }} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function MacTab({ sample, value, onPick }: { sample: string; value: FontChoice | null; onPick: (c: FontChoice) => void }) {
  const [list, setList] = useState<SystemList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => {
    setBusy(true);
    loadSystemFonts(refresh).then((l) => { setList(l); setErr(l.error); }, (e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  useEffect(() => {
    let live = true;
    loadSystemFonts().then((l) => { if (live) { setList(l); setErr(l.error); } }, (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);
  const hits = useMemo(() => (list ? searchFamilies(list.families, q, 40) : []), [list, q]);
  const faces = hits.flatMap((f) => f.faces.filter((x) => x.ref).map((x) => x.postscriptName));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <input aria-label="Mac-Schriften durchsuchen" className="field py-1 text-xs" placeholder="Suchen, z. B. Didot" value={q} onChange={(e) => setQ(e.target.value)} data-testid="font-mac-search" />
        <Button size="sm" variant="ghost" busy={busy} onClick={() => load(true)} title="Liste neu einlesen (nach dem Installieren einer Schrift)">Neu einlesen</Button>
      </div>
      {list ? <p className="hint m-0">{list.families.length} Familien installiert (Quelle: {list.source}). Gezeigt werden Schnitte, die libass sicher findet; kursive nur, wenn du sie ausdrücklich wählst.</p> : null}
      <MacFontFaces names={faces.slice(0, 200)} />
      <ul className="grid max-h-64 gap-0.5 overflow-auto" data-testid="font-mac-list">
        {hits.map((fam) => <MacFamilyRow key={fam.family} fam={fam} sample={sample} value={value} onPick={onPick} />)}
      </ul>
      <ErrorNote error={err} />
    </div>
  );
}

function MacFamilyRow({ fam, sample, value, onPick }: { fam: InstalledFamily; sample: string; value: FontChoice | null; onPick: (c: FontChoice) => void }) {
  const selectable = fam.faces.filter((f) => f.ref);
  const upright = selectable.filter((f) => !f.italic);
  const initial = selectable.find((f) => f.ref === value?.ref) ?? upright.find((f) => f.weight === 700) ?? upright[0] ?? selectable[0];
  const [ps, setPs] = useState(initial?.postscriptName ?? '');
  const face = selectable.find((f) => f.postscriptName === ps);
  const pick = (f: InstalledFace) => onPick({ ref: f.ref!, face: { family: f.family, style: f.style, weight: f.weight, italic: f.italic, ...(f.assName !== f.postscriptName ? { assName: f.assName } : {}) } });
  return (
    <li className="flex items-center gap-2 rounded px-2 py-1 hover:bg-black/5">
      <span className="min-w-0 flex-1 truncate text-base" style={face ? { fontFamily: `'studio-mac-${face.postscriptName}', sans-serif` } : undefined} title={fam.family}>{sample || fam.family}</span>
      <span className="w-28 shrink-0 truncate text-muted" title={fam.family}>{fam.family}</span>
      {selectable.length ? (
        <>
          <select aria-label={`${fam.family}: Schnitt`} className="field w-28 shrink-0 py-0.5 text-xs" value={ps} onChange={(e) => setPs(e.target.value)}>
            {selectable.map((f) => <option key={f.postscriptName} value={f.postscriptName}>{f.style}{f.italic ? ' (kursiv)' : ''}</option>)}
          </select>
          <Button size="sm" className="shrink-0" onClick={() => face && pick(face)} disabled={!face} data-testid={`mac-pick-${fam.family}`}>Wählen</Button>
        </>
      ) : <span className="text-muted">Name nicht sicher verwendbar</span>}
    </li>
  );
}

function GoogleTab({ sample, preferWeight, studioFonts, onFontsAdded, onPick }: {
  sample: string; preferWeight: number; studioFonts: readonly StudioFont[]; onFontsAdded?: () => Promise<readonly StudioFont[] | void>; onPick: (c: FontChoice) => void;
}) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<GoogleCategory | null>(null);
  const [data, setData] = useState<GoogleResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<GoogleResult>(`/api/fonts/google?${new URLSearchParams({ q, ...(cat ? { category: cat } : {}), limit: '30' })}`)
        .then((d) => { if (live) { setData(d); setErr(null); } }, (e: Error) => { if (live) setErr(e.message); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, cat]);
  const shown = data ? (q || cat ? data.results : data.curated) : [];
  const text = (sample || 'Hook').replace(PREVIEW_OK, '');
  async function add(f: GoogleFamily, weight: number | 'both') {
    setBusy(f.family); setErr(null); setNote(null);
    try {
      const weights = weight === 'both' ? f.weights.filter((w) => w === 400 || w === 700) : [weight];
      const r = await api<{ fonts: { font: { id: string; family: string; weight: number; license: string }; duplicate: boolean }[] }>('/api/fonts/google', { method: 'POST', json: { family: f.family, ...(weights.length ? { weights } : {}) } });
      const best = [...r.fonts].sort((a, b) => Math.abs(a.font.weight - preferWeight) - Math.abs(b.font.weight - preferWeight))[0];
      setNote(`${f.family} hinzugefügt (${r.fonts.map((x) => x.font.weight).join(', ')}). Lizenz: ${r.fonts[0]?.font.license ?? ''}`);
      setData((d) => (d ? { ...d, added: [...d.added, ...r.fonts.map((x) => ({ id: x.font.id, family: f.family, weight: x.font.weight }))] } : d));
      // pick first (her draft becomes „changed“), then reload the font list, so the reload cannot reset the draft
      if (best) onPick({ ref: `custom:${best.font.id}` });
      await onFontsAdded?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <input aria-label="Google Fonts durchsuchen" className="field w-44 py-1 text-xs" placeholder="Suchen, z. B. Bebas" value={q} onChange={(e) => setQ(e.target.value)} data-testid="font-google-search" />
        <button type="button" onClick={() => setCat(null)} className={`rounded-full border px-2 py-0.5 ${!cat ? 'border-accent font-semibold' : 'border-line'}`}>Alle</button>
        {GOOGLE_CATEGORIES.map((c) => <button key={c} type="button" onClick={() => setCat(c)} aria-pressed={cat === c} className={`rounded-full border px-2 py-0.5 ${cat === c ? 'border-accent font-semibold' : 'border-line'}`}>{GOOGLE_CATEGORY_LABELS[c]}</button>)}
      </div>
      {data ? <p className="hint m-0">{q || cat ? `${data.results.length} Treffer` : 'Schnellauswahl typischer Reel-Schriften'} · Katalog {data.total} Familien, Stand {data.fetchedAt.slice(0, 10)}{data.stale ? ' (gespeicherte Kopie – offline?)' : ''}. Hinzufügen lädt die Dateien (OFL/Apache) in deine Schriften.</p> : null}
      <GooglePreviewFaces families={shown.slice(0, 30).map((f) => ({ family: f.family, weight: f.weights.includes(preferWeight) ? preferWeight : f.weights.includes(400) ? 400 : f.weights[0]! }))} />
      <ul className="grid max-h-64 gap-0.5 overflow-auto" data-testid="font-google-list">
        {shown.map((f) => {
          const added = data!.added.filter((a) => a.family === f.family);
          return (
            <li key={f.family} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-black/5" data-testid={`google-row-${f.family}`}>
              <span className="min-w-0 flex-1 truncate text-base" style={{ fontFamily: `'${googleAlias(f.family)}', sans-serif` }}>{text}</span>
              <span className="w-32 shrink-0 truncate text-muted">{f.family} · {GOOGLE_CATEGORY_LABELS[f.category]}</span>
              {added.length ? added.map((a) => (
                <Button key={a.id} size="sm" onClick={() => onPick({ ref: `custom:${a.id}` })} disabled={!studioFonts.some((s) => s.ref === `custom:${a.id}`)} data-testid={`google-pick-${f.family}-${a.weight}`}>Wählen {a.weight}</Button>
              )) : (
                <Button size="sm" variant="primary" busy={busy === f.family} disabled={!!busy} onClick={() => void add(f, 'both')} data-testid={`google-add-${f.family}`}
                  title={`Lädt ${f.weights.filter((w) => w === 400 || w === 700).join(' + ') || f.weights[0]} von fonts.gstatic.com`}>Hinzufügen</Button>
              )}
            </li>
          );
        })}
      </ul>
      {note ? <p className="m-0 text-[11px] text-accent" data-testid="google-added-note">{note}</p> : null}
      <ErrorNote error={err} />
    </div>
  );
}
