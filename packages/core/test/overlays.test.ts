import { describe, expect, it } from 'vitest';
import { AI_DISCLOSURE } from '../src/agents/scriptAgents';
import { disclosureLabels, EditPlanBody, validateEditPlan, type EditAssetInfo } from '../src/edit';
import {
  CONTENT_AREA, FRAME_BARS, fontFallbacks, freeHookBlockers, graphicsSummary, hexToAssStyle, hexToAssTag, hookLayout, intersects, LABEL_ZONE, layoutConflicts,
  lookKey, needsLibass, OVERLAY_FONTS, overlayAss, overlayBox, PLACEHOLDER_LABEL, readableOn, contrastRatio, SLOT_BAND, styleTokens, SUBTITLE_BAND, TEXT_LIMIT, textFromSource, quoteProblem, burnedTextBlockers, timedElements,
  type OverlayKind, type Slot, type TimedOverlay,
} from '../src/overlays';
import { buildTimeline } from '../src/timeline';
import { buildAss, LABEL_LAYER } from '../src/transcript';

const SLOTS: Slot[] = ['upper', 'center', 'lower'];
const KINDS: OverlayKind[] = ['lower_third', 'keyword', 'arrow', 'frame'];
const inside = (b: { x0: number; y0: number; x1: number; y1: number }, a: { x0: number; y0: number; x1: number; y1: number }) => b.x0 >= a.x0 && b.y0 >= a.y0 && b.x1 <= a.x1 && b.y1 <= a.y1;
const placeholder = styleTokens(null, 'Avenir Next');
const timed = (o: Partial<TimedOverlay>): TimedOverlay => ({ clip: 0, index: 0, kind: 'keyword', text: 'Wolle', slot: 'center', direction: 'down', startSec: 0, endSec: 2, ...o });

describe('colours and look tokens', () => {
  it('converts #RRGGBB to ASS style and tag colours', () => {
    expect(hexToAssStyle('#FF8800')).toBe('&H000088FF');
    expect(hexToAssStyle('#FF8800', 128)).toBe('&H800088FF');
    expect(hexToAssTag('#FF8800')).toBe('&H0088FF&');
    expect(() => hexToAssTag('red')).toThrow();
  });

  it('uses the pinned approved Style Bible, else the labelled placeholder (draft, missing, no palette)', () => {
    const rules = { visual: { palette: ['#C8553D', '#F4E9D8', 'kaputt'] } };
    const ok = styleTokens({ id: 'sb1', version: 3, approvedAt: '2026-11-01', rules }, 'Futura');
    expect(ok).toMatchObject({ source: 'style_bible', styleBibleVersionId: 'sb1', version: 3, label: 'Style Bible v3', accent: '#C8553D', box: '#F4E9D8', text: '#111111', font: 'Futura' });
    expect(contrastRatio(ok.text, ok.box)).toBeGreaterThan(4.5);
    // one colour only: the box is a darker accent, the text white
    expect(styleTokens({ id: 'sb1', version: 3, approvedAt: '2026-11-01', rules: { visual: { palette: ['#FFCC00'] } } }, 'Futura')).toMatchObject({ accent: '#FFCC00', box: '#735C00', text: '#FFFFFF' });
    // a draft (never approved) gives no colours
    expect(styleTokens({ id: 'sb2', version: 4, approvedAt: null, rules }, 'Futura')).toMatchObject({ source: 'placeholder', styleBibleVersionId: null, label: PLACEHOLDER_LABEL, box: '#111111', text: '#FFFFFF' });
    expect(styleTokens({ id: 'sb3', version: 5, approvedAt: '2026-11-01', rules: { visual: { palette: [] } } }, 'Futura').label).toMatch(/v5 hat keine Farbpalette/);
    expect(placeholder).toMatchObject({ source: 'placeholder', accent: '#9AA0A6' });
    expect(readableOn('#000000')).toBe('#FFFFFF');
    expect(lookKey(ok)).not.toBe(lookKey(placeholder));
  });

  it('never burns the placeholder label into the video', () => {
    const ass = buildAss([], { overlays: overlayAss({ overlays: [timed({})], hook: null }, placeholder) });
    expect(ass).not.toContain('Platzhalter');
    expect(ass).not.toContain('Style Bible');
  });
});

