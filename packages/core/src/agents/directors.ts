/**
 * Style Director (style_synthesis) and Voice Director (voice_analysis).
 * Both only SUGGEST: the result fills the editor form, the user edits it, creates a draft
 * version herself and approves it explicitly. Nothing here writes a Style Bible or Voice Guide.
 */
import { z } from 'zod';
import type { LlmProvider, StructuredResult } from '../providers/types';
import { STYLE_FORM_LIMITS, STYLE_ITEM_MAX, STYLE_TEXT_MAX, ValidationError, VOICE_FORM_LIMITS, type StyleForm, type VoiceForm } from '../schemas';
import { collapseWs, joinList, splitList, squash, unique, wordCount } from '../text';
import { DEFAULT_STYLE_NAME } from './styleCompose';

export const STYLE_DIRECTOR_PROMPT_VERSION = 'style-director@2026-11-15.1';
export const VOICE_DIRECTOR_PROMPT_VERSION = 'voice-director@2026-11-15.1';

/** Shape every director returns (same as the web AgentResult). */
type DirectorResult<S> = StructuredResult<{ suggestion: S; warnings: string[] }> & { promptVersion: string };

// ---------- shared helpers ----------
const cleanText = (s: string, max = STYLE_TEXT_MAX) => collapseWs(s, max);
const cleanList = (xs: string[], max: number) => unique(xs.map((x) => cleanText(x, STYLE_ITEM_MAX))).slice(0, max);
const cleanTexts = (xs: string[], max: number) => xs.map((x) => cleanText(x)).filter(Boolean).slice(0, max);
/** The user's own list entries first, then suggested ones; joined for the form within its character limit. */
const mergeList = (own: string, suggested: string[], maxChars: number) => joinList(unique([...splitList(own, 40), ...suggested]), maxChars);

// ---------- Style Director ----------
const STYLE_TEXT_FIELDS = ['typography', 'lighting', 'composition', 'textures', 'motion'] as const;
type StyleTextField = (typeof STYLE_TEXT_FIELDS)[number];
export const STYLE_SUGGESTION_FIELDS = ['name', 'traits', 'avoid', ...STYLE_TEXT_FIELDS, 'transitions'] as const;
export type StyleSuggestionField = (typeof STYLE_SUGGESTION_FIELDS)[number];
/** UI labels – the same words as the editor form. */
export const STYLE_FIELD_LABELS: Record<StyleSuggestionField, string> = {
  name: 'Name', traits: 'Visuelle Leitbegriffe', avoid: 'Vermeiden', typography: 'Typografie', lighting: 'Licht',
  composition: 'Komposition', textures: 'Texturen', motion: 'Schnitt und Bewegung', transitions: 'Übergänge',
};

export const StyleSuggestionWire = z.object({
  name: z.string(),
  traits: z.array(z.string()),
  avoid: z.array(z.string()),
  typography: z.string(),
  lighting: z.string(),
  composition: z.string(),
  textures: z.string(),
  motion: z.string(),
  transitions: z.array(z.string()),
  /** Which approved observations support a field (IDs from the input only). */
  evidence: z.array(z.object({ field: z.enum(STYLE_SUGGESTION_FIELDS), observationIds: z.array(z.string()), note: z.string() })),
  /** Contradictions between observations, or between observations and the user's own entries. */
  conflicts: z.array(z.string()),
  uncertainties: z.array(z.string()),
});
export type StyleSuggestion = z.infer<typeof StyleSuggestionWire>;

export interface StyleSynthesisInput {
  /** The user's own entries – authoritative; the director keeps and extends them. */
  form: StyleForm;
  /** Only observations the user explicitly approved in the review gate. */
  approvedObservations: { id: string; referenceName: string; dimension: string; kind: string; statement: string; confidence: number }[];
  likes: string[];
  dislikes: string[];
}

