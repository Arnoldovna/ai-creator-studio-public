import { describe, expect, it } from 'vitest';
import { buildFrame, buildPreview, buildRender, checkEditPlan, disclosureLabels, EditDraftBody, EditPlanBody, frameInput, validateEditPlan, type EditAssetInfo } from '../src/edit';
import { defaultPreset, deriveDesignSystem, DesignSystem, OverlayPreset } from '../src/designSystem';
import {
  CONTENT_AREA, FRAME, freeBoxFindings, hookLayout, inside, intersects, LABEL_ZONE, LOWER_THIRD_TEXT_INSET, overlayBox, placeElement, posCenter, SLOT_BAND, slotAnchors,
  STAGE_ZONES, subtitleBox, subtitleMarginV, SUBTITLE_Y, toNormPos, type Box, type NormPos, type Slot,
} from '../src/overlayLayout';
import { lookFit, lookKey, overlayAss, styleTokens, timedElements, usedPresetIds, type TimedOverlay } from '../src/overlays';
import { buildTimeline } from '../src/timeline';
import { applyPacing, buildTimelineView, cutWords, keepClearOfLabel, phraseOf, retimeOverlay, addOverlayAt, addOverlayForRange, safeSuggestions, acceptSuggestions, setHook, updateOverlay, wordsOutputRange } from '../src/timelineView';
import { buildAss } from '../src/transcript';
import { suggestCuts } from '../src/cuts';

/**
 * Etappe 13: one geometry for ASS, stage and validator (overlayLayout.ts), free positions, per-element styles and sizes,
 * subtitle height, exact preview/frame arguments, transcript selection → cut/overlay, and filler suggestions that never
 * cut her voice words automatically.
 */
const at = '2026-11-19T10:00:00.000Z';
const SLOTS: Slot[] = ['upper', 'center', 'lower'];
const timed = (o: Partial<TimedOverlay>): TimedOverlay => ({ clip: 0, index: 0, kind: 'keyword', text: 'Wolle', slot: 'center', direction: 'down', startSec: 0, endSec: 2, ...o });
const rules = { visual: { palette: ['#C8553D', '#20302A'], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] } };
const base = deriveDesignSystem({ rules, observations: [], references: [], voice: null, current: null }).design;
const design = DesignSystem.parse({
  ...base,
  presets: [
    defaultPreset(),
    OverlayPreset.parse({ id: 'kontur', name: 'Kontur', hook: { shape: 'outline', fill: 'primary', text: 'onVideo' }, lowerThird: { shape: 'box' }, keyword: { shape: 'outline' }, animation: 'none', origin: { source: 'manual' } }),
  ],
});
const version = { id: 'sb-1', version: 3, approvedAt: at, rules: { ...rules, design } };
const looks = [
  { name: 'legacy', tokens: styleTokens({ id: 'sb-l', version: 1, approvedAt: at, rules }, 'Avenir Next') },
  { name: 'marke', tokens: styleTokens(version, 'Avenir Next', { fontSource: 'design' }) },
  { name: 'kontur', tokens: styleTokens(version, 'Avenir Next', { fontSource: 'design', preset: 'kontur' }) },
];
const center = (b: Box) => ({ x: Math.round((b.x0 + b.x1) / 2), y: Math.round((b.y0 + b.y1) / 2) });
const posOf = (line: string) => {
  const m = /\\pos\((-?\d+),(-?\d+)\)/.exec(line);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};
const FREE: NormPos[] = [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.5 }, { x: 0.83, y: 0.62 }, { x: 0, y: 1 }, { x: 1, y: 0.18 }];

