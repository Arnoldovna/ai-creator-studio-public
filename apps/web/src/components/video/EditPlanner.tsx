'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditPlanBody, LOUDNESS, MAX_SEGMENTS, ZOOM_AMOUNT, type ClipZoom, type CutRange, type EditClip, type LoudnessPreset, type ZoomKind } from '@studio/core/edit';
import { buildTimeline } from '@studio/core/timeline';
import { graphicsSummary, OVERLAY_FONTS, TEXT_LIMIT, type ClipOverlay, type LookTokens, type OverlayFont, type OverlayKind, type PlanHook, type Slot } from '@studio/core/overlays';
import { fmtBytes, fmtDuration } from '@studio/core/media';
import { editPlanLintParts } from '@studio/core/strategyLint';
import { api, useApi } from '@/lib/api';
import type { EditState, FootageList, TakeSuggestions } from '@/lib/types';
import { useToast } from '../toast';
import { CutSuggestions } from './CutSuggestions';
import { LEGACY_LABEL, LintMarker } from '../strategy/GateParts';
import { StrategyGateCard } from '../strategy/StrategyGateCard';
import { Button, Empty, ErrorNote, Field, fmtDateTime, Pill } from '../ui';
import { FinishExport } from './FinishExport';

type Draft = EditClip;
type Render = EditState['renders'][number];

const PLAN_STATUS = { draft: { label: 'Entwurf', tone: 'default' }, approved: { label: 'freigegeben', tone: 'ok' } } as const;
const RENDER_STATUS: Record<Render['status'], { label: string; tone: 'default' | 'warn' | 'ok' | 'danger' }> = {
  rendering: { label: 'rendert', tone: 'warn' },
  pending_review: { label: 'wartet auf Prüfung', tone: 'warn' },
  approved: { label: 'freigegeben', tone: 'ok' },
  rejected: { label: 'abgelehnt', tone: 'danger' },
  failed: { label: 'fehlgeschlagen', tone: 'danger' },
  cancelled: { label: 'abgebrochen', tone: 'default' },
};
const LOUDNESS_LABEL: Record<LoudnessPreset, string> = { ...Object.fromEntries(Object.entries(LOUDNESS).map(([k, v]) => [k, v.label])), off: 'Aus (Originalpegel)' } as Record<LoudnessPreset, string>;
const round = (n: number) => Math.round(n * 100) / 100;
const FREE = '__free';
const NO_ZOOM: ClipZoom = { kind: 'none', amount: ZOOM_AMOUNT.default, punchOnCuts: false };
const ZOOM_LABEL: Record<ZoomKind, string> = { none: 'kein Zoom', push_in: 'Push-in (langsam näher)', push_out: 'Push-out (langsam weiter)', punch_in: 'Punch-in (fester Ausschnitt)' };
const CUT_REASON: Record<CutRange['reason'], string> = { manual: 'manuell', filler: 'Füllwort', pause: 'Pause' };
const OVERLAY_LABEL: Record<OverlayKind, string> = { lower_third: 'Bauchbinde', keyword: 'Keyword', arrow: 'Pfeil', frame: 'Rahmen' };
const SLOT_LABEL: Record<Slot, string> = { upper: 'oben', center: 'Mitte', lower: 'unten' };
const DIRECTION_LABEL: Record<ClipOverlay['direction'], string> = { down: 'nach unten', up: 'nach oben', left: 'nach links', right: 'nach rechts' };

/** The look line: pinned Style Bible colours, or the labelled placeholder (never burned in). „Meine Marke“ links to its page. */
function LookLine({ look, font }: { look: LookTokens; font: string }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="look-line">
      {look.design ? <Link href="/meine-marke" className="underline-offset-2 hover:underline"><Pill tone="ok">{look.label}</Pill></Link> : look.source === 'style_bible' ? <Pill tone="ok">{look.label}</Pill> : <Pill tone="warn">{look.label}</Pill>}
      {[look.accent, look.box, look.text].map((c, i) => <span key={i} title={['Akzent', 'Fläche', 'Text'][i]} className="inline-block h-4 w-4 rounded border border-line" style={{ background: c }} />)}
      <span className="text-muted">Schrift: {font}</span>
    </span>
  );
}

/** Short effects summary of a plan for the version list, e.g. „3 Schnitte · Push-in“. */
function effectsSummary(clips: EditClip[]): string {
  const all = clips.flatMap((c) => c.cuts ?? []);
  const by = (r: CutRange['reason']) => all.filter((x) => x.reason === r).length;
  const fillers = by('filler'), pauses = by('pause'), manual = by('manual');
  const cuts = all.length && (fillers || pauses)
    ? [fillers ? `${fillers} Füllw${fillers === 1 ? 'ort' : 'örter'}` : '', pauses ? `${pauses} Pause${pauses === 1 ? '' : 'n'}` : '', manual ? `${manual} manuell` : ''].filter(Boolean).join(', ')
    : '';
  const zooms = [...new Set(clips.map((c) => c.zoom?.kind ?? 'none').filter((k) => k !== 'none'))].map((k) => ZOOM_LABEL[k as ZoomKind].split(' ')[0]);
  const punch = clips.some((c) => c.zoom?.punchOnCuts);
  return [cuts || (all.length ? `${all.length} Schnitt${all.length === 1 ? '' : 'e'}` : ''), ...zooms, punch ? 'Punch bei Schnitten' : ''].filter(Boolean).join(' · ');
}

