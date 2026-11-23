/**
 * Design Director (use case `design_system_synthesis`, Etappe 14). Only SUGGESTS: the result is shown next to
 * „Meine Marke“ as before/after and becomes a Style Bible version only when she takes it over and saves.
 *
 * - Input: CONFIRMED observations, the Style Bible rules, reference METADATA (names, palettes, likes, tags – no
 *   pixels), her Voice Guide and the deterministic derivation as the base. All of it goes in as untrusted data.
 * - Evidence only from confirmed observations: unknown observation/reference ids are dropped (warning).
 * - Fonts only from the allow-list (system fonts and her uploaded fonts); anything else keeps the base font.
 * - Own words only when they literally occur in her texts (no invented phrases).
 * - Mock mode: deterministic (the derivation itself), labelled [MOCK].
 */
import { z } from 'zod';
import type { LlmProvider, StructuredResult } from '../providers/types';
import { collapseWs, unique } from '../text';
import {
  COLOR_ROLES, contrastChecks, DesignSystem, FontRef, TEMPERATURES, TRANSITIONS, TYPE_ROLES,
  type ColorRole, type DesignSystem as DesignSystemT, type Provenance, type TypeRole,
} from '../designSystem';

export const DESIGN_DIRECTOR_PROMPT_VERSION = 'design-director@2026-11-19.1';

const ROLE_ENUM = z.enum(COLOR_ROLES);
const TYPE_ROLE_ENUM = z.enum(TYPE_ROLES);
export const DesignSuggestionWire = z.object({
  colors: z.array(z.object({ role: ROLE_ENUM, hex: z.string(), observationIds: z.array(z.string()), note: z.string() })),
  typography: z.array(z.object({
    role: TYPE_ROLE_ENUM, font: z.string(), weight: z.enum(['regular', 'bold']), size: z.enum(['S', 'M', 'L']), textCase: z.enum(['none', 'upper', 'lower']),
    observationIds: z.array(z.string()), note: z.string(),
  })),
  preset: z.object({
    hookShape: z.enum(['box', 'outline']), lowerThirdShape: z.enum(['stripe', 'box', 'outline']), keywordShape: z.enum(['box', 'outline']), animation: z.enum(['fade', 'none']), note: z.string(),
  }),
  motion: z.object({
    targetCutSec: z.number().nullable(), transitions: z.array(z.enum(TRANSITIONS)), zoom: z.enum(['none', 'push_in', 'push_out', 'punch_in']), tempo: z.enum(['calm', 'medium', 'fast']), note: z.string(),
  }),
  imagery: z.object({ keywords: z.array(z.string()), light: z.string(), temperature: z.enum(TEMPERATURES).nullable(), referenceIds: z.array(z.string()), observationIds: z.array(z.string()) }),
  phrases: z.array(z.string()),
  guidelines: z.string(),
  uncertainties: z.array(z.string()),
});
export type DesignSuggestionWire = z.infer<typeof DesignSuggestionWire>;

export interface DesignSynthesisInput {
  approvedObservations: { id: string; referenceId: string; referenceName: string; dimension: string; statement: string; colors: string[] }[];
  rules: { palette: string[]; traits: string[]; avoid: string[]; typography: string; lighting: string; composition: string; textures: string; pacing: string; transitions: string[] };
  references: { id: string; name: string; palette: string[]; likes: string[]; dislikes: string[]; tags: string[] }[];
  voice: { traits: string[]; texts: string[] } | null;
  /** Allowed font refs with a label (system fonts and her uploaded fonts). */
  fonts: { ref: string; label: string }[];
  /** Deterministic derivation (`deriveDesignSystem`): the base the suggestion is applied to. */
  base: DesignSystemT;
}

export interface DesignSuggestion { design: DesignSystemT; uncertainties: string[] }
type DirectorResult = StructuredResult<{ suggestion: DesignSuggestion; warnings: string[] }> & { promptVersion: string };

const clean = (s: string, max: number) => collapseWs(s, max);
const norm = (s: string) => s.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();