describe('overlayLayout: slot boxes are the Etappe-8 boxes, free boxes are centred and stay in the picture', () => {
  it('slot elements stay in their bands; a free element is centred on its position and never leaves the picture', () => {
    for (const slot of SLOTS) for (const kind of ['keyword', 'lower_third', 'arrow'] as const) expect(inside(overlayBox({ kind, text: 'Wolle & Garn', slot }), SLOT_BAND[slot])).toBe(true);
    for (const pos of FREE)
      for (const kind of ['keyword', 'lower_third', 'arrow'] as const) {
        const b = overlayBox({ kind, text: 'Wolle & Garn', slot: 'center', pos });
        expect(inside(b, FRAME), `${kind} ${JSON.stringify(pos)}`).toBe(true);
        const c = posCenter(pos);
        // centred where it fits; moved only by the frame clamp
        if (inside({ x0: c.cx - (b.x1 - b.x0) / 2, y0: c.cy - (b.y1 - b.y0) / 2, x1: c.cx + (b.x1 - b.x0) / 2, y1: c.cy + (b.y1 - b.y0) / 2 }, FRAME)) expect(center(b)).toEqual({ x: c.cx, y: c.cy });
      }
    // frames never move
    expect(overlayBox({ kind: 'frame', text: '', slot: 'center', pos: { x: 0.1, y: 0.1 } })).toEqual(overlayBox({ kind: 'frame', text: '', slot: 'center' }));
    const h = hookLayout('So färbst du Wolle', 'upper', 1, { x: 0.5, y: 0.6 })!;
    expect({ x: h.x, y: h.y }).toEqual({ x: 540, y: 1152 });
    expect(inside(hookLayout('So färbst du Wolle', 'upper', 1, { x: 0.5, y: 0 })!.box, FRAME)).toBe(true);
  });

  it('normalised positions round-trip to the same whole pixel', () => {
    for (let cx = 0; cx <= 1080; cx += 37) for (let cy = 0; cy <= 1920; cy += 53) expect(posCenter(toNormPos(cx, cy))).toEqual({ cx, cy });
  });

  it('the stage drag snaps into slots and to the centre lines, and can never place anything over the AI label', () => {
    const kw = { kind: 'keyword' as const, text: 'Wolle' };
    for (const a of slotAnchors(kw)) expect(placeElement(kw, a.cx + 10, a.cy - 10)).toEqual({ slot: a.slot, snapped: 'slot' });
    expect(placeElement(kw, 548, 1400)).toEqual({ pos: toNormPos(540, 1400), snapped: 'center' });
    expect(placeElement(kw, 300, 970)?.snapped).toBe('middle');
    for (const t of [kw, { kind: 'lower_third' as const, text: 'Carola' }, { kind: 'hook' as const, text: 'So färbst du Wolle mit Zwiebelschalen' }, { kind: 'arrow' as const, text: '' }])
      for (const [x, y] of [[540, 0], [0, 100], [1080, 200], [540, 1920]] as const) {
        const p = placeElement(t, x, y)!;
        const box = t.kind === 'hook' ? hookLayout(t.text, p.slot ?? 'center', 1, p.pos)!.box : overlayBox({ kind: t.kind, text: t.text, slot: p.slot ?? 'center', pos: p.pos });
        expect(intersects(box, LABEL_ZONE), `${t.kind} ${x},${y}`).toBe(false);
        expect(inside(box, FRAME)).toBe(true);
      }
    expect(placeElement({ kind: 'frame', text: '' }, 10, 10)).toBeNull();
    expect(placeElement(kw, 548, 1400, { free: true })).toEqual({ pos: toNormPos(548, 1400), snapped: null });
  });

  it('free boxes: the label zone is an error, Instagram zones and subtitles are warnings', () => {
    expect(freeBoxFindings({ x0: 400, y0: 200, x1: 600, y1: 400 }, 'X').errors).toHaveLength(1);
    expect(freeBoxFindings({ x0: 400, y0: 1650, x1: 600, y1: 1700 }, 'X').warnings.join(' ')).toMatch(/Bildunterschrift/);
    expect(freeBoxFindings({ x0: 950, y0: 1100, x1: 1000, y1: 1200 }, 'X').warnings.join(' ')).toMatch(/Knöpfen/);
    expect(freeBoxFindings({ x0: 400, y0: 1300, x1: 600, y1: 1350 }, 'X', subtitleBox(0.72)).warnings.join(' ')).toMatch(/Untertitel/);
    expect(freeBoxFindings({ x0: 100, y0: 700, x1: 300, y1: 800 }, 'X', subtitleBox(0.72))).toEqual({ errors: [], warnings: [] });
  });

  it('subtitle height: absent = MarginV 380 (legacy), the recommended 72 % sits above the caption zone and below the lowest slot', () => {
    expect(subtitleMarginV(undefined)).toBe(380);
    expect(subtitleMarginV(SUBTITLE_Y.legacy)).toBe(380);
    const b = subtitleBox(SUBTITLE_Y.recommended);
    expect(b.y1).toBeLessThan(STAGE_ZONES.caption.y0);
    expect(b.y0).toBeGreaterThan(CONTENT_AREA.y1);
    expect(buildAss([{ startSec: 0, endSec: 1, text: 'Hallo' }])).toBe(buildAss([{ startSec: 0, endSec: 1, text: 'Hallo' }], { marginV: 380 }));
    expect(buildAss([{ startSec: 0, endSec: 1, text: 'Hallo' }], { marginV: subtitleMarginV(0.72) })).toMatch(/,2,90,90,538,1$/m);
  });
});