/** EDL editor: pick a take per scene, set In/Out from the player, save versions, approve, render, review. */
export function EditPlanner({ projectId, footage }: { projectId: string; footage: FootageList['items'] }) {
  const toast = useToast();
  const state = useApi<EditState>(`/api/projects/${projectId}/edit-plans`);
  const [scriptId, setScriptId] = useState('');
  const scripts = state.data?.scripts ?? [];
  // „Freier Schnitt“ without a script: personal content only (client work always needs an approved script)
  const freeAllowed = state.data?.projectKind === 'PERSONAL_CONTENT';
  // Etappe 10: her own projects have no approval click – „Rendern“ on a saved draft approves it on the server
  const personal = state.data?.projectKind === 'PERSONAL_CONTENT';
  const free = freeAllowed && (scriptId === FREE || !scripts.length);
  const script = free ? null : scripts.find((s) => s.id === scriptId) ?? scripts.find((s) => s.status === 'approved') ?? scripts[0] ?? null;
  const [clips, setClips] = useState<Draft[]>([]);
  const [parentId, setParentId] = useState<string | null>(null);
  const [loudness, setLoudness] = useState<LoudnessPreset>('streaming_-14');
  const [subtitles, setSubtitles] = useState<'off' | 'burn'>('off');
  // Etappe 13: the subtitle height set in the editor; kept when a version is loaded and saved again here
  const [subtitleY, setSubtitleY] = useState<number | undefined>(undefined);
  // Etappe 16b: the word-by-word subtitle fields are carried along (set in the editor; the classic view does not edit them)
  const [subtitleAnim, setSubtitleAnim] = useState<{ subtitleMode?: 'lines' | 'karaoke' | 'word'; subtitleWords?: number }>({});
  const [hook, setHook] = useState<PlanHook | null>(null);
  const [font, setFont] = useState<OverlayFont>('Avenir Next');
  // Etappe 14: overlay style („Meine Marke“ preset) and whether the fonts come from the design system; null = not chosen yet
  const [fontSource, setFontSource] = useState<'plan' | 'design' | null>(null);
  const [preset, setPreset] = useState<string | null>(null);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // strategy gate per draft plan (reported by its gate card; unknown = blocked until loaded). The server enforces it too.
  const [planBlocked, setPlanBlocked] = useState<Record<string, boolean>>({});
  const onPlanBlocked = useCallback((id: string, b: boolean) => setPlanBlocked((m) => (m[id] === b ? m : { ...m, [id]: b })), []);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // a pending cut start belongs to one clip and one take: it never carries over to another clip or a loaded plan
  const [cutStart, setCutStart] = useState<{ clip: number; assetId: string; t: number } | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  // a seek requested for a clip that is not shown yet: applied once its video has loaded (see the player)
  const pendingSeek = useRef<number | null>(null);
  // ▶ of a suggestion: play from the pending seek and pause at this source time
  const stopAt = useRef<number | null>(null);
  const playAfterSeek = useRef(false);
  const usable = useMemo(() => footage.filter((a) => a.probe?.durationSec != null), [footage]);
  // the free cut takes real footage only: the server refuses AI-generated clips in plans without a script
  const generatedCount = usable.filter((a) => a.origin === 'generated').length;
  const pickable = free ? usable.filter((a) => a.origin !== 'generated') : usable;
  const durationOf = (id: string) => footage.find((a) => a.id === id)?.probe?.durationSec ?? 0;
  const plans = (state.data?.plans ?? []).filter((p) => (free ? p.scriptId === null : p.scriptId === script?.id));
  const renders = state.data?.renders ?? [];
  const rendering = renders.some((r) => r.status === 'rendering');
  const { reload } = state;

  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => void reload(), 1500);
    return () => clearInterval(t);
  }, [rendering, reload]);

  const activeClip = clips[active] ?? null;
  /** Shows clip `ci` in the player; a cut start set on another clip is dropped. */
  function select(ci: number) {
    if (ci !== active) setCutStart(null);
    setActive(ci);
  }
  /** Plays clip `ci` from source time `t` – also when the clip is not shown yet (its video loads first). */
  function previewAt(ci: number, t: number, until?: number) {
    const at = Math.max(0, t);
    stopAt.current = until ?? null;
    playAfterSeek.current = until != null;
    if (ci === active && player.current && player.current.readyState >= 1) {
      player.current.currentTime = at;
      if (until != null) void player.current.play().catch(() => undefined);
      playAfterSeek.current = false;
      return;
    }
    pendingSeek.current = at;
    select(ci);
  }
  // after the shown clip changed: an unchanged video applies the pending seek now, a reloading one on load
  useEffect(() => {
    const v = player.current, t = pendingSeek.current;
    if (v && t != null && v.readyState >= 1) {
      v.currentTime = t;
      pendingSeek.current = null;
      if (playAfterSeek.current) void v.play().catch(() => undefined);
      playAfterSeek.current = false;
    }
  }, [active, activeClip?.assetId, activeClip?.inSec]);
  /** Called on loadedmetadata and seeked: the media fragment (#t=In) can seek after us, so seek again until it holds. */
  function applyPendingSeek(v: HTMLVideoElement) {
    const t = pendingSeek.current;
    if (t == null) return;
    if (Math.abs(v.currentTime - t) < 0.05) {
      pendingSeek.current = null;
      if (playAfterSeek.current) void v.play().catch(() => undefined);
      playAfterSeek.current = false;
    } else v.currentTime = t;
  }
  function stopPreview(v: HTMLVideoElement) {
    if (stopAt.current != null && v.currentTime >= stopAt.current) {
      v.pause();
      stopAt.current = null;
    }
  }
  // the same frame-quantised timeline the render uses (cuts shorten the clips)
  const timeline = useMemo(() => buildTimeline(clips), [clips]);
  const total = round(timeline.durationSec);

  function update(i: number, patch: Partial<Draft>) {
    setClips((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  /**
   * After In/Out changed (on leaving the field, from the player, before saving): cuts that no longer lie
   * inside are dropped with a visible notice, instead of a failing save. Not while typing.
   */
  function pruneCuts(list: Draft[]): Draft[] {
    const dropped: string[] = [];
    const next = list.map((c, i) => {
      const kept = c.cuts.filter((x) => x.startSec >= c.inSec && x.endSec <= c.outSec);
      const keptOverlays = c.overlays.filter((o) => o.startSec >= c.inSec && o.endSec <= c.outSec);
      if (kept.length === c.cuts.length && keptOverlays.length === c.overlays.length) return c;
      const n = c.cuts.length - kept.length, m = c.overlays.length - keptOverlays.length;
      dropped.push(`Clip ${i + 1}: ${[n ? `${n} Schnitt${n === 1 ? '' : 'e'}` : '', m ? `${m} Overlay${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' und ')}`);
      return { ...c, cuts: kept, overlays: keptOverlays };
    });
    if (dropped.length) setNotice(`Außerhalb des neuen In/Out entfernt – ${dropped.join(', ')}.`);
    return dropped.length ? next : list;
  }
  const prune = () => setClips((cs) => pruneCuts(cs));
  const newClip = (sceneIndex: number | null, a: (typeof usable)[number], wholeClip: boolean): Draft => ({
    sceneIndex, assetId: a.id, inSec: 0, outSec: round(wholeClip ? a.probe!.durationSec! : Math.min(a.probe!.durationSec!, 3)),
    subtitle: '', briefId: a.generation?.briefId ?? null, cuts: [], zoom: { ...NO_ZOOM }, overlays: [],
  });
  function addClip(sceneIndex: number | null) {
    // a free cut takes the whole clip by default; footage the user has not used yet comes first
    const a = sceneIndex == null ? pickable.find((x) => !clips.some((c) => c.assetId === x.id)) ?? pickable[0] : pickable[0];
    if (!a) return;
    setScores({}); // match scores are per suggested clip index
    const at = sceneIndex == null ? clips.length : clips.filter((c) => c.sceneIndex != null && c.sceneIndex <= sceneIndex).length;
    select(at);
    setCutStart(null); // clip indexes after `at` shift
    setClips((cs) => [...cs.slice(0, at), newClip(sceneIndex, a, sceneIndex == null), ...cs.slice(at)]);
  }
  const position = () => (player.current ? round(player.current.currentTime) : null);
  function fromPlayer(which: 'inSec' | 'outSec') {
    const t = position();
    if (!activeClip || t == null) return;
    setClips((cs) => pruneCuts(cs.map((c, j) => (j === active ? { ...c, [which]: t } : c))));
  }
  function addCut(i: number, startSec: number, endSec: number) {
    const c = clips[i];
    if (!c) return;
    const [a, b] = startSec <= endSec ? [startSec, endSec] : [endSec, startSec];
    if (b - a < 0.05) return setError('Schnitt zu kurz: Anfang und Ende liegen zu nah beieinander.');
    if (a < c.inSec || b > c.outSec) return setError(`Der Schnitt muss zwischen In (${c.inSec} s) und Out (${c.outSec} s) liegen.`);
    setError(null);
    update(i, { cuts: [...c.cuts, { startSec: round(a), endSec: round(b), reason: 'manual' as const, word: '' }].sort((x, y) => x.startSec - y.startSec) });
  }
  function cutFromPlayer(which: 'start' | 'end') {
    const t = position();
    if (!activeClip || t == null) return;
    if (which === 'start') return setCutStart({ clip: active, assetId: activeClip.assetId, t });
    if (cutStart == null) return setError('Erst „Schnitt ab Position“ setzen.');
    if (cutStart.clip !== active || cutStart.assetId !== activeClip.assetId) {
      setCutStart(null);
      return setError(`Der Schnittanfang wurde in Clip ${cutStart.clip + 1} gesetzt, nicht in diesem Clip – bitte „Schnitt ab Position“ hier neu setzen.`);
    }
    addCut(active, cutStart.t, t);
    setCutStart(null);
  }
  function selectBase(value: string) {
    setScriptId(value);
    setClips([]);
    setHook(null);
    setParentId(null);
    setNotice(null);
    setCutStart(null);
  }
  function load(plan: EditState['plans'][number]) {
    // through the parser: plans from before Etappe 8 get the defaults for cuts and zoom
    const parsed = EditPlanBody.safeParse(plan.body);
    if (!parsed.success) return setError(`Version v${plan.version} lässt sich nicht laden: Der gespeicherte Schnittplan ist beschädigt oder hat ein unbekanntes Format.`);
    const body = parsed.data;
    setError(null);
    setCutStart(null);
    setScriptId(plan.scriptId ?? FREE);
    setClips(body.clips.map((c) => ({ ...c }))); // keeps subtitle, briefId, cuts and zoom
    setLoudness(body.loudness);
    setSubtitles(body.subtitles);
    setSubtitleY(body.subtitleY);
    setSubtitleAnim({ ...(body.subtitleMode ? { subtitleMode: body.subtitleMode } : {}), ...(body.subtitleWords ? { subtitleWords: body.subtitleWords } : {}) });
    setHook(body.hook);
    setFont(body.look.font);
    setFontSource(body.look.fontSource);
    setPreset(body.look.preset);
    setScores({});
    setParentId(plan.id);
    setActive(0);
    setNotice(null);
  }
  /** Pre-fills one clip per scene from the best transcript match; nothing is saved until the user saves. */
  async function suggest() {
    if (!script) return;
    await act('suggest', async () => {
      const s = await api<TakeSuggestions>(`/api/projects/${projectId}/take-suggestions?scriptId=${script.id}`);
      if (!s.transcribedClips) throw new Error('Noch kein transkribiertes Footage – erst Clips transkribieren.');
      const picked = s.scenes.flatMap((sc) => (sc.candidates[0] ? [{ sceneIndex: sc.sceneIndex, ...sc.candidates[0] }] : []));
      setClips(picked.map((c) => ({ sceneIndex: c.sceneIndex, assetId: c.assetId, inSec: c.inSec, outSec: c.outSec, subtitle: '', briefId: null, cuts: [], zoom: { ...NO_ZOOM }, overlays: [] })));
      setScores(Object.fromEntries(picked.map((c, i) => [i, c.score])));
      setParentId(null);
      setActive(0);
      setCutStart(null);
      toast(`${picked.length} von ${s.scenes.length} Szenen per Textabgleich vorbelegt${s.mock ? ' (MOCK-Transkripte)' : ''} – bitte prüfen und speichern.`);
    });
  }
  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setError(null);
    setBusy(key);
    try {
      await fn();
      await reload();
      if (done) toast(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!state.data) return <section className="panel mb-4"><ErrorNote error={state.error} /></section>;
  const overlaysOn = state.data.capabilities.overlays;
  const look = free ? state.data.freeLook : script?.look ?? state.data.freeLook;
  const brand = look.presets.length > 0;
  // a new plan on a „Meine Marke“ version takes its fonts; an old plan keeps what it was saved with
  const effFontSource = fontSource ?? (brand ? 'design' : 'plan');
  const effPreset = brand && preset && look.presets.some((p) => p.id === preset) ? preset : null;
  if (!script && !free) return <section className="panel mb-4" data-testid="edit-planner"><h2 className="mb-2 text-lg font-bold">Schnitt (EDL)</h2><Empty>Für den Schnitt braucht das Projekt ein Skript (Content Lab).</Empty></section>;

  const clipRow = (c: Draft, ci: number) => {
    const span = timeline.clips[ci];
    const pieces = span?.segments.length ?? 1;
    return (
      <div key={ci} className={`mb-1 rounded-lg p-2 ${ci === active ? 'bg-card2' : ''}`} data-testid="edit-clip">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Take" htmlFor={`ep-a-${ci}`}>
            <select id={`ep-a-${ci}`} className="field" value={c.assetId} onFocus={() => select(ci)} onChange={(e) => {
              const a = usable.find((x) => x.id === e.target.value);
              // a new take: In/Out reset to the whole clip in a free cut; cuts belong to the old take and are dropped
              if (cutStart?.clip === ci) setCutStart(null);
              const lost = [c.cuts.length ? `${c.cuts.length} Schnitt${c.cuts.length === 1 ? '' : 'e'}` : '', c.overlays.length ? `${c.overlays.length} Overlay${c.overlays.length === 1 ? '' : 's'}` : ''].filter(Boolean);
              if (lost.length && e.target.value !== c.assetId) setNotice(`Clip ${ci + 1}: Take gewechselt – ${lost.join(' und ')} des alten Takes entfernt (sie gehörten zu dessen Zeiten).`);
              update(ci, { assetId: e.target.value, briefId: a?.generation?.briefId ?? null, cuts: [], overlays: [], ...(free && a ? { inSec: 0, outSec: round(a.probe!.durationSec!) } : {}) });
            }}>
              {(pickable.some((a) => a.id === c.assetId) ? pickable : [...pickable, ...usable.filter((a) => a.id === c.assetId)]).map((a) => <option key={a.id} value={a.id}>{a.name} ({fmtDuration(a.probe!.durationSec)})</option>)}
            </select>
          </Field>
          <Field label="In (s)" htmlFor={`ep-in-${ci}`}>
            <input id={`ep-in-${ci}`} className="field w-20" type="number" min={0} step={0.1} value={c.inSec} onFocus={() => select(ci)} onChange={(e) => update(ci, { inSec: Number(e.target.value) })} onBlur={prune} />
          </Field>
          <Field label="Out (s)" htmlFor={`ep-out-${ci}`}>
            <input id={`ep-out-${ci}`} className="field w-20" type="number" min={0} max={durationOf(c.assetId)} step={0.1} value={c.outSec} onFocus={() => select(ci)} onChange={(e) => update(ci, { outSec: Number(e.target.value) })} onBlur={prune} />
          </Field>
          <span className="pb-2 text-muted">{round(span?.durationSec ?? Math.max(0, c.outSec - c.inSec))} s{c.cuts.length ? ` nach ${c.cuts.length} Schnitt${c.cuts.length === 1 ? '' : 'en'} (${pieces} Stücke)` : ''}{scores[ci] != null ? ` · Treffer ${Math.round(scores[ci]! * 100)} %` : ''}</span>
          <Button size="sm" variant="ghost" onClick={() => select(ci)}>Vorschau</Button>
          <Button size="sm" variant="ghost" onClick={() => { setClips((cs) => cs.filter((_, j) => j !== ci)); setScores({}); setCutStart(null); setActive(0); }}>Entfernen</Button>
        </div>
        <details className="mt-1" data-testid="clip-effects" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) select(ci); }}>
          <summary className="cursor-pointer text-muted">Schnitt, Zoom &amp; Overlays{c.cuts.length || c.zoom.kind !== 'none' || c.zoom.punchOnCuts || c.overlays.length ? ` · ${[effectsSummary([c]), graphicsSummary({ clips: [c] })].filter(Boolean).join(' · ')}` : ''}</summary>
          <div className="mt-2 grid gap-2 pl-1">
            <CutSuggestions projectId={projectId} scriptId={free ? null : script?.id ?? null} clip={c} onPreview={(a, b) => previewAt(ci, a, b)}
              onAccept={(cuts, msg) => { update(ci, { cuts }); setNotice(`Clip ${ci + 1}: ${msg}`); }} />
            <div>
              <strong>Schnitte</strong> <span className="text-muted">(Teile des Takes, die herausfallen – erst nach {personal ? 'Speichern und Rendern' : 'Speichern, Freigeben und Rendern'} im Video)</span>
              {c.cuts.length ? (
                <ul className="mt-1 grid gap-1" aria-label={`Schnitte in Clip ${ci + 1}`}>
                  {c.cuts.map((x, k) => (
                    <li key={`${x.startSec}-${x.endSec}`} className="flex flex-wrap items-center gap-2" data-testid="clip-cut">
                      <span>{x.startSec.toFixed(2)}–{x.endSec.toFixed(2)} s</span>
                      <Pill>{CUT_REASON[x.reason]}{x.word ? `: „${x.word}“` : ''}</Pill>
                      <Button size="sm" variant="ghost" onClick={() => previewAt(ci, x.startSec - 0.5)}>▶ ab 0,5 s davor</Button>
                      <Button size="sm" variant="ghost" onClick={() => update(ci, { cuts: c.cuts.filter((_, j) => j !== k) })}>Schnitt entfernen</Button>
                    </li>
                  ))}
                </ul>
              ) : <p className="hint">Noch keine Schnitte.</p>}
              <CutInput clip={ci} onAdd={(a, b) => addCut(ci, a, b)} />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Zoom" htmlFor={`ep-zoom-${ci}`}>
                <select id={`ep-zoom-${ci}`} className="field" value={c.zoom.kind} onChange={(e) => {
                  const kind = e.target.value as ZoomKind;
                  update(ci, { zoom: { ...c.zoom, kind, punchOnCuts: kind === 'push_in' || kind === 'push_out' ? false : c.zoom.punchOnCuts } });
                }}>
                  {(Object.keys(ZOOM_LABEL) as ZoomKind[]).map((k) => <option key={k} value={k}>{ZOOM_LABEL[k]}</option>)}
                </select>
              </Field>
              <Field label={`Stärke ${Math.round((c.zoom.amount - 1) * 100)} %`} htmlFor={`ep-zamt-${ci}`}>
                <input id={`ep-zamt-${ci}`} type="range" min={ZOOM_AMOUNT.min} max={ZOOM_AMOUNT.max} step={0.01} value={c.zoom.amount}
                  disabled={c.zoom.kind === 'none' && !c.zoom.punchOnCuts} onChange={(e) => update(ci, { zoom: { ...c.zoom, amount: Number(e.target.value) } })} />
              </Field>
              <label className="flex items-center gap-1.5 pb-2">
                <input type="checkbox" checked={c.zoom.punchOnCuts} disabled={c.zoom.kind === 'push_in' || c.zoom.kind === 'push_out'}
                  onChange={(e) => update(ci, { zoom: { ...c.zoom, punchOnCuts: e.target.checked } })} />
                Punch-in bei Schnitten (wechselt bei jedem Schnitt zwischen nah und normal)
              </label>
            </div>
            <p className="hint">Der Zoom wirkt nur auf das Bild dieses Clips, nie auf Untertitel oder das KI-Label. Eine Vorschau gibt es erst im Render.</p>
            <OverlayEditor clip={c} index={ci} enabled={overlaysOn} position={position} projectKind={state.data!.projectKind}
              onChange={(overlays) => update(ci, { overlays })} onPreview={(t) => previewAt(ci, t)} />
          </div>
        </details>
      </div>
    );
  };

  return (
    <section className="panel mb-4" data-testid="edit-planner">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="m-0 text-lg font-bold">Schnitt (EDL)</h2>
        <span className="text-xs text-muted">{free ? 'Freier Schnitt: Footage wählen, In/Out und Schnitte setzen, als Version speichern, rendern. Ohne KI.' : `Pro Szene einen Take wählen, In/Out setzen, als Version speichern, ${personal ? '' : 'freigeben, '}rendern. Ohne KI.`}</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="grid content-start gap-3">
          <div className="flex flex-wrap gap-3">
            <Field label="Grundlage" htmlFor="ep-script">
              <select id="ep-script" className="field" value={free ? FREE : script!.id} onChange={(e) => selectBase(e.target.value)}>
                {scripts.map((s) => <option key={s.id} value={s.id}>Skript v{s.version} · {s.status === 'approved' ? 'freigegeben' : s.status === 'rejected' ? 'abgelehnt' : 'Entwurf'}</option>)}
                {freeAllowed ? <option value={FREE}>Freier Schnitt (ohne Skript)</option> : null}
              </select>
            </Field>
            <Field label="Untertitel" htmlFor="ep-subs">
              <select id="ep-subs" className="field" value={subtitles} onChange={(e) => setSubtitles(e.target.value as 'off' | 'burn')}>
                <option value="off">keine</option>
                <option value="burn" disabled={!state.data.capabilities.subtitles}>einbrennen (aus Transkript){state.data.capabilities.subtitles ? '' : ' – FFmpeg ohne libass'}</option>
              </select>
            </Field>
            <Field label="Lautheit" htmlFor="ep-loud">
              <select id="ep-loud" className="field" value={loudness} onChange={(e) => setLoudness(e.target.value as LoudnessPreset)}>
                {(Object.keys(LOUDNESS_LABEL) as LoudnessPreset[]).map((k) => <option key={k} value={k}>{LOUDNESS_LABEL[k]}</option>)}
              </select>
            </Field>
          </div>
          {free ? (
            <p className="hint" data-testid="free-cut-note">Freier Schnitt: ohne Skript, nur für eigenen Content. Es gibt keine Szenen und keine KI-generierten Clips. Gespeicherte Versionen lassen sich direkt rendern; die Prüfung des Renders ist optional.{scripts.length ? '' : ' (Das Projekt hat noch kein Skript.)'}{generatedCount ? ` ${generatedCount} KI-generierte${generatedCount === 1 ? 'r Clip steht' : ' Clips stehen'} hier nicht zur Wahl – dafür einen Schnittplan mit Skript anlegen.` : ''}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" busy={busy === 'suggest'} disabled={!usable.length} onClick={() => void suggest()}>Takes vorschlagen</Button>
              <span className="hint">Vergleicht den Dialog jeder Szene mit den Transkripten (reiner Textabgleich, kein KI-Aufruf).</span>
            </div>
          )}
          {!usable.length ? <p className="hint text-warn">Kein Footage mit bekannter Dauer: ffprobe wird gebraucht, um In/Out zu prüfen.</p> : null}
          {free ? (
            <div className="rounded-xl border border-line p-3 text-xs" data-testid="free-cut">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <strong>Clips</strong>
                <span className="text-muted">in dieser Reihenfolge, standardmäßig der ganze Clip</span>
                <Button size="sm" variant="ghost" className="ml-auto" disabled={!pickable.length} onClick={() => addClip(null)}>+ Clip</Button>
              </div>
              {clips.length ? clips.map((c, ci) => clipRow(c, ci)) : <p className="hint">Noch kein Clip – „+ Clip“ übernimmt ein Footage ganz.</p>}
            </div>
          ) : (
            <ol className="grid gap-2 text-xs">
              {script!.scenes.map((sc, si) => (
                <li key={si} className="rounded-xl border border-line p-3" data-testid="edit-scene">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <strong>Szene {si + 1}</strong>
                    <span className="text-muted">{sc.startSecond}–{sc.endSecond} s · {sc.beat}</span>
                    {sc.shotType === 'product' ? <Pill tone="warn">Produkt: nur echtes Footage</Pill> : null}
                    <Button size="sm" variant="ghost" className="ml-auto" disabled={!usable.length} onClick={() => addClip(si)}>+ Clip</Button>
                  </div>
                  {sc.dialogue ? <p className="mb-2 text-muted">„{sc.dialogue}“</p> : null}
                  {clips.map((c, ci) => (c.sceneIndex !== si ? null : clipRow(c, ci)))}
                </li>
              ))}
            </ol>
          )}
          <HookEditor hook={hook} onChange={setHook} enabled={overlaysOn} free={free} script={script} projectKind={state.data.projectKind} defaultSlot={look.hookSlot ?? 'upper'} />
          <div className="flex flex-wrap items-end gap-3 text-xs">
            {brand ? (
              <Field label="Overlay-Stil (Meine Marke)" htmlFor="ep-preset">
                <select id="ep-preset" className="field" value={effPreset ?? ''} onChange={(e) => setPreset(e.target.value || null)} data-testid="ep-preset">
                  <option value="">Standard ({look.presets.find((p) => p.id === look.defaultPresetId)?.name ?? '–'})</option>
                  {look.presets.filter((p) => p.id !== look.defaultPresetId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            ) : null}
            <Field label="Schrift (Hook, Overlays)" htmlFor="ep-font">
              <select id="ep-font" className="field" value={brand && effFontSource === 'design' ? '__design' : font} onChange={(e) => {
                if (e.target.value === '__design') setFontSource('design');
                else { setFontSource('plan'); setFont(e.target.value as OverlayFont); }
              }}>
                {brand ? <option value="__design">Aus Meine Marke</option> : null}
                {OVERLAY_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            <div className="pb-2"><LookLine look={look} font={brand && effFontSource === 'design' ? look.font : font} /></div>
          </div>
          <p className="hint">{brand
            ? <>Farben, Schriften, Größen und Overlay-Stile kommen aus <Link href="/meine-marke" className="underline">Meine Marke</Link> in der Style-Bible-Version, die der Schnittplan beim Speichern festhält (mit Skript: die des Skripts, im Freien Schnitt: die gerade aktive). Spätere Änderungen an Meine Marke ändern diesen Schnitt erst, wenn du ihn neu speicherst. Das KI-Label behält seine feste Schrift.</>
            : 'Farben kommen aus der Style-Bible-Version, die der Schnittplan beim Speichern festhält (mit Skript: die des Skripts, im Freien Schnitt: die gerade aktive). Ohne aktive Style Bible gilt ein neutraler Platzhalter – das Etikett erscheint nur hier und im Render-Protokoll, nie im Video. Untertitel und KI-Label behalten ihre feste Schrift.'}</p>
          {notice ? <p className="hint text-warn" role="status">{notice}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" busy={busy === 'save'} disabled={!clips.length} onClick={() => void act('save', async () => {
              const body = { clips: pruneCuts(clips), loudness, subtitles, hook, look: { font, fontSource: effFontSource, preset: effPreset }, ...(subtitleY != null ? { subtitleY } : {}), ...subtitleAnim };
              setClips(body.clips);
              const plan = await api<{ id: string }>(`/api/projects/${projectId}/edit-plans`, { method: 'POST', json: { scriptId: free ? null : script!.id, parentId, body } });
              setParentId(plan.id);
            }, 'Neue Schnittplan-Version gespeichert.')}>Als neue Version speichern</Button>
            <span className="text-xs text-muted">{clips.length} Clips · {total} s{timeline.segments.length > clips.length ? ` · ${timeline.segments.length} Stücke (höchstens ${MAX_SEGMENTS})` : ''}{parentId ? ' · basiert auf geladener Version' : ''}</span>
          </div>
          <ErrorNote error={error} />
        </div>
        <div className="grid content-start gap-2">
          {activeClip ? (
            <>
              <video ref={player} key={activeClip.assetId} className="max-h-[420px] w-full rounded-lg bg-[#1f2617]" src={`/api/media/${activeClip.assetId}#t=${activeClip.inSec}`} controls preload="metadata"
                onLoadedMetadata={(e) => applyPendingSeek(e.currentTarget)} onSeeked={(e) => applyPendingSeek(e.currentTarget)} onTimeUpdate={(e) => stopPreview(e.currentTarget)} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => fromPlayer('inSec')}>In = Position</Button>
                <Button size="sm" onClick={() => fromPlayer('outSec')}>Out = Position</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => cutFromPlayer('start')}>Schnitt ab Position</Button>
                <Button size="sm" disabled={cutStart == null || cutStart.clip !== active} onClick={() => cutFromPlayer('end')}>Schnitt bis Position</Button>
              </div>
              <p className="hint">Clip {active + 1}: Video an die Stelle spulen und In bzw. Out übernehmen. Für einen Schnitt Anfang und Ende der Stelle setzen, die herausfallen soll{cutStart != null && cutStart.clip === active ? ` (Anfang: ${cutStart.t.toFixed(2)} s)` : ''}.</p>
            </>
          ) : <p className="hint">Clip hinzufügen, um ihn hier anzusehen.</p>}
        </div>
      </div>

      <h3 className="mt-5 mb-2 text-sm font-bold">Versionen</h3>
      {plans.length ? (
        <ul className="grid gap-2 text-xs" data-testid="edit-plans">
          {plans.map((p) => (
            <li key={p.id} className="rounded-xl border border-line p-3" data-testid="edit-plan">
              <div className="flex flex-wrap items-center gap-2">
                <strong>v{p.version}</strong>
                <Pill tone={PLAN_STATUS[p.status].tone}>{PLAN_STATUS[p.status].label}</Pill>
                <span className="text-muted">{p.scriptId ? '' : 'Freier Schnitt · '}{p.bodyError ? '' : <>{p.body.clips.length} Clips · </>}{p.durationSec} s{!p.bodyError && effectsSummary(p.body.clips) ? ` · ${effectsSummary(p.body.clips)}` : ''}{!p.bodyError && graphicsSummary(p.body) ? ` · ${graphicsSummary(p.body)}` : ''}{!p.bodyError && p.body.subtitles === 'burn' ? ' · Untertitel' : ''} · {fmtDateTime(p.createdAt)}</span>
                {p.disclosures.map((d) => <Pill key={d} tone="warn">Kennzeichnung: {d}</Pill>)}
                {p.bodyError ? <Pill tone="danger">beschädigt – nicht ladbar</Pill> : null}
                {p.strategyVersionId === undefined && state.data!.projectKind === 'PERSONAL_CONTENT' ? <Pill>{LEGACY_LABEL}</Pill> : null}
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="ghost" disabled={p.bodyError} onClick={() => load(p)}>Laden</Button>
                  {p.status === 'draft' && personal ? <Button size="sm" variant="primary" busy={busy === `render-${p.id}`} onClick={() => void act(`render-${p.id}`, () => api(`/api/edit-plans/${p.id}/render`, { method: 'POST', json: {} }), 'Render gestartet.')}>Rendern</Button> : null}
                  {p.status === 'draft' && !personal ? <Button size="sm" disabled={planBlocked[p.id] !== false} title={planBlocked[p.id] !== false ? 'Erst den Strategie-Check klären' : undefined} busy={busy === `approve-${p.id}`} onClick={() => void act(`approve-${p.id}`, () => api(`/api/edit-plans/${p.id}/approve`, { method: 'POST' }), 'Schnittplan freigegeben.')}>Freigeben</Button> : null}
                  {p.status === 'approved' ? <Button size="sm" variant="primary" busy={busy === `render-${p.id}`} onClick={() => void act(`render-${p.id}`, () => api(`/api/edit-plans/${p.id}/render`, { method: 'POST', json: {} }), 'Render gestartet.')}>Rendern</Button> : null}
                </span>
              </div>
              {!p.bodyError && graphicsSummary(p.body) ? <div className="mt-1"><LookLine look={p.look} font={p.body.look.font} /></div> : null}
              {p.warnings.length ? <ul className="mt-1 list-disc pl-5 text-warn">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
              {p.status === 'draft' && !personal ? (
                <StrategyGateCard kind="edit_plan" id={p.id} onBlocked={(b) => onPlanBlocked(p.id, b)} onChanged={() => void state.reload()}
                  texts={p.bodyError ? undefined : Object.fromEntries(editPlanLintParts(p.body).map((x) => [x.field, x.text]))} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : <Empty>{free ? 'Noch keine Version im Freien Schnitt.' : 'Noch keine Version für dieses Skript.'}</Empty>}

      <h3 className="mt-5 mb-2 text-sm font-bold">Renders</h3>
      {renders.length ? (
        <ul className="grid gap-3 text-xs" data-testid="renders">
          {renders.map((r) => {
            const plan = state.data!.plans.find((p) => p.id === r.editPlanId);
            return (
              <li key={r.id} className="rounded-xl border border-line p-3" data-testid="render">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>Schnittplan v{plan?.version ?? '?'}</strong>
                  <Pill tone={RENDER_STATUS[r.status].tone}>{RENDER_STATUS[r.status].label}</Pill>
                  <span className="text-muted">{fmtDateTime(r.createdAt)}{r.size ? ` · ${fmtBytes(r.size)}` : ''}{r.loudness?.measured ? ` · gemessen ${r.loudness.measured.input_i} LUFS` : ''}</span>
                  {r.disclosures.map((d) => <Pill key={d} tone="warn">Kennzeichnung: {d}</Pill>)}
                  <span className="ml-auto flex gap-2">
                    {r.status === 'rendering' && r.job ? <Button size="sm" variant="ghost" onClick={() => void act(`cancel-${r.id}`, () => api(`/api/video-jobs/${r.jobId}/cancel`, { method: 'POST' }))}>Abbrechen</Button> : null}
                    {r.status !== 'rendering' && r.status !== 'approved' ? <Button size="sm" variant="ghost" onClick={() => void act(`del-${r.id}`, () => api(`/api/renders/${r.id}`, { method: 'DELETE' }))}>Löschen</Button> : null}
                  </span>
                </div>
                {r.status === 'rendering' && r.job ? (
                  <div className="mt-2 grid gap-1">
                    <div className="h-2 overflow-hidden rounded bg-card2" role="progressbar" aria-label="Renderfortschritt" aria-valuenow={Math.round((r.job.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full bg-lime" style={{ width: `${Math.round((r.job.progress ?? 0) * 100)}%` }} />
                    </div>
                    <span className="text-muted">{r.job.status === 'queued' ? 'wartet auf den Worker' : r.job.progressNote}</span>
                  </div>
                ) : null}
                {r.look ? <div className="mt-1" data-testid="render-look"><LookLine look={r.look} font={r.look.font} /></div> : null}
                {r.look?.warnings.length ? <ul className="mt-1 list-disc pl-5 text-warn">{r.look.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
                {r.error && r.status !== 'cancelled' ? <p className="mt-1 text-danger">{r.error}</p> : null}
                {r.reviewNote ? <p className="mt-1 text-muted">Prüfung: {r.reviewNote}</p> : null}
                {r.storagePath ? <video className="mt-2 max-h-[480px] rounded-lg" src={`/api/media/${r.id}`} controls preload="metadata" /> : null}
                {r.storagePath ? (
                  <details className="mt-2" data-testid="render-finish"><summary className="cursor-pointer">Für CapCut exportieren</summary><FinishExport renderId={r.id} compact /></details>
                ) : null}
                {r.status === 'pending_review' ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    {personal ? <p className="hint m-0 w-full">Fertig – Download und Veröffentlichung gehen sofort. Die Prüfung ist optional.</p> : null}
                    <Field label="Anmerkung (bei Ablehnung/Revision Pflicht)" htmlFor={`rv-${r.id}`}>
                      <input id={`rv-${r.id}`} className="field w-72" value={notes[r.id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} maxLength={1000} />
                    </Field>
                    <Button size="sm" variant="primary" onClick={() => void act(`rv-${r.id}`, () => api(`/api/renders/${r.id}/review`, { method: 'POST', json: { decision: 'approve', note: notes[r.id] ?? '' } }), 'Render freigegeben.')}>Freigeben</Button>
                    <Button size="sm" onClick={() => void act(`rv-${r.id}`, () => api(`/api/renders/${r.id}/review`, { method: 'POST', json: { decision: 'revise', note: notes[r.id] ?? '' } }), 'Neue Schnittplan-Version zum Überarbeiten angelegt.')}>Überarbeiten</Button>
                    <Button size="sm" variant="danger" onClick={() => void act(`rv-${r.id}`, () => api(`/api/renders/${r.id}/review`, { method: 'POST', json: { decision: 'reject', note: notes[r.id] ?? '' } }))}>Ablehnen</Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <Empty>Noch kein Render.</Empty>}
    </section>
  );
}

/** Manual cut by numbers (source time of the take). */
function CutInput({ clip, onAdd }: { clip: number; onAdd: (startSec: number, endSec: number) => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  return (
    <div className="mt-1 flex flex-wrap items-end gap-2">
      <Field label="Schnitt von (s)" htmlFor={`ep-cut-a-${clip}`}>
        <input id={`ep-cut-a-${clip}`} className="field w-20" type="number" min={0} step={0.05} value={a} onChange={(e) => setA(e.target.value)} />
      </Field>
      <Field label="bis (s)" htmlFor={`ep-cut-b-${clip}`}>
        <input id={`ep-cut-b-${clip}`} className="field w-20" type="number" min={0} step={0.05} value={b} onChange={(e) => setB(e.target.value)} />
      </Field>
      <Button size="sm" disabled={a === '' || b === ''} onClick={() => { onAdd(Number(a), Number(b)); setA(''); setB(''); }}>Schnitt hinzufügen</Button>
    </div>
  );
}

const LIBASS_MISSING = 'Hook und Overlays brauchen FFmpeg mit libass (Filter „subtitles“) – das installierte FFmpeg hat ihn nicht. Nach „brew install ffmpeg-full“ den Server neu starten.';

/**
 * Text hook of the plan (from 0 s). With a script: the script's selected hook or one of its variants, exactly
 * (changes happen in the script and its approval). Free cut: her own short text, after the claim check.
 */
function HookEditor({ hook, onChange, enabled, free, script, projectKind, defaultSlot }: {
  hook: PlanHook | null; onChange: (h: PlanHook | null) => void; enabled: boolean; free: boolean; projectKind: 'PERSONAL_CONTENT' | 'UGC_CLIENT'; defaultSlot: Slot;
  script: { selectedHook: string; hookVariants: string[] } | null;
}) {
  const base: PlanHook = free
    ? { source: 'free', variantIndex: null, text: '', endSec: 2.5, slot: defaultSlot, claimsReviewed: false }
    : { source: 'selected', variantIndex: null, text: script?.selectedHook ?? '', endSec: 2.5, slot: defaultSlot, claimsReviewed: false };
  const ref = hook ? (hook.source === 'variant' ? `v${hook.variantIndex}` : hook.source) : '';
  return (
    <div className="rounded-xl border border-line p-3 text-xs" data-testid="hook-editor">
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={hook != null} disabled={!enabled && hook == null} onChange={(e) => onChange(e.target.checked ? base : null)} />
        <strong>Text-Hook</strong> <span className="text-muted">am Anfang des Videos eingeblendet</span>
      </label>
      {!enabled ? <p className="hint text-warn">{LIBASS_MISSING}</p> : null}
      {hook ? (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {free ? (
            <>
              <Field label={`Eigener Hook (höchstens ${TEXT_LIMIT.free_hook} Zeichen)`} htmlFor="ep-hook-text">
                {/* Etappe 10: a free hook (personal only) needs no confirmation; unverified figures come back as hints after saving */}
                <input id="ep-hook-text" className="field w-80" maxLength={TEXT_LIMIT.free_hook} value={hook.text} onChange={(e) => onChange({ ...hook, text: e.target.value })} />
                <LintMarker text={hook.text} projectKind={projectKind} />
              </Field>
            </>
          ) : (
            <Field label="Hook aus dem Skript" htmlFor="ep-hook-ref">
              <select id="ep-hook-ref" className="field max-w-md" value={ref} onChange={(e) => {
                const v = e.target.value;
                const i = v.startsWith('v') ? Number(v.slice(1)) : null;
                onChange({ ...hook, source: i == null ? 'selected' : 'variant', variantIndex: i, text: i == null ? script?.selectedHook ?? '' : script?.hookVariants[i] ?? '' });
              }}>
                <option value="selected">Ausgewählt: {script?.selectedHook || '(keiner)'}</option>
                {(script?.hookVariants ?? []).map((h, i) => <option key={i} value={`v${i}`}>Variante {i + 1}: {h}</option>)}
              </select>
            </Field>
          )}
          <Field label={`Dauer ${hook.endSec.toFixed(1)} s`} htmlFor="ep-hook-end">
            <input id="ep-hook-end" type="range" min={0.5} max={5} step={0.5} value={hook.endSec} onChange={(e) => onChange({ ...hook, endSec: Number(e.target.value) })} />
          </Field>
          <Field label="Platz" htmlFor="ep-hook-slot">
            <select id="ep-hook-slot" className="field" value={hook.slot} onChange={(e) => onChange({ ...hook, slot: e.target.value as Slot })}>
              {(Object.keys(SLOT_LABEL) as Slot[]).map((k) => <option key={k} value={k}>{SLOT_LABEL[k]}</option>)}
            </select>
          </Field>
        </div>
      ) : null}
      {hook && !free ? <p className="hint mt-1">Eigener Text geht nur über das Skript: dort ändern und freigeben lassen (Claim-Prüfung).</p> : null}
    </div>
  );
}

/** Overlays of one clip, in source time of the take: lower third and keyword quote the script or her own transcript. */
function OverlayEditor({ clip, index, enabled, position, projectKind, onChange, onPreview }: {
  clip: Draft; index: number; enabled: boolean; position: () => number | null; projectKind: 'PERSONAL_CONTENT' | 'UGC_CLIENT';
  onChange: (o: ClipOverlay[]) => void; onPreview: (t: number) => void;
}) {
  const [kind, setKind] = useState<OverlayKind>('lower_third');
  function add() {
    const t = position();
    const start = round(Math.min(Math.max(t ?? clip.inSec, clip.inSec), Math.max(clip.inSec, clip.outSec - 0.5)));
    onChange([...clip.overlays, { kind, startSec: start, endSec: round(Math.min(clip.outSec, start + 2)), text: '', slot: kind === 'lower_third' ? 'lower' : 'center', direction: 'down' }]);
  }
  const set = (k: number, patch: Partial<ClipOverlay>) => onChange(clip.overlays.map((o, j) => (j === k ? { ...o, ...patch } : o)));
  return (
    <div data-testid="overlay-editor">
      <strong>Grafik-Overlays</strong> <span className="text-muted">(feste Plätze unter dem KI-Label und über den Untertiteln)</span>
      {!enabled ? <p className="hint text-warn">{LIBASS_MISSING}</p> : null}
      {clip.overlays.length ? (
        <ul className="mt-1 grid gap-2" aria-label={`Overlays in Clip ${index + 1}`}>
          {clip.overlays.map((o, k) => (
            <li key={k} className="flex flex-wrap items-end gap-2" data-testid="clip-overlay">
              <Pill>{OVERLAY_LABEL[o.kind]}</Pill>
              <Field label="von (s)" htmlFor={`ov-a-${index}-${k}`}>
                <input id={`ov-a-${index}-${k}`} className="field w-20" type="number" step={0.1} min={clip.inSec} max={clip.outSec} value={o.startSec} onChange={(e) => set(k, { startSec: Number(e.target.value) })} />
              </Field>
              <Field label="bis (s)" htmlFor={`ov-b-${index}-${k}`}>
                <input id={`ov-b-${index}-${k}`} className="field w-20" type="number" step={0.1} min={clip.inSec} max={clip.outSec} value={o.endSec} onChange={(e) => set(k, { endSec: Number(e.target.value) })} />
              </Field>
              {o.kind === 'lower_third' || o.kind === 'keyword' ? (
                <Field label={projectKind === 'PERSONAL_CONTENT' ? `Text (frei, max. ${TEXT_LIMIT[o.kind]})` : `Text (wörtlich aus Dialog/On-Screen-Text, max. ${TEXT_LIMIT[o.kind]})`} htmlFor={`ov-t-${index}-${k}`}>
                  <input id={`ov-t-${index}-${k}`} className="field w-64" maxLength={TEXT_LIMIT[o.kind]} value={o.text} onChange={(e) => set(k, { text: e.target.value })} />
                  <LintMarker text={o.text} projectKind={projectKind} />
                </Field>
              ) : null}
              {o.kind !== 'frame' ? (
                <Field label="Platz" htmlFor={`ov-s-${index}-${k}`}>
                  <select id={`ov-s-${index}-${k}`} className="field" value={o.slot} onChange={(e) => set(k, { slot: e.target.value as Slot })}>
                    {(Object.keys(SLOT_LABEL) as Slot[]).map((x) => <option key={x} value={x}>{SLOT_LABEL[x]}</option>)}
                  </select>
                </Field>
              ) : null}
              {o.kind === 'arrow' ? (
                <Field label="Richtung" htmlFor={`ov-d-${index}-${k}`}>
                  <select id={`ov-d-${index}-${k}`} className="field" value={o.direction} onChange={(e) => set(k, { direction: e.target.value as ClipOverlay['direction'] })}>
                    {(Object.keys(DIRECTION_LABEL) as ClipOverlay['direction'][]).map((x) => <option key={x} value={x}>{DIRECTION_LABEL[x]}</option>)}
                  </select>
                </Field>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => onPreview(o.startSec)}>▶ ab hier</Button>
              <Button size="sm" variant="ghost" onClick={() => onChange(clip.overlays.filter((_, j) => j !== k))}>Entfernen</Button>
            </li>
          ))}
        </ul>
      ) : <p className="hint">Noch keine Overlays.</p>}
      <div className="mt-1 flex flex-wrap items-end gap-2">
        <Field label="Neues Overlay" htmlFor={`ov-k-${index}`}>
          <select id={`ov-k-${index}`} className="field" value={kind} disabled={!enabled} onChange={(e) => setKind(e.target.value as OverlayKind)}>
            {(Object.keys(OVERLAY_LABEL) as OverlayKind[]).map((x) => <option key={x} value={x}>{OVERLAY_LABEL[x]}</option>)}
          </select>
        </Field>
        <Button size="sm" disabled={!enabled || clip.overlays.length >= 8} onClick={add}>+ ab Player-Position (2 s)</Button>
      </div>
      <p className="hint">Keine Live-Vorschau: Overlays siehst du erst im Render.</p>
    </div>
  );
}
