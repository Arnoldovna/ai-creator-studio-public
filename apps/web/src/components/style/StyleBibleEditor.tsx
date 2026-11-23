'use client';
import { styleSuggestionToForm, voiceSuggestionToForm } from '@studio/core/directors';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, downloadUrl, useApi } from '@/lib/api';
import type { DirectorSuggestion, StyleBibleVersion, StyleForm, StyleState, VoiceForm, VoiceGuideVersion } from '@/lib/types';
import { useToast } from '../toast';
import { Button, ErrorNote, Field, Pill, Swatches } from '../ui';
import { AdoptColor } from '../brand/Adopt';
import { StyleSuggestionCard, VoiceSuggestionCard } from './DirectorSuggestions';
import { StyleRulesEditor, VoiceRulesEditor } from './RulesEditor';

const STATUS_TONE = { approved: 'ok', draft: 'warn', archived: 'default' } as const;
const STATUS_LABEL = { approved: 'aktiv', draft: 'Entwurf', archived: 'archiviert' } as const;
type Saved<T> = T & { warnings?: string[] };

export function StyleBibleEditor() {
  const toast = useToast();
  const { data, error, reload } = useApi<StyleState>('/api/style');
  const [form, setForm] = useState<StyleForm | null>(null);
  const [voice, setVoice] = useState<VoiceForm | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Suggestion currently loaded into the form – sent as lineage when a version is created. */
  const [basis, setBasis] = useState<{ style: string | null; voice: string | null }>({ style: null, voice: null });
  const [samples, setSamples] = useState('');
  /** Inline edit of the active version's rules (a save creates a new active version). */
  const [editing, setEditing] = useState<'style' | 'voice' | null>(null);

  useEffect(() => {
    if (data && !form) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate editable form once
      setForm(data.form);
      setVoice(data.voiceForm);
    }
  }, [data, form]);

  if (error) return <ErrorNote error={error} />;
  if (!data || !form || !voice) return <p className="hint">Lade …</p>;

  const set = (k: keyof StyleForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const setV = (k: keyof VoiceForm) => (e: { target: { value: string } }) => setVoice({ ...voice, [k]: e.target.value });

  async function act<T>(label: string, fn: () => Promise<T>, ok: (r: T) => string) {
    setBusy(label);
    setErr(null);
    try {
      const r = await fn();
      await reload();
      toast(ok(r));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const saveDraft = () => api('/api/style', { method: 'PUT', json: { style: form, voice } });
  const savedText = (label: string) => (v: Saved<{ version: number }>) => [`${label} v${v.version} gespeichert und aktiv.`, ...(v.warnings ?? [])].join(' ');
  const createVersion = (kind: 'style' | 'voice') => async () => {
    const v = await api<Saved<StyleBibleVersion | VoiceGuideVersion>>(kind === 'style' ? '/api/style/versions' : '/api/voice/versions', {
      method: 'POST', json: { ...(kind === 'style' ? form : voice), suggestionId: basis[kind] },
    });
    setBasis((b) => ({ ...b, [kind]: null }));
    return v;
  };
  /** Saves edited rules as a new active version; the form is refreshed from the server afterwards. */
  const saveRules = (kind: 'style' | 'voice') => async (rules: StyleBibleVersion['rules'] | VoiceGuideVersion['rules']) => {
    setBusy(`rules-${kind}`);
    setErr(null);
    try {
      const v = await api<Saved<StyleBibleVersion | VoiceGuideVersion>>(kind === 'style' ? '/api/style/versions' : '/api/voice/versions', { method: 'POST', json: { rules } });
      const fresh = await api<StyleState>('/api/style');
      setForm(fresh.form);
      setVoice(fresh.voiceForm);
      await reload();
      setSelected(null);
      setEditing(null);
      toast(savedText(kind === 'style' ? 'Style Bible' : 'Voice Guide')(v));
    } finally {
      setBusy(null);
    }
  };
  const activeVoice = data.voiceVersions.find((v) => v.status === 'approved') ?? null;
  const { style: styleSuggestion, voice: voiceSuggestion } = data.suggestions;

  const preview = data.versions.find((v) => v.id === selected) ?? data.current;

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel self-start">
          <h2 className="mb-1 text-lg font-bold">Dein Style System</h2>
          <p className="hint">Style Director (regelbasiert): kombiniert dieses Formular, deine „Mag ich“-Merkmale und ausschließlich <strong>bestätigte</strong> KI-Beobachtungen.</p>
          <Field label="Name deiner Designsprache" htmlFor="styleName"><input id="styleName" className="field" value={form.name} onChange={set('name')} placeholder="z. B. Curious Editorial" /></Field>
          <Field label="Visuelle Leitbegriffe" htmlFor="styleTraits"><textarea id="styleTraits" rows={3} className="field" value={form.traits} onChange={set('traits')} placeholder="warm, grafisch, mutig, texturbetont …" /></Field>
          <Field label="Typografischer Charakter" htmlFor="styleTypography"><input id="styleTypography" className="field" value={form.typography} onChange={set('typography')} placeholder="Editorial, klare große Headlines, viel Weißraum" /></Field>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Licht" htmlFor="styleLighting"><input id="styleLighting" className="field" value={form.lighting} onChange={set('lighting')} placeholder="weiches Fensterlicht" /></Field>
            <Field label="Komposition" htmlFor="styleComposition"><input id="styleComposition" className="field" value={form.composition} onChange={set('composition')} placeholder="Negativraum, Drittel" /></Field>
            <Field label="Texturen" htmlFor="styleTextures"><input id="styleTextures" className="field" value={form.textures} onChange={set('textures')} placeholder="Wolle, Papier, Korn" /></Field>
            <Field label="Übergänge" htmlFor="styleTransitions"><input id="styleTransitions" className="field" value={form.transitions} onChange={set('transitions')} placeholder="harter Cut, Match Cut" /></Field>
          </div>
          <Field label="Schnitt und Bewegung" htmlFor="styleMotion"><input id="styleMotion" className="field" value={form.motion} onChange={set('motion')} placeholder="Ruhige Beobachtung, überraschende harte Cuts" /></Field>
          <Field label="Das vermeiden wir" htmlFor="styleAvoid"><textarea id="styleAvoid" rows={2} className="field" value={form.avoid} onChange={set('avoid')} placeholder="Pseudo-Luxus, generische AI-Reels …" /></Field>
          <Field label="Farbpalette (#RRGGBB, kommagetrennt · leer = automatisch aus Referenzen)" htmlFor="stylePalette">
            <input id="stylePalette" className="field font-mono" value={form.palette} onChange={set('palette')} placeholder="#D8FB96, #111411" />
          </Field>
          {data.suggestedPalette.length ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Swatches colors={data.suggestedPalette} />
              <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, palette: data.suggestedPalette.join(', ') })}>Vorschlag übernehmen</Button>
            </div>
          ) : null}
          <div className="note">Automatische Farben stammen aus einer groben Pixelstichprobe (kein KI-Verständnis). Grundlage: {data.likedReferenceCount} Referenzen mit „Mag ich“-Merkmalen, {data.approvedObservations.length} bestätigte KI-Beobachtungen{data.pendingObservationCount ? `, ${data.pendingObservationCount} noch offen (werden nicht übernommen)` : ''}.</div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" busy={busy === 'style'} onClick={() => act('style', createVersion('style'), savedText('Style Bible'))}>
              ✳ Style Bible aus Formular speichern
            </Button>
            <Button busy={busy === 'draft'} onClick={() => act('draft', saveDraft, () => 'Entwurf gespeichert.')}>Formular speichern</Button>
            <Button
              busy={busy === 'synth'}
              disabled={!data.approvedObservations.length}
              title={data.approvedObservations.length ? undefined : 'Erst Beobachtungen im Review bestätigen'}
              onClick={() => act('synth', () => api<DirectorSuggestion>('/api/style/synthesize', { method: 'POST', json: { style: form } }), (r) => (r.mock ? 'Regelbasierter Vorschlag erstellt (Mock).' : 'KI-Vorschlag erstellt – bitte prüfen.'))}
            >
              KI-Vorschlag aus Beobachtungen
            </Button>
          </div>
          {styleSuggestion ? (
            <StyleSuggestionCard
              suggestion={styleSuggestion}
              applied={basis.style === styleSuggestion.id}
              onApply={() => { setForm(styleSuggestionToForm(styleSuggestion.output, form)); setBasis((b) => ({ ...b, style: styleSuggestion.id })); toast('Vorschlag ergänzt dein Formular – prüfen, anpassen, dann speichern.'); }}
            />
          ) : null}
        </section>

        <section className="panel self-start">
          <h2 className="mb-1 text-lg font-bold">Dein Voice Guide</h2>
          <p className="hint">Benutze eigene Texte und Sprachbeispiele. Nicht die Persönlichkeit fremder Creators imitieren.</p>
          <Field label="So klinge ich" htmlFor="voiceTraits"><textarea id="voiceTraits" rows={3} className="field" value={voice.traits} onChange={setV('traits')} placeholder="neugierig, direkt, humorvoll, unperfekt …" /></Field>
          <Field label="So möchte ich NICHT klingen" htmlFor="voiceAvoid"><textarea id="voiceAvoid" rows={3} className="field" value={voice.avoid} onChange={setV('avoid')} placeholder="Sales-Phrasen, künstliche Begeisterung, Clickbait …" /></Field>
          <Field label="Ein eigenes Textbeispiel" htmlFor="voiceExample"><textarea id="voiceExample" rows={4} className="field" value={voice.example} onChange={setV('example')} placeholder="Ein paar eigene Sätze, wie du wirklich sprechen würdest …" /></Field>
          <Button className="mt-4 w-full" busy={busy === 'voice'} onClick={() => act('voice', createVersion('voice'), savedText('Voice Guide'))}>
            Voice Guide aus Formular speichern
          </Button>
          <Field label="Eigene Texte analysieren (Captions, Notizen, Transkripte · Absätze mit Leerzeile trennen)" htmlFor="voiceSamples">
            <textarea id="voiceSamples" rows={4} className="field" value={samples} onChange={(e) => setSamples(e.target.value)} placeholder="Nur deine eigenen Texte – keine fremden Creator." />
          </Field>
          <Button
            className="mt-2"
            busy={busy === 'vanalyze'}
            onClick={() => act('vanalyze', () => api<DirectorSuggestion>('/api/voice/analyze', { method: 'POST', json: { samples: samples.split(/\n\s*\n/), voice } }), (r) => (r.mock ? 'Textstatistik erstellt (Mock).' : 'KI-Analyse erstellt – bitte prüfen.'))}
          >
            Stimme analysieren
          </Button>
          <p className="hint mt-1">Analysiert werden die Texte oben plus dein Beispieltext und bereits gespeicherte eigene Beispiele. „So klinge ich“ und „Nicht so“ gelten als deine Vorgaben.</p>
          <Button
            className="mt-2"
            busy={busy === 'vcontext'}
            data-testid="voice-from-context"
            onClick={() => act('vcontext', () => api<DirectorSuggestion>('/api/voice/from-context', { method: 'POST' }), (r) => (r.mock ? 'Vorschlag aus Profil und Quellen erstellt (MOCK: nur Textstatistik, keine KI).' : 'KI-Vorschlag aus Profil und Quellen erstellt – bitte prüfen.'))}
          >
            Voice Guide aus Profil und Quellen ableiten
          </Button>
          <p className="hint mt-1">Liest dein aktives Profil und die Quellen, die nicht auf „Nie mitsenden“ stehen (Interviewfragen werden ausgelassen). Ein Agentenlauf mit Budget; das Ergebnis ist nur ein Vorschlag – du übernimmst ihn ins Formular und speicherst selbst.</p>
          {voiceSuggestion ? (
            <VoiceSuggestionCard
              suggestion={voiceSuggestion}
              applied={basis.voice === voiceSuggestion.id}
              onApply={() => { setVoice(voiceSuggestionToForm(voiceSuggestion.output, voice)); setBasis((b) => ({ ...b, voice: voiceSuggestion.id })); toast('Merkmale ergänzen dein Formular – prüfen, dann Version speichern.'); }}
            />
          ) : null}
          <VersionList
            title="Voice-Versionen"
            items={data.voiceVersions.map((v) => ({ id: v.id, version: v.version, status: v.status, label: v.rules.traits.slice(0, 4).join(' · ') || '—' }))}
            onActivate={(id) => act('va', () => api(`/api/voice/versions/${id}/approve`, { method: 'POST' }), () => 'Voice Guide wieder aktiv.')}
            onEditActive={activeVoice && editing !== 'voice' ? () => setEditing('voice') : undefined}
          />
          {activeVoice && editing === 'voice' ? (
            <VoiceRulesEditor key={activeVoice.id} rules={activeVoice.rules} busy={busy === 'rules-voice'} onSave={saveRules('voice')} onCancel={() => setEditing(null)} />
          ) : null}
          {data.approvedObservations.length ? (
            <>
              <h3 className="mt-6 mb-2 text-sm font-bold">Bestätigte KI-Beobachtungen</h3>
              <ul className="grid max-h-60 gap-1 overflow-auto text-xs text-[#343b2d]">
                {data.approvedObservations.map((o) => <li key={o.id}>• {o.statement} <span className="text-muted">({o.referenceName}{o.mock ? ', Mock' : ''})</span></li>)}
              </ul>
            </>
          ) : null}
        </section>
      </div>
      <ErrorNote error={err} />

      <section className="panel mt-4" data-testid="style-preview">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="m-0 text-lg font-bold">Style Bible · Versionen</h2>
          {preview ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => downloadUrl(`/api/style/versions/${preview.id}/export?format=json`)}>↓ JSON</Button>
              <Button size="sm" onClick={() => downloadUrl(`/api/style/versions/${preview.id}/export?format=md`)}>↓ Markdown</Button>
            </div>
          ) : null}
        </div>
        {!data.versions.length ? (
          <p className="hint">Erstelle zuerst deine Style Bible, um hier deine Farben, Motive und Regeln zu sehen.</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
            <ul className="grid content-start gap-2">
              {data.versions.map((v) => (
                <li key={v.id}>
                  <button onClick={() => { setSelected(v.id); setEditing(null); }} className={`w-full rounded-xl border p-3 text-left ${preview?.id === v.id ? 'border-accent bg-[#eef6dc]' : 'border-line bg-card2'}`}>
                    <div className="flex items-center justify-between"><strong className="text-sm">v{v.version}</strong><Pill tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Pill></div>
                    <div className="mt-1 truncate text-[11px] text-muted">{v.rules.name} · {v.createdAt.slice(0, 16).replace('T', ' ')}</div>
                  </button>
                </li>
              ))}
            </ul>
            {preview && editing === 'style' && preview.status === 'approved' ? (
              <div>
                <div className="eyebrow">CREATIVE DNA · VERSION {preview.version} BEARBEITEN</div>
                <StyleRulesEditor key={preview.id} rules={preview.rules} busy={busy === 'rules-style'} onSave={saveRules('style')} onCancel={() => setEditing(null)} />
              </div>
            ) : preview ? (
              <div>
                <div className="eyebrow">CREATIVE DNA · VERSION {preview.version} · {STATUS_LABEL[preview.status].toUpperCase()}</div>
                <h2 className="text-2xl font-bold">{preview.rules.name}</h2>
                <Sub>Farbwelt</Sub>
                <div className="flex flex-wrap gap-3">
                  {preview.rules.visual.palette.length ? preview.rules.visual.palette.map((c) => (
                    <div key={c} className="w-[70px]"><div className="h-16 rounded-lg border border-black/10" style={{ background: c }} /><div className="mt-1.5 font-mono text-[10px] text-muted">{c}</div></div>
                  )) : <span className="hint">Keine Farben.</span>}
                </div>
                {preview.status === 'approved' && preview.rules.visual.palette.length ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="palette-adopt">
                    <span className="text-muted">Ins Design System (<Link href="/meine-marke" className="underline">Meine Marke</Link>):</span>
                    {preview.rules.visual.palette.map((c) => <AdoptColor key={c} hex={c} onDone={() => void reload()} />)}
                  </div>
                ) : null}
                <Sub>Visuelle Eigenschaften</Sub>
                <div className="flex flex-wrap gap-1.5">{preview.rules.visual.traits.length ? preview.rules.visual.traits.map((t) => <span key={t} className="tag">{t}</span>) : <span className="hint">Noch keine festgelegt.</span>}</div>
                <Sub>Nicht erwünscht</Sub>
                <div className="flex flex-wrap gap-1.5">{preview.rules.visual.avoid.length ? preview.rules.visual.avoid.map((t) => <span key={t} className="tag tag-avoid">{t}</span>) : <span className="hint">Noch nichts festgelegt.</span>}</div>
                <Sub>Typografie · Licht · Komposition · Texturen</Sub>
                <p className="hint">{[preview.rules.visual.typography, preview.rules.visual.lighting, preview.rules.visual.composition, preview.rules.visual.textures].map((x) => x || 'offen').join(' · ')}</p>
                <Sub>Motion</Sub>
                <p className="hint">{preview.rules.motion.pacing || 'offen'}{preview.rules.motion.transitions.length ? ` · ${preview.rules.motion.transitions.join(', ')}` : ''}</p>
                <p className="hint">{preview.rules.approvedReferenceIds.length} Referenzen · {preview.rules.approvedObservationIds.length} bestätigte KI-Beobachtungen</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {preview.status === 'approved' ? (
                    <>
                      <Pill tone="ok">Aktiv für Content-Agenten</Pill>
                      <Button variant="primary" onClick={() => setEditing('style')}>Bearbeiten</Button>
                    </>
                  ) : (
                    <Button busy={busy === 'approve'} onClick={() => act('approve', () => api(`/api/style/versions/${preview.id}/approve`, { method: 'POST' }), () => `Style Bible v${preview.version} ist wieder aktiv – Content-Agenten verwenden jetzt diese Version.`)}>
                      Wieder aktivieren
                    </Button>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </>
  );
}

const Sub = ({ children }: { children: React.ReactNode }) => <div className="mt-5 mb-2 text-[10px] tracking-[1.4px] text-[#737b68] uppercase">{children}</div>;

function VersionList({ title, items, onActivate, onEditActive }: {
  title: string; items: { id: string; version: number; status: 'draft' | 'approved' | 'archived'; label: string }[]; onActivate: (id: string) => void; onEditActive?: () => void;
}) {
  if (!items.length) return null;
  return (
    <>
      <h3 className="mt-6 mb-2 text-sm font-bold">{title}</h3>
      <ul className="grid gap-1.5">
        {items.map((v) => (
          <li key={v.id} className="flex items-center gap-2 text-xs">
            <strong>v{v.version}</strong>
            <Pill tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Pill>
            <span className="truncate text-muted">{v.label}</span>
            {v.status !== 'approved'
              ? <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onActivate(v.id)}>wieder aktivieren</Button>
              : onEditActive ? <Button size="sm" className="ml-auto" onClick={onEditActive}>Bearbeiten</Button> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