describe('parity: core box = ASS position, for slots and free positions, in every look', () => {
  it('keyword, arrow and hook are drawn at their box centre; the lower third at its box corner (+ text inset)', () => {
    for (const { name, tokens } of looks)
      for (const pos of [undefined, ...FREE])
        for (const slot of SLOTS) {
          const overlays = [
            timed({ index: 0, kind: 'keyword', text: 'Wolle & Garn', slot, pos }),
            timed({ index: 1, kind: 'arrow', slot, pos, startSec: 3, endSec: 4 }),
            timed({ index: 2, kind: 'lower_third', text: 'Carola, Strickerin', slot, pos, startSec: 5, endSec: 6 }),
          ];
          const layout = hookLayout('So färbst du Wolle mit Zwiebelschalen', slot, 1, pos)!;
          const { events } = overlayAss({ overlays, hook: { text: 'x', startSec: 0, endSec: 2, layout } }, tokens);
          const where = `${name} ${slot} ${JSON.stringify(pos)}`;
          const kw = events.find((e) => /,Keyword,/.test(e))!;
          expect(posOf(kw), where).toEqual(center(overlayBox(overlays[0]!)));
          const arrow = events.find((e) => /\\frz/.test(e))!;
          expect(posOf(arrow), where).toEqual(center(overlayBox(overlays[1]!)));
          const lt = overlayBox(overlays[2]!);
          const ltText = events.find((e) => /,LowerThird,/.test(e))!;
          expect(posOf(ltText), where).toEqual({ x: Math.round(lt.x0 + LOWER_THIRD_TEXT_INSET), y: Math.round((lt.y0 + lt.y1) / 2) });
          const ltShapes = events.filter((e) => e.startsWith('Dialogue: 1,0:00:05'));
          if (ltShapes.length) expect(ltShapes.map(posOf).some((p) => p!.x === Math.round(lt.x0) && p!.y === Math.round(lt.y0)), where).toBe(true);
          expect(posOf(events.find((e) => /,Hook,/.test(e))!), where).toEqual({ x: layout.x, y: layout.y });
          expect(center(layout.box)).toEqual({ x: layout.x, y: layout.y });
        }
  });

  it('the timeline view hands the stage the same boxes and hook layout the ASS uses', () => {
    const body = EditDraftBody.parse({
      clips: [{ assetId: 'a', inSec: 0, outSec: 6, overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 1, endSec: 3, pos: { x: 0.3, y: 0.7 }, size: 'L' }, { kind: 'lower_third', text: 'Carola', startSec: 3, endSec: 5, slot: 'lower' }] }],
      hook: { source: 'free', text: 'So färbst du Wolle', pos: { x: 0.5, y: 0.25 } },
    });
    const fit = lookFit(looks[1]!.tokens);
    const view = buildTimelineView(body, { fit });
    const t = timedElements(body, buildTimeline(body.clips), fit);
    expect(view.overlays.map((o) => o.box)).toEqual(t.overlays.map((o) => overlayBox(o)));
    expect(view.hook!.layout).toEqual(t.hook!.layout);
    expect(view.overlays[0]!.scale).toBe(1.15);
    expect(view.overlays[0]!.size).toBe('L');
  });
});