export function normalizeStyleSuggestion(raw: unknown, knownObservationIds: readonly string[]): { suggestion: StyleSuggestion; warnings: string[] } {
  const s = StyleSuggestionWire.parse(raw);
  const known = new Set(knownObservationIds);
  const warnings: string[] = [];
  let dropped = 0;
  const evidence = s.evidence
    .map((e) => {
      const ids = unique(e.observationIds.filter((id) => known.has(id)));
      dropped += e.observationIds.length - ids.length;
      return { field: e.field, observationIds: ids, note: cleanText(e.note) };
    })
    .filter((e) => e.observationIds.length)
    .slice(0, 30);
  if (dropped) warnings.push(`${dropped} Evidenz-Verweis(e) auf unbekannte Beobachtungen wurden entfernt.`);
  const suggestion: StyleSuggestion = {
    name: cleanText(s.name, STYLE_FORM_LIMITS.name),
    traits: cleanList(s.traits, 20),
    avoid: cleanList(s.avoid, 20),
    typography: cleanText(s.typography),
    lighting: cleanText(s.lighting),
    composition: cleanText(s.composition),
    textures: cleanText(s.textures),
    motion: cleanText(s.motion),
    transitions: cleanList(s.transitions, 12),
    evidence,
    conflicts: cleanTexts(s.conflicts, 12),
    uncertainties: cleanTexts(s.uncertainties, 12),
  };
  if (!suggestion.evidence.length) warnings.push('Der Vorschlag nennt keine belegenden Beobachtungen – bitte besonders kritisch prüfen.');
  return { suggestion, warnings };
}

/**
 * Suggestion → editor form. Adds to the user's entries, never removes them: her list items stay first,
 * her non-empty text fields win, and every field stays within the form limit.
 * The palette is not an LLM decision and stays untouched.
 */
export function styleSuggestionToForm(s: StyleSuggestion, current: StyleForm): StyleForm {
  const text = (f: StyleTextField) => (current[f].trim() || s[f]).slice(0, STYLE_FORM_LIMITS[f]);
  return {
    ...current,
    name: current.name.trim() || s.name,
    traits: mergeList(current.traits, s.traits, STYLE_FORM_LIMITS.traits),
    avoid: mergeList(current.avoid, s.avoid, STYLE_FORM_LIMITS.avoid),
    transitions: mergeList(current.transitions, s.transitions, STYLE_FORM_LIMITS.transitions),
    typography: text('typography'),
    lighting: text('lighting'),
    composition: text('composition'),
    textures: text('textures'),
    motion: text('motion'),
  };
}

const STYLE_DIM_FIELD: Partial<Record<string, StyleTextField>> = {
  typography: 'typography', lighting: 'lighting', composition: 'composition', texture: 'textures', motion: 'motion',
};

/**
 * Deterministic, rule-based synthesis (mock mode): fills empty text fields from approved observations of
 * the matching dimension. Likes, dislikes and other observations are not repeated here because
 * composeStyleBible adds them to every version anyway.
 */
export function mockStyleSuggestion(input: StyleSynthesisInput): StyleSuggestion {
  const byField = new Map<StyleTextField, StyleSynthesisInput['approvedObservations']>();
  for (const o of input.approvedObservations) {
    const field = STYLE_DIM_FIELD[o.dimension];
    if (!field) continue; // colour → palette sampler; aesthetic/subject → added by composeStyleBible
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field)!.push(o);
  }
  const text = (f: StyleTextField) => input.form[f].trim() || (byField.get(f) ?? []).map((o) => o.statement).join('; ');
  return {
    name: input.form.name.trim() || DEFAULT_STYLE_NAME,
    traits: splitList(input.form.traits),
    avoid: splitList(input.form.avoid),
    typography: text('typography'),
    lighting: text('lighting'),
    composition: text('composition'),
    textures: text('textures'),
    motion: text('motion'),
    transitions: splitList(input.form.transitions, 20),
    evidence: [...byField.entries()].map(([field, obs]) => ({
      field, observationIds: obs.map((o) => o.id), note: `${obs.length} bestätigte Beobachtung(en) der Dimension ${obs[0]!.dimension}.`,
    })),
    conflicts: [],
    uncertainties: ['[MOCK] Regelbasierte Zusammenfassung ohne KI: Beobachtungen wurden nur nach Dimension gruppiert, nicht gewichtet oder verdichtet.'],
  };
}

