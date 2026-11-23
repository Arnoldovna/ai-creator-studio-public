'use client';
import { useState } from 'react';
import type { EditDraftBody } from '@studio/core/edit';
import { placeElement, type NormPos, type PlaceTarget, type Slot } from '@studio/core/overlayLayout';
import { overlayHasText, TEXT_LIMIT, type ClipOverlay, type ElementSize, type OverlayKind, type PlanHook } from '@studio/core/overlays';
import { HOOK_MAX_SEC, removeOverlay, retimeOverlay, setHook, updateOverlay, type TimelineView } from '@studio/core/timelineView';
import { SlopHints } from '../../SlopHints';
import { Button, Field } from '../../ui';
import { KIND_LABEL, type ElementRef } from './StageGraphics';
import { TEXT_ANIM_LABELS, TEXT_ANIMS, type TextAnim } from '@studio/core/textAnim';
import type { ElementFont } from '@studio/core/designSystem';
import { FontPicker, type StudioFont } from '../../fonts/FontPicker';

/**
 * Inspector of the selected hook or overlay (Etappe 13): text, kind, overlay style from „Meine Marke“, size step, time
 * and position. Text edits are live on the stage (`onPreview`) and become one undo step when the field is left
 * (`onCommit`); every other control is one undo step (`onApply`). Problems of this element come from the draft check.
 */
const SLOT_LABEL: Record<Slot, string> = { upper: 'Platz oben', center: 'Platz Mitte', lower: 'Platz unten' };
const SIZES: (ElementSize | 'role')[] = ['role', 'S', 'M', 'L'];
type Fn = (b: EditDraftBody) => EditDraftBody;

export interface InspectorProps {
  body: EditDraftBody;
  view: TimelineView;
  sel: ElementRef;
  presets: readonly { id: string; name: string }[];
  defaultPresetName: string | null;
  personal: boolean;
  script: { selectedHook: string; hookVariants: readonly string[] } | null;
  issues: { errors: readonly string[]; warnings: readonly string[] };
  /** Etappe 16b: the studio font list (system, her own and Google fonts) for an element's own font. */
  fonts: readonly StudioFont[];
  /** After a Google font was added in the picker: reload the studio font list. */
  onFontsAdded?: () => Promise<void>;
  onApply: (fn: Fn) => void;
  onPreview: (fn: Fn) => void;
  onCommit: () => void;
  onSelect: (ref: ElementRef | null) => void;
  onSeek: (t: number) => void;
}

