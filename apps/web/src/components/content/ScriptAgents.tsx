'use client';
import { useGateChanges } from '@/components/strategy/gateEvents';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { ScriptOutputView, ScriptVersion } from '@/lib/types';
import { SlopHints } from '../SlopHints';
import { useToast } from '../toast';
import { copyLintParts, storyboardLintParts } from '@studio/core/strategyLint';
import { StrategyGateCard } from '../strategy/StrategyGateCard';
import { Button, ErrorNote, List, ORIGIN_LABEL, OutputCard, Pill } from '../ui';

type Kind = ScriptOutputView['kind'];
type Of<K extends Kind> = Extract<ScriptOutputView, { kind: K }>;
const SEVERITY = { blocker: 'danger', warning: 'warn', info: 'default' } as const;
const LABEL: Record<Kind, string> = { qa: 'Content-QA', copy: 'Instagram-Copy', storyboard: 'Dramaturgie & Shotlist' };

/**
 * QA, Instagram copy and cinematic direction for ONE script version. Everything is a draft until the user approves it.
 * `personal` (Etappe 10): the caption is written for any script that is not rejected; the strategy gate card and the
 * copy confirmation are gone (the server's `gate.confirm` drives the checkbox, a storyboard with AI media keeps it).
 */
export function ScriptAgents({ script, outputs, dirty, reload, personal = false }: { script: ScriptVersion; outputs: ScriptOutputView[]; dirty: boolean; reload: () => Promise<void>; personal?: boolean }) {
  // the approve boxes use the parent's gate blockers: reload them when any gate view on the page changes
  useGateChanges(reload);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = <K extends Kind>(kind: K) => outputs.findLast((o): o is Of<K> => o.scriptId === script.id && o.kind === kind) ?? null;
  const qa = latest('qa'), copy = latest('copy'), board = latest('storyboard');
  const copyAllowed = personal ? script.status !== 'rejected' : script.status === 'approved';

  async function act(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await reload();
      toast(ok);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const generate = (kind: Kind) => act(kind, () => api(`/api/scripts/${script.id}/agents/${kind}`, { method: 'POST' }), `${LABEL[kind]} erstellt – bitte prüfen.`);
  const approve = (o: ScriptOutputView) => (body: { confirmed: boolean; clientConsentNote: string }) =>
    act(`approve-${o.kind}`, () => api(`/api/script-outputs/${o.id}/approve`, { method: 'POST', json: body }), `${LABEL[o.kind]} freigegeben.`);

  return (
    <div className="mt-6 border-t border-line pt-5" data-testid="script-agents">
      <h3 className="mb-1 text-sm font-bold">Prüfen, Caption & Dreh planen · Skript v{script.version}</h3>
      <p className="hint">Alle Ergebnisse sind Entwürfe. Nichts wird gepostet, generiert oder gekauft; das Skript selbst bleibt unverändert.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" disabled={dirty} busy={busy === 'qa'} onClick={() => generate('qa')}>Skript prüfen (QA)</Button>
        <Button size="sm" disabled={dirty} busy={busy === 'storyboard'} onClick={() => generate('storyboard')}>Dreh planen</Button>
        <Button size="sm" disabled={dirty || !copyAllowed} title={!copyAllowed ? (personal ? 'Verworfenes Skript' : 'Erst das Skript freigeben') : undefined} busy={busy === 'copy'} onClick={() => generate('copy')}>
          Caption schreiben
        </Button>
      </div>
      <ErrorNote error={error} />
      {qa ? <QaCard key={qa.id} o={qa} /> : null}
      {board ? <StoryboardCard key={board.id} o={board} busy={busy === 'approve-storyboard'} onApprove={approve(board)} reload={reload} /> : null}
      {copy ? <CopyCard key={copy.id} o={copy} busy={busy === 'approve-copy'} onApprove={approve(copy)} onCopied={() => toast('Caption kopiert – bitte selbst posten.')} reload={reload} /> : null}
    </div>
  );
}

const StatusPill = ({ o }: { o: ScriptOutputView }) => <Pill tone={o.status === 'approved' ? 'ok' : 'warn'}>{o.status === 'approved' ? 'freigegeben' : 'Entwurf'}</Pill>;

/** Approval controls driven by the server's gate; keyed per output so a confirmation never carries over to a new result. */
function Approve({ o, label, confirmText, busy, onApprove }: { o: ScriptOutputView; label: string; confirmText: string; busy: boolean; onApprove: (b: { confirmed: boolean; clientConsentNote: string }) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  if (o.status === 'approved') return o.clientConsentNote ? <p className="mt-2 text-muted">Zustimmung der Kundin: {o.clientConsentNote}</p> : null;
  if (o.gate.blockers.length) return <List title="Freigabe blockiert" items={o.gate.blockers} tone="text-danger" />;
  const ready = (!o.gate.confirm || confirmed) && (!o.gate.clientConsent || note.trim());
  return (
    <div className="mt-3 grid gap-2">
      {o.gate.confirm ? (
        <label className="flex items-center gap-2 text-[11px] text-muted">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> {confirmText}
        </label>
      ) : null}
      {o.gate.clientConsent ? (
        <input className="field py-1.5 text-xs" aria-label="Zustimmung der Kundin" placeholder="Zustimmung der Kundin dokumentieren, z. B. „Mail vom 12.11.“" value={note} onChange={(e) => setNote(e.target.value)} />
      ) : null}
      <div><Button size="sm" disabled={!ready} busy={busy} onClick={() => onApprove({ confirmed, clientConsentNote: note })}>{label}</Button></div>
    </div>
  );
}

function QaCard({ o }: { o: Of<'qa'> }) {
  const r = o.output;
  return (
    <OutputCard testId="output-qa" title="Content-QA (Hinweise)" mock={o.mock} createdAt={o.createdAt} warnings={o.warnings}>
      <p className="mb-2"><strong className={r.blockers ? 'text-danger' : ''}>{r.blockers} Blocker · {r.warnings} Warnungen.</strong> {r.summary}</p>
      <ul className="grid gap-1.5">
        {r.findings.map((f, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-1.5">
            <Pill tone={SEVERITY[f.severity]}>{f.severity}</Pill>
            <span className="text-muted">{f.category}{f.sceneIndex != null ? ` · Szene ${f.sceneIndex + 1}` : ''}{f.source === 'rule' ? ' · Regel' : ' · KI'}</span>
            <span>{f.issue}{f.quote ? <span className="text-muted"> („{f.quote}“)</span> : null}{f.suggestion ? <span className="text-muted"> → {f.suggestion}</span> : null}</span>
          </li>
        ))}
      </ul>
    </OutputCard>
  );
}

const textsOf = (parts: { field: string; text: string }[]) => Object.fromEntries(parts.map((p) => [p.field, p.text]));

function StoryboardCard({ o, busy, onApprove, reload }: { o: Of<'storyboard'>; busy: boolean; onApprove: (b: { confirmed: boolean; clientConsentNote: string }) => void; reload: () => Promise<void> }) {
  const s = o.output;
  return (
    <OutputCard testId="output-storyboard" title="Dramaturgie & Shotlist" mock={o.mock} createdAt={o.createdAt} badges={<StatusPill o={o} />} warnings={o.warnings}>
      <p className="mb-2 font-semibold">{s.logline}</p>
      <ol className="grid list-decimal gap-1 pl-5">
        {s.beats.map((b, i) => <li key={i}><strong>Szene {b.sceneIndex + 1}:</strong> {b.intent} <span className="text-muted">· Kamera {b.camera} · Licht {b.lighting} · Ton {b.sound} · → {b.transition}</span></li>)}
      </ol>
      <div className="mt-2 font-semibold">Shotlist</div>
      <ul className="grid gap-0.5">
        {s.shots.map((x, i) => <li key={i}>• Szene {x.sceneIndex + 1} <span className="text-muted">[{x.shotType} · {ORIGIN_LABEL[x.origin]}]</span> {x.shot} — {x.framing}{x.movement ? `, ${x.movement}` : ''}{x.notes ? ` (${x.notes})` : ''}</li>)}
      </ul>
      <List
        title="KI-Asset-Briefs (nur Text, nichts wird erzeugt)"
        items={s.aiAssetBriefs.map((b) => `Szene ${b.sceneIndex + 1}: ${b.purpose} – Prompt: ${b.prompt} · Kennzeichnung: „${b.disclosureLabel}“${b.clientApprovalRequired ? ' · Kundin muss zustimmen' : ''}`)}
      />
      <p className="mt-2 text-muted">Drehzeit ca. {s.production.estimatedShootMinutes} min{s.production.locations.length ? ` · Orte: ${s.production.locations.join(', ')}` : ''}{s.production.props.length ? ` · Requisiten: ${s.production.props.join(', ')}` : ''}</p>
      <List items={s.warnings} tone="mt-1 text-warn" />
      {o.status !== 'approved' ? <StrategyGateCard kind="storyboard" id={o.id} texts={textsOf(storyboardLintParts(s))} onChanged={() => void reload()} /> : null}
      <Approve o={o} label="✓ Drehplan freigeben" confirmText="KI-Elemente geprüft: gekennzeichnet, keine Produktdarstellung, kein bezahlter Job ohne weitere Freigabe." busy={busy} onApprove={onApprove} />
    </OutputCard>
  );
}

function CopyCard({ o, busy, onApprove, onCopied, reload }: { o: Of<'copy'>; busy: boolean; onApprove: (b: { confirmed: boolean; clientConsentNote: string }) => void; onCopied: () => void; reload: () => Promise<void> }) {
  const c = o.output;
  return (
    <OutputCard testId="output-copy" title={`Instagram-Copy (Job ${c.job})`} mock={o.mock} createdAt={o.createdAt} badges={<StatusPill o={o} />} warnings={o.warnings}>
      {c.disclosures.length ? <p className="mb-2">Kennzeichnung (vom Studio gesetzt): {c.disclosures.map((d) => <Pill key={d} tone="warn">{d}</Pill>)} · beim Posten zusätzlich die Instagram-Labels setzen („Bezahlte Partnerschaft“ bzw. „KI-Info“).</p> : null}
      <pre className="whitespace-pre-wrap rounded-lg border border-line bg-[#f5f7f0] p-3 font-sans text-[12px]" data-testid="caption">{c.caption}</pre>
      <SlopHints text={c.caption} where="caption" testId="caption-slop" />
      <p className="mt-2"><span className="text-muted">Cover:</span> {c.coverText} · <span className="text-muted">Alt-Text:</span> {c.altText}</p>
      <p><span className="text-muted">Suchbegriffe:</span> {c.searchTerms.join(', ') || '—'}</p>
      <List items={c.lint.filter((l) => l.level === 'warn').map((l) => `⚠ ${l.message}`)} tone="mt-1 text-warn" />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(c.caption).then(onCopied)}>Caption kopieren</Button>
      </div>
      {o.status !== 'approved' ? <StrategyGateCard kind="copy" id={o.id} texts={textsOf(copyLintParts(c))} onChanged={() => void reload()} /> : null}
      <Approve o={o} label="✓ Caption freigeben" confirmText="Geprüft: keine unbelegten Aussagen, Kennzeichnungen stimmen. Posten mache ich selbst." busy={busy} onApprove={onApprove} />
    </OutputCard>
  );
}