describe('per-element overlay styles and sizes', () => {
  it('an element with another preset gets that style (extra ASS styles); the others keep the plan style', () => {
    const body = { clips: [{ overlays: [{ kind: 'keyword' as const, text: 'Wolle', startSec: 0, endSec: 2, slot: 'center' as const, direction: 'down' as const, presetId: 'kontur' }, { kind: 'keyword' as const, text: 'Garn', startSec: 3, endSec: 4, slot: 'center' as const, direction: 'down' as const }] }], hook: null };
    expect(usedPresetIds(body)).toEqual(['kontur']);
    const tokens = styleTokens(version, 'Avenir Next', { fontSource: 'design', elementPresets: usedPresetIds(body) });
    expect(Object.keys(tokens.presetLooks ?? {})).toEqual(['kontur']);
    expect(lookKey(tokens)).not.toBe(lookKey(looks[1]!.tokens));
    const ass = overlayAss(timedElements(body, buildTimeline([{ inSec: 0, outSec: 5, cuts: [] }]), lookFit(tokens)), tokens);
    expect(ass.styles.some((x) => x.startsWith('Style: KeywordP1,'))).toBe(true);
    expect(ass.events.find((e) => e.includes('}Wolle'))).toMatch(/,KeywordP1,/);
    expect(ass.events.find((e) => e.includes('}Garn'))).toMatch(/,Keyword,/);
    // kontur has no animation: no fade on its element, the plan style keeps its fade
    expect(ass.events.find((e) => e.includes('}Wolle'))).not.toContain('\\fad(');
    expect(ass.events.find((e) => e.includes('}Garn'))).toContain('\\fad(');
    // no element names another style: no extra styles, same tokens as before
    expect(styleTokens(version, 'Avenir Next', { fontSource: 'design', elementPresets: [] })).toEqual(looks[1]!.tokens);
    // an unknown style falls back with a note
    expect(styleTokens(version, 'Avenir Next', { fontSource: 'design', elementPresets: ['weg'] }).designNotes!.join(' ')).toMatch(/„weg“ gibt es/);
  });

  it('own size steps scale the element (ASS \\fs and the box)', () => {
    const body = { clips: [{ overlays: [{ kind: 'keyword' as const, text: 'Wolle', startSec: 0, endSec: 2, slot: 'center' as const, direction: 'down' as const, size: 'L' as const }] }], hook: null };
    const t = timedElements(body, buildTimeline([{ inSec: 0, outSec: 3, cuts: [] }]));
    expect(t.overlays[0]!.scale).toBe(1.15);
    expect(overlayAss(t, looks[0]!.tokens).events[0]).toContain('\\fs96');
  });
});

describe('old plans render byte-identically (Etappe-13 fields are additive)', () => {
  it('a body without the new fields parses unchanged and gives the same ASS and FFmpeg arguments as with explicit absent fields', () => {
    const raw = { clips: [{ assetId: 'a', inSec: 0, outSec: 4, overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 0.5, endSec: 2 }, { kind: 'lower_third', text: 'Carola', startSec: 2, endSec: 3.5, slot: 'lower' }] }], hook: { source: 'free', text: 'So färbst du Wolle' }, subtitles: 'burn' };
    const body = EditPlanBody.parse(raw);
    expect('subtitleY' in body).toBe(false);
    expect(body.clips[0]!.overlays.every((o) => !('pos' in o) && !('presetId' in o) && !('size' in o))).toBe(true);
    expect(body.hook && !('pos' in body.hook)).toBe(true);
    const tl = buildTimeline(body.clips);
    for (const { tokens } of looks) {
      const ass = buildAss([{ startSec: 0, endSec: 1, text: 'Hallo' }], { overlays: overlayAss(timedElements(body, tl, lookFit(tokens)), tokens), labels: disclosureLabels([{ origin: 'generated', inSec: 0, outSec: 4 }]) });
      expect(ass).toMatch(/,2,90,90,380,1$/m);
      expect(ass.trimEnd().split('\n').pop()).toMatch(/^Dialogue: 9,.*,Label,/);
    }
    const clips = [{ path: '/d/a.mp4', hasAudio: true, inSec: 0, outSec: 4 }];
    expect(buildRender(clips, '/w/o.mp4', { preset: 'streaming_-14', measured: null }, '/w/s.ass')).toEqual([
      '-ss', '0.000', '-t', '4.000', '-i', '/d/a.mp4', '-filter_complex',
      '[0:v:0]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,format=yuv420p,trim=duration=4.000[v0];[0:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=4.000[a0];[v0][a0]concat=n=1:v=1:a=1[vcat][acat];[vcat]subtitles=filename=\'/w/s.ass\'[vsub];[acat]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]',
      '-map', '[vsub]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-y', '/w/o.mp4',
    ]);
  });
});

