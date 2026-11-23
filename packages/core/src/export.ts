import type { StyleBibleRules, UgcScript, VoiceGuideRules } from './schemas';

const list = (xs: string[], empty = '_noch nichts festgelegt_') => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : empty);

export function styleBibleToMarkdown(
  style: { version: number; status: string; createdAt: string; rules: StyleBibleRules },
  voice?: { version: number; rules: VoiceGuideRules } | null,
): string {
  const r = style.rules;
  return `# ${r.name} — Style Bible v${style.version}

_Status: ${style.status} · erstellt ${style.createdAt.slice(0, 10)}_

## Farbwelt
${r.visual.palette.length ? r.visual.palette.map((c) => `- \`${c}\``).join('\n') : '_keine Farben_'}

> Farben stammen aus technischer Pixelstichprobe bzw. freigegebenen Beobachtungen.

## Visuelle Eigenschaften
${list(r.visual.traits)}

## Typografie
${r.visual.typography || '_offen_'}

## Licht
${r.visual.lighting || '_offen_'}

## Komposition
${r.visual.composition || '_offen_'}

## Texturen
${r.visual.textures || '_offen_'}

## Motion & Schnitt
${r.motion.pacing || '_offen_'}
${r.motion.transitions.length ? '\nÜbergänge:\n' + list(r.motion.transitions) : ''}

## Das vermeiden wir
${list(r.visual.avoid)}
${voice ? `
## Voice Guide v${voice.version}
**So klinge ich**
${list(voice.rules.traits)}

**So nicht**
${list(voice.rules.avoid)}

**Eigene Beispiele**
${voice.rules.ownExamples.map((e) => `> ${e.replace(/\n/g, '\n> ')}`).join('\n\n') || '_keine_'}
` : ''}
---
Referenzen: ${r.approvedReferenceIds.length} · freigegebene KI-Beobachtungen: ${r.approvedObservationIds.length}
`;
}

export function scriptToMarkdown(title: string, version: number, s: UgcScript): string {
  return `# ${title} — Skript v${version}

**Format:** ${s.format} · **Länge:** ${s.estimatedSeconds}s

## Hook-Varianten
${s.hookVariants.map((h) => `- ${h === s.selectedHook ? '**' + h + '** (gewählt)' : h}`).join('\n')}

## Szenen
| Zeit | Beat | Dialog | On-Screen | Bild | Origin |
|---|---|---|---|---|---|
${s.scenes.map((sc) => `| ${sc.startSecond}–${sc.endSecond}s | ${sc.beat} | ${sc.dialogue.replace(/\|/g, '/')} | ${sc.onScreenText.replace(/\|/g, '/')} | ${sc.visual.replace(/\|/g, '/')} | ${sc.origin} |`).join('\n')}

## CTA
${s.cta}

## Shotlist
${s.shotlist.map((x, i) => `${i + 1}. [${x.shotType}] ${x.shot} — ${x.framing}${x.notes ? ` (${x.notes})` : ''}`).join('\n')}

## Claims
Verifiziert:
${list(s.verifiedClaims, '_keine_')}

Zu prüfen:
${list(s.claimsToVerify, '_keine_')}

## Hinweise
${list(s.warnings, '_keine_')}
`;
}
