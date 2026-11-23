'use client';
import { useState, type ReactNode } from 'react';
import {
  COLOR_ROLE_LABELS, COLOR_ROLES, contrastChecks, PROVENANCE_LABELS, TEMPERATURE_LABELS, TEMPERATURES, TEMPO_LABELS, TRANSITION_LABELS, TRANSITIONS,
  TYPE_ROLE_LABELS, TYPE_ROLES, type ColorRole, type DesignSystem, type OverlayPreset, type Provenance,
} from '@studio/core/designSystem';
import type { DesignState } from '@/lib/types';
import { Button, Field, Pill } from '../ui';
import { SUBTITLE_MODE_LABELS, SUBTITLE_MODES, TEXT_ANIM_LABELS, TEXT_ANIMS } from '@studio/core/textAnim';
import { FontPicker } from '../fonts/FontPicker';
import { cssFont, cssWeight, StagePreview } from './StagePreview';

export type Setter = (fn: (d: DesignSystem) => DesignSystem) => void;
export const manual = (note = ''): Provenance => ({ source: 'manual', observationIds: [], referenceIds: [], note });
const HEX = /^#[0-9A-Fa-f]{6}$/;
const SLOT_LABEL = { upper: 'oben', center: 'Mitte', lower: 'unten' } as const;
const ZOOM_LABEL = { none: 'kein Zoom', push_in: 'Push-in', push_out: 'Push-out', punch_in: 'Punch-in' } as const;

export function Section({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel mb-4" id={id} aria-labelledby={`${id}-h`} data-testid={`brand-${id}`}>
      <h2 id={`${id}-h`} className="mb-1 text-lg font-bold">{title}</h2>
      {lead ? <p className="hint mb-3">{lead}</p> : null}
      {children}
    </section>
  );
}

/** „Woher kommt das?“ – source label, linked observation statements and reference names. */
export function Origin({ o, state }: { o: Provenance; state: DesignState }) {
  const obs = o.observationIds.map((id) => state.observations.find((x) => x.id === id)).filter(Boolean);
  const refs = o.referenceIds.map((id) => state.references.find((x) => x.id === id)).filter(Boolean);
  return (
    <span className="text-[10px] leading-snug text-muted" data-testid="origin">
      Herkunft: {PROVENANCE_LABELS[o.source]}{o.note ? ` · ${o.note}` : ''}
      {obs.length ? <> · {obs.map((x) => `„${x!.statement.slice(0, 60)}${x!.statement.length > 60 ? '…' : ''}“`).join(', ')}</> : null}
      {refs.length ? <> · Referenz {refs.map((x) => x!.name).join(', ')}</> : null}
    </span>
  );
}

const ROLE_OPTIONS = COLOR_ROLES.map((r) => <option key={r} value={r}>{COLOR_ROLE_LABELS[r].label}</option>);

