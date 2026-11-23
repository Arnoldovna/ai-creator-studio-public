'use client';
import { useCallback, useState } from 'react';
import { ShotType, type UgcScript } from '@studio/core/schemas';
import { scriptLintParts } from '@studio/core/strategyLint';
import { api, downloadUrl } from '@/lib/api';
import type { ScriptOutputView, ScriptVersion } from '@/lib/types';
import { SlopHints } from '../SlopHints';
import { useToast } from '../toast';
import { Button, ErrorNote, MockBadge, ORIGIN_LABEL, Pill } from '../ui';
import { LEGACY_LABEL } from '../strategy/GateParts';
import { StrategyGateCard } from '../strategy/StrategyGateCard';
import { ScriptAgents } from './ScriptAgents';

/**
 * `personal`: her own project (Etappe 10): approval is one click – no claim checkbox and no strategy gate; open
 * claims stay visible as hints under „Zu prüfen“. Client projects keep the checkbox and the gate card.
 */
export function ScriptEditor({ scripts, outputs, styleVersions, reload, personal = false }: { scripts: ScriptVersion[]; outputs: ScriptOutputView[]; styleVersions: Record<string, { version: number; status: string; name: string }>; reload: () => Promise<void>; personal?: boolean }) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState(scripts.at(-1)!.id);
  const selected = scripts.find((s) => s.id === selectedId) ?? scripts.at(-1)!;
  const [draft, setDraft] = useState<UgcScript>(selected.body);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimsReviewed, setClaimsReviewed] = useState(false);
  const [gateBlocked, setGateBlocked] = useState(true);
  const onBlocked = useCallback((b: boolean) => setGateBlocked(b), []);

  const select = (s: ScriptVersion) => {
    if (dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) return;
    setSelectedId(s.id);
    setDraft(s.body);
    setDirty(false);
    setError(null);
    setClaimsReviewed(false);
  };
  const update = (fn: (d: UgcScript) => UgcScript) => {
    setDraft((d) => fn(structuredClone(d)));
    setDirty(true);
    setClaimsReviewed(false);
  };

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const next = await api<ScriptVersion>(`/api/scripts/${selected.id}`, { method: 'PUT', json: draft });
      await reload();
      setSelectedId(next.id);
      setDraft(next.body);
      setDirty(false);
      toast(`Skript v${next.version} gespeichert.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function setStatus(status: 'approved' | 'rejected' | 'draft') {
    setBusy(status);
    setError(null);
    try {
      await api(`/api/scripts/${selected.id}/status`, { method: 'POST', json: { status, claimsReviewed: status === 'approved' && !personal ? claimsReviewed : undefined } });
      await reload();
      toast(status === 'approved' ? `Skript v${selected.version} freigegeben.` : 'Status geändert.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const style = selected.styleBibleVersionId ? styleVersions[selected.styleBibleVersionId] : null;

  return (
    <section className="panel" data-testid="script-editor">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-lg font-bold">Skript & Shotlist</h2>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => downloadUrl(`/api/scripts/${selected.id}/export?format=json`)}>↓ Skript-JSON</Button>
          <Button size="sm" onClick={() => downloadUrl(`/api/scripts/${selected.id}/export?format=md`)}>↓ Markdown</Button>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <ul className="grid content-start gap-2" aria-label="Skriptversionen">
          {[...scripts].reverse().map((s) => (
            <li key={s.id}>
              <button onClick={() => select(s)} className={`w-full rounded-xl border p-3 text-left ${s.id === selected.id ? 'border-accent bg-[#eef6dc]' : 'border-line bg-card2'}`}>
                <div className="flex items-center justify-between"><strong className="text-sm">v{s.version}</strong><Pill tone={s.status === 'approved' ? 'ok' : s.status === 'rejected' ? 'danger' : 'warn'}>{s.status}</Pill></div>
                <div className="mt-1 text-[10px] text-muted">{s.source === 'agent' ? 'Agent' : 'Bearbeitung'} · {s.createdAt.slice(11, 16)}</div>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px] tracking-wider text-accent">
            <span>{draft.format.toUpperCase()} · {draft.estimatedSeconds} SEKUNDEN · HYBRID</span>
            <MockBadge mock={selected.mock} />
            <Pill>Style: {style ? `${style.name} v${style.version}` : 'keine'}</Pill>
            {selected.promptVersion ? <Pill>{selected.promptVersion}</Pill> : null}
            {selected.strategyVersionId === undefined ? <Pill>{LEGACY_LABEL}</Pill> : null}
          </div>

          <h3 className="mb-2 text-sm font-bold">Hook-Varianten</h3>
          <div className="grid gap-1.5">
            {draft.hookVariants.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="radio" name="hook" aria-label={`Hook ${i + 1} wählen`} checked={draft.selectedHook === h} onChange={() => update((d) => ({ ...d, selectedHook: h }))} />
                <input
                  className="field py-1.5"
                  value={h}
                  aria-label={`Hook ${i + 1}`}
                  onChange={(e) => update((d) => {
                    const wasSel = d.selectedHook === d.hookVariants[i];
                    d.hookVariants[i] = e.target.value;
                    if (wasSel) d.selectedHook = e.target.value;
                    return d;
                  })}
                />
              </div>
            ))}
          </div>
          <SlopHints text={draft.hookVariants.join('\n\n')} where="hook" testId="hook-slop" />

          <h3 className="mt-5 mb-2 text-sm font-bold">Szenen</h3>
          <div className="grid gap-2">
            {draft.scenes.map((sc, i) => (
              <div key={i} className="grid gap-2 rounded-xl border border-[#dde2d2] bg-[#f5f7f0] p-3 md:grid-cols-[96px_minmax(0,1fr)]" data-testid="scene">
                <div className="flex items-start gap-1 text-xs font-bold text-accent">
                  <input type="number" min={0} step={0.5} aria-label="Start (s)" className="field w-12 px-1 py-1 text-xs" value={sc.startSecond} onChange={(e) => update((d) => { d.scenes[i]!.startSecond = Number(e.target.value); return d; })} />
                  <span className="pt-1.5">–</span>
                  <input type="number" min={0} step={0.5} aria-label="Ende (s)" className="field w-12 px-1 py-1 text-xs" value={sc.endSecond} onChange={(e) => update((d) => { d.scenes[i]!.endSecond = Number(e.target.value); return d; })} />
                </div>
                <div className="grid gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <strong className="text-ink">{sc.beat}</strong>
                    <select aria-label="Einstellung" className="field w-auto px-2 py-1 text-[11px]" value={sc.shotType} onChange={(e) => update((d) => { d.scenes[i]!.shotType = e.target.value as UgcScript['scenes'][number]['shotType']; return d; })}>
                      {ShotType.options.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <span>{ORIGIN_LABEL[sc.origin]}</span>
                  </div>
                  <textarea rows={2} aria-label="Dialog" className="field text-[13px]" value={sc.dialogue} onChange={(e) => update((d) => { d.scenes[i]!.dialogue = e.target.value; return d; })} />
                  <input aria-label="On-Screen-Text" placeholder="On-Screen-Text" className="field py-1.5 text-xs" value={sc.onScreenText} onChange={(e) => update((d) => { d.scenes[i]!.onScreenText = e.target.value; return d; })} />
                  <input aria-label="Bild" className="field py-1.5 text-xs text-[#5b6450]" value={sc.visual} onChange={(e) => update((d) => { d.scenes[i]!.visual = e.target.value; return d; })} />
                  <SlopHints text={sc.dialogue} where="script" testId="scene-slop" />
                  <SlopHints text={sc.onScreenText} where="overlay" testId="scene-overlay-slop" />
                </div>
              </div>
            ))}
          </div>

          <h3 className="mt-5 mb-2 text-sm font-bold">CTA</h3>
          <input aria-label="CTA" className="field" value={draft.cta} onChange={(e) => update((d) => ({ ...d, cta: e.target.value }))} />
          <SlopHints text={draft.cta} where="caption" testId="cta-slop" />

          <h3 className="mt-5 mb-2 text-sm font-bold">Shotlist</h3>
          <ol className="list-decimal pl-5 text-xs leading-6 text-[#343b2d]">
            {draft.shotlist.map((s, i) => <li key={i}><span className="text-muted">[{s.shotType}]</span> {s.shot} — {s.framing}{s.notes ? ` (${s.notes})` : ''}</li>)}
          </ol>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-bold">Verifizierte Claims</h3>
              <ul className="list-disc pl-5 text-xs text-[#343b2d]">{draft.verifiedClaims.length ? draft.verifiedClaims.map((c) => <li key={c}>{c}</li>) : <li className="text-muted">keine</li>}</ul>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-bold">Zu prüfen</h3>
              <ul className="grid gap-1 text-xs text-warn">
                {draft.claimsToVerify.length ? draft.claimsToVerify.map((c, i) => (
                  <li key={c} className="flex items-center gap-2">⚠ {c}
                    <Button size="sm" variant="ghost" title="Nur möglich, wenn der Claim nicht mehr im Text steht – sonst bleibt er beim Speichern markiert." onClick={() => update((d) => { d.claimsToVerify.splice(i, 1); return d; })}>als erledigt markieren</Button>
                  </li>
                )) : <li className="text-muted">keine</li>}
              </ul>
            </div>
          </div>
          {draft.warnings.length ? <div className="note">{draft.warnings.join(' ')}</div> : null}
          {selected.status !== 'approved' && !personal ? (
            <StrategyGateCard key={`gate-${selected.id}`} kind="script" id={selected.id} onBlocked={onBlocked} onChanged={() => void reload()}
              texts={Object.fromEntries(scriptLintParts(selected.body).map((p) => [p.field, p.text]))} />
          ) : null}
          <ErrorNote error={error} />
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="primary" disabled={!dirty} busy={busy === 'save'} onClick={save}>Als neue Version speichern</Button>
            {selected.status !== 'approved' && personal ? (
              <Button disabled={dirty} busy={busy === 'approved'} onClick={() => setStatus('approved')}>✓ Skript freigeben</Button>
            ) : selected.status !== 'approved' ? (
              <>
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  <input type="checkbox" checked={claimsReviewed} disabled={dirty} onChange={(e) => setClaimsReviewed(e.target.checked)} />
                  Ich habe Dialog, On-Screen-Text, Hooks und CTA geprüft: keine unbelegten Produktaussagen.
                </label>
                <Button disabled={dirty || !claimsReviewed || gateBlocked} title={gateBlocked ? 'Erst den Strategie-Check klären' : undefined} busy={busy === 'approved'} onClick={() => setStatus('approved')}>✓ Skript freigeben</Button>
              </>
            ) : <Pill tone="ok">freigegeben</Pill>}
            {selected.status !== 'rejected' ? <Button variant="danger" disabled={dirty} busy={busy === 'rejected'} onClick={() => setStatus('rejected')}>Verwerfen</Button> : null}
            {dirty ? <span className="self-center text-[11px] text-warn">Ungespeicherte Änderungen</span> : null}
          </div>
          <ScriptAgents key={selected.id} personal={personal} script={selected} outputs={outputs} dirty={dirty} reload={reload} />
        </div>
      </div>
    </section>
  );
}