describe('geometry: slots, label zone and subtitle band', () => {
  it('keeps every slot element inside its slot band, below the label zone and above the subtitles', () => {
    const texts = ['A', 'Wolle färben', 'W'.repeat(TEXT_LIMIT.keyword), 'M'.repeat(TEXT_LIMIT.lower_third)];
    for (const slot of SLOTS)
      for (const kind of KINDS)
        for (const text of texts) {
          if (kind === 'frame' || (kind !== 'arrow' && text.length > TEXT_LIMIT[kind])) continue;
          const b = overlayBox({ kind, text, slot });
          expect(inside(b, SLOT_BAND[slot]), `${kind} ${slot} ${text}`).toBe(true);
          expect(intersects(b, LABEL_ZONE)).toBe(false);
          expect(intersects(b, SUBTITLE_BAND)).toBe(false);
          expect(b.y1).toBeLessThanOrEqual(1180);
        }
    // slot bands never overlap each other, so elements in different slots never collide
    expect(intersects(SLOT_BAND.upper, SLOT_BAND.center) || intersects(SLOT_BAND.center, SLOT_BAND.lower)).toBe(false);
    for (const bar of FRAME_BARS) {
      expect(intersects(bar, LABEL_ZONE) || intersects(bar, SUBTITLE_BAND)).toBe(false);
      for (const slot of SLOTS) expect(intersects(bar, SLOT_BAND[slot])).toBe(false);
    }
  });

  it('keeps the hook box (all wrapped lines) inside the content area for every length and slot, never in the label zone', () => {
    for (const slot of SLOTS)
      for (let n = 1; n <= 120; n += 7) {
        const text = Array.from({ length: n }, (_, i) => (i % 6 === 5 ? ' ' : 'a')).join('').trim() || 'a';
        const l = hookLayout(text, slot);
        if (!l) {
          expect(n).toBeGreaterThan(TEXT_LIMIT.free_hook); // every free hook fits
          continue;
        }
        expect(inside(l.box, CONTENT_AREA), `${slot} ${n}`).toBe(true);
        expect(intersects(l.box, LABEL_ZONE)).toBe(false);
        expect(l.lines.length).toBeLessThanOrEqual(4);
      }
    expect(hookLayout('Kurz', 'center')!.size).toBe(96);
    expect(hookLayout('x'.repeat(200), 'center')).toBeNull();
  });

  it('reports elements that overlap in time and place, not ones that only touch in time or sit inside a frame', () => {
    expect(layoutConflicts({ overlays: [timed({}), timed({ index: 1, kind: 'arrow' })], hook: null })).toHaveLength(1);
    expect(layoutConflicts({ overlays: [timed({}), timed({ index: 1, startSec: 2, endSec: 3 })], hook: null })).toEqual([]);
    expect(layoutConflicts({ overlays: [timed({}), timed({ index: 1, slot: 'lower' })], hook: null })).toEqual([]);
    expect(layoutConflicts({ overlays: [timed({ kind: 'frame' }), timed({ index: 1 })], hook: null })).toEqual([]);
    const hook = { text: 'Hook', startSec: 0, endSec: 2.5, layout: hookLayout('Hook', 'center')! };
    expect(layoutConflicts({ overlays: [timed({})], hook })[0]).toMatch(/Hook/);
  });
});