function PositionControls({ slot, pos, target, onChange }: { slot: Slot; pos?: NormPos; target: PlaceTarget; onChange: (patch: { slot?: Slot; pos?: NormPos | undefined }) => void }) {
  const setXY = (x: number, y: number) => {
    const p = placeElement(target, (x / 100) * 1080, (y / 100) * 1920, { free: true });
    if (p?.pos) onChange({ pos: p.pos });
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Position" htmlFor="ins-pos">
        <select id="ins-pos" className="field w-auto" value={pos ? 'free' : slot} onChange={(e) => {
          const v = e.target.value;
          if (v === 'free') setXY(50, 50);
          else onChange({ slot: v as Slot, pos: undefined });
        }}>
          {(Object.keys(SLOT_LABEL) as Slot[]).map((s) => <option key={s} value={s}>{SLOT_LABEL[s]}</option>)}
          <option value="free">frei (auf der Bühne ziehen)</option>
        </select>
      </Field>
      {pos ? (
        <>
          <Field label="X %" htmlFor="ins-x"><input id="ins-x" key={`x${pos.x}`} className="field w-20" type="number" min={0} max={100} step={1} defaultValue={Math.round(pos.x * 1000) / 10}
            onBlur={(e) => setXY(Number(e.target.value), pos.y * 100)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></Field>
          <Field label="Y %" htmlFor="ins-y"><input id="ins-y" key={`y${pos.y}`} className="field w-20" type="number" min={0} max={100} step={1} defaultValue={Math.round(pos.y * 1000) / 10}
            onBlur={(e) => setXY(pos.x * 100, Number(e.target.value))} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></Field>
        </>
      ) : null}
    </div>
  );
}

function StyleControls({ presetId, size, presets, defaultPresetName, onChange }: { presetId?: string; size?: ElementSize; presets: InspectorProps['presets']; defaultPresetName: string | null; onChange: (patch: { presetId?: string | undefined; size?: ElementSize | undefined }) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Stil (Meine Marke)" htmlFor="ins-style">
        <select id="ins-style" className="field w-auto" value={presetId ?? ''} disabled={!presets.length} onChange={(e) => onChange({ presetId: e.target.value || undefined })}>
          <option value="">{defaultPresetName ? `wie der Schnitt („${defaultPresetName}“)` : 'wie der Schnitt'}</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <div role="group" aria-label="Größe" className="flex items-center gap-1 text-[11px]">
        <span className="text-muted">Größe</span>
        {SIZES.map((s) => (
          <button key={s} type="button" className={`rounded border px-2 py-0.5 ${(size ?? 'role') === s ? 'border-lime bg-lime text-olive-ink' : 'border-line'}`} aria-pressed={(size ?? 'role') === s}
            data-testid={`ins-size-${s}`} onClick={() => onChange({ size: s === 'role' ? undefined : s })}>{s === 'role' ? 'Standard' : s}</button>
        ))}
      </div>
    </div>
  );
}

/** Etappe 16b: the element's own font (else its role's in Meine Marke) and its animation (else the role's / style's). */
function FontAnimControls({ font, anim, fonts, withFont, onChange, onFontsAdded }: { font?: ElementFont; anim?: TextAnim; fonts: readonly StudioFont[]; withFont: boolean; onFontsAdded?: () => Promise<void>; onChange: (patch: { font?: ElementFont | undefined; anim?: TextAnim | undefined }) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      {withFont ? (
        <div className="grid gap-0.5"><span className="text-[11px] text-muted">Schrift</span>
          <div className="w-56"><FontPicker label="Element" testId="ins-font" value={font ?? null} studioFonts={fonts} allowInherit="wie die Rolle (Meine Marke)" onFontsAdded={onFontsAdded}
            onChange={(c) => onChange({ font: c ? { ref: c.ref, ...(c.face ? { face: c.face } : {}) } : undefined })} /></div>
        </div>
      ) : null}
      <Field label="Animation" htmlFor="ins-anim">
        <select id="ins-anim" className="field w-auto" value={anim ?? ''} data-testid="ins-anim" onChange={(e) => onChange({ anim: (e.target.value || undefined) as TextAnim | undefined })}>
          <option value="">wie Rolle/Stil</option>
          {TEXT_ANIMS.map((a) => <option key={a} value={a}>{TEXT_ANIM_LABELS[a]}</option>)}
        </select>
      </Field>
    </div>
  );
}

function Problems({ issues, prefix }: { issues: InspectorProps['issues']; prefix: string }) {
  const mine = (xs: readonly string[]) => xs.filter((x) => x.startsWith(prefix));
  const e = mine(issues.errors), w = mine(issues.warnings);
  if (!e.length && !w.length) return null;
  return (
    <ul className="m-0 mt-2 list-disc pl-5" data-testid="inspector-issues">
      {e.map((x) => <li key={x} className="text-danger">{x}</li>)}
      {w.map((x) => <li key={x} className="text-warn">{x}</li>)}
    </ul>
  );
}

/** A text field that previews every keystroke and commits on leave; an empty text is never sent (Keyword/Bauchbinde need one). */
function LiveText({ id, value, max, onPreview, onCommit, label }: { id: string; value: string; max: number; onPreview: (v: string) => void; onCommit: () => void; label: string }) {
  const [text, setText] = useState(value);
  return (
    <Field label={`${label} (höchstens ${max} Zeichen)`} htmlFor={id}>
      <input id={id} className="field w-72" value={text} maxLength={max} data-testid="ins-text"
        onChange={(e) => { setText(e.target.value); if (e.target.value.trim()) onPreview(e.target.value); }}
        onBlur={onCommit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </Field>
  );
}

export function OverlayInspector(p: InspectorProps) {
  const { sel, body, view } = p;
  if (sel.type === 'hook') return <HookInspector {...p} hook={body.hook} />;
  const o = body.clips[sel.clip]?.overlays[sel.index];
  const vo = view.overlays.find((x) => x.clip === sel.clip && x.index === sel.index);
  if (!o) return null;
  const name = `Clip ${sel.clip + 1}, Overlay ${sel.index + 1}`;
  const upd = (patch: Partial<ClipOverlay>) => p.onApply((b) => updateOverlay(b, sel.clip, sel.index, patch));
  const target: PlaceTarget = { kind: o.kind, text: vo?.text ?? o.text, scale: vo?.scale };
  return (
    <div className="rounded-lg border border-lime/70 bg-card p-3 text-xs" data-testid="overlay-inspector" aria-label={`Inspector ${name}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong>{KIND_LABEL[o.kind]}</strong><span className="text-muted">{name}{vo ? ` · ${vo.startSec.toFixed(1)}–${vo.endSec.toFixed(1)} s im Schnitt` : ' · liegt ganz in einem Schnitt (nicht sichtbar)'}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => p.onSelect(null)}>Schließen</Button>
        <Button size="sm" variant="ghost" data-testid="ins-remove" onClick={() => { p.onApply((b) => removeOverlay(b, sel.clip, sel.index)); p.onSelect(null); }}>Entfernen</Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Art" htmlFor="ins-kind">
          <select id="ins-kind" className="field w-auto" value={o.kind} onChange={(e) => {
            const kind = e.target.value as OverlayKind;
            const text = overlayHasText(kind) ? (o.text || 'Text').slice(0, TEXT_LIMIT[kind as 'keyword' | 'lower_third']) : '';
            upd({ kind, text });
          }}>
            {(Object.keys(KIND_LABEL) as OverlayKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        {overlayHasText(o.kind) ? (
          <LiveText key={`${sel.clip}-${sel.index}-${o.kind}`} id="ins-text" label="Text" value={o.text} max={TEXT_LIMIT[o.kind as 'keyword' | 'lower_third']}
            onPreview={(v) => p.onPreview((b) => updateOverlay(b, sel.clip, sel.index, { text: v }))} onCommit={p.onCommit} />
        ) : null}
        {o.kind === 'arrow' ? (
          <Field label="Richtung" htmlFor="ins-dir">
            <select id="ins-dir" className="field w-auto" value={o.direction} onChange={(e) => upd({ direction: e.target.value as ClipOverlay['direction'] })}>
              <option value="down">↓ nach unten</option><option value="up">↑ nach oben</option><option value="left">← nach links</option><option value="right">→ nach rechts</option>
            </select>
          </Field>
        ) : null}
      </div>
      {overlayHasText(o.kind) ? <SlopHints text={o.text} where="overlay" testId="ins-slop" /> : null}
      {!p.personal && overlayHasText(o.kind) ? <p className="hint mt-1 mb-0">Kundenprojekt: Text nur wörtlich aus dem freigegebenen Skript (Zitat-Regel, wird geprüft).</p> : null}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <StyleControls presetId={o.presetId} size={o.size} presets={p.presets} defaultPresetName={p.defaultPresetName} onChange={upd} />
        <FontAnimControls font={o.font} anim={o.anim} fonts={p.fonts} withFont={overlayHasText(o.kind)} onChange={upd} onFontsAdded={p.onFontsAdded} />
        {vo ? (
          <>
            <Field label="Start im Schnitt (s)" htmlFor="ins-start"><input id="ins-start" key={`s${vo.startSec}`} className="field w-20" type="number" step={0.1} min={0} defaultValue={vo.startSec.toFixed(2)}
              onBlur={(e) => { const a = Number(e.target.value); if (Number.isFinite(a)) p.onApply((b) => retimeOverlay(b, sel.clip, sel.index, a, a + (vo.endSec - vo.startSec), 'move')); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></Field>
            <Field label="Dauer (s)" htmlFor="ins-dur"><input id="ins-dur" key={`d${vo.endSec - vo.startSec}`} className="field w-20" type="number" step={0.1} min={0.3} defaultValue={(vo.endSec - vo.startSec).toFixed(2)}
              onBlur={(e) => { const d = Number(e.target.value); if (Number.isFinite(d)) p.onApply((b) => retimeOverlay(b, sel.clip, sel.index, vo.startSec, vo.startSec + d, 'end')); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></Field>
            <Button size="sm" variant="ghost" onClick={() => p.onSeek(vo.startSec)}>Hinspringen</Button>
          </>
        ) : null}
      </div>
      {o.kind !== 'frame' ? <div className="mt-2"><PositionControls slot={o.slot} pos={o.pos} target={target} onChange={upd} /></div> : <p className="hint mt-2 mb-0">Der Rahmen liegt immer um den Inhaltsbereich.</p>}
      <Problems issues={p.issues} prefix={name} />
    </div>
  );
}

function HookInspector(p: InspectorProps & { hook: PlanHook | null }) {
  const h = p.hook;
  if (!h) return null;
  const upd = (patch: Partial<PlanHook>) => p.onApply((b) => setHook(b, patch));
  const scripted = !!p.script;
  const target: PlaceTarget = { kind: 'hook', text: p.view.hook?.text ?? h.text, scale: p.view.hook?.scale };
  return (
    <div className="rounded-lg border border-lime/70 bg-card p-3 text-xs" data-testid="overlay-inspector" aria-label="Inspector Hook">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong>Hook</strong><span className="text-muted">ab 0 s, {h.endSec.toFixed(1)} s lang</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => p.onSelect(null)}>Schließen</Button>
        <Button size="sm" variant="ghost" data-testid="ins-remove" onClick={() => { p.onApply((b) => setHook(b, null)); p.onSelect(null); }}>Entfernen</Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {scripted ? (
          <Field label="Hook aus dem Skript" htmlFor="ins-hook-src">
            <select id="ins-hook-src" className="field w-72" value={h.source === 'variant' ? `v${h.variantIndex}` : 'selected'}
              onChange={(e) => upd(e.target.value === 'selected' ? { source: 'selected', variantIndex: null } : { source: 'variant', variantIndex: Number(e.target.value.slice(1)) })}>
              <option value="selected">Ausgewählter Hook: {p.script!.selectedHook.slice(0, 50)}</option>
              {p.script!.hookVariants.map((v, i) => <option key={i} value={`v${i}`}>Variante {i + 1}: {v.slice(0, 50)}</option>)}
            </select>
          </Field>
        ) : (
          <LiveText key="hook" id="ins-hook-text" label="Hook-Text" value={h.text} max={TEXT_LIMIT.free_hook}
            onPreview={(v) => p.onPreview((b) => setHook(b, { text: v }))} onCommit={p.onCommit} />
        )}
        <SlopHints text={h.text} where="hook" testId="ins-hook-slop" />
        <Field label="Dauer (s)" htmlFor="ins-hook-end"><input id="ins-hook-end" key={`e${h.endSec}`} className="field w-20" type="number" min={0.5} max={HOOK_MAX_SEC} step={0.1} defaultValue={h.endSec}
          onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) upd({ endSec: v }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></Field>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <StyleControls presetId={h.presetId} size={h.size} presets={p.presets} defaultPresetName={p.defaultPresetName} onChange={upd} />
        <FontAnimControls font={h.font} anim={h.anim} fonts={p.fonts} withFont onChange={upd} onFontsAdded={p.onFontsAdded} />
      </div>
      <div className="mt-2"><PositionControls slot={h.slot} pos={h.pos} target={target} onChange={upd} /></div>
      <Problems issues={p.issues} prefix="Hook" />
    </div>
  );
}

