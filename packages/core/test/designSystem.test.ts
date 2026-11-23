import { describe, expect, it } from 'vitest';
import { disclosureLabels } from '../src/edit';
import {
  applyCase, contrastChecks, defaultPreset, deriveColorRoles, deriveDesignSystem, DesignSystem, designOf, legacyDesignFromRules, resolveDesignLook,
  type DesignSystemInput,
} from '../src/designSystem';
import { mockDesignSuggestion, normalizeDesignSuggestion, runDesignDirector, type DesignSynthesisInput } from '../src/agents/designDirector';
import { contrastRatio } from '../src/lookBase';
import {
  CONTENT_AREA, hookLayout, intersects, layoutConflicts, LABEL_ZONE, lookFit, lookKey, OVERLAY_FONTS, overlayAss, overlayBox, SLOT_BAND, styleTokens, subtitleStyleOf, TEXT_LIMIT, timedElements,
  type Slot, type TimedOverlay,
} from '../src/overlays';
import { MockProvider } from '../src/providers/mock';
import { buildTimeline } from '../src/timeline';
import { buildAss } from '../src/transcript';

const at = '2026-11-19T10:00:00.000Z';
const timed = (o: Partial<TimedOverlay>): TimedOverlay => ({ clip: 0, index: 0, kind: 'keyword', text: 'Wolle', slot: 'center', direction: 'down', startSec: 0, endSec: 2, ...o });
const obs = [
  { id: 'o1', referenceId: 'r1', dimension: 'color', statement: 'Warmes Terrakotta', colors: ['#C8553D', '#F4E9D8'] },
  { id: 'o2', referenceId: 'r2', dimension: 'color', statement: 'Tiefes Grün', colors: ['#20302a'] },
  { id: 'o3', referenceId: 'r2', dimension: 'typography', statement: 'Geometrische Grotesk in Versalien', colors: [] },
  { id: 'o4', referenceId: 'r1', dimension: 'lighting', statement: 'Warmes Seitenlicht am Fenster', colors: [] },
];
const rules = {
  visual: { palette: ['#C8553D'], traits: ['Handarbeit', 'echte Werkstatt'], avoid: ['Hochglanz'], typography: '', lighting: '', composition: 'viel Luft', textures: '' },
  motion: { pacing: 'ruhig, weiche Blenden', transitions: ['weich'] },
};

function design(over: Partial<DesignSystemInput> = {}): DesignSystem {
  const base = deriveDesignSystem({ rules, observations: obs, references: [], voice: null, current: null }).design;
  return DesignSystem.parse({ ...base, ...over });
}

describe('deriveColorRoles: deterministic, with WCAG contrast', () => {
  it('gives the same roles for the same input, palette first, every role with its origin', () => {
    const a = deriveColorRoles({ palette: rules.visual.palette, observations: obs });
    const b = deriveColorRoles({ palette: rules.visual.palette, observations: structuredClone(obs) });
    expect(a).toEqual(b);
    expect(a).toMatchSnapshot();
    const c = a!.colors;
    expect(c.primary).toMatchObject({ hex: '#C8553D', origin: { source: 'palette' } });
    expect(c.surface).toMatchObject({ hex: '#20302A', origin: { source: 'observation', observationIds: ['o2'], referenceIds: ['r2'] } });
    expect(c.accent.hex).toBe('#C8553D');
    // text on surface/accent passes AA, from her palette where possible
    expect(contrastRatio(c.onSurface.hex, c.surface.hex)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.onAccent.hex, c.accent.hex)).toBeGreaterThanOrEqual(4.5);
    expect(c.onSurface).toMatchObject({ hex: '#F4E9D8', origin: { source: 'observation', observationIds: ['o1'] } });
    expect(c.background.hex).toBe('#F4E9D8');
    expect(a!.checks.every((x) => x.aa)).toBe(true);
  });

  it('falls back to derived contrast colours and a darkened primary; null without any colour', () => {
    const mid = deriveColorRoles({ palette: ['#777777'], observations: [] })!;
    expect(mid.colors.surface.origin.source).toBe('derived');
    expect(contrastRatio('#FFFFFF', mid.colors.surface.hex)).toBeGreaterThanOrEqual(4.5);
    for (const ch of contrastChecks(mid.colors)) expect(ch.aa, ch.label).toBe(true);
    expect(deriveColorRoles({ palette: [], observations: [{ id: 'x', referenceId: 'r', colors: ['kaputt'] }] })).toBeNull();
  });

  it('reports pairs below AA', () => {
    const d = design();
    const bad = contrastChecks({ ...d.colors, onSurface: { hex: d.colors.surface.hex, origin: d.colors.surface.origin } });
    expect(bad.find((x) => x.fg === 'onSurface' && x.bg === 'surface')).toMatchObject({ ratio: 1, aa: false });
  });
});

