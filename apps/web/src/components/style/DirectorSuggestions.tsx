'use client';
import { STYLE_FIELD_LABELS, STYLE_SUGGESTION_FIELDS } from '@studio/core/directors';
import type { ReactNode } from 'react';
import type { StyleState } from '@/lib/types';
import { Button, List, OutputCard } from '../ui';

type Suggestions = StyleState['suggestions'];
type Base = { mock: boolean; warnings: string[]; createdAt: string };

function Frame({ testId, title, meta, onApply, applyLabel, applied, warning, children }: {
  testId: string; title: string; meta: Base; onApply: () => void; applyLabel: string; applied: boolean; warning?: string; children: ReactNode;
}) {
  return (
    <OutputCard testId={testId} title={title} mock={meta.mock} createdAt={meta.createdAt} warnings={meta.warnings}>
      <p className="hint mb-2">Nur ein Vorschlag: Er ergänzt dein Formular erst, wenn du ihn übernimmst. Deine eigenen Einträge bleiben erhalten; danach Version speichern (sie ist sofort aktiv).</p>
      {children}
      {warning ? <p className="mt-2 text-warn" data-testid="suggestion-outdated">{warning}</p> : null}
      <Button size="sm" className="mt-3" onClick={onApply} disabled={applied}>{applied ? '✓ Im Formular' : applyLabel}</Button>
    </OutputCard>
  );
}

export function StyleSuggestionCard({ suggestion, onApply, applied }: { suggestion: NonNullable<Suggestions['style']>; onApply: () => void; applied: boolean }) {
  const s = suggestion.output;
  const evidence = new Map<string, number>();
  for (const e of s.evidence) evidence.set(e.field, (evidence.get(e.field) ?? 0) + e.observationIds.length);
  return (
    <Frame
      testId="suggestion-style" title="Style-Director-Vorschlag" meta={suggestion} onApply={onApply} applyLabel="In Formular übernehmen" applied={applied}
      warning={suggestion.outdated ? 'Hinweis: Mindestens eine zugrunde liegende Beobachtung ist nicht mehr bestätigt. Du kannst den Vorschlag trotzdem übernehmen oder neu erstellen.' : undefined}
    >
      <ul className="grid gap-1">
        {STYLE_SUGGESTION_FIELDS.map((field) => {
          const value = s[field];
          const text = Array.isArray(value) ? value.join(' · ') : value;
          const n = evidence.get(field) ?? 0;
          return text ? <li key={field}><span className="text-muted">{STYLE_FIELD_LABELS[field]}:</span> {text}{n ? <span className="text-muted"> ({n} Beleg{n > 1 ? 'e' : ''})</span> : null}</li> : null;
        })}
      </ul>
      <List title="Widersprüche" items={s.conflicts} tone="text-warn" />
      <List title="Unsicherheiten" items={s.uncertainties} />
    </Frame>
  );
}

export function VoiceSuggestionCard({ suggestion, onApply, applied }: { suggestion: NonNullable<Suggestions['voice']>; onApply: () => void; applied: boolean }) {
  const s = suggestion.output;
  return (
    <Frame testId="suggestion-voice" title="Voice-Director-Vorschlag" meta={suggestion} onApply={onApply} applyLabel="Merkmale übernehmen" applied={applied}>
      <p className="text-muted">{suggestion.sampleCount} eigene Textprobe(n) analysiert. {s.sentenceStyle}</p>
      <div className="mt-2 font-semibold">So klingst du</div>
      <ul className="grid gap-1">
        {s.traits.map((t, i) => (
          <li key={i}>
            • {t.trait}{' '}
            {t.source === 'user' ? <span className="text-muted">(von dir festgelegt)</span> : t.evidenceQuote ? <span className="text-muted">– „{t.evidenceQuote}“</span> : <span className="text-warn">(kein wörtlicher Beleg)</span>}
          </li>
        ))}
      </ul>
      <List title="Klingt nicht nach dir" items={s.avoid.map((a) => `${a.pattern}${a.reason ? ` – ${a.reason}` : ''}`)} />
      <List title="Typische Formulierungen (wörtlich aus deinen Texten)" items={s.signaturePhrases.map((p) => `„${p}“`)} />
      <List title="Widersprüche" items={s.conflicts} tone="text-warn" />
      <List title="Unsicherheiten" items={s.uncertainties} />
    </Frame>
  );
}