const STYLE_SYSTEM = `Du bist Style Director eines Creative Studios. Du verdichtest von der Nutzerin BESTÄTIGTE
Beobachtungen zu Referenzen in eine eigene, konsistente Bildsprache (Style-Bible-Entwurf).
Regeln:
- Die eigenen Einträge der Nutzerin (form) sind maßgeblich: übernimm sie sinngemäß und ergänze sie, widersprich ihnen nicht stillschweigend.
  Widersprechen Beobachtungen ihren Einträgen, nenne das unter "conflicts".
- Formuliere Regeln für eine EIGENE Handschrift, keine Kopie einzelner Referenzen, Creator, Marken oder Logos.
- Jede Liste: kurze, konkrete Einträge ohne Kommas (max. ca. 12 Wörter je Eintrag).
- Texte für Typografie, Licht, Komposition, Texturen, Motion: je 1–3 Sätze, beobachtbar und umsetzbar.
- "evidence": nur IDs aus approvedObservations; erfinde keine IDs.
- Was die Beobachtungen nicht hergeben, bleibt leer oder kommt unter "uncertainties".
Antworte auf Deutsch.`;

export async function runStyleDirector(
  provider: LlmProvider,
  input: StyleSynthesisInput,
): Promise<DirectorResult<StyleSuggestion>> {
  const res = await provider.generate({
    agent: 'style_director',
    promptVersion: STYLE_DIRECTOR_PROMPT_VERSION,
    schemaName: 'style_suggestion',
    schema: StyleSuggestionWire,
    system: STYLE_SYSTEM,
    instruction:
      `Erstelle einen Style-Bible-Vorschlag aus ${input.approvedObservations.length} bestätigten Beobachtungen, ` +
      'den Mag-ich/Mag-ich-nicht-Merkmalen und den eigenen Einträgen der Nutzerin. Max. 20 Leitbegriffe, 20 Vermeiden-Einträge, 12 Übergänge.',
    untrustedContext: {
      form: { ...input.form, palette: undefined },
      approvedObservations: input.approvedObservations,
      likes: input.likes,
      dislikes: input.dislikes,
    },
    mock: () => mockStyleSuggestion(input),
  });
  const { suggestion, warnings } = normalizeStyleSuggestion(res.output, input.approvedObservations.map((o) => o.id));
  return { ...res, output: { suggestion, warnings }, promptVersion: STYLE_DIRECTOR_PROMPT_VERSION };
}

// ---------- Voice Director ----------
export const VoiceSuggestionWire = z.object({
  traits: z.array(z.object({ trait: z.string(), evidenceQuote: z.string() })),
  avoid: z.array(z.object({ pattern: z.string(), reason: z.string() })),
  /** Verbatim phrases from the user's samples that sound typical for her. */
  signaturePhrases: z.array(z.string()),
  sentenceStyle: z.string(),
  conflicts: z.array(z.string()),
  uncertainties: z.array(z.string()),
});
type VoiceSuggestionWire = z.infer<typeof VoiceSuggestionWire>;
export interface VoiceSuggestion {
  /** evidenceQuote is null when the model's quote does not occur verbatim in the samples; `user` = the user's own statement. */
  traits: { trait: string; evidenceQuote: string | null; source: 'user' | 'samples' }[];
  avoid: { pattern: string; reason: string }[];
  signaturePhrases: string[];
  sentenceStyle: string;
  conflicts: string[];
  uncertainties: string[];
}

export const VOICE_SAMPLE_MAX = 4000;
export const VoiceAnalysisRequest = z.object({
  samples: z.array(z.string().trim().max(VOICE_SAMPLE_MAX, `Ein Absatz darf max. ${VOICE_SAMPLE_MAX} Zeichen haben – bitte mit Leerzeilen teilen.`)).max(40)
    .transform((xs) => xs.filter(Boolean)),
});
export const VOICE_MIN_CHARS = 80;
export const VOICE_MAX_TOTAL_CHARS = 12000;