export function ColorsSection({ d, set, state }: { d: DesignSystem; set: Setter; state: DesignState }) {
  const checks = contrastChecks(d.colors, d.presets.find((p) => p.id === d.defaultPresetId));
  const badge = (role: ColorRole) => checks.filter((c) => c.fg === role || c.bg === role);
  return (
    <Section id="farben" title="Farben" lead="Sieben Rollen statt einer losen Palette. Text auf Fläche und Text auf Akzent brauchen WCAG AA (mindestens 4,5:1).">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {COLOR_ROLES.map((role) => {
          const c = d.colors[role];
          return (
            <div key={role} className="rounded-xl border border-line p-3" data-testid={`color-${role}`}>
              <div className="mb-2 h-14 rounded-lg border border-black/10" style={{ background: c.hex }} />
              <div className="flex items-center justify-between gap-2"><strong className="text-sm">{COLOR_ROLE_LABELS[role].label}</strong><span className="font-mono text-[11px]" data-testid="color-hex">{c.hex}</span></div>
              <p className="hint m-0">{COLOR_ROLE_LABELS[role].hint}</p>
              <div className="mt-2 flex items-center gap-2">
                <input type="color" aria-label={`${COLOR_ROLE_LABELS[role].label}: Farbe wählen`} value={c.hex.toLowerCase()} onChange={(e) => set((x) => ({ ...x, colors: { ...x.colors, [role]: { hex: e.target.value.toUpperCase(), origin: manual() } } }))} className="h-8 w-10 cursor-pointer rounded border border-line" />
                <input aria-label={`${COLOR_ROLE_LABELS[role].label} (#RRGGBB)`} className="field py-1 font-mono text-xs" defaultValue={c.hex} key={c.hex} onBlur={(e) => {
                  const v = e.target.value.trim().toUpperCase();
                  if (HEX.test(v) && v !== c.hex) set((x) => ({ ...x, colors: { ...x.colors, [role]: { hex: v, origin: manual() } } }));
                }} />
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {badge(role).map((b) => <Pill key={b.label} tone={b.aa ? 'ok' : 'danger'}>{b.label}: {b.ratio.toFixed(1)}:1 {b.aa ? 'AA' : 'unter AA'}</Pill>)}
              </div>
              <div className="mt-1"><Origin o={c.origin} state={state} /></div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const ANIM_ROLES = new Set(['hook', 'lowerThird', 'keyword']);

export function TypeSection({ d, set, state, fontsSlot, reloadFonts }: { d: DesignSystem; set: Setter; state: DesignState; fontsSlot: ReactNode; reloadFonts?: () => Promise<void> }) {
  return (
    <Section id="schriften" title="Schriften" lead="Je Rolle eine Schrift: Studio-Liste, auf deinem Mac installierte Schriften, Google Fonts (Ein-Klick-Hinzufügen mit Lizenzvermerk) oder eigene Dateien. Eine Zuordnung aus Beobachtungen ist immer eine Annäherung.">
      <div className="grid gap-2">
        {TYPE_ROLES.map((role) => {
          const t = d.typography[role];
          const upd = (patch: Partial<typeof t>) => set((x) => ({ ...x, typography: { ...x.typography, [role]: { ...x.typography[role], ...patch, origin: manual() } } }));
          const custom = t.font.startsWith('custom:');
          const mac = t.font.startsWith('mac:');
          return (
            <div key={role} className="grid items-center gap-2 rounded-xl border border-line p-3 md:grid-cols-[130px_minmax(0,1fr)_auto]" data-testid={`type-${role}`}>
              <strong className="text-sm">{TYPE_ROLE_LABELS[role]}</strong>
              <div className="min-w-0">
                <p className="m-0 truncate text-2xl" style={{ fontFamily: cssFont(t.font, t.face?.family), fontWeight: cssWeight(t), fontStyle: mac && t.face?.italic ? 'italic' : undefined, textTransform: t.textCase === 'upper' ? 'uppercase' : t.textCase === 'lower' ? 'lowercase' : 'none' }}>
                  {role.startsWith('carousel') ? 'Drei Dinge, die ich gelernt habe' : 'So sieht dein Text aus'}
                </p>
                <Origin o={t.origin} state={state} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <div className="w-56"><FontPicker label={TYPE_ROLE_LABELS[role]} testId={`type-${role}`} value={{ ref: t.font, ...(mac && t.face ? { face: t.face } : {}) }} studioFonts={state.fonts}
                  preferWeight={t.weight === 'bold' ? 700 : 400} onFontsAdded={reloadFonts}
                  onChange={(c) => c && upd({ font: c.ref, face: c.face, ...(c.face ? { weight: c.face.weight >= 600 ? 'bold' : 'regular' } : {}) })} /></div>
                <select aria-label={`${TYPE_ROLE_LABELS[role]}: Gewicht`} className="field w-auto py-1 text-xs" value={t.weight} disabled={custom || mac} title={custom ? 'Eigene Schrift: Schnitt kommt aus der Datei' : mac ? 'Mac-Schrift: Schnitt kommt aus der Auswahl' : undefined} onChange={(e) => upd({ weight: e.target.value as typeof t.weight })}>
                  <option value="bold">fett</option><option value="regular">normal</option>
                </select>
                <select aria-label={`${TYPE_ROLE_LABELS[role]}: Größe`} className="field w-auto py-1 text-xs" value={t.size} onChange={(e) => upd({ size: e.target.value as typeof t.size })}>
                  <option value="S">S</option><option value="M">M</option><option value="L">L</option>
                </select>
                <select aria-label={`${TYPE_ROLE_LABELS[role]}: Schreibweise`} className="field w-auto py-1 text-xs" value={t.textCase} onChange={(e) => upd({ textCase: e.target.value as typeof t.textCase })}>
                  <option value="none">wie geschrieben</option><option value="upper">VERSALIEN</option><option value="lower">klein</option>
                </select>
                {ANIM_ROLES.has(role) ? (
                  <select aria-label={`${TYPE_ROLE_LABELS[role]}: Animation`} className="field w-auto py-1 text-xs" value={t.animation ?? ''} onChange={(e) => upd({ animation: (e.target.value || undefined) as typeof t.animation })} data-testid={`type-${role}-anim`}>
                    <option value="">Animation wie der Stil</option>
                    {TEXT_ANIMS.map((a) => <option key={a} value={a}>{TEXT_ANIM_LABELS[a]}</option>)}
                  </select>
                ) : role === 'subtitle' ? (
                  <>
                    <select aria-label="Untertitel: Darstellung" className="field w-auto py-1 text-xs" value={t.subtitleMode ?? 'lines'} onChange={(e) => upd({ subtitleMode: e.target.value === 'lines' ? undefined : e.target.value as typeof t.subtitleMode })} data-testid="type-subtitle-mode">
                      {SUBTITLE_MODES.map((m) => <option key={m} value={m}>{SUBTITLE_MODE_LABELS[m]}</option>)}
                    </select>
                    {t.subtitleMode === 'karaoke' ? (
                      <select aria-label="Untertitel: Wörter je Zeile" className="field w-auto py-1 text-xs" value={t.wordsPerLine ?? 3} onChange={(e) => upd({ wordsPerLine: Number(e.target.value) })}>
                        {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'Wort' : 'Wörter'}/Zeile</option>)}
                      </select>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {fontsSlot}
    </Section>
  );
}

export function PresetsSection({ d, set, specimen }: { d: DesignSystem; set: Setter; specimen: (presetId: string) => ReactNode }) {
  const [sel, setSel] = useState(d.defaultPresetId);
  const preset = d.presets.find((p) => p.id === sel) ?? d.presets[0]!;
  const upd = (patch: Partial<OverlayPreset>) => set((x) => ({ ...x, presets: x.presets.map((p) => (p.id === preset.id ? { ...p, ...patch, origin: manual() } : p)) }));
  const part = <K extends 'hook' | 'lowerThird' | 'keyword'>(k: K, patch: Partial<OverlayPreset[K]>) => upd({ [k]: { ...preset[k], ...patch } } as Partial<OverlayPreset>);
  const role = (label: string, value: ColorRole, onChange: (r: ColorRole) => void) => (
    <label className="grid gap-0.5 text-[11px]"><span className="text-muted">{label}</span>
      <select className="field py-1 text-xs" value={value} onChange={(e) => onChange(e.target.value as ColorRole)} aria-label={`${preset.name}: ${label}`}>{ROLE_OPTIONS}</select>
    </label>
  );
  const add = () => {
    const n = d.presets.length + 1;
    if (n > 8) return;
    const id = `stil-${n}-${Math.random().toString(36).slice(2, 6)}`;
    set((x) => ({ ...x, presets: [...x.presets, { ...preset, id, name: `${preset.name} Kopie`, origin: manual('Kopie') }] }));
    setSel(id);
  };
  return (
    <Section id="overlays" title="Overlay-Stile" lead="So stehen Hook, Bauchbinde, Keyword und Untertitel im Reel. Im Video-Editor wählst du pro Schnitt einen dieser Stile.">
      <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Overlay-Stile">
        {d.presets.map((p) => (
          <button key={p.id} role="tab" aria-selected={p.id === preset.id} onClick={() => setSel(p.id)} className={`rounded-full border px-3 py-1 text-xs ${p.id === preset.id ? 'border-accent bg-[#eef6dc] font-semibold' : 'border-line'}`}>
            {p.name}{p.id === d.defaultPresetId ? ' · Standard' : ''}
          </button>
        ))}
        <Button size="sm" variant="ghost" onClick={add} disabled={d.presets.length >= 8}>+ Stil</Button>
      </div>
      <div className="flex flex-wrap gap-5">
        <div className="grid content-start gap-2">
          <StagePreview design={d} preset={preset} />
          {specimen(preset.id)}
        </div>
        <div className="grid min-w-[260px] flex-1 content-start gap-3 text-xs">
          <Field label="Name" htmlFor="preset-name"><input id="preset-name" className="field" maxLength={60} value={preset.name} onChange={(e) => upd({ name: e.target.value })} /></Field>
          <fieldset className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-3"><legend className="px-1 font-semibold">Hook</legend>
            <label className="grid gap-0.5 text-[11px]"><span className="text-muted">Form</span><select className="field py-1 text-xs" aria-label={`${preset.name}: Hook-Form`} value={preset.hook.shape} onChange={(e) => part('hook', { shape: e.target.value as 'box' })}><option value="box">Box</option><option value="outline">ohne Box (Kontur)</option></select></label>
            {role(preset.hook.shape === 'box' ? 'Box' : 'Kontur', preset.hook.fill, (r) => part('hook', { fill: r }))}
            {role('Text', preset.hook.text, (r) => part('hook', { text: r }))}
          </fieldset>
          <fieldset className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-4"><legend className="px-1 font-semibold">Bauchbinde</legend>
            <label className="grid gap-0.5 text-[11px]"><span className="text-muted">Form</span><select className="field py-1 text-xs" aria-label={`${preset.name}: Bauchbinden-Form`} value={preset.lowerThird.shape} onChange={(e) => part('lowerThird', { shape: e.target.value as 'stripe' })}><option value="stripe">Box mit Streifen</option><option value="box">Box</option><option value="outline">ohne Box (Kontur)</option></select></label>
            {role(preset.lowerThird.shape === 'outline' ? 'Kontur' : 'Box', preset.lowerThird.fill, (r) => part('lowerThird', { fill: r }))}
            {role('Streifen', preset.lowerThird.stripe, (r) => part('lowerThird', { stripe: r }))}
            {role('Text', preset.lowerThird.text, (r) => part('lowerThird', { text: r }))}
          </fieldset>
          <fieldset className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-3"><legend className="px-1 font-semibold">Keyword</legend>
            <label className="grid gap-0.5 text-[11px]"><span className="text-muted">Form</span><select className="field py-1 text-xs" aria-label={`${preset.name}: Keyword-Form`} value={preset.keyword.shape} onChange={(e) => part('keyword', { shape: e.target.value as 'box' })}><option value="box">Box</option><option value="outline">ohne Box (Kontur)</option></select></label>
            {role(preset.keyword.shape === 'box' ? 'Box' : 'Kontur', preset.keyword.fill, (r) => part('keyword', { fill: r }))}
            {role('Text', preset.keyword.text, (r) => part('keyword', { text: r }))}
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-4">
            {role('Pfeile, Rahmen', preset.graphic, (r) => upd({ graphic: r }))}
            <label className="grid gap-0.5 text-[11px]"><span className="text-muted">Hook-Position</span><select className="field py-1 text-xs" value={preset.hookSlot} onChange={(e) => upd({ hookSlot: e.target.value as 'upper' })}>{Object.entries(SLOT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="grid gap-0.5 text-[11px]"><span className="text-muted">Overlay-Position</span><select className="field py-1 text-xs" value={preset.overlaySlot} onChange={(e) => upd({ overlaySlot: e.target.value as 'center' })}>{Object.entries(SLOT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="grid gap-0.5 text-[11px]"><span className="text-muted">Animation</span><select className="field py-1 text-xs" value={preset.animation} onChange={(e) => upd({ animation: e.target.value as 'fade' })}><option value="fade">einblenden</option><option value="none">keine</option></select></label>
          </div>
          <div className="flex flex-wrap gap-2">
            {preset.id !== d.defaultPresetId ? <Button size="sm" onClick={() => set((x) => ({ ...x, defaultPresetId: preset.id }))}>Als Standard</Button> : null}
            {preset.id !== d.defaultPresetId ? <Button size="sm" variant="danger" onClick={() => { set((x) => ({ ...x, presets: x.presets.filter((p) => p.id !== preset.id) })); setSel(d.defaultPresetId); }}>Stil löschen</Button> : null}
          </div>
        </div>
      </div>
    </Section>
  );
}

export function MotionSection({ d, set, state }: { d: DesignSystem; set: Setter; state: DesignState }) {
  const m = d.motion;
  const upd = (patch: Partial<typeof m>) => set((x) => ({ ...x, motion: { ...x.motion, ...patch, origin: manual() } }));
  return (
    <Section id="bewegung" title="Bewegung und Schnitt" lead="Richtwerte für Schnitt und Dramaturgie (Video-Editor und spätere Vorschläge). Nichts davon schneidet automatisch.">
      <div className="grid gap-3 text-xs sm:grid-cols-4">
        <Field label="Ziel-Schnittlänge (s)" htmlFor="m-cut"><input id="m-cut" type="number" min={0.5} max={15} step={0.1} className="field" value={m.targetCutSec ?? ''} placeholder="offen" onChange={(e) => upd({ targetCutSec: e.target.value === '' ? null : Math.min(15, Math.max(0.5, Number(e.target.value))) })} /></Field>
        <Field label="Tempo" htmlFor="m-tempo"><select id="m-tempo" className="field" value={m.tempo} onChange={(e) => upd({ tempo: e.target.value as typeof m.tempo })}>{Object.entries(TEMPO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Zoom-Standard" htmlFor="m-zoom"><select id="m-zoom" className="field" value={m.zoom} onChange={(e) => upd({ zoom: e.target.value as typeof m.zoom })}>{Object.entries(ZOOM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <fieldset className="grid gap-1"><legend className="label">Erlaubte Übergänge</legend>
          {TRANSITIONS.map((t) => (
            <label key={t} className="flex items-center gap-2"><input type="checkbox" checked={m.transitions.includes(t)} onChange={(e) => {
              const next = e.target.checked ? [...m.transitions, t] : m.transitions.filter((x) => x !== t);
              upd({ transitions: next.length ? next : ['hard_cut'] });
            }} /> {TRANSITION_LABELS[t]}</label>
          ))}
        </fieldset>
      </div>
      <Origin o={m.origin} state={state} />
    </Section>
  );
}

export function ImagerySection({ d, set, state }: { d: DesignSystem; set: Setter; state: DesignState }) {
  const im = d.imagery;
  const upd = (patch: Partial<typeof im>) => set((x) => ({ ...x, imagery: { ...x.imagery, ...patch, origin: { ...x.imagery.origin, source: 'manual' } } }));
  const images = state.references.filter((r) => r.kind === 'image');
  return (
    <Section id="bildlook" title="Bildlook" lead="Stichworte, Licht und Farbtemperatur deiner Bilder, dazu die Referenzbilder, die den Look zeigen (Inspiration, keine Vorlage zum Kopieren).">
      <div className="grid gap-3 text-xs md:grid-cols-3">
        <Field label="Stichworte (Komma)" htmlFor="im-kw"><input id="im-kw" className="field" defaultValue={im.keywords.join(', ')} key={im.keywords.join('|')} onBlur={(e) => upd({ keywords: [...new Set(e.target.value.split(',').map((x) => x.trim().slice(0, 80)).filter(Boolean))].slice(0, 20) })} /></Field>
        <Field label="Licht" htmlFor="im-light"><input id="im-light" className="field" maxLength={600} value={im.light} onChange={(e) => upd({ light: e.target.value })} /></Field>
        <Field label="Farbtemperatur" htmlFor="im-temp"><select id="im-temp" className="field" value={im.temperature ?? ''} onChange={(e) => upd({ temperature: (e.target.value || null) as typeof im.temperature })}><option value="">offen</option>{TEMPERATURES.map((t) => <option key={t} value={t}>{TEMPERATURE_LABELS[t]}</option>)}</select></Field>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8" data-testid="imagery-refs">
        {images.length ? images.map((r) => {
          const on = im.referenceIds.includes(r.id);
          return (
            <label key={r.id} className={`relative cursor-pointer overflow-hidden rounded-lg border-2 ${on ? 'border-accent' : 'border-transparent'}`} title={r.name}>
              <input type="checkbox" className="absolute top-1 left-1" checked={on} aria-label={`${r.name} als Bildlook`} onChange={() => set((x) => ({
                ...x, imagery: { ...x.imagery, referenceIds: on ? x.imagery.referenceIds.filter((id) => id !== r.id) : [...x.imagery.referenceIds, r.id].slice(0, 24), origin: { ...x.imagery.origin, referenceIds: on ? x.imagery.origin.referenceIds.filter((id) => id !== r.id) : [...new Set([...x.imagery.origin.referenceIds, r.id])].slice(0, 24) } },
              }))} />
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated local media route */}
              <img src={`/api/media/${r.id}`} alt="" className="aspect-square w-full object-cover" />
            </label>
          );
        }) : <p className="hint col-span-full">Noch keine Referenzbilder – im Style Lab hochladen.</p>}
      </div>
      <div className="mt-2"><Origin o={im.origin} state={state} /></div>
    </Section>
  );
}

export function WordsSection({ d, set, state }: { d: DesignSystem; set: Setter; state: DesignState }) {
  const [word, setWord] = useState('');
  const has = new Set(d.phrases.map((p) => p.text));
  const fromVoice = state.voicePhrases.filter((p) => !has.has(p));
  const addAll = (texts: string[], origin: Provenance) => set((x) => ({ ...x, phrases: [...x.phrases, ...texts.filter((t) => !x.phrases.some((p) => p.text === t)).map((text) => ({ text: text.slice(0, 160), origin }))].slice(0, 40) }));
  return (
    <Section id="woerter" title="Eigene Wörter und Phrasen" lead="Wörter, die nach dir klingen. Die KI nutzt sie als Hinweis, nicht als Pflicht.">
      <div className="flex flex-wrap gap-1.5" data-testid="phrases">
        {d.phrases.map((p) => (
          <span key={p.text} className="tag" title={`Herkunft: ${PROVENANCE_LABELS[p.origin.source]}`}>
            {p.text}
            <button type="button" className="ml-1 text-muted hover:text-danger" aria-label={`${p.text} entfernen`} onClick={() => set((x) => ({ ...x, phrases: x.phrases.filter((y) => y.text !== p.text) }))}>×</button>
          </span>
        ))}
        {!d.phrases.length ? <span className="hint">Noch keine.</span> : null}
      </div>
      <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (word.trim()) addAll([word.trim()], manual()); setWord(''); }}>
        <input aria-label="Neues Wort oder neue Phrase" className="field max-w-sm py-1.5" maxLength={160} value={word} onChange={(e) => setWord(e.target.value)} placeholder="z. B. „einfach mal ausprobieren“" />
        <Button size="sm" type="submit">Hinzufügen</Button>
        {fromVoice.length ? <Button size="sm" variant="ghost" type="button" onClick={() => addAll(fromVoice, { source: 'voice', observationIds: [], referenceIds: [], note: 'aus dem Voice-Vorschlag (wörtlich aus deinen Texten)' })}>Aus Voice übernehmen ({fromVoice.length})</Button> : null}
      </form>
      {state.voice ? <p className="hint mt-2">Voice Guide v{state.voice.version}: {state.voice.traits.join(', ') || 'keine Merkmale'}</p> : null}
    </Section>
  );
}

export function GuidelinesSection({ d, set, state }: { d: DesignSystem; set: Setter; state: DesignState }) {
  return (
    <Section id="leitlinien" title="Leitlinien für die KI" lead="Freier Text, den Agenten als deine Regeln lesen (z. B. „Hook immer als Frage“, „keine Emojis im Bild“).">
      <textarea aria-label="Leitlinien für die KI" rows={5} maxLength={2000} className="field" value={d.guidelines} onChange={(e) => set((x) => ({ ...x, guidelines: e.target.value, guidelinesOrigin: { ...x.guidelinesOrigin, source: 'manual' } }))} />
      <div className="flex justify-between"><Origin o={d.guidelinesOrigin} state={state} /><span className="text-[10px] text-muted">{d.guidelines.length}/2000</span></div>
    </Section>
  );
}

/** Every token and where it comes from, in one table. */
export function ProvenanceSection({ d, state }: { d: DesignSystem; state: DesignState }) {
  const rows: [string, Provenance][] = [
    ...COLOR_ROLES.map((r): [string, Provenance] => [`Farbe · ${COLOR_ROLE_LABELS[r].label}`, d.colors[r].origin]),
    ...TYPE_ROLES.map((r): [string, Provenance] => [`Schrift · ${TYPE_ROLE_LABELS[r]}`, d.typography[r].origin]),
    ...d.presets.map((p): [string, Provenance] => [`Overlay-Stil · ${p.name}`, p.origin]),
    ['Bewegung', d.motion.origin], ['Bildlook', d.imagery.origin], ['Leitlinien', d.guidelinesOrigin],
  ];
  return (
    <Section id="herkunft" title="Herkunft" lead="Jedes Token mit seiner Quelle. Verweise auf Beobachtungen gelten nur, solange sie bestätigt sind.">
      <table className="w-full text-left text-xs">
        <tbody>
          {rows.map(([label, o]) => (
            <tr key={label} className="border-t border-line align-top"><td className="py-1.5 pr-3 font-semibold whitespace-nowrap">{label}</td><td className="py-1.5"><Origin o={o} state={state} /></td></tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
