import type { LlmProvider, StructuredResult } from '../providers/types';
import { ConceptsWire, normalizeConcepts, type ConceptDraft } from '../schemas';
import { contextWarnings, STRATEGY_PROMPT_RULE, untrustedCreativeContext, type CreativeContext } from './context';

export const CONTENT_STRATEGIST_PROMPT_VERSION = 'content-strategist@2026-11-16.1';

const SYSTEM = `Du bist Content Strategist für Instagram-Reels und UGC. Entwickle genau drei klar
unterschiedliche Konzepte (verschiedene Winkel, nicht nur umformulierte Hooks) für das Briefing.
Nutze Style Bible und Voice Guide, wenn vorhanden. Jeder Hook muss in den ersten 2 Sekunden funktionieren
und sprechbar sein. Keine erfundenen Claims, Zahlen, Testimonials oder Vorher-Nachher-Versprechen.
Bei UGC_CLIENT nur Aussagen aus den verifizierten Fakten bzw. Kundenclaims verwenden.
Eine Growth-Hypothese ist eine Testidee, kein Beweis.
${STRATEGY_PROMPT_RULE}
Antworte auf Deutsch.`;

/** Rule-based concepts (ported from the prototype, extended with hook variants). */
export function mockConcepts(ctx: CreativeContext): { concepts: ConceptDraft[]; warnings: string[] } {
  const b = ctx.brief;
  const subject = b.topic;
  const who = b.audience || 'Menschen, die neugierig auf das Thema sind';
  const ugc = ctx.projectKind === 'UGC_CLIENT';
  const styleNotes = ctx.style
    ? `Style „${ctx.style.rules.name}“ v${ctx.style.version}: ${ctx.style.rules.visual.traits.slice(0, 4).join(', ') || 'keine Leitbegriffe'}${ctx.style.rules.motion.pacing ? ` · Motion: ${ctx.style.rules.motion.pacing}` : ''}`
    : 'Noch keine Style Bible – neutral, echtes Licht, ruhige Kamera.';
  const cta = b.cta || null;
  const concepts: ConceptDraft[] = [
    {
      title: 'Der klare Aha-Moment',
      kind: 'PRODUKT / DEMO',
      hook: ugc ? `So sieht ${subject} wirklich in der Anwendung aus.` : `Das ist der Teil an ${subject}, den ich spannend finde.`,
      hookVariants: [
        `Kurz und ehrlich: ${subject} in echt.`,
        `Bevor du ${subject} ausprobierst, schau dir das an.`,
      ],
      angle: `Einstieg über eine konkrete Beobachtung, dann echte Anwendung zeigen. Für: ${who}.`,
      structure: ['Beobachtbarer Einstieg', 'Problem oder Kontext', 'Echte Demonstration', 'Offene Frage / CTA'],
      cta: cta ?? (ugc ? 'Das Produkt im Einsatz beurteilen und bei Bedarf mehr erfahren.' : 'Welche Details soll ich als Nächstes zeigen?'),
      rationale: 'Demonstration schafft Vertrauen, weil sie zeigt statt behauptet.',
      styleNotes,
    },
    {
      title: 'Experiment mit offenem Ausgang',
      kind: 'PROZESS / STORY',
      hook: ugc ? `Ich teste heute ${subject} – ohne vorweggenommenes Fazit.` : `Was passiert, wenn ich ${subject} einfach mal anders angehe?`,
      hookVariants: [`Ich weiß noch nicht, ob das klappt: ${subject}.`, `Experiment: ${subject}, Versuch 1.`],
      angle: 'Neugier und Prozess vor perfektem Ergebnis. Raum für kleine Überraschungen, keine künstlichen Behauptungen.',
      structure: ['Frage', 'Setup und Erwartung', 'Experiment in kurzen Schritten', 'Tatsächlicher Zwischenstand'],
      cta: cta ?? 'Was würdest du als Nächstes ausprobieren?',
      rationale: 'Offener Ausgang erzeugt Spannung bis zum Ende (Watchtime), ohne Ergebnis zu versprechen.',
      styleNotes,
    },
    {
      title: 'Eine kleine persönliche Geschichte',
      kind: 'BEHIND THE SCENES',
      hook: ugc ? `Ein Blick hinter meinen echten Test von ${subject}.` : `Weshalb ich mich gerade mit ${subject} beschäftige.`,
      hookVariants: [`Warum gerade ${subject}? Kurze Geschichte.`, `Hinter den Kulissen: ${subject}.`],
      angle: 'Persönlicher Zugang mit ruhigen Detailaufnahmen, wertschätzender Ehrlichkeit und einem kurzen Erkenntnismoment.',
      structure: ['Persönlicher Kontext', 'Was ich daran interessant finde', 'Echter Prozess / Produktdetail', 'Einladung zum Austausch'],
      cta: cta ?? 'Welche Erfahrung hast du mit dem Thema?',
      rationale: 'Persönlichkeit macht den Account wiedererkennbar und lädt zu Kommentaren ein.',
      styleNotes,
    },
  ];
  return { concepts, warnings: ['Regelbasierte Demo-Konzepte (Mock-Modus, kein LLM).'] };
}

export async function runContentStrategist(
  provider: LlmProvider,
  ctx: CreativeContext,
): Promise<StructuredResult<{ concepts: ConceptDraft[]; warnings: string[] }> & { promptVersion: string }> {
  const res = await provider.generate({
    agent: 'content_strategist',
    promptVersion: CONTENT_STRATEGIST_PROMPT_VERSION,
    schemaName: 'content_concepts',
    schema: ConceptsWire,
    system: SYSTEM,
    instruction:
      `Erstelle genau 3 Konzepte für ein ${ctx.brief.lengthSeconds}-Sekunden-Video im Format ${ctx.brief.format}. ` +
      'Jedes Konzept: Titel, Art, Haupt-Hook, 2–3 Hook-Varianten, Winkel, 3–5 Strukturschritte, CTA, Begründung, Stilhinweise.',
    untrustedContext: untrustedCreativeContext(ctx),
    mock: () => mockConcepts(ctx),
  });
  const normalized = normalizeConcepts(res.output);
  return {
    ...res,
    output: { ...normalized, warnings: [...new Set([...normalized.warnings, ...contextWarnings(ctx)])] },
    promptVersion: CONTENT_STRATEGIST_PROMPT_VERSION,
  };
}