describe('ASS layers: the AI label is always on top', () => {
  const look = styleTokens({ id: 's', version: 1, approvedAt: 'x', rules: { visual: { palette: ['#C8553D', '#20302A'] } } }, 'Helvetica Neue');
  const label = disclosureLabels([{ origin: 'generated', inSec: 0, outSec: 3 }]);
  const layerOf = (line: string) => Number(/^Dialogue: (\d+),/.exec(line)![1]);

  it('writes the label lines last, on a layer above every other event, for every combination', () => {
    const variants: { cues: boolean; hook: boolean; kinds: OverlayKind[] }[] = [];
    for (const cues of [false, true]) for (const hook of [false, true]) for (const kinds of [[], ['lower_third'], ['keyword', 'arrow'], ['frame', 'lower_third'], KINDS] as OverlayKind[][]) variants.push({ cues, hook, kinds });
    for (const v of variants) {
      const overlays = v.kinds.map((kind, i) => timed({ index: i, kind, slot: SLOTS[i % 3]!, text: kind === 'lower_third' ? 'Carola, Strickerin' : 'Wolle' }));
      const t = { overlays, hook: v.hook ? { text: 'So färbst du Wolle', startSec: 0, endSec: 2.5, layout: hookLayout('So färbst du Wolle', 'upper')! } : null };
      const ass = buildAss(v.cues ? [{ startSec: 0, endSec: 2, text: 'Hallo' }] : [], { labels: label, overlays: overlayAss(t, look) });
      const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
      const labels = events.filter((l) => l.includes(',Label,'));
      expect(labels).toHaveLength(1);
      expect(events.slice(-labels.length)).toEqual(labels);
      const others = events.filter((l) => !l.includes(',Label,'));
      expect(Math.max(-1, ...others.map(layerOf))).toBeLessThan(LABEL_LAYER);
      expect(layerOf(labels[0]!)).toBe(LABEL_LAYER);
    }
  });

  it('pins the label font: the look font only reaches hook and overlay styles', () => {
    const ass = buildAss([], { font: 'Futura', labels: label, overlays: overlayAss({ overlays: [timed({})], hook: null }, look) });
    expect(ass).toMatch(/^Style: Label,Arial,44,/m);
    expect(ass).toMatch(/^Style: Keyword,Helvetica Neue,/m);
    expect(ass).toMatch(/^Style: Hook,Helvetica Neue,/m);
  });

  it('refuses overlay lines on or above the label layer and styles that replace Default/Label', () => {
    expect(() => buildAss([], { overlays: { styles: [], events: [`Dialogue: ${LABEL_LAYER},0:00:00.00,0:00:01.00,Hook,,0,0,0,,x`] } })).toThrow();
    expect(() => buildAss([], { overlays: { styles: ['Style: Label,Arial,10'], events: [] } })).toThrow();
  });

  it('draws shapes with their own outline-free style, tag colours in &HBBGGRR& form, frames as four bars and arrows rotated in place', () => {
    const { styles, events } = overlayAss({ overlays: [timed({ kind: 'frame' }), timed({ index: 1, kind: 'arrow', direction: 'right', slot: 'lower' }), timed({ index: 2, kind: 'lower_third', text: 'Carola', slot: 'upper' })], hook: null }, look);
    expect(styles[0]).toMatch(/^Style: Shape,.*,1,0,0,7,0,0,0,1$/);
    const shapes = events.filter((e) => e.includes(',Shape,'));
    expect(shapes.filter((e) => e.includes('\\an7\\pos(30,') || e.includes('\\an7\\pos(1038,'))).toHaveLength(4);
    expect(shapes.every((e) => /\\1c&H[0-9A-F]{6}&\\1a&H00&\\bord0\\shad0/.test(e))).toBe(true);
    expect(shapes.find((e) => e.includes('\\frz'))).toMatch(/\\an5\\pos\(540,1042\)\\frz90/);
    expect(events.find((e) => e.includes(',LowerThird,'))).toMatch(/\\an4\\pos\(108,490\)/);
    expect(events.every((e) => !e.includes('\\,'))).toBe(true);
  });
});