describe('deriveDesignSystem', () => {
  it('is deterministic and labels the font as an approximation; keeps her choices from the current design', () => {
    const r1 = deriveDesignSystem({ rules, observations: obs, references: [{ id: 'r1', palette: [], likes: ['x'], tags: ['Wolle'] }], voice: { phrases: ['Ich zeig dir das mal'] }, current: null });
    const r2 = deriveDesignSystem({ rules, observations: obs, references: [{ id: 'r1', palette: [], likes: ['x'], tags: ['Wolle'] }], voice: { phrases: ['Ich zeig dir das mal'] }, current: null });
    expect(r1).toEqual(r2);
    expect(r1.design.typography.hook).toMatchObject({ font: 'Futura', origin: { source: 'observation', observationIds: ['o3'], note: expect.stringMatching(/Annäherung/) } });
    expect(r1.notes.join(' ')).toMatch(/Annäherung/);
    expect(r1.design.motion).toMatchObject({ tempo: 'calm', transitions: ['soft_cut'] });
    expect(r1.design.imagery).toMatchObject({ temperature: 'warm', referenceIds: ['r1'], keywords: ['Handarbeit', 'echte Werkstatt', 'Wolle'] });
    expect(r1.design.phrases).toEqual([{ text: 'Ich zeig dir das mal', origin: expect.objectContaining({ source: 'voice' }) }]);
    // with a current design, her typography and presets stay
    const mine = DesignSystem.parse({ ...r1.design, typography: { ...r1.design.typography, hook: { ...r1.design.typography.hook, font: 'Georgia', origin: { source: 'manual' } } } });
    expect(deriveDesignSystem({ rules, observations: obs, references: [], voice: null, current: mine }).design.typography.hook.font).toBe('Georgia');
  });
});

describe('legacy versions (no rules.design)', () => {
  const legacyVersions = [
    { id: 'a', version: 1, approvedAt: at, rules: { visual: { palette: ['#C8553D', '#F4E9D8'] } } },
    { id: 'b', version: 2, approvedAt: at, rules: { visual: { palette: ['#ffcc00'] } } },
    { id: 'c', version: 3, approvedAt: at, rules: { visual: { palette: ['#20302A', '#C8553D', '#112233'] } } },
  ];

  it('legacyDesignFromRules gives the palette[0]/[1] tokens; resolving it renders the same ASS as the legacy look', () => {
    const overlays = [timed({ kind: 'lower_third', text: 'Carola', slot: 'upper' }), timed({ index: 1 }), timed({ index: 2, kind: 'arrow', slot: 'lower' }), timed({ index: 3, kind: 'frame', startSec: 3, endSec: 4 })];
    const hook = { text: 'So färbst du Wolle', startSec: 0, endSec: 2.5, layout: hookLayout('So färbst du Wolle', 'upper')! };
    for (const v of legacyVersions)
      for (const font of OVERLAY_FONTS) {
        const legacy = styleTokens(v, font);
        const d = legacyDesignFromRules(v.rules)!;
        expect([d.colors.accent.hex, d.colors.surface.hex, d.colors.onSurface.hex]).toEqual([legacy.accent, legacy.box, legacy.text]);
        expect(legacy.design).toBeUndefined();
        // the same design stored explicitly, with the plan's font kept: same pixels (ASS), only the key adds the design
        const explicit = styleTokens({ ...v, rules: { ...v.rules, design: d } }, font);
        expect(overlayAss({ overlays, hook }, explicit)).toEqual(overlayAss({ overlays, hook }, legacy));
        expect(lookKey(explicit).startsWith(lookKey(legacy))).toBe(true);
        // and the subtitles of the explicit legacy design are the fixed Etappe-6 style
        const cues = [{ startSec: 0, endSec: 1, text: 'Hallo' }];
        expect(buildAss(cues, { subtitle: subtitleStyleOf(explicit) })).toBe(buildAss(cues));
      }
  });

  it('invalid stored design falls back to legacy, no palette to the placeholder', () => {
    expect(designOf({ design: { broken: true }, visual: { palette: ['#C8553D'] } })).toMatchObject({ legacy: true });
    expect(designOf({ visual: { palette: [] } })).toBeNull();
    expect(styleTokens({ id: 'x', version: 9, approvedAt: at, rules: { visual: { palette: [] }, design: design() } }, 'Futura')).toMatchObject({ source: 'style_bible', design: expect.any(Object) });
  });
});