export interface VoiceAnalysisInput {
  /** The user's own texts (new samples + examples already stored in the Voice Guide). */
  samples: string[];
  /** Explicit statements/corrections by the user – authoritative. */
  userTraits: string[];
  userAvoid: string[];
}

export function assertVoiceSamples(samples: string[]) {
  const total = samples.reduce((n, s) => n + s.length, 0);
  if (total < VOICE_MIN_CHARS) throw new ValidationError(`Für eine Voice-Analyse braucht es mindestens ${VOICE_MIN_CHARS} Zeichen eigenen Text (aktuell ${total}).`);
  if (total > VOICE_MAX_TOTAL_CHARS) throw new ValidationError(`Max. ${VOICE_MAX_TOTAL_CHARS} Zeichen Textproben pro Analyse (aktuell ${total}).`);
}

export function normalizeVoiceSuggestion(raw: unknown, samples: readonly string[], userTraits: readonly string[] = []): { suggestion: VoiceSuggestion; warnings: string[] } {
  const v: VoiceSuggestionWire = VoiceSuggestionWire.parse(raw);
  const own = new Set(userTraits.map(squash));
  // Per sample: a "quote" stitched together across two separate texts is not verbatim.
  const corpus = samples.map(squash);
  const verbatim = (q: string) => q.trim().length >= 3 && corpus.some((c) => c.includes(squash(q)));
  const warnings: string[] = [];
  const traits = v.traits
    .map((t) => ({
      trait: cleanText(t.trait, STYLE_ITEM_MAX),
      evidenceQuote: verbatim(t.evidenceQuote) ? t.evidenceQuote.trim().slice(0, 300) : null,
      source: own.has(squash(t.trait)) ? ('user' as const) : ('samples' as const),
    }))
    .filter((t) => t.trait)
    .slice(0, 15);
  const unbacked = traits.filter((t) => !t.evidenceQuote && t.source === 'samples').length;
  if (unbacked) warnings.push(`${unbacked} Merkmal(e) ohne wörtlich belegbares Zitat aus deinen Texten – Beleg wurde entfernt, bitte prüfen.`);
  const phrases = v.signaturePhrases.map((p) => p.trim()).filter(Boolean);
  const signaturePhrases = unique(phrases.filter(verbatim).map((p) => p.slice(0, 200))).slice(0, 10);
  if (phrases.length > signaturePhrases.length) warnings.push(`${phrases.length - signaturePhrases.length} „typische Formulierung(en)“ standen nicht wörtlich in deinen Texten und wurden entfernt.`);
  return {
    suggestion: {
      traits,
      avoid: v.avoid.map((a) => ({ pattern: cleanText(a.pattern, STYLE_ITEM_MAX), reason: cleanText(a.reason) })).filter((a) => a.pattern).slice(0, 15),
      signaturePhrases,
      sentenceStyle: cleanText(v.sentenceStyle),
      conflicts: cleanTexts(v.conflicts, 10),
      uncertainties: cleanTexts(v.uncertainties, 10),
    },
    warnings,
  };
}

/** Suggestion → voice form: the user's own traits/avoids stay first, her example text is never replaced. */
export function voiceSuggestionToForm(s: VoiceSuggestion, current: VoiceForm): VoiceForm {
  return {
    ...current,
    traits: mergeList(current.traits, s.traits.map((t) => t.trait), VOICE_FORM_LIMITS.traits),
    avoid: mergeList(current.avoid, s.avoid.map((a) => a.pattern), VOICE_FORM_LIMITS.avoid),
  };
}

const sentencesOf = (text: string) => text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 1);

