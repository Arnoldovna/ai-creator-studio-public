'use client';
import { HEX } from '@studio/core/schemas';
import { useState } from 'react';
import type { StyleBibleVersion, VoiceGuideVersion } from '@/lib/types';
import { Button, ErrorNote, Field } from '../ui';

type StyleRules = StyleBibleVersion['rules'];
type VoiceRules = VoiceGuideVersion['rules'];

/**
 * Editable chips: each entry can be changed in place or removed (✕), new ones are added below.
 * Empty entries are dropped on save by the caller (`clean`).
 */
export function ChipList({ label, items, onChange, tone, max = 40, maxChars = 160, multiline }: {
  label: string; items: string[]; onChange: (next: string[]) => void; tone?: 'avoid'; max?: number; maxChars?: number; multiline?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (!t || items.length >= max) return;
    onChange([...items, t.slice(0, maxChars)]);
    setDraft('');
  };
  return (
    <div className="mt-3" data-testid={`chips-${label}`}>
      <div className="label">{label}</div>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((t, i) => (
          <li key={i} className={`tag flex items-center gap-1 ${tone === 'avoid' ? 'tag-avoid' : ''}`}>
            {multiline ? (
              <textarea aria-label={`${label} ${i + 1}`} rows={2} maxLength={maxChars} className="min-w-[220px] border-0 bg-transparent text-[12px] outline-none"
                value={t} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
            ) : (
              <input aria-label={`${label} ${i + 1}`} maxLength={maxChars} className="border-0 bg-transparent text-[12px] outline-none" size={Math.max(4, t.length)}
                value={t} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
            )}
            <button type="button" className="text-[10px]" aria-label={`„${t}“ entfernen`} onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ul>
      {items.length < max ? (
        <div className="mt-2 flex gap-2">
          <input aria-label={`Neu: ${label}`} className="field max-w-sm py-1.5" value={draft} maxLength={maxChars}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <Button size="sm" onClick={add} disabled={!draft.trim()}>+ hinzufügen</Button>
        </div>
      ) : null}
    </div>
  );
}

/** Palette chips: colour picker plus hex field per colour, ✕ removes, „+ Farbe“ adds. */
export function PaletteChips({ colors, onChange, max = 12 }: { colors: string[]; onChange: (next: string[]) => void; max?: number }) {
  const set = (i: number, c: string) => onChange(colors.map((x, j) => (j === i ? c.toUpperCase() : x)));
  return (
    <div className="mt-3" data-testid="chips-palette">
      <div className="label">Farbwelt</div>
      <ul className="flex flex-wrap gap-2">
        {colors.map((c, i) => (
          <li key={i} className="tag flex items-center gap-1.5">
            <input type="color" aria-label={`Farbe ${i + 1} wählen`} className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0" value={HEX.test(c) ? c : '#000000'} onChange={(e) => set(i, e.target.value)} />
            <input aria-label={`Farbe ${i + 1}`} className={`w-[76px] border-0 bg-transparent font-mono text-[11px] outline-none ${HEX.test(c) ? '' : 'text-danger'}`} maxLength={7} value={c} onChange={(e) => set(i, e.target.value)} />
            <button type="button" className="text-[10px]" aria-label={`Farbe ${c} entfernen`} onClick={() => onChange(colors.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ul>
      {colors.length < max ? <Button size="sm" className="mt-2" onClick={() => onChange([...colors, '#888888'])}>+ Farbe</Button> : null}
    </div>
  );
}

const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Direct edit of the active Style Bible: „Speichern“ creates a new version that is active at once. */
export function StyleRulesEditor({ rules, busy, onSave, onCancel }: { rules: StyleRules; busy: boolean; onSave: (r: StyleRules) => Promise<void>; onCancel: () => void }) {
  const [r, setR] = useState<StyleRules>(structuredClone(rules));
  const [error, setError] = useState<string | null>(null);
  const visual = (p: Partial<StyleRules['visual']>) => setR((x) => ({ ...x, visual: { ...x.visual, ...p } }));
  const motion = (p: Partial<StyleRules['motion']>) => setR((x) => ({ ...x, motion: { ...x.motion, ...p } }));
  const save = async () => {
    const palette = r.visual.palette.map((c) => c.trim().toUpperCase());
    if (palette.some((c) => !HEX.test(c))) return setError('Jede Farbe braucht das Format #RRGGBB.');
    if (!r.name.trim()) return setError('Name fehlt.');
    setError(null);
    await onSave({
      ...r, name: r.name.trim(),
      visual: { ...r.visual, palette: [...new Set(palette)], traits: clean(r.visual.traits), avoid: clean(r.visual.avoid) },
      motion: { ...r.motion, transitions: clean(r.motion.transitions) },
    }).catch((e: Error) => setError(e.message));
  };
  const text = (key: 'typography' | 'lighting' | 'composition' | 'textures', label: string) => (
    <Field label={label} htmlFor={`rules-${key}`}><input id={`rules-${key}`} className="field" maxLength={600} value={r.visual[key]} onChange={(e) => visual({ [key]: e.target.value })} /></Field>
  );
  return (
    <div data-testid="style-rules-editor">
      <Field label="Name" htmlFor="rules-name"><input id="rules-name" className="field" maxLength={120} value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
      <PaletteChips colors={r.visual.palette} onChange={(palette) => visual({ palette })} />
      <ChipList label="Visuelle Eigenschaften" items={r.visual.traits} onChange={(traits) => visual({ traits })} />
      <ChipList label="Nicht erwünscht" tone="avoid" items={r.visual.avoid} onChange={(avoid) => visual({ avoid })} />
      <div className="grid gap-x-3 sm:grid-cols-2">
        {text('typography', 'Typografie')}
        {text('lighting', 'Licht')}
        {text('composition', 'Komposition')}
        {text('textures', 'Texturen')}
      </div>
      <Field label="Schnitt und Bewegung" htmlFor="rules-pacing"><input id="rules-pacing" className="field" maxLength={600} value={r.motion.pacing} onChange={(e) => motion({ pacing: e.target.value })} /></Field>
      <ChipList label="Übergänge" max={20} items={r.motion.transitions} onChange={(transitions) => motion({ transitions })} />
      <ErrorNote error={error} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={busy} onClick={save}>Speichern</Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Abbrechen</Button>
        <span className="hint">Speichern legt eine neue Version an und macht sie sofort aktiv. Die bisherige bleibt in der Historie.</span>
      </div>
    </div>
  );
}

/** Direct edit of the active Voice Guide (traits, avoid, own examples). */
export function VoiceRulesEditor({ rules, busy, onSave, onCancel }: { rules: VoiceRules; busy: boolean; onSave: (r: VoiceRules) => Promise<void>; onCancel: () => void }) {
  const [r, setR] = useState<VoiceRules>(structuredClone(rules));
  const [error, setError] = useState<string | null>(null);
  const save = () => onSave({ traits: clean(r.traits), avoid: clean(r.avoid), ownExamples: clean(r.ownExamples) }).catch((e: Error) => setError(e.message));
  return (
    <div className="mt-3 rounded-xl border border-line p-3" data-testid="voice-rules-editor">
      <ChipList label="So klinge ich" max={30} items={r.traits} onChange={(traits) => setR({ ...r, traits })} />
      <ChipList label="So nicht" tone="avoid" max={30} items={r.avoid} onChange={(avoid) => setR({ ...r, avoid })} />
      <ChipList label="Eigene Beispiele" max={20} maxChars={2000} multiline items={r.ownExamples} onChange={(ownExamples) => setR({ ...r, ownExamples })} />
      <ErrorNote error={error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" busy={busy} onClick={save}>Speichern</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Abbrechen</Button>
      </div>
    </div>
  );
}
