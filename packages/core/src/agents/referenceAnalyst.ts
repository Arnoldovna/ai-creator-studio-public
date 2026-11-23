import { describePalette } from '../palette';
import type { ImageInput, LlmProvider, StructuredResult } from '../providers/types';
import { normalizeReferenceAnalysis, ReferenceAnalysisWire, type ReferenceAnalysis } from '../schemas';
import { fnv1a } from '../text';

export const REFERENCE_ANALYST_PROMPT_VERSION = 'reference-analyst@2026-11-14.1';

export interface ReferenceAnalystInput {
  reference: {
    id: string;
    name: string;
    kind: 'image' | 'video';
    palette: string[];
    notes: string;
    likes: string[];
    dislikes: string[];
    tags: string[];
  };
  /** The image itself, or extracted video keyframes. */
  images: ImageInput[];
  keyframeTimestamps?: number[];
}

const SYSTEM = `Du bist der Reference Analyst eines Creative Studios. Du analysierst visuelle Referenzen
(Fotos, Grafikdesign, Typografie, Filmstills, Video-Keyframes) als Inspiration für eine EIGENE Bildsprache.
Trenne strikt:
- "observed": direkt im Bild sichtbare Merkmale (Farben, Licht, Bildaufbau, sichtbare Schrift),
- "interpreted": Deutungen (Stimmung, Ästhetik, Zielgruppe).
Gib für jede Beobachtung eine konkrete visuelle Evidenz und eine ehrliche Konfidenz zwischen 0 und 1 an.
Benenne Unsicherheiten (z. B. Kompression, Ausschnitt, nur Keyframes statt Bewegung).
Identifiziere keine Personen. Empfiehl nicht, fremde Werke, Logos oder Creator-Identitäten zu kopieren.
Antworte auf Deutsch. Farben als #RRGGBB.`;

export function mockReferenceAnalysis(input: ReferenceAnalystInput): ReferenceAnalysis {
  const r = input.reference;
  const { temperature, contrast } = describePalette(r.palette);
  const seed = fnv1a(r.id + r.name);
  const compositions = ['zentrierte Hauptfigur', 'asymmetrische Drittel-Aufteilung', 'grafische Fläche mit viel Negativraum', 'enger Detailausschnitt'];
  const isVideo = r.kind === 'video';
  const frames = input.keyframeTimestamps?.length ?? 0;
  const observations: ReferenceAnalysis['observations'] = [];
  if (r.palette.length) {
    observations.push({
      dimension: 'color',
      kind: 'observed',
      statement: `Technische Farbstichprobe: ${r.palette.join(', ')} (${temperature === 'warm' ? 'eher warm' : temperature === 'cool' ? 'eher kühl' : temperature === 'mixed' ? 'gemischte Temperatur' : 'neutral'}, Kontrast ${contrast}).`,
      evidence: 'Quantisierte Pixelhäufigkeiten – gemessen, nicht KI-interpretiert.',
      confidence: 0.9,
    });
  }
  for (const like of r.likes.slice(0, 5)) {
    observations.push({
      dimension: 'aesthetic',
      kind: 'interpreted',
      statement: `Von dir markiert: „${like}“`,
      evidence: 'Übernommen aus deiner eigenen Bewertung (Mock-Modus, keine Bildanalyse).',
      confidence: 0.6,
    });
  }
  observations.push({
    dimension: 'composition',
    kind: 'interpreted',
    statement: `[MOCK] Platzhalter-Komposition: ${compositions[seed % compositions.length]}.`,
    evidence: 'Deterministischer Mock-Wert – bitte nicht als echte Analyse übernehmen.',
    confidence: 0.1,
  });
  if (isVideo) {
    observations.push({
      dimension: 'motion',
      kind: 'observed',
      statement: frames ? `${frames} Keyframes extrahiert; Bewegung/Schnittrhythmus noch nicht analysiert.` : 'Keine Keyframes verfügbar; Bewegung nicht analysiert.',
      evidence: 'FFmpeg-Keyframe-Extraktion',
      confidence: frames ? 0.5 : 0.1,
    });
  }
  return {
    summary: `[MOCK] Deterministische Demo-Analyse für „${r.name}“. Es wurde kein KI-Modell aufgerufen.`,
    colorCharacter: {
      description: r.palette.length ? `Technische Farbstichprobe, ${temperature}, Kontrast ${contrast}.` : 'Keine Farbstichprobe verfügbar.',
      dominantColors: r.palette,
      temperature,
      contrast,
    },
    typography: { visible: false, description: null },
    composition: '[MOCK] nicht analysiert',
    lighting: '[MOCK] nicht analysiert',
    textures: '[MOCK] nicht analysiert',
    aesthetic: r.likes.slice(0, 5),
    observations,
    uncertainties: [
      'Mock-Modus: Komposition, Licht, Typografie und Texturen wurden nicht wirklich analysiert.',
      ...(isVideo ? ['Video: nur Keyframes; Motion- und Audioanalyse folgen später.'] : []),
    ],
  };
}

export async function runReferenceAnalyst(
  provider: LlmProvider,
  input: ReferenceAnalystInput,
): Promise<StructuredResult<ReferenceAnalysis> & { promptVersion: string }> {
  const r = input.reference;
  const res = await provider.generate({
    agent: 'reference_analyst',
    promptVersion: REFERENCE_ANALYST_PROMPT_VERSION,
    schemaName: 'reference_analysis',
    schema: ReferenceAnalysisWire,
    system: SYSTEM,
    instruction:
      `Analysiere ${r.kind === 'video' ? `diese ${input.images.length} Keyframes eines Videos (Zeitpunkte in Sekunden: ${(input.keyframeTimestamps ?? []).join(', ') || 'unbekannt'})` : 'dieses Referenzbild'} ` +
      'hinsichtlich Farbcharakter, Typografie (falls sichtbar), Bildkomposition, Licht, Texturen und Ästhetik. ' +
      'Liefere 6–15 Beobachtungen. Die technische Farbstichprobe und die Notizen der Nutzerin stehen in den Daten unten.',
    untrustedContext: {
      fileName: r.name,
      technicalPalette: r.palette,
      userNotes: r.notes,
      userLikes: r.likes,
      userDislikes: r.dislikes,
      tags: r.tags,
    },
    images: input.images,
    mock: () => mockReferenceAnalysis(input),
  });
  return { ...res, output: normalizeReferenceAnalysis(res.output), promptVersion: REFERENCE_ANALYST_PROMPT_VERSION };
}
