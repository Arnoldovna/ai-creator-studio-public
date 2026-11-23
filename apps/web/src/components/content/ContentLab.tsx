'use client';
import Link from 'next/link';
import { conceptLintParts } from '@studio/core/strategyLint';
import { splitLines } from '@studio/core/text';
import { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '@/lib/api';
import type { Brief, Concept, Project, ScriptVersion, ResearchReportRecord, ScriptOutputView, ContextOverview } from '@/lib/types';
import { LEGACY_LABEL } from '../strategy/GateParts';
import { StrategyGateCard } from '../strategy/StrategyGateCard';
import { useToast } from '../toast';
import { Button, Empty, ErrorNote, Field, MockBadge, PageHeader, Pill } from '../ui';
import { AiContextPreview } from './AiContextPreview';
import { ResearchPanel } from './ResearchPanel';
import { ScriptEditor } from './ScriptEditor';

interface ContentData {
  briefs: Brief[];
  concepts: Concept[];
  scripts: ScriptVersion[];
  scriptOutputs: ScriptOutputView[];
  researchReports: ResearchReportRecord[];
  styleVersions: Record<string, { version: number; status: string; name: string }>;
  context: { style: { version: number; status: string; name: string } | null; voice: { version: number; status: string } | null; growthHypothesis: string | null };
}

const GOALS = { practice: 'Üben & Freude', growth: 'Passende neue Follower gewinnen', engagement: 'Community und Interaktion', trust: 'Vertrauen und Persönlichkeit zeigen', conversion: 'Produkt verständlich präsentieren' };
/** Goals hidden for personal projects while the phase is „Private Erprobung“. */
const PAUSED_GOALS = new Set(['growth', 'conversion']);
const FORMATS = { talking_head: 'Talking Head', product_demo: 'Product Demo', voiceover: 'Voiceover' };

export function ContentLab() {
  const toast = useToast();
  const projects = useApi<Project[]>('/api/projects');
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    // Etappe 20: the week board opens the Content Lab of its project (`?project=`)
    const wanted = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('project') : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default selection once projects load
    if (!projectId && projects.data?.length) setProjectId(projects.data.find((p) => p.id === wanted)?.id ?? projects.data[0]!.id);
  }, [projects.data, projectId]);
  const project = projects.data?.find((p) => p.id === projectId) ?? null;
  const content = useApi<ContentData>(projectId ? `/api/content?projectId=${projectId}` : null);
  const strategy = useApi<ContextOverview>('/api/context');
  const personal = project?.kind === 'PERSONAL_CONTENT';
  // D7: in „Private Erprobung“ growth hints and growth/conversion goals are paused for her own projects
  const privateTrial = (strategy.data?.phase ?? 'private_trial') === 'private_trial';
  const goalOptions = Object.entries(GOALS).filter(([k]) => !(personal && privateTrial && PAUSED_GOALS.has(k)));
  const pillars = strategy.data?.pillars ?? [];
  const pillarName = (id: string | null | undefined) => (id ? pillars.find((p) => p.id === id)?.name ?? id : null);
  // Etappe 11: topic ideas are the example topics of the active strategy's pillars
  const topicIdeas = personal ? strategy.data?.topicIdeas ?? [] : [];

  // goal '' = default per project kind: „Üben & Freude“ for her own content, growth for client work (as before)
  const [brief, setBrief] = useState({ topic: '', audience: '', goal: '', facts: '', format: 'talking_head', lengthSeconds: 30, cta: '', notes: '', pillarId: '' });
  const goal = brief.goal && goalOptions.some(([k]) => k === brief.goal) ? brief.goal : personal ? 'practice' : 'growth';
  const [briefId, setBriefId] = useState<string | null>(null);
  const [conceptId, setConceptId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A failed „Skript bauen“ is shown at the concept's button, not in the brief panel above. */
  const [writeError, setWriteError] = useState<{ conceptId: string; message: string } | null>(null);

  const activeBriefId = briefId ?? content.data?.briefs[0]?.id ?? null;
  const concepts = useMemo(() => (content.data?.concepts ?? []).filter((c) => c.briefId === activeBriefId).sort((a, b) => a.index - b.index), [content.data, activeBriefId]);
  const activeConceptId = conceptId ?? concepts.find((c) => c.status === 'approved')?.id ?? null;
  const scripts = (content.data?.scripts ?? []).filter((s) => s.conceptId === activeConceptId);

  async function generate() {
    if (!projectId) return;
    if (!brief.topic.trim()) { setError('Bitte zuerst ein Produkt oder Thema eintragen.'); return; }
    setBusy('concepts');
    setError(null);
    try {
      const r = await api<{ briefId: string; concepts: Concept[]; warnings: string[]; mock: boolean }>('/api/content/concepts', {
        method: 'POST',
        json: {
          projectId, topic: brief.topic, audience: brief.audience, goal, verifiedFacts: splitLines(brief.facts, 20), format: brief.format, lengthSeconds: Number(brief.lengthSeconds), cta: brief.cta, notes: brief.notes,
          // Etappe 10: the pillar is optional for her own content (no strategy gate)
          pillarId: personal && brief.pillarId ? brief.pillarId : null,
        },
      });
      setBriefId(r.briefId);
      setConceptId(null);
      await content.reload();
      toast(`Drei Konzepte erstellt${r.mock ? ' (Mock)' : ''}.${r.warnings.length ? ` Hinweis: ${r.warnings.join(' ')}` : ''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function writeScript(c: Concept) {
    setBusy(c.id);
    setWriteError(null);
    try {
      await api<ScriptVersion>(`/api/content/concepts/${c.id}/script`, { method: 'POST' });
      setConceptId(c.id);
      await content.reload();
      toast('UGC-Skript erstellt – bitte prüfen und bearbeiten.');
    } catch (e) {
      setWriteError({ conceptId: c.id, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const currentBrief = content.data?.briefs.find((b) => b.id === activeBriefId) ?? null;
  const ctx = content.data?.context;
  const set = (k: keyof typeof brief) => (e: { target: { value: string } }) => setBrief({ ...brief, [k]: e.target.value });

  return (
    <div className="appear">
      <PageHeader
        eyebrow="02 / CONTENT LAB · STORY BEFORE VOLUME"
        title="Content mit Konzept."
        accent="Nicht mit Zufall."
        lead="Briefing → aktuelle Style Bible & Voice → drei Konzepte → eins auswählen → UGC-Skript mit Hooks, Szenen, CTA und Shotlist. Jede Bearbeitung wird als neue Version gespeichert."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel">
          <h2 className="mb-1 text-lg font-bold">Creative Brief</h2>
          <Field label="Projekt" htmlFor="project">
            <select id="project" className="field" value={projectId ?? ''} onChange={(e) => { setProjectId(e.target.value); setBriefId(null); setConceptId(null); setBrief((b) => ({ ...b, goal: '', pillarId: '' })); }}>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.title} · {p.kind === 'UGC_CLIENT' ? 'UGC-Kunde' : 'Persönlich'}</option>)}
            </select>
          </Field>
          {personal ? (
            <Field label="Säule (optional)" htmlFor="pillar" hint={pillars.length ? 'Aus deiner Strategie.' : undefined}>
              {pillars.length ? (
                <select id="pillar" className="field" value={brief.pillarId} onChange={set('pillarId')}>
                  <option value="">– keine Säule –</option>
                  {pillars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              ) : strategy.error ? (
                <ErrorNote error={`Strategie konnte nicht geladen werden: ${strategy.error}`} />
              ) : !strategy.data ? (
                <p className="hint m-0" data-testid="strategy-loading">Lade Strategie …</p>
              ) : (
                <p className="hint m-0" data-testid="no-strategy">Noch keine Säulen – optional, unter <Link className="underline" href="/strategy">Strategie</Link> anlegbar.</p>
              )}
            </Field>
          ) : null}
          <Field label="Produkt oder Thema" htmlFor="topic"><input id="topic" className="field" value={brief.topic} onChange={set('topic')} placeholder="z. B. meine Brother-Strickmaschine" /></Field>
          {topicIdeas.length ? (
            <div className="-mt-1 mb-2 flex flex-wrap gap-1.5" aria-label="Themenideen">
              {topicIdeas.map((t) => (
                <button key={t} type="button" className="rounded-full border border-line px-2 py-0.5 text-[11px]" onClick={() => setBrief((b) => ({ ...b, topic: t }))}>{t}</button>
              ))}
            </div>
          ) : null}
          <Field label="Zielgruppe" htmlFor="audience"><input id="audience" className="field" value={brief.audience} onChange={set('audience')} placeholder="z. B. Menschen, die Kreativität und Tech mögen" /></Field>
          <div className="grid gap-x-3 sm:grid-cols-3">
            <Field label="Ziel" htmlFor="goal"><select id="goal" className="field" value={goal} onChange={set('goal')}>{goalOptions.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Format" htmlFor="format"><select id="format" className="field" value={brief.format} onChange={set('format')}>{Object.entries(FORMATS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Videolänge" htmlFor="length"><select id="length" className="field" value={brief.lengthSeconds} onChange={set('lengthSeconds')}>{[15, 30, 45].map((n) => <option key={n} value={n}>{n} Sekunden</option>)}</select></Field>
          </div>
          <Field label="Verifizierte Fakten / echte Erfahrung (eine pro Zeile)" htmlFor="facts" hint="Nur diese Aussagen (plus Kundenclaims bei UGC) dürfen im Skript als Claims stehen.">
            <textarea id="facts" rows={3} className="field" value={brief.facts} onChange={set('facts')} placeholder="Was weißt du sicher? Welche eigene Erfahrung hast du tatsächlich gemacht?" />
          </Field>
          {projectId ? (
            <ResearchPanel
              key={`research-${projectId}`}
              projectId={projectId} topic={brief.topic} audience={brief.audience} reports={content.data?.researchReports ?? []} reload={content.reload}
              onAdoptFact={(fact) => setBrief((b) => ({ ...b, facts: b.facts.trim() ? `${b.facts.trim()}\n${fact}` : fact }))}
            />
          ) : null}
          <Field label="Call to Action (optional)" htmlFor="cta"><input id="cta" className="field" value={brief.cta} onChange={set('cta')} placeholder="z. B. Welche Technik soll ich als Nächstes testen?" /></Field>
          {projectId ? <AiContextPreview key={`preview-${projectId}`} subject={{ projectId }} /> : null}
          <Button variant="primary" className="mt-5 w-full" busy={busy === 'concepts'} onClick={generate}>✳ Drei Konzepte erstellen</Button>
          <ErrorNote error={error} />
        </section>
        <section className="panel self-start">
          <h2 className="mb-3 text-lg font-bold">Was die Agenten berücksichtigen</h2>
          <ul className="list-disc pl-5 text-xs leading-7 text-[#343b2d]">
            <li><strong className="text-accent">Style:</strong> {ctx?.style ? `${ctx.style.name} v${ctx.style.version} (${ctx.style.status === 'approved' ? 'aktiv' : 'Entwurf – nicht aktiv'})` : 'Noch keine Style Bible'}</li>
            <li><strong className="text-accent">Voice:</strong> {ctx?.voice ? `v${ctx.voice.version} (${ctx.voice.status})` : 'Noch nicht kalibriert'}</li>
            <li><strong className="text-accent">Projekt:</strong> {project ? `${project.title} · ${project.kind}` : '—'}</li>
            {project?.kind === 'UGC_CLIENT' ? <li><strong className="text-accent">Kundenclaims:</strong> {project.client?.productClaims.length ?? 0} freigegebene Aussagen</li> : null}
            <li><strong className="text-accent">UGC:</strong> echte Produkterfahrung, keine erfundenen Claims oder Testimonials</li>
            <li><strong className="text-accent">Video:</strong> Hybrid (deine Aufnahmen + optionale, gekennzeichnete KI-Assets)</li>
          </ul>
          <div className="my-5 h-px bg-line" />
          {personal && privateTrial ? (
            <p className="hint m-0" data-testid="growth-feedback-paused">Growth-Hinweise pausiert (private Erprobung).</p>
          ) : (
            <>
              <h3 className="mb-2 text-sm font-bold">Growth-Feedback</h3>
              <p className="hint">{ctx?.growthHypothesis ?? 'Noch keine Daten. Erstelle zunächst einen Post und erfasse später echte Insights.'}</p>
              <p className="hint">Hypothesen sind Testideen – Style-Regeln werden nie automatisch geändert.</p>
            </>
          )}
        </section>
      </div>

      {content.data?.briefs.length ? (
        <div className="mt-10">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="m-0 text-xl font-bold">Deine drei Konzepte</h2>
            <div className="flex items-center gap-2">
              {concepts[0] ? <MockBadge mock={concepts[0].mock} /> : null}
              <select aria-label="Briefing wählen" className="field w-64 py-1.5" value={activeBriefId ?? ''} onChange={(e) => { setBriefId(e.target.value); setConceptId(null); }}>
                {content.data.briefs.map((b) => <option key={b.id} value={b.id}>{b.createdAt.slice(0, 16).replace('T', ' ')} · {b.input.topic}</option>)}
              </select>
            </div>
          </div>
          {currentBrief ? <p className="hint mb-3">Briefing: {currentBrief.input.topic} · {FORMATS[currentBrief.input.format]} · {currentBrief.input.lengthSeconds}s · {currentBrief.input.verifiedFacts.length} verifizierte Fakten</p> : null}
          <div className="grid gap-4 md:grid-cols-3" data-testid="concepts">
            {concepts.map((c, i) => (
              <article key={c.id} className={`flex flex-col gap-3 rounded-xl border p-5 ${activeConceptId === c.id ? 'border-accent bg-[#f5f7f0]' : 'border-line bg-card'}`} data-testid="concept-card">
                <div className="font-mono text-2xl text-[#4a6116]">0{i + 1}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] tracking-wider text-[#737b68]">
                  {c.body.kind}
                  {c.pillarId ? <Pill tone="ok">Säule {pillarName(c.pillarId)}</Pill> : null}
                  {c.strategyVersionId === undefined && personal ? <Pill>{LEGACY_LABEL}</Pill> : null}
                </div>
                <h3 className="m-0 text-[17px] leading-snug font-bold">{c.body.title}</h3>
                <p className="m-0 text-xs leading-relaxed text-[#343b2d]"><b>Hook:</b> „{c.body.hook}“</p>
                {c.body.hookVariants.length ? <ul className="m-0 list-disc pl-4 text-[11px] text-muted">{c.body.hookVariants.map((h) => <li key={h}>{h}</li>)}</ul> : null}
                <p className="m-0 text-xs leading-relaxed text-[#343b2d]">{c.body.angle}</p>
                <p className="m-0 text-[11px] text-muted"><b>Warum:</b> {c.body.rationale}</p>
                <p className="m-0 text-[11px] text-muted"><b>Stil:</b> {c.body.styleNotes}</p>
                <p className="m-0 flex-1 text-[11px] text-muted"><b>CTA:</b> {c.body.cta}</p>
                <div className="grid gap-1.5">
                  {personal ? (
                    // Etappe 10: no FitCheck in her own projects – the concept goes straight to the script
                    <>
                      <Button variant={activeConceptId === c.id ? 'primary' : 'subtle'} busy={busy === c.id} onClick={() => writeScript(c)}>
                        {content.data!.scripts.some((s) => s.conceptId === c.id) ? 'Neues Skript generieren' : 'Skript daraus bauen →'}
                      </Button>
                      {writeError?.conceptId === c.id ? <ErrorNote error={writeError.message} /> : null}
                    </>
                  ) : (
                    <ClientConceptAction concept={c} active={activeConceptId === c.id} busy={busy === c.id} hasScript={content.data!.scripts.some((s) => s.conceptId === c.id)} onWrite={() => writeScript(c)}
                      error={writeError?.conceptId === c.id ? writeError.message : null} />
                  )}
                  {content.data!.scripts.some((s) => s.conceptId === c.id) && activeConceptId !== c.id ? <Button size="sm" variant="ghost" onClick={() => setConceptId(c.id)}>Skripte ansehen</Button> : null}
                  {personal ? (
                    // Etappe 18: not every day needs a reel – the same idea as a carousel
                    <Link className="rounded-lg border border-[#dde2d2] px-2.5 py-1.5 text-center text-[11px] font-medium hover:bg-[#f2f4ec]" data-testid="concept-carousel"
                      href={`/karussells?project=${encodeURIComponent(c.projectId)}&source=concept&id=${encodeURIComponent(c.id)}`}>Karussell daraus →</Link>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {activeConceptId ? (
        <div className="mt-10">
          {scripts.length ? (
            <ScriptEditor key={activeConceptId} personal={personal} scripts={scripts} outputs={content.data?.scriptOutputs ?? []} styleVersions={content.data?.styleVersions ?? {}} reload={content.reload} />
          ) : (
            <Empty>Für dieses Konzept gibt es noch kein Skript.</Empty>
          )}
        </div>
      ) : null}
      {content.error ? <ErrorNote error={content.error} /> : null}
      {projects.data && !projects.data.length ? <Pill>Kein Projekt</Pill> : null}
    </div>
  );
}

/**
 * Client project concept: no FitCheck, but the boundary lint (own list, home location) runs on the concept text.
 * The gate card shows findings with „Bewusst trotzdem“; the script button stays disabled while one blocks.
 */
function ClientConceptAction({ concept, active, busy, hasScript, onWrite, error }: { concept: Concept; active: boolean; busy: boolean; hasScript: boolean; onWrite: () => void; error: string | null }) {
  const [blocked, setBlocked] = useState(true);
  return (
    <>
      <Button variant={active ? 'primary' : 'subtle'} busy={busy} disabled={blocked} onClick={onWrite}>
        {hasScript ? 'Neues Skript generieren' : 'Skript daraus bauen →'}
      </Button>
      <ErrorNote error={error} />
      <StrategyGateCard kind="concept" id={concept.id} onBlocked={setBlocked} texts={Object.fromEntries(conceptLintParts(concept.body).map((p) => [p.field, p.text]))} />
    </>
  );
}