describe('validator: free positions and the AI label', () => {
  const assets = new Map<string, EditAssetInfo>([['a', { origin: 'own', durationSec: 10, hasAudio: true, hasVideo: true }], ['g', { origin: 'generated', durationSec: 5, hasAudio: false, hasVideo: true }]]);
  const ctx = { scenes: null, assets, projectKind: 'PERSONAL_CONTENT' as const };
  const plan = (overlay: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ clips: [{ assetId: 'a', inSec: 0, outSec: 4, overlays: [{ kind: 'keyword', text: 'Wolle', startSec: 0, endSec: 2, ...overlay }] }], ...extra });

  it('nothing can cover the AI label: a free overlay or hook in the label zone is an error (draft shows it, render refuses it)', () => {
    expect(checkEditPlan(plan({ pos: { x: 0.5, y: 0.08 } }), ctx).errors.join(' ')).toMatch(/KI-Labels/);
    expect(() => validateEditPlan(plan({ pos: { x: 0.5, y: 0.08 } }), ctx)).toThrow(/KI-Labels/);
    expect(checkEditPlan({ clips: [{ assetId: 'a', inSec: 0, outSec: 4 }], hook: { source: 'free', text: 'Hallo', pos: { x: 0.5, y: 0.05 } } }, ctx).errors.join(' ')).toMatch(/Hook: liegt im Bereich des KI-Labels/);
    for (const kind of ['arrow', 'lower_third'] as const) expect(checkEditPlan(plan({ kind, text: kind === 'arrow' ? '' : 'Carola', pos: { x: 0.5, y: 0.1 } }), ctx).errors.join(' ')).toMatch(/KI-Labels/);
    // placed below the zone it is fine; in Instagram's caption only a warning
    expect(checkEditPlan(plan({ pos: { x: 0.5, y: 0.4 } }), ctx).errors).toEqual([]);
    const low = checkEditPlan(plan({ pos: { x: 0.5, y: 0.9 } }), ctx);
    expect(low.errors).toEqual([]);
    expect(low.result.warnings.join(' ')).toMatch(/Bildunterschrift/);
    // the label layer is above everything, whatever the position
    const tl = buildTimeline([{ inSec: 0, outSec: 4, cuts: [] }]);
    const ass = buildAss([], { labels: disclosureLabels([{ origin: 'generated', inSec: 0, outSec: 4 }]), overlays: overlayAss(timedElements(EditPlanBody.parse(plan({ pos: { x: 0.5, y: 0.2 } })), tl), looks[0]!.tokens) });
    expect(ass.trimEnd().split('\n').pop()).toMatch(/^Dialogue: 9,.*,Label,/);
  });

  it('subtitles at the same height as a free overlay are a warning; unknown styles a warning', () => {
    const r = checkEditPlan(plan({ pos: { x: 0.5, y: 0.66 } }, { subtitles: 'burn', subtitleY: 0.72 }), ctx);
    expect(r.result.warnings.join(' ')).toMatch(/Untertitel/);
    expect(checkEditPlan(plan({ presetId: 'weg' }), { ...ctx, presetIds: ['marke'] }).result.warnings.join(' ')).toMatch(/„weg“ gibt es/);
    expect(checkEditPlan(plan({ presetId: 'weg' }), { ...ctx, presetIds: [] }).result.warnings.join(' ')).toMatch(/erst mit „Meine Marke“/);
  });

  it('client projects keep the quote rule for overlay text', () => {
    const client = { ...ctx, projectKind: 'UGC_CLIENT' as const, scenes: [{ shotType: 'talking_head' as const, origin: 'real' as const }], script: { selectedHook: 'H', hookVariants: [], texts: ['Ich stricke gern.'] } };
    const body = { clips: [{ sceneIndex: 0, assetId: 'a', inSec: 0, outSec: 4, overlays: [{ kind: 'keyword', text: 'Bestes Garn', startSec: 0, endSec: 2, pos: { x: 0.5, y: 0.5 } }] }] };
    expect(checkEditPlan(body, client).errors.join(' ')).toMatch(/nicht wörtlich/);
  });
});