describe('design-system look: tokens, presets, ASS', () => {
  const presets = [
    defaultPreset(),
    { id: 'clean', name: 'Clean', hook: { shape: 'outline', fill: 'surface', text: 'onVideo' }, lowerThird: { shape: 'box', fill: 'surface', stripe: 'accent', text: 'onSurface' }, keyword: { shape: 'outline', fill: 'surface', text: 'onVideo' }, graphic: 'primary', animation: 'none', origin: { source: 'manual' } },
  ] as const;
  const d = design({
    presets: presets as unknown as DesignSystemInput['presets'],
    typography: {
      ...design().typography,
      hook: { font: 'Georgia', weight: 'bold', size: 'L', textCase: 'upper', origin: { source: 'manual' } },
      keyword: { font: 'Futura', weight: 'regular', size: 'S', textCase: 'lower', origin: { source: 'manual' } },
      subtitle: { font: 'Helvetica Neue', weight: 'regular', size: 'L', textCase: 'none', origin: { source: 'manual' } },
    },
  });
  const v = { id: 'sb-d', version: 7, approvedAt: at, rules: { visual: { palette: ['#C8553D'] }, design: d } };

  it('labels the look „Look aus Meine Marke (Style Bible vN)“, picks the preset, and keys on the resolved design', () => {
    const t = styleTokens(v, 'Avenir Next', { fontSource: 'design' });
    expect(t.label).toBe('Look aus Meine Marke (Style Bible v7) · Stil „Marke“');
    expect(t).toMatchObject({ font: 'Georgia', accent: d.colors.accent.hex, box: d.colors.surface.hex, text: d.colors.onSurface.hex });
    const clean = styleTokens(v, 'Avenir Next', { fontSource: 'design', preset: 'clean' });
    expect(clean.design!.presetName).toBe('Clean');
    expect(lookKey(clean)).not.toBe(lookKey(t));
    const missing = styleTokens(v, 'Avenir Next', { fontSource: 'design', preset: 'weg' });
    expect(missing.design!.presetId).toBe('marke');
    expect(missing.designNotes!.join(' ')).toMatch(/gibt es in dieser Version nicht/);
    // plan font kept: hook/keyword family replaced, subtitles stay from the design
    const planFont = styleTokens(v, 'DIN Condensed');
    expect(planFont.design!.hook.type.family).toBe('DIN Condensed');
    expect(planFont.design!.subtitle.type.family).toBe('Helvetica Neue');
  });

  it('preset snapshots: default and outline/no-animation preset, with size steps, cases and subtitle style', () => {
    const body = {
      clips: [{ overlays: [
        { kind: 'keyword' as const, text: 'Wolle Färben', startSec: 0, endSec: 2, slot: 'center' as Slot, direction: 'down' as const },
        { kind: 'lower_third' as const, text: 'Carola, Strickerin', startSec: 2, endSec: 4, slot: 'lower' as Slot, direction: 'down' as const },
        { kind: 'arrow' as const, text: '', startSec: 2, endSec: 3, slot: 'center' as Slot, direction: 'up' as const },
      ] }],
      hook: { source: 'free' as const, variantIndex: null, text: 'So färbst du Wolle', endSec: 2.5, slot: 'upper' as Slot, claimsReviewed: false },
    };
    const tl = buildTimeline([{ inSec: 0, outSec: 6, cuts: [] }]);
    const out = (['marke', 'clean'] as const).map((preset) => {
      const look = styleTokens(v, 'Avenir Next', { fontSource: 'design', preset });
      const t = timedElements(body, tl, lookFit(look));
      return buildAss([{ startSec: 4, endSec: 5, text: 'Untertitel hier' }], { labels: disclosureLabels([{ origin: 'generated', inSec: 0, outSec: 6 }]), overlays: overlayAss(t, look), subtitle: subtitleStyleOf(look) });
    });
    expect(out).toMatchSnapshot();
    expect(out[0]).toMatch(/^Style: Hook,Georgia,110,/m);
    expect(out[0]).toContain('SO FÄRBST DU');
    expect(out[0]).toContain('wolle färben');
    expect(out[0]).toMatch(/^Style: Keyword,Futura,62,.*,0,0,0,0,100,100,0,0,3,18,0,5,0,0,0,1$/m);
    expect(out[0]).toMatch(/^Style: Default,Helvetica Neue,74,&H00FFFFFF,&H000000FF,&H00101010,&H64000000,0,/m);
    expect(out[1]).not.toContain('\\fad(');
    expect(out[1]).not.toContain('\\t(0,150');
    expect(out[1]).toMatch(/^Style: Hook,Georgia,110,[^,]+,&H000000FF,[^,]+,[^,]+,-1,0,0,0,100,100,0,0,1,4,0,5,/m);
    // the AI label stays on top and last
    for (const ass of out) expect(ass.trimEnd().split('\n').pop()).toMatch(/^Dialogue: 9,.*,Label,/);
  });

  it('every size step keeps keyword and lower third inside their slot band and the hook inside the content area', () => {
    for (const scale of [0.85, 1, 1.15])
      for (const slot of ['upper', 'center', 'lower'] as Slot[]) {
        for (const kind of ['keyword', 'lower_third'] as const)
          for (const text of ['A', 'W'.repeat(TEXT_LIMIT[kind])]) {
            const b = overlayBox({ kind, text, slot, scale });
            expect(b.y0 >= SLOT_BAND[slot].y0 && b.y1 <= SLOT_BAND[slot].y1 && b.x0 >= SLOT_BAND[slot].x0 && b.x1 <= SLOT_BAND[slot].x1, `${kind} ${slot} ${scale}`).toBe(true);
          }
        for (let n = 1; n <= TEXT_LIMIT.free_hook; n += 6) {
          const text = Array.from({ length: n }, (_, i) => (i % 6 === 5 ? ' ' : 'w')).join('').trim() || 'w';
          const l = hookLayout(applyCase(text, 'upper'), slot, scale);
          expect(l, `${n} ${scale}`).not.toBeNull();
          expect(l!.box.y0 >= CONTENT_AREA.y0 && l!.box.y1 <= CONTENT_AREA.y1 && !intersects(l!.box, LABEL_ZONE)).toBe(true);
        }
      }
    // a larger hook can collide where the Etappe-8 one did not: the conflict check sees the same fit as the render
    const t = timedElements({ clips: [{ overlays: [] }], hook: null }, buildTimeline([{ inSec: 0, outSec: 3, cuts: [] }]));
    expect(layoutConflicts(t)).toEqual([]);
  });

  it('own fonts: the exact face by PostScript name, bold only from the file; a missing font falls back with a note', () => {
    const own = DesignSystem.parse({ ...d, typography: { ...d.typography, hook: { ...d.typography.hook, font: 'custom:f1' } } });
    const fonts = [{ id: 'f1', family: 'Geist', postscriptName: 'Geist-Regular', assName: 'Geist Regular', weight: 400, italic: false }];
    const r = resolveDesignLook(own, { fonts });
    expect(r.look.hook.type).toMatchObject({ family: 'Geist', assName: 'Geist Regular', bold: false, custom: true });
    expect(r.look.customFonts).toBe(true);
    const gone = resolveDesignLook(own, { fonts: [] });
    expect(gone.look.hook.type).toMatchObject({ family: 'Avenir Next', custom: false });
    expect(gone.warnings.join(' ')).toMatch(/nicht mehr vorhanden/);
    const ass = overlayAss({ overlays: [], hook: null }, styleTokens({ ...v, rules: { ...v.rules, design: own } }, 'Avenir Next', { fontSource: 'design', fonts }));
    expect(ass.styles.find((s) => s.startsWith('Style: Hook,'))).toMatch(/^Style: Hook,Geist Regular,110,.*,0,0,0,0,100,/);
  });

  it('refuses unknown fonts and duplicate or missing presets in the schema', () => {
    expect(DesignSystem.safeParse({ ...d, typography: { ...d.typography, hook: { ...d.typography.hook, font: 'Comic Sans' } } }).success).toBe(false);
    expect(DesignSystem.safeParse({ ...d, defaultPresetId: 'nope' }).success).toBe(false);
    expect(DesignSystem.safeParse({ ...d, presets: [defaultPreset(), defaultPreset()] }).success).toBe(false);
  });
});

