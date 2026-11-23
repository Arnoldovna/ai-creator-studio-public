import { enforceClaimAllowlist } from '../claims';
import type { LlmProvider, StructuredResult } from '../providers/types';
import { UgcScriptWire, validateScript, type ConceptDraft, type UgcScript, type VideoFormat } from '../schemas';
import { allowedClaims, contextWarnings, STRATEGY_PROMPT_RULE, untrustedCreativeContext, type CreativeContext } from './context';

export const UGC_SCRIPTWRITER_PROMPT_VERSION = 'ugc-scriptwriter@2026-11-16.1';

const SYSTEM = `Du bist UGC Scriptwriter. Schreibe ein sprechbares, natürliches Skript in der Stimme der Creatorin
(Voice Guide), mit Szenen und Sekundenangaben, Hook-Varianten, CTA und einfacher Shotlist für echte Aufnahmen.
Regeln:
- Ca. 2,3 gesprochene Wörter pro Sekunde; kurze Sätze; keine Werbephrasen aus der Anti-Liste des Voice Guides.
- verifiedClaims enthält NUR Aussagen, die wörtlich in den verifizierten Fakten / Kundenclaims stehen.
- Jede andere Produkt- oder Wirkungsbehauptung gehört in claimsToVerify – besser: weglassen.
- Keine erfundenen persönlichen Erfahrungen, Testimonials, Zahlen oder Vorher-Nachher-Ergebnisse.
- origin "real" für eigene Aufnahmen; "generated"/"hybrid" nur für klar künstlerische Ergänzungen.
- ${STRATEGY_PROMPT_RULE}
Antworte auf Deutsch.`;

const FORMAT_VISUALS: Record<VideoFormat, { visual: string[]; shot: UgcScript['scenes'][number]['shotType'][] }> = {
  talking_head: {
    visual: ['Talking Head, Augenhöhe, Hook-Text eingeblendet', 'Talking Head mit Cutaway auf Detail', 'B-Roll vom echten Prozess, Stimme läuft weiter', 'Talking Head, ruhiger Abschluss, dezenter CTA'],
    shot: ['talking_head', 'close_up', 'b_roll', 'talking_head'],
  },
  product_demo: {
    visual: ['Sofortige Makroaufnahme des Produkts mit Hook-Text', 'Hände nehmen das Produkt, Over-Shoulder', 'Echte Anwendung Schritt für Schritt, Detailshots', 'Ergebnis bzw. Zwischenstand im Ganzen, CTA-Text'],
    shot: ['macro', 'over_shoulder', 'product', 'wide'],
  },
  voiceover: {
    visual: ['Starkes erstes Bild (Detail), Voiceover setzt sofort ein', 'Prozess-B-Roll im Rhythmus des Voiceovers', 'Detailshots; optionale KI-Atmosphäre nur als klar kreative Ergänzung', 'Ruhiges Schlussbild, CTA als Text'],
    shot: ['macro', 'b_roll', 'close_up', 'wide'],
  },
};

/** Rule-based script (ported from the prototype's selectConcept, extended). */
export function mockScript(ctx: CreativeContext, concept: ConceptDraft): UgcScript {
  const b = ctx.brief;
  const dur = b.lengthSeconds;
  const beats = [Math.round(dur * 0.14), Math.round(dur * 0.34), Math.round(dur * 0.73), dur];
  const subject = b.topic;
  const fact = b.verifiedFacts[0] ?? ctx.client?.productClaims[0] ?? '';
  const ugc = ctx.projectKind === 'UGC_CLIENT';
  const lines = ugc
    ? [concept.hook, `Ich zeige dir ${subject} in einer echten Aufnahme, nicht nur in Werbebildern.`, fact ? `Wichtig ist: ${fact}` : 'Hier zeige ich die tatsächlichen Details und den Ablauf – ohne unbelegte Produktversprechen.', concept.cta]
    : [concept.hook, `Ich beschäftige mich gerade mit ${subject} und zeige dir den Prozess.`, fact ? `Was ich bisher weiß: ${fact}` : 'Ich filme die Details und schaue, was dabei tatsächlich passiert.', concept.cta];
  const fv = FORMAT_VISUALS[b.format];
  const beatNames = concept.structure.length >= 4 ? concept.structure.slice(0, 4) : ['Hook', 'Kontext', 'Demonstration', 'CTA'];
  let t = 0;
  const scenes = beats.map((end, i) => {
    const s = {
      startSecond: t,
      endSecond: end,
      beat: beatNames[i]!,
      dialogue: lines[i]!,
      onScreenText: i === 0 ? concept.hook : i === 3 ? concept.cta : '',
      visual: fv.visual[i]!,
      shotType: fv.shot[i]!,
      origin: 'real' as const,
    };
    t = end;
    return s;
  });
  return {
    format: b.format,
    estimatedSeconds: dur,
    hookVariants: [concept.hook, ...concept.hookVariants].slice(0, 4),
    selectedHook: concept.hook,
    scenes,
    cta: concept.cta,
    shotlist: scenes.map((s) => ({ shot: `${s.beat}: ${s.visual}`, shotType: s.shotType, framing: '9:16 vertikal', notes: s.shotType === 'talking_head' ? 'Natürliches Fensterlicht, Augenhöhe' : 'Mehrere Takes, je 3–5 s', origin: s.origin })),
    verifiedClaims: fact ? [fact] : [],
    claimsToVerify: [],
    warnings: ['Demo-Entwurf ohne KI (Mock-Modus). Wortmenge und Timing vor Aufnahme prüfen.', 'Persönliche Produkterfahrungen und Wirkversprechen nur verwenden, wenn tatsächlich belegbar.'],
  };
}

export async function runUgcScriptwriter(
  provider: LlmProvider,
  ctx: CreativeContext,
  concept: ConceptDraft,
): Promise<StructuredResult<UgcScript> & { promptVersion: string }> {
  const res = await provider.generate({
    agent: 'ugc_scriptwriter',
    promptVersion: UGC_SCRIPTWRITER_PROMPT_VERSION,
    schemaName: 'ugc_script',
    schema: UgcScriptWire,
    system: SYSTEM,
    instruction:
      `Schreibe ein ${ctx.brief.lengthSeconds}-Sekunden-Skript im Format "${ctx.brief.format}" für das ausgewählte Konzept. ` +
      'Szenen lückenlos von 0 bis zur Ziellänge, 3–6 Szenen, 3–4 Hook-Varianten, Shotlist mit einer Zeile je benötigter Einstellung.',
    untrustedContext: { ...untrustedCreativeContext(ctx), selectedConcept: concept, allowedClaims: allowedClaims(ctx) },
    mock: () => mockScript(ctx, concept),
  });
  const script = enforceClaimAllowlist(validateScript(res.output, ctx.brief.lengthSeconds), allowedClaims(ctx));
  return {
    ...res,
    output: { ...script, warnings: [...new Set([...script.warnings, ...contextWarnings(ctx)])] },
    promptVersion: UGC_SCRIPTWRITER_PROMPT_VERSION,
  };
}