describe('exact preview and still frame', () => {
  const clips = [{ path: '/d/a.mp4', hasAudio: true, inSec: 1, outSec: 3 }, { path: '/d/b.mp4', hasAudio: true, inSec: 0, outSec: 2 }];
  it('the preview runs the render graph (incl. ASS) and scales the result to 540×960', () => {
    const args = buildPreview(clips, '/w/p.mp4', { preset: 'streaming_-14' }, '/w/s.ass');
    const render = buildRender(clips, '/w/r.mp4', { preset: 'streaming_-14', measured: null }, '/w/s.ass');
    const g = args[args.indexOf('-filter_complex') + 1]!;
    expect(g.startsWith(render[render.indexOf('-filter_complex') + 1]!)).toBe(true);
    expect(g).toMatch(/\[vsub\]scale=540:960:flags=bilinear\[vprev\]$/);
    expect(args).toContain('veryfast');
  });

  it('one frame: the segment that shows t, from that source moment, with t as timestamp for the ASS', () => {
    const body = EditPlanBody.parse({ clips: [{ assetId: 'a', inSec: 1, outSec: 3, zoom: { kind: 'push_in' } }, { assetId: 'b', inSec: 0, outSec: 2 }] });
    const tl = buildTimeline(body.clips);
    const f = frameInput(tl, body.clips, [{ path: '/d/a.mp4', hasAudio: true }, { path: '/d/b.mp4', hasAudio: true }], 2.5)!;
    expect(f.outT).toBe(2.5);
    expect(f.clip).toMatchObject({ path: '/d/b.mp4', inSec: 0.5 });
    const g = frameInput(tl, body.clips, [{ path: '/d/a.mp4', hasAudio: true }, { path: '/d/b.mp4', hasAudio: true }], 1)!;
    expect(g.clip).toMatchObject({ path: '/d/a.mp4', inSec: 2, zoom: { kind: 'push_in', offsetSec: 1 } });
    const args = buildFrame(f.clip, f.outT, '/w/f.png', '/w/s.ass', null, { width: 540, height: 960 });
    expect(args.slice(0, 2)).toEqual(['-ss', '0.000']);
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/trim=start=0\.500,setpts=PTS-STARTPTS,.*trim=end_frame=1,setpts=PTS\+2\.500\/TB,subtitles=filename='\/w\/s\.ass',scale=540:960/);
    // a push keeps its moment: the earlier seek is taken off its offset
    const pushArgs = buildFrame(g.clip, g.outT, '/w/g.png');
    expect(pushArgs.slice(0, 2)).toEqual(['-ss', '1.500']);
    expect(pushArgs[pushArgs.indexOf('-filter_complex') + 1]).toContain('min((t+0.500)/2.000,1)');
    expect(frameInput(tl, body.clips, [{ path: '/d/a.mp4', hasAudio: true }, { path: '/d/b.mp4', hasAudio: true }], 99)!.outT).toBeCloseTo(3.967, 3);
    expect(() => buildFrame(f.clip, 1, "/w/f'.png", "/w/s'.ass")).toThrow(/unzulässige/);
  });
});