describe('injection: burned-in text cannot style or move itself', () => {
  it('neutralises override blocks, backslash escapes and line breaks in hook and keyword text', () => {
    const evil = '{\\an8} {\\pos(0,0)} {\\fs200}oben \\Ngroß\nzweite';
    const hookText = evil.slice(0, 60);
    const t = { overlays: [timed({ text: evil })], hook: { text: hookText, startSec: 0, endSec: 2, layout: hookLayout(hookText, 'lower')! } };
    const { events } = overlayAss(t, placeholder);
    for (const e of events) {
      const text = e.slice(e.indexOf('}') + 1);
      expect(text).not.toMatch(/[{}]/);
      expect(text.replace(/\\N/g, '')).not.toContain('\\');
      expect(e).not.toMatch(/\n/);
    }
    const hook = events.find((e) => e.includes(',Hook,'))!;
    expect(hook.match(/\{/g)).toHaveLength(1); // only our own override block
  });
});

describe('text sources and the free-hook claim lint', () => {
  it('accepts only literal parts of the sources (whole words, punctuation and fillers ignored)', () => {
    const src = ['Ähm, heute färbe ich Wolle mit Zwiebelschalen. Das geht, äh, ganz einfach!'];
    expect(textFromSource('Wolle mit Zwiebelschalen', src)).toBe(true);
    expect(textFromSource('„Das geht ganz einfach!“', src)).toBe(true);
    expect(textFromSource('Wolle mit Zwiebel', src)).toBe(false); // part of a word
    expect(textFromSource('−50 % in 3 Tagen', src)).toBe(false);
    expect(textFromSource('', src)).toBe(false);
    expect(textFromSource('Zwiebelschalen Das geht', src)).toBe(false); // across a sentence end
  });

  it('never turns a denial or a question into a statement', () => {
    expect(quoteProblem('klinisch getestet', ['Das ist nicht klinisch getestet.'])).toBe('negated');
    expect(quoteProblem('getestet', ['Das ist kein getestetes Mittel, ohne getestet zu sein.'])).toBe('negated');
    expect(quoteProblem('nicht klinisch getestet', ['Das ist nicht klinisch getestet.'])).toBeNull(); // the negation itself is quoted
    expect(quoteProblem('In 7 Tagen sichtbar', ['In 7 Tagen sichtbar? Nein.'])).toBe('question');
    expect(quoteProblem('In 7 Tagen sichtbar?', ['In 7 Tagen sichtbar? Nein.'])).toBeNull();
    expect(quoteProblem('sichtbar Nein', ['In 7 Tagen sichtbar? Nein.'])).toBe('missing');
    // one faithful occurrence is enough
    expect(quoteProblem('klinisch getestet', ['Nicht klinisch getestet? Doch: klinisch getestet.'])).toBeNull();
    expect(textFromSource('1.5 Liter', ['Ich nehme 1.5 Liter Wasser.'])).toBe(true); // a decimal point is no sentence end
  });

  it('compares figures as whole tokens, never as substrings', () => {
    const rules = { allowed: ['Enthält 50 ml', 'Ab 1000 Stück', 'Nur 1,5 kg'], flagged: [] };
    expect(burnedTextBlockers('5x schneller wach', rules).join(' ')).toMatch(/Zahlen im Hook ohne verifizierten Claim: 5/);
    expect(burnedTextBlockers('100 Stück', rules).join(' ')).toMatch(/: 100/);
    expect(burnedTextBlockers('15 kg', rules).join(' ')).toMatch(/: 15/);
    expect(burnedTextBlockers('50 ml Flasche', rules)).toEqual([]);
    expect(burnedTextBlockers('1.5 kg', rules)).toEqual([]); // 1,5 = 1.5
    expect(burnedTextBlockers('5x', rules, 'im Overlay').join(' ')).toMatch(/Zahlen im Overlay/);
  });

  it.each([
    'Keine Anzeige – ehrlich getestet', 'Nicht bezahlt!', 'Kein Sponsoring, alles echt', 'Nicht gesponsert', 'nicht gesponsort',
    'Keine Kooperation', 'Unbeauftragt getestet', 'Komplett ohne Filter', 'Ungefiltert', 'Kein Filter', 'Keine Werbung', 'Ohne KI',
  ])('blocks the burned-in label denial „%s“', (text) => {
    expect(burnedTextBlockers(text, { allowed: [], flagged: [] }, 'im Overlay').join(' ')).toMatch(/bestreitet eine Kennzeichnung/);
  });

  it('does not flag ordinary wording near the denial words', () => {
    for (const text of ['Anzeige', 'Kaffeefilter wechseln', 'Bezahlt habe ich selbst', 'Meine Kooperation mit dem Garten']) {
      expect(burnedTextBlockers(text, { allowed: [], flagged: [] })).toEqual([]);
    }
  });

  it('blocks flagged claims, invented figures, links and label denials, and needs her confirmation', () => {
    const rules = { allowed: ['Die Wolle ist 100 % Merino'], flagged: ['heilt Neurodermitis'] };
    expect(freeHookBlockers('So färbe ich Wolle', rules, true)).toEqual([]);
    expect(freeHookBlockers('So färbe ich Wolle', rules, false).join(' ')).toMatch(/Bestätigung fehlt/);
    expect(freeHookBlockers('Diese Wolle heilt Neurodermitis', rules, true).join(' ')).toMatch(/Ungeprüfte Claims/);
    expect(freeHookBlockers('−50 % in 3 Tagen', rules, true).join(' ')).toMatch(/Zahlen im Hook ohne verifizierten Claim: 50 %, 3/);
    expect(freeHookBlockers('100 % Merino', rules, true)).toEqual([]);
    expect(freeHookBlockers('Mehr auf www.example.com', rules, true).join(' ')).toMatch(/Link/);
    expect(freeHookBlockers('Keine Werbung, ehrlich', rules, true).join(' ')).toMatch(/bestreitet/);
  });
});

describe('validateEditPlan: hook, overlays and look', () => {
  const assets = new Map<string, EditAssetInfo>([['a', { origin: 'own', durationSec: 10, hasAudio: true, hasVideo: true }]]);
  const free = { scenes: null, assets, projectKind: 'PERSONAL_CONTENT' as const, transcriptTexts: new Map([['a', 'Heute färbe ich Wolle mit Zwiebelschalen.']]) };
  const scripted = {
    scenes: [{ shotType: 'talking_head' as const, origin: 'real' as const }], assets, projectKind: 'PERSONAL_CONTENT' as const,
    script: { selectedHook: 'Das hätte ich früher wissen müssen', hookVariants: ['Variante eins', 'Variante  zwei'], texts: ['Ich zeige dir meinen Trick.', 'Trick'] },
  };
  // client projects keep the quote rule and the claim lint as errors (Etappe 10)
  const clientScripted = { ...scripted, projectKind: 'UGC_CLIENT' as const };
  const clip = (x: Record<string, unknown> = {}) => ({ assetId: 'a', inSec: 0, outSec: 6, ...x });

  it('parses old bodies with the do-nothing defaults', () => {
    const b = EditPlanBody.parse({ clips: [{ sceneIndex: 0, assetId: 'a', inSec: 0, outSec: 2 }] });
    expect(b.hook).toBeNull();
    expect(b.look).toEqual({ font: 'Avenir Next', fontSource: 'plan', preset: null });
    expect(b.clips[0]!.overlays).toEqual([]);
    expect(needsLibass(b, [])).toBe(false);
    expect(graphicsSummary(b)).toBe('');
  });

  it('resolves a script hook to the exact script string; a free hook with a script is refused', () => {
    const v = validateEditPlan({ clips: [clip({ sceneIndex: 0 })], hook: { source: 'variant', variantIndex: 1, text: 'egal' } }, scripted);
    expect(v.body.hook).toMatchObject({ source: 'variant', variantIndex: 1, text: 'Variante zwei', claimsReviewed: false });
    expect(validateEditPlan({ clips: [clip({ sceneIndex: 0 })], hook: { source: 'selected' } }, scripted).body.hook!.text).toBe('Das hätte ich früher wissen müssen');
    expect(() => validateEditPlan({ clips: [clip({ sceneIndex: 0 })], hook: { source: 'free', text: 'Mein Text', claimsReviewed: true } }, scripted)).toThrow(/Hook aus dem Skript/);
    expect(() => validateEditPlan({ clips: [clip({ sceneIndex: 0 })], hook: { source: 'variant', variantIndex: 4 } }, scripted)).toThrow(/keine Variante 5/);
  });

  it('checks a free hook of a scriptless plan with the claim lint (as warnings) and its length, without a confirmation', () => {
    const ok = validateEditPlan({ clips: [clip()], hook: { source: 'free', text: '  So färbe ich Wolle  ', claimsReviewed: true, endSec: 3 } }, free);
    expect(ok.body.hook).toMatchObject({ source: 'free', text: 'So färbe ich Wolle', endSec: 3, slot: 'upper' });
    expect(needsLibass(ok.body, [])).toBe(true);
    // Etappe 10: personal: an unverified figure is a hint, no confirmation checkbox needed
    const figures = validateEditPlan({ clips: [clip()], hook: { source: 'free', text: 'In 7 Tagen 5 kg weniger' } }, free);
    expect(figures.warnings.join(' ')).toMatch(/Hook: Zahlen im Hook ohne verifizierten Claim: 7, 5/);
    expect(validateEditPlan({ clips: [clip()], hook: { source: 'free', text: 'So färbe ich Wolle' } }, free).warnings).toEqual([]);
    // a denied label stays an error for personal projects too
    expect(() => validateEditPlan({ clips: [clip()], hook: { source: 'free', text: 'Keine Werbung, ehrlich' } }, free)).toThrow(/bestreitet eine Kennzeichnung/);
    expect(() => validateEditPlan({ clips: [clip()], hook: { source: 'free', text: 'Ganz ohne KI gemacht' } }, free)).toThrow(/bestreitet eine Kennzeichnung/);
    expect(() => validateEditPlan({ clips: [clip()], hook: { source: 'free', text: 'x'.repeat(61), claimsReviewed: true } }, free)).toThrow(/höchstens 60 Zeichen/);
    expect(() => validateEditPlan({ clips: [clip()], hook: { source: 'selected' } }, free)).toThrow(/Ohne Skript/);
    expect(() => validateEditPlan({ clips: [clip({ outSec: 0.6 })], hook: { source: 'free', text: 'Kurz', claimsReviewed: true } }, free)).toThrow(/kürzer als 1 s/);
    expect(validateEditPlan({ clips: [clip({ outSec: 2 })], hook: { source: 'free', text: 'Kurz', claimsReviewed: true, endSec: 4 } }, free).warnings.join(' ')).toMatch(/endet mit dem Schnitt/);
  });

  it('lower thirds and keywords keep the meaning of their source and pass the claim lint', () => {
    const kw = (text: string) => ({ clips: [clip({ overlays: [{ kind: 'keyword', startSec: 1, endSec: 2, text }] })] });
    const lt = (text: string) => ({ clips: [clip({ sceneIndex: 0, overlays: [{ kind: 'lower_third', startSec: 1, endSec: 2, text, slot: 'lower' }] })] });
    const withTexts = (texts: string[]) => ({ ...clientScripted, script: { ...clientScripted.script, texts } });
    // client, scripted: a negated phrase or a question would become a claim the approved script never makes
    expect(() => validateEditPlan(lt('klinisch getestet'), withTexts(['Das ist nicht klinisch getestet.']))).toThrow(/nur verneint/);
    expect(() => validateEditPlan(lt('Schneller sichtbar'), withTexts(['Schneller sichtbar? Nein.']))).toThrow(/ist dort eine Frage/);
    expect(validateEditPlan(lt('Schneller sichtbar?'), withTexts(['Schneller sichtbar? Nein.'])).body.clips[0]!.overlays).toHaveLength(1);
    // client: a figure in a quote needs a verified claim, also from the script
    expect(() => validateEditPlan(lt('In 7 Tagen'), withTexts(['In 7 Tagen färbst du selbst.']))).toThrow(/Zahlen im Overlay ohne verifizierten Claim: 7/);
    expect(validateEditPlan(lt('In 7 Tagen'), { ...withTexts(['In 7 Tagen färbst du selbst.']), claimRules: { allowed: ['Lieferung in 7 Tagen'], flagged: [] } }).body.clips[0]!.overlays).toHaveLength(1);
    // Etappe 10, personal free cut: free text; figures, flagged claims and links are warnings only
    const warned = (body: unknown, ctx: Parameters<typeof validateEditPlan>[1] = free) => validateEditPlan(body, ctx).warnings.join(' ');
    expect(warned(kw('−50 % garantiert'))).toMatch(/Zahlen im Overlay ohne verifizierten Claim: 50 %/);
    expect(warned(kw('Klinisch getestet'), { ...free, claimRules: { allowed: [], flagged: ['klinisch getestet'] } })).toMatch(/Ungeprüfte Claims im Overlay/);
    expect(warned(kw('www.example.com'))).toMatch(/Link im Overlay/);
    expect(validateEditPlan(kw('Heute färbe ich Wolle'), free).warnings).toEqual([]);
    // … and personal scripted plans too (no negation/question rule, claims as hints)
    expect(validateEditPlan(lt('klinisch getestet'), { ...scripted, script: { ...scripted.script, texts: ['Das ist nicht klinisch getestet.'] } }).body.clips[0]!.overlays).toHaveLength(1);
    expect(warned(lt('In 7 Tagen'), scripted)).toMatch(/Zahlen im Overlay ohne verifizierten Claim: 7/);
    // a denied label stays an error in every project
    expect(() => validateEditPlan(kw('keine Werbung'), free)).toThrow(/bestreitet eine Kennzeichnung/);
    expect(() => validateEditPlan(kw('100 % echt, ohne KI'), free)).toThrow(/bestreitet eine Kennzeichnung/);
    expect(() => validateEditPlan(lt('nicht gesponsert'), withTexts(['Das ist nicht gesponsert.']))).toThrow(/bestreitet eine Kennzeichnung/);
  });

  it('client projects burn in lower thirds and keywords only from the script; personal overlays are free text', () => {
    const lt = (text: string) => ({ kind: 'lower_third', startSec: 1, endSec: 3, text, slot: 'lower' });
    expect(validateEditPlan({ clips: [clip({ overlays: [lt('Wolle mit Zwiebelschalen')] })] }, free).body.clips[0]!.overlays[0]).toMatchObject({ text: 'Wolle mit Zwiebelschalen' });
    // Etappe 10: personal: neither the transcript nor the script has to contain the text
    expect(validateEditPlan({ clips: [clip({ overlays: [lt('Bestes Färbemittel der Welt')] })] }, free).body.clips[0]!.overlays[0]).toMatchObject({ text: 'Bestes Färbemittel der Welt' });
    expect(validateEditPlan({ clips: [clip({ overlays: [lt('Bestes Färbemittel')] })] }, { ...free, transcriptTexts: undefined }).body.clips[0]!.overlays).toHaveLength(1);
    expect(validateEditPlan({ clips: [clip({ sceneIndex: 0, overlays: [lt('Wolle')] })] }, scripted).body.clips[0]!.overlays).toHaveLength(1);
    // client: only the approved script's words
    expect(() => validateEditPlan({ clips: [clip({ sceneIndex: 0, overlays: [lt('Wolle')] })] }, clientScripted)).toThrow(/nicht wörtlich im Dialog/);
    expect(validateEditPlan({ clips: [clip({ sceneIndex: 0, overlays: [{ ...lt('meinen Trick'), kind: 'keyword' }] })] }, clientScripted).body.clips[0]!.overlays).toHaveLength(1);
    // arrows and frames carry no text, whatever the client sends
    expect(validateEditPlan({ clips: [clip({ overlays: [{ kind: 'arrow', startSec: 0, endSec: 1, text: 'Hallo' }] })] }, free).body.clips[0]!.overlays[0]!.text).toBe('');
    expect(() => EditPlanBody.parse({ clips: [clip({ overlays: [{ kind: 'keyword', startSec: 0, endSec: 1 }] })] })).toThrow();
    expect(() => validateEditPlan({ clips: [clip({ overlays: [{ ...lt('Wolle'), kind: 'keyword', text: 'Wolle '.repeat(6).trim() }] })] }, free)).toThrow(/höchstens 30 Zeichen/);
  });

  it('refuses overlays outside In/Out and collisions, and drops (with a warning) one that lies inside a cut', () => {
    const kw = { kind: 'keyword', startSec: 1, endSec: 3, text: 'Wolle', slot: 'center' };
    expect(() => validateEditPlan({ clips: [clip({ outSec: 2, overlays: [kw] })] }, free)).toThrow(/außerhalb von In\/Out/);
    expect(() => validateEditPlan({ clips: [clip({ overlays: [kw, { kind: 'arrow', startSec: 2, endSec: 4 }] })] }, free)).toThrow(/gleichzeitig an derselben Stelle/);
    const v = validateEditPlan({ clips: [clip({ cuts: [{ startSec: 1, endSec: 3.5 }], overlays: [kw, { ...kw, startSec: 4, endSec: 5 }] })] }, free);
    expect(v.warnings.join(' ')).toMatch(/Overlay 1 liegt ganz in einem Schnitt/);
  });

  it('Etappe 10: a default hook (upper) and a default keyword (center) / lower third do not collide', () => {
    const kw = { kind: 'keyword', startSec: 0, endSec: 2, text: 'Zwiebelschalen' };
    const lt = { kind: 'lower_third', startSec: 0, endSec: 2, text: 'Wolle mit Zwiebelschalen', slot: 'lower' };
    const hook = { source: 'free', text: 'So färbe ich Wolle mit Zwiebelschalen und Essig' };
    const v = validateEditPlan({ clips: [clip({ overlays: [kw, lt] })], hook }, free);
    expect(v.body.hook!.slot).toBe('upper');
    expect(v.body.clips[0]!.overlays.map((o) => o.slot)).toEqual(['center', 'lower']);
    // a real collision (both in the middle) is still refused: burned-in text on top of each other is unreadable
    expect(() => validateEditPlan({ clips: [clip({ overlays: [kw] })], hook: { ...hook, slot: 'center' } }, free)).toThrow(/gleichzeitig an derselben Stelle/);
  });
});

describe('timeline mapping of hook and overlays', () => {
  it('maps an overlay across a cut to ONE contiguous span and clamps the hook to the cut length', () => {
    const clips = [{ inSec: 0, outSec: 4, cuts: [{ startSec: 1, endSec: 1.5 }], overlays: [{ kind: 'keyword' as const, startSec: 0.5, endSec: 3, text: 'Wolle', slot: 'center' as const, direction: 'down' as const }] }];
    const tl = buildTimeline(clips);
    const t = timedElements({ clips, hook: { source: 'free', variantIndex: null, text: 'Hallo', endSec: 5, slot: 'center', claimsReviewed: true } }, tl);
    expect(t.overlays).toHaveLength(1);
    expect(t.overlays[0]).toMatchObject({ startSec: 0.5, endSec: 2.5 });
    expect(t.hook).toMatchObject({ startSec: 0, endSec: tl.durationSec });
  });
});

describe('needsLibass and the font check', () => {
  it.each([
    [{ subtitles: 'off', hook: null, clips: [{ overlays: [] }] }, 0, false],
    [{ subtitles: 'burn', hook: null, clips: [{ overlays: [] }] }, 0, true],
    [{ subtitles: 'off', hook: null, clips: [{ overlays: [] }] }, 1, true],
    [{ subtitles: 'off', hook: { source: 'free' }, clips: [{ overlays: [] }] }, 0, true],
    [{ subtitles: 'off', hook: null, clips: [{ overlays: [] }, { overlays: [{}] }] }, 0, true],
  ] as const)('%j with %i labels → %s', (body, labels, want) => {
    expect(needsLibass(body as never, Array.from({ length: labels }, () => AI_DISCLOSURE))).toBe(want);
  });

  it('finds silent font fallbacks and missing glyphs in the libass log', () => {
    const log = [
      '[Parsed_subtitles_0 @ 0x7f8] fontselect: (Avenir Next, 700, 0) -> /System/Library/Fonts/Avenir Next.ttc, 0, AvenirNext-Bold',
      '[Parsed_subtitles_0 @ 0x7f8] fontselect: (Arial, 700, 0) -> /System/Library/Fonts/Supplemental/Arial Bold.ttf, 0, Arial-BoldMT',
      '[Parsed_subtitles_0 @ 0x7f8] fontselect: (DIN Condensed, 700, 0) -> /System/Library/Fonts/Helvetica.ttc, 0, Helvetica-Bold',
      '[Parsed_subtitles_0 @ 0x7f8] fontselect: failed to find any fallback with glyph 0x1F9F6 for font: (Futura, 700, 0)',
    ].join('\n');
    const w = fontFallbacks(log);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/„DIN Condensed“ nicht gefunden.*Helvetica-Bold/);
    expect(w[1]).toMatch(/U\+1F9F6/);
    expect(fontFallbacks('')).toEqual([]);
    for (const f of OVERLAY_FONTS) expect(fontFallbacks(`fontselect: (${f}, 700, 0) -> /x.ttc, 0, ${f.replace(/ /g, '')}-Bold`)).toEqual([]);
    // a glyph the font lacks (emoji) is taken from another font but logged with the requested family: no warning
    const mixed = [
      '[Parsed_subtitles_0 @ 0x7f8] fontselect: (Avenir Next, 700, 0) -> /System/Library/Fonts/Avenir Next.ttc, 0, AvenirNext-Bold',
      '[Parsed_subtitles_0 @ 0x7f8] Glyph 0x1F600 not found, selecting one more font for (Avenir Next, 700, 0)',
      '[Parsed_subtitles_0 @ 0x7f8] fontselect: (Avenir Next, 700, 0) -> /System/Library/Fonts/Apple Color Emoji.ttc, 0, AppleColorEmoji',
    ].join('\n');
    expect(fontFallbacks(mixed)).toEqual([]);
    // the same lines without a real selection of the family: missing
    expect(fontFallbacks(mixed.split('\n').slice(1).join('\n'))).toEqual([expect.stringMatching(/„Avenir Next“ nicht gefunden.*AppleColorEmoji/)]);
  });

  it('warns when libass picks an italic face for an upright request (CoreText + Avenir Next.ttc, 2026-11-16)', () => {
    const italic = '[Parsed_ass_0 @ 0x1] fontselect: (Avenir Next, 700, 0) -> /System/Library/Fonts/Avenir Next.ttc, -1, AvenirNext-BoldItalic';
    expect(fontFallbacks(italic)).toEqual([expect.stringMatching(/„Avenir Next“.*kursiv.*AvenirNext-BoldItalic/)]);
    // an italic request that gets an italic face is fine, so is an oblique-free upright face
    expect(fontFallbacks(italic.replace(', 700, 0)', ', 700, 1)'))).toEqual([]);
    expect(fontFallbacks('fontselect: (AvenirNext-Bold, 700, 0) -> /System/Library/Fonts/Avenir Next.ttc, -1, AvenirNext-Bold')).toEqual([]);
    expect(fontFallbacks('fontselect: (Futura, 700, 0) -> /x/Futura.ttc, -1, Futura-BoldOblique')).toHaveLength(1);
  });

  it('hands libass the exact upright bold face of Avenir Next and the family name of every other font', () => {
    const name = (font: (typeof OVERLAY_FONTS)[number]) => {
      const { styles } = overlayAss({ overlays: [], hook: null }, { ...placeholder, font });
      return styles.find((s) => s.startsWith('Style: Hook,'))!.split(',')[1];
    };
    expect(name('Avenir Next')).toBe('AvenirNext-Bold');
    for (const f of OVERLAY_FONTS.filter((x) => x !== 'Avenir Next')) expect(name(f)).toBe(f);
    // the look itself (and so lookKey and approved renders) keeps the family name
    expect(placeholder.font).toBe('Avenir Next');
  });
});