describe('Design Director', () => {
  const input = (): DesignSynthesisInput => ({
    approvedObservations: obs.map((o) => ({ ...o, referenceName: o.referenceId })),
    rules: { palette: ['#C8553D'], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '', pacing: '', transitions: [] },
    references: [{ id: 'r1', name: 'Poster', palette: [], likes: [], dislikes: [], tags: [] }],
    voice: { traits: ['direkt'], texts: ['Ich zeig dir das mal, ganz ohne Perfektion.'] },
    fonts: [...OVERLAY_FONTS, 'Arial'].map((f) => ({ ref: f, label: f })),
    base: design(),
  });

  it('mock is deterministic, labelled and equals the derivation', async () => {
    const p = new MockProvider();
    const a = await runDesignDirector(p, input());
    const b = await runDesignDirector(p, input());
    expect(a.output).toEqual(b.output);
    expect(a.output.suggestion.uncertainties[0]).toMatch(/^\[MOCK\]/);
    expect(a.output.suggestion.design.colors.surface.hex).toBe(input().base.colors.surface.hex);
  });

  it('drops invented evidence, fonts outside the list, unknown references and phrases she never wrote', () => {
    const raw = mockDesignSuggestion(input());
    raw.colors[0] = { role: 'primary', hex: '#123456', observationIds: ['o1', 'erfunden'], note: 'x' };
    raw.colors[1] = { role: 'accent', hex: 'rot', observationIds: [], note: '' };
    raw.typography[0] = { role: 'hook', font: 'Comic Sans', weight: 'bold', size: 'L', textCase: 'upper', observationIds: [], note: '' };
    raw.imagery.referenceIds = ['r1', 'fremd'];
    raw.phrases = ['ganz ohne Perfektion', 'Kauf jetzt mit Rabatt'];
    const { suggestion, warnings } = normalizeDesignSuggestion(raw, input());
    expect(suggestion.design.colors.primary).toMatchObject({ hex: '#123456', origin: { source: 'ai', observationIds: ['o1'] } });
    expect(suggestion.design.colors.accent.hex).toBe(input().base.colors.accent.hex);
    expect(suggestion.design.typography.hook).toMatchObject({ font: input().base.typography.hook.font, size: 'L', textCase: 'upper' });
    expect(suggestion.design.imagery.referenceIds).toEqual(['r1']);
    expect(suggestion.design.phrases.map((x) => x.text)).toEqual(['ganz ohne Perfektion']);
    expect(warnings.join(' ')).toMatch(/kein #RRGGBB/);
    expect(warnings.join(' ')).toMatch(/nicht in der erlaubten Liste/);
    expect(warnings.join(' ')).toMatch(/nicht wörtlich/);
    expect(warnings.join(' ')).toMatch(/nicht bestätigte oder unbekannte Beobachtungen/);
  });
});

describe('agents read „Meine Marke“ as compact text', () => {
  it('replaces the stored design (with provenance ids) by its guideline text', async () => {
    const { untrustedCreativeContext } = await import('../src/agents/context');
    const d = design({ guidelines: 'Hook immer als Frage.', phrases: [{ text: 'einfach mal ausprobieren', origin: { source: 'manual' } }] });
    const rules = { name: 'X', visual: { palette: [], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: ['o1'], design: d };
    const ctx = untrustedCreativeContext({ brief: { projectId: 'p', topic: 't', audience: '', goal: 'growth', verifiedFacts: [], format: 'talking_head', lengthSeconds: 30, cta: '', notes: '', pillarId: null }, projectKind: 'PERSONAL_CONTENT', client: null, style: { versionId: 'v', version: 3, status: 'approved', rules }, voice: null } as never);
    const sb = ctx.styleBible as Record<string, unknown>;
    expect(sb).not.toHaveProperty('design');
    expect(sb.brand).toMatch(/Hook immer als Frage\./);
    expect(sb.brand).toMatch(/„einfach mal ausprobieren“/);
    expect(JSON.stringify(sb)).not.toContain('observationIds');
  });
});