describe('editor operations: overlays, hook, transcript selection', () => {
  const body = EditDraftBody.parse({ clips: [{ assetId: 'a', inSec: 0, outSec: 4, cuts: [{ startSec: 1, endSec: 1.5 }] }, { assetId: 'b', inSec: 2, outSec: 5 }] });

  it('a new overlay at the playhead lies in the clip under it, in source time, and is visible at once in the view', () => {
    const r = addOverlayAt(body, 2, { kind: 'keyword', text: 'Wolle', slot: 'center' });
    if ('error' in r) throw new Error(r.error);
    expect(r).toMatchObject({ clip: 0, index: 0 });
    expect(r.body.clips[0]!.overlays[0]).toMatchObject({ kind: 'keyword', text: 'Wolle', startSec: 2.5, endSec: 4 });
    const v = buildTimelineView(r.body);
    expect(v.overlays[0]).toMatchObject({ startSec: 2, endSec: 3.5, text: 'Wolle' });
    // near the end of a clip it starts earlier; long texts are refused (never truncated)
    const late = addOverlayAt(body, 3.45, { kind: 'arrow' });
    if ('error' in late) throw new Error(late.error);
    expect(late.body.clips[0]!.overlays[0]!.endSec - late.body.clips[0]!.overlays[0]!.startSec).toBeGreaterThan(1);
    expect(addOverlayAt(body, 1, { kind: 'keyword', text: 'W'.repeat(31) })).toEqual({ error: expect.stringMatching(/höchstens 30 Zeichen/) });
    expect(addOverlayAt(EditDraftBody.parse({ clips: [] }), 0, { kind: 'arrow' })).toEqual({ error: 'Noch kein Clip im Schnitt.' });
  });

  it('moving and trimming a block maps output times back into its own clip; the stage patch sets or clears pos', () => {
    const r = addOverlayAt(body, 0, { kind: 'keyword', text: 'Wolle' });
    if ('error' in r) throw new Error(r.error);
    const moved = retimeOverlay(r.body, 0, 0, 1.5, 3.5, 'move');
    expect(moved.clips[0]!.overlays[0]).toMatchObject({ startSec: 2, endSec: 4 });
    expect(retimeOverlay(r.body, 0, 0, 10, 12, 'move').clips[0]!.overlays[0]).toMatchObject({ endSec: 4 }); // stays in clip 0
    const trimmed = retimeOverlay(r.body, 0, 0, 0, 0.1, 'end');
    expect(trimmed.clips[0]!.overlays[0]!.endSec).toBeCloseTo(0.3, 3);
    const placed = updateOverlay(r.body, 0, 0, { pos: { x: 0.3, y: 0.6 }, size: 'S' });
    expect(placed.clips[0]!.overlays[0]).toMatchObject({ pos: { x: 0.3, y: 0.6 }, size: 'S' });
    expect('pos' in updateOverlay(placed, 0, 0, { pos: undefined }).clips[0]!.overlays[0]!).toBe(false);
    expect(EditDraftBody.safeParse(placed).success).toBe(true);
  });

  it('a free element that grows (size step, text) is moved out of the AI-label zone, never into it', () => {
    const r = addOverlayAt(body, 0, { kind: 'keyword', text: 'Wolle' });
    if ('error' in r) throw new Error(r.error);
    const placed = placeElement({ kind: 'keyword', text: 'Wolle' }, 540, 0)!;
    const top = updateOverlay(r.body, 0, 0, { pos: placed.pos });
    const bigger = updateOverlay(top, 0, 0, { size: 'L' });
    const boxOf = (b: typeof bigger) => { const o = b.clips[0]!.overlays[0]!; return overlayBox({ kind: o.kind, text: o.text, slot: o.slot, scale: o.size === 'L' ? 1.15 : 1, pos: o.pos }); };
    expect(intersects(boxOf(bigger), LABEL_ZONE)).toBe(true);
    const fixed = keepClearOfLabel(bigger);
    expect(intersects(boxOf(fixed), LABEL_ZONE)).toBe(false);
    expect(keepClearOfLabel(fixed)).toBe(fixed);
    const hook = setHook(body, { source: 'free', text: 'So färbst du Wolle', pos: { x: 0.5, y: 0.1 } });
    expect(hookLayout('So färbst du Wolle', 'upper', 1, keepClearOfLabel(hook).hook!.pos)!.box.y0).toBeGreaterThanOrEqual(LABEL_ZONE.y1);
  });

  it('transcript selection → cut, keyword, lower third and hook in the draft', () => {
    const words = [{ clip: 1, startSec: 2.5, endSec: 2.9, text: 'Wolle,' }, { clip: 1, startSec: 3.0, endSec: 3.4, text: 'färben.' }];
    const range = wordsOutputRange(buildTimeline(body.clips), words)!;
    expect(range).toEqual({ a: 4, b: 4.9 });
    const cut = cutWords(body, words);
    expect(cut.body.clips[1]!.cuts).toEqual([{ startSec: 2.5, endSec: 3.4, reason: 'manual', word: '' }]);
    const kw = addOverlayForRange(body, range.a, range.b, { kind: 'keyword', text: phraseOf(words.map((w) => w.text)) });
    if ('error' in kw) throw new Error(kw.error);
    expect(kw.body.clips[1]!.overlays[0]).toMatchObject({ kind: 'keyword', text: 'Wolle, färben', startSec: 2.5, endSec: 3.4 });
    const hook = setHook(body, { source: 'free', text: phraseOf(['so', 'färbst', 'du', 'Wolle?']) });
    expect(hook.hook).toMatchObject({ source: 'free', text: 'so färbst du Wolle?', endSec: 2.5, slot: 'upper' });
    expect(EditDraftBody.safeParse(hook).success).toBe(true);
    expect(setHook(hook, { endSec: 9 }).hook!.endSec).toBe(5);
    expect(setHook(hook, null).hook).toBeNull();
    expect(phraseOf(['„Also,', 'heute', 'stricken!“'])).toBe('Also, heute stricken');
  });
});