/** Applies a validated wire suggestion to the base design; everything not provable is dropped with a warning. */
export function normalizeDesignSuggestion(raw: unknown, input: DesignSynthesisInput): { suggestion: DesignSuggestion; warnings: string[] } {
  const s = DesignSuggestionWire.parse(raw);
  const warnings: string[] = [];
  const knownObs = new Set(input.approvedObservations.map((o) => o.id));
  const knownRefs = new Set(input.references.map((r) => r.id));
  const fonts = new Set(input.fonts.map((f) => f.ref));
  let droppedIds = 0;
  const obsIds = (ids: string[]) => {
    const ok = unique(ids.filter((id) => knownObs.has(id))).slice(0, 20);
    droppedIds += ids.length - ok.length;
    return ok;
  };
  const ai = (observationIds: string[], note: string, referenceIds: string[] = []): Provenance => ({ source: 'ai', observationIds, referenceIds, note: clean(note, 200) });
  const d = structuredClone(input.base);

  const seenColor = new Set<ColorRole>();
  for (const c of s.colors) {
    if (seenColor.has(c.role)) continue;
    seenColor.add(c.role);
    if (!/^#[0-9A-Fa-f]{6}$/.test(c.hex)) { warnings.push(`Farbe „${clean(c.hex, 20)}“ für ${c.role} ist kein #RRGGBB – verworfen.`); continue; }
    const hex = c.hex.toUpperCase(), ids = obsIds(c.observationIds);
    // a colour that is in no confirmed observation, the palette or a reference is the model's own invention: say so
    const known = [...input.rules.palette, ...input.approvedObservations.flatMap((o) => o.colors), ...input.references.flatMap((r) => r.palette)].map((x) => x.toUpperCase());
    if (!known.includes(hex)) warnings.push(`${c.role}: ${hex} kommt in keiner bestätigten Beobachtung, Palette oder Referenz vor (KI-eigene Farbe).`);
    d.colors[c.role] = { hex, origin: ai(ids, known.includes(hex) ? c.note : `KI-eigene Farbe · ${c.note}`) };
  }
  const seenType = new Set<TypeRole>();
  for (const t of s.typography) {
    if (seenType.has(t.role)) continue;
    seenType.add(t.role);
    if (!fonts.has(t.font) || !FontRef.safeParse(t.font).success) {
      warnings.push(`Schrift „${clean(t.font, 40)}“ (${t.role}) ist nicht in der erlaubten Liste – bisherige Schrift behalten.`);
      // font kept from the base: so is its origin (the AI did not set it)
      d.typography[t.role] = { ...d.typography[t.role], weight: t.weight, size: t.size, textCase: t.textCase };
      continue;
    }
    d.typography[t.role] = { font: t.font, weight: t.weight, size: t.size, textCase: t.textCase, origin: ai(obsIds(t.observationIds), `Annäherung: ${clean(t.note, 180)}`) };
  }
  const p = d.presets.findIndex((x) => x.id === d.defaultPresetId);
  if (p >= 0) {
    const cur = d.presets[p]!;
    d.presets[p] = {
      ...cur, hook: { ...cur.hook, shape: s.preset.hookShape }, lowerThird: { ...cur.lowerThird, shape: s.preset.lowerThirdShape },
      keyword: { ...cur.keyword, shape: s.preset.keywordShape }, animation: s.preset.animation, origin: ai([], s.preset.note),
    };
  }
  const target = s.motion.targetCutSec;
  d.motion = {
    targetCutSec: target == null || !Number.isFinite(target) ? null : Math.round(Math.min(15, Math.max(0.5, target)) * 10) / 10,
    transitions: unique(s.motion.transitions).slice(0, 3), zoom: s.motion.zoom, tempo: s.motion.tempo, origin: ai([], s.motion.note),
  };
  if (!d.motion.transitions.length) d.motion.transitions = ['hard_cut'];
  const refIds = unique(s.imagery.referenceIds.filter((id) => knownRefs.has(id))).slice(0, 24);
  if (refIds.length < s.imagery.referenceIds.length) warnings.push(`${s.imagery.referenceIds.length - refIds.length} unbekannte Referenz-ID(s) im Bildlook entfernt.`);
  d.imagery = {
    keywords: unique(s.imagery.keywords.map((k) => clean(k, 80)).filter(Boolean)).slice(0, 20), light: clean(s.imagery.light, 600), temperature: s.imagery.temperature,
    referenceIds: refIds.length ? refIds : d.imagery.referenceIds, origin: ai(obsIds(s.imagery.observationIds), 'Bildlook', refIds),
  };
  // own words: only what literally occurs in her texts or is already hers
  const haystack = norm([...(input.voice?.texts ?? []), ...input.base.phrases.map((x) => x.text)].join('\n'));
  const phrases = unique(s.phrases.map((x) => clean(x, 160)).filter(Boolean));
  const proven = phrases.filter((x) => haystack.includes(norm(x)));
  if (proven.length < phrases.length) warnings.push(`${phrases.length - proven.length} Phrase(n) stehen nicht wörtlich in deinen Texten – nicht übernommen.`);
  d.phrases = unique([...input.base.phrases.map((x) => x.text), ...proven]).slice(0, 40)
    .map((text) => input.base.phrases.find((x) => x.text === text) ?? { text, origin: { source: 'voice', observationIds: [], referenceIds: [], note: 'wörtlich aus deinen Texten (KI-Auswahl)' } });
  const guidelines = clean(s.guidelines, 2000);
  if (guidelines) { d.guidelines = guidelines; d.guidelinesOrigin = ai([], 'Leitlinien'); }
  if (droppedIds) warnings.push(`${droppedIds} Verweis(e) auf nicht bestätigte oder unbekannte Beobachtungen entfernt.`);

  const parsed = DesignSystem.safeParse(d);
  if (!parsed.success) throw new z.ZodError(parsed.error.issues);
  const preset = parsed.data.presets.find((x) => x.id === parsed.data.defaultPresetId);
  for (const c of contrastChecks(parsed.data.colors, preset).filter((x) => !x.aa)) warnings.push(`${c.label}: Kontrast ${c.ratio.toFixed(1)}:1 unter WCAG AA (4,5:1).`);
  const evidence = [...Object.values(parsed.data.colors), ...Object.values(parsed.data.typography)].some((t) => t.origin.source === 'ai' && t.origin.observationIds.length);
  if (!evidence) warnings.push('Der Vorschlag nennt keine belegenden Beobachtungen – bitte besonders kritisch prüfen.');
  return { suggestion: { design: parsed.data, uncertainties: s.uncertainties.map((u) => clean(u, 300)).filter(Boolean).slice(0, 12) }, warnings };
}

/** Mock: the deterministic derivation, expressed as a wire answer (so the same normalisation runs). */
export function mockDesignSuggestion(input: DesignSynthesisInput): DesignSuggestionWire {
  const b = input.base;
  const preset = b.presets.find((p) => p.id === b.defaultPresetId) ?? b.presets[0]!;
  return {
    colors: COLOR_ROLES.map((role) => ({ role, hex: b.colors[role].hex, observationIds: b.colors[role].origin.observationIds, note: `[MOCK] ${b.colors[role].origin.note || 'aus der Ableitung'}` })),
    typography: TYPE_ROLES.map((role) => ({ ...b.typography[role], role, observationIds: b.typography[role].origin.observationIds, note: '[MOCK] aus der Ableitung' })),
    preset: { hookShape: preset.hook.shape, lowerThirdShape: preset.lowerThird.shape, keywordShape: preset.keyword.shape, animation: preset.animation, note: '[MOCK] Standard-Stil' },
    motion: { targetCutSec: b.motion.targetCutSec, transitions: b.motion.transitions, zoom: b.motion.zoom, tempo: b.motion.tempo, note: '[MOCK] aus Tempo und Übergängen' },
    imagery: { keywords: b.imagery.keywords, light: b.imagery.light, temperature: b.imagery.temperature, referenceIds: b.imagery.referenceIds, observationIds: b.imagery.origin.observationIds },
    phrases: b.phrases.map((p) => p.text),
    guidelines: b.guidelines,
    uncertainties: ['[MOCK] Regelbasierte Ableitung ohne KI: Farben nach Helligkeit und Farbigkeit sortiert, Schriften nur grob zugeordnet.'],
  };
}

const SYSTEM = `Du bist Design Director eines Creative Studios. Du entwickelst aus von der Nutzerin BESTÄTIGTEN Beobachtungen,
ihren Style-Bible-Regeln, Referenz-Metadaten und ihrem Voice Guide ein eigenes Design System („Meine Marke“) für
Reel-Overlays, Karussells und Stories.
Regeln:
- Eigene Handschrift, keine Kopie einzelner Referenzen, Creator, Marken oder Logos.
- Farben als #RRGGBB je Rolle (primary, accent, surface, onSurface, onAccent, onVideo, background). Text auf Fläche und
  Text auf Akzent müssen WCAG AA erfüllen (Kontrast mindestens 4,5:1).
- Schriften NUR aus der Liste "fonts" (Feld "ref"). Die Zuordnung von Typografie-Beobachtungen zu Schriften ist eine
  Annäherung; schreibe das in "note".
- "observationIds" nur aus approvedObservations; erfinde keine IDs. "referenceIds" nur aus references.
- "phrases": nur Wörter oder Wendungen, die wörtlich in voice.texts stehen.
- Was die Daten nicht hergeben, kommt unter "uncertainties"; "base" ist die regelbasierte Ableitung als Ausgangspunkt.
Antworte auf Deutsch.`;

export async function runDesignDirector(provider: LlmProvider, input: DesignSynthesisInput): Promise<DirectorResult> {
  const res = await provider.generate({
    agent: 'design_director',
    promptVersion: DESIGN_DIRECTOR_PROMPT_VERSION,
    schemaName: 'design_system_suggestion',
    schema: DesignSuggestionWire,
    system: SYSTEM,
    instruction: `Schlage ein Design System aus ${input.approvedObservations.length} bestätigten Beobachtungen vor. Alle sieben Farbrollen, alle sechs Schriftrollen, ein Overlay-Stil, Bewegung, Bildlook, bis zu 20 eigene Wörter, Leitlinien (max. 1500 Zeichen).`,
    untrustedContext: {
      approvedObservations: input.approvedObservations, rules: input.rules, references: input.references, voice: input.voice, fonts: input.fonts,
      base: { colors: input.base.colors, typography: input.base.typography, motion: input.base.motion, imagery: input.base.imagery },
    },
    mock: () => mockDesignSuggestion(input),
  });
  const { suggestion, warnings } = normalizeDesignSuggestion(res.output, input);
  return { ...res, output: { suggestion, warnings }, promptVersion: DESIGN_DIRECTOR_PROMPT_VERSION };
}