/** Deterministic text statistics (mock mode) – measured, not interpreted. */
export function mockVoiceSuggestion(input: VoiceAnalysisInput): VoiceSuggestionWire {
  const sentences = input.samples.flatMap(sentencesOf);
  const avg = sentences.length ? sentences.reduce((n, s) => n + wordCount(s), 0) / sentences.length : 0;
  const first = (pred: (s: string) => boolean) => sentences.find(pred) ?? '';
  const traits: VoiceSuggestionWire['traits'] = input.userTraits.map((t) => ({ trait: t, evidenceQuote: '' }));
  traits.push({ trait: avg <= 12 ? 'kurze Sätze' : avg <= 20 ? 'mittellange Sätze' : 'lange verschachtelte Sätze', evidenceQuote: sentences[0] ?? '' });
  const q = sentences.filter((s) => s.endsWith('?'));
  if (q.length) traits.push({ trait: 'stellt Fragen', evidenceQuote: q[0]! });
  const du = first((s) => /\b(du|dich|dir|dein)\b/i.test(s));
  if (du) traits.push({ trait: 'spricht das Publikum direkt mit du an', evidenceQuote: du });
  const ich = first((s) => /\b(ich|mich|mir|mein)\b/i.test(s));
  if (ich) traits.push({ trait: 'erzählt aus der Ich-Perspektive', evidenceQuote: ich });
  return {
    traits,
    avoid: input.userAvoid.map((p) => ({ pattern: p, reason: 'Von dir festgelegt.' })),
    signaturePhrases: input.samples.map((s) => sentencesOf(s)[0] ?? '').filter((s) => s && s.length <= 200).slice(0, 5),
    sentenceStyle: `Ø ${avg.toFixed(1)} Wörter pro Satz über ${sentences.length} Sätze (gezählt, nicht interpretiert).`,
    conflicts: [],
    uncertainties: ['[MOCK] Nur Textstatistik (Satzlänge, Fragen, Ansprache) ohne KI – Tonalität und Humor wurden nicht analysiert.'],
  };
}

const VOICE_SYSTEM = `Du bist Voice Director. Du analysierst AUSSCHLIESSLICH die eigenen Texte der Nutzerin
(samples), um ihre echte Sprache für Skripte zu beschreiben – keine fremden Creator, keine Wunsch-Persona.
Regeln:
- userTraits und userAvoid sind ausdrückliche Festlegungen der Nutzerin und haben Vorrang. Übernimm sie;
  widersprechen die Texte, nenne das unter "conflicts", statt sie zu streichen.
- Jedes Merkmal braucht ein wörtliches Zitat (evidenceQuote) aus den samples. Kein passendes Zitat → Merkmal weglassen.
- signaturePhrases: nur wörtliche Ausschnitte aus den samples.
- avoid: Muster, die NICHT nach ihr klingen (z. B. Werbefloskeln), jeweils mit kurzer Begründung.
- Merkmale kurz und ohne Kommas (max. ca. 8 Wörter).
- Zu wenig Text für eine Aussage → unter "uncertainties".
Antworte auf Deutsch.`;

export async function runVoiceDirector(
  provider: LlmProvider,
  input: VoiceAnalysisInput,
): Promise<DirectorResult<VoiceSuggestion>> {
  assertVoiceSamples(input.samples); // thrown before generate() → runAgent reports it as the user's 400
  const res = await provider.generate({
    agent: 'voice_director',
    promptVersion: VOICE_DIRECTOR_PROMPT_VERSION,
    schemaName: 'voice_suggestion',
    schema: VoiceSuggestionWire,
    system: VOICE_SYSTEM,
    instruction:
      `Analysiere ${input.samples.length} eigene Textprobe(n). Liefere 4–12 Merkmale mit wörtlichem Beleg, ` +
      '3–10 Vermeiden-Muster, bis zu 8 typische Formulierungen und eine kurze Beschreibung des Satzbaus.',
    untrustedContext: { ...input },
    mock: () => mockVoiceSuggestion(input),
  });
  const { suggestion, warnings } = normalizeVoiceSuggestion(res.output, input.samples, input.userTraits);
  return { ...res, output: { suggestion, warnings }, promptVersion: VOICE_DIRECTOR_PROMPT_VERSION };
}