describe('her voice words are never cut automatically', () => {
  // whisper with DTW: „Also, ähm, genau, ja, heute, sozusagen, stricken.“ – every filler between silences
  const w = (text: string, s: number, e: number) => ({ text, startSec: s, endSec: e, atSec: (s + e) / 2 });
  const words = [w('Also,', 0.3, 0.6), w('ähm,', 1.2, 1.5), w('genau,', 2.1, 2.4), w('ja,', 3.0, 3.2), w('heute,', 3.8, 4.1), w('sozusagen,', 4.7, 5.1), w('stricken.', 5.7, 6.1)];
  const transcript = { language: 'de', segments: [{ startSec: 0, endSec: 6.5, text: words.map((x) => x.text).join(' '), words }] };
  const silences = [[0, 0.3], [0.6, 1.2], [1.5, 2.1], [2.4, 3.0], [3.2, 3.8], [4.1, 4.7], [5.1, 5.7], [6.1, 6.5]].map(([a, b]) => ({ startSec: a!, endSec: b! }));
  const voice = /also|genau|ja|sozusagen/i;

  it('they come only as low-confidence suggestions; „Alle sicheren annehmen“ and pacing never take them', () => {
    const res = suggestCuts({ transcript, silences, clip: { inSec: 0, outSec: 6.5 } });
    const fillers = res.suggestions.filter((s) => s.kind !== 'pause');
    expect(fillers.map((s) => s.word).sort()).toEqual(['Also', 'genau', 'ja', 'sozusagen', 'ähm'].sort());
    for (const s of fillers.filter((x) => voice.test(x.word))) expect(s).toMatchObject({ kind: 'weak_filler', safe: false, confidence: 'low' });
    expect(safeSuggestions(res.suggestions).some((s) => voice.test(s.word))).toBe(false);
    expect(safeSuggestions(res.suggestions).map((s) => s.word)).toContain('ähm');
    const body = EditDraftBody.parse({ clips: [{ assetId: 'a', inSec: 0, outSec: 6.5 }] });
    for (const preset of ['calm', 'normal', 'brisk'] as const) {
      const r = applyPacing(body, preset, new Map([['a', { transcript, silences }]]));
      for (const c of r.body.clips[0]!.cuts) {
        expect(voice.test(c.word), `${preset} ${c.word}`).toBe(false);
        for (const x of words.filter((y) => voice.test(y.text))) expect(c.startSec < x.atSec && c.endSec > x.atSec, `${preset} cuts ${x.text}`).toBe(false);
      }
    }
  });

  it('a strong filler glued to a voice word in one sound island is not safe either', () => {
    const glued = [w('ähm', 1.2, 1.35), { text: 'also,', startSec: 1.36, endSec: 1.5, atSec: 1.44 }];
    const t = { language: 'de', segments: [{ startSec: 0, endSec: 3, text: 'ähm also,', words: glued }] };
    const res = suggestCuts({ transcript: t, silences: [{ startSec: 0, endSec: 1.2 }, { startSec: 1.5, endSec: 3 }], clip: { inSec: 0, outSec: 3 } });
    expect(res.suggestions.filter((s) => s.kind !== 'pause').every((s) => !s.safe)).toBe(true);
  });

  it('she can still accept one voice-word suggestion herself (it becomes a filler cut)', () => {
    const res = suggestCuts({ transcript, silences, clip: { inSec: 0, outSec: 6.5 } });
    const genau = res.suggestions.find((s) => s.word === 'genau')!;
    const body = EditDraftBody.parse({ clips: [{ assetId: 'a', inSec: 0, outSec: 6.5 }] });
    const r = acceptSuggestions(body, 0, [genau], silences);
    expect(r.added).toBe(1);
    expect(r.body.clips[0]!.cuts[0]).toMatchObject({ reason: 'filler', word: 'genau' });
  });
});
