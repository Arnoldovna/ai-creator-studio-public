import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  defaultPreset, deriveDesignSystem, DesignSystem, EditDraftBody, lookFit, OverlayPreset, overlayAss, styleTokens, timedElements, buildTimeline, buildTimelineView, usedPresetIds,
  type Box, type LookTokens,
} from '@studio/core';
import { StageGraphics } from '@/components/video/editor/StageGraphics';

/**
 * Etappe 13 parity: the DOM box of every element on the stage = the core box = the ASS position, for slots and free
 * positions, in the legacy look and every overlay style of „Meine Marke“ (server-rendered stage, no browser needed).
 */
const at = '2026-11-19T10:00:00.000Z';
const rules = { visual: { palette: ['#C8553D', '#20302A'], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] } };
const derived = deriveDesignSystem({ rules, observations: [], references: [], voice: null, current: null }).design;
const design = DesignSystem.parse({
  ...derived,
  presets: [defaultPreset(), OverlayPreset.parse({ id: 'kontur', name: 'Kontur', hook: { shape: 'outline' }, lowerThird: { shape: 'outline' }, keyword: { shape: 'outline' }, animation: 'none', origin: { source: 'manual' } })],
});
const version = { id: 'sb', version: 2, approvedAt: at, rules: { ...rules, design } };
const K = 0.5; // a 540 px wide stage

/** left/top/width/height (px) of every `data-testid` element in the markup, back in PlayRes pixels. */
function domBoxes(html: string, testId: string): Box[] {
  return [...html.matchAll(new RegExp(`<div[^>]*data-testid="${testId}"[^>]*style="([^"]*)"`, 'g'))].map((m) => {
    const px = (k: string) => Number(new RegExp(`(?:^|;)${k}:(-?[\\d.]+)(?:px)?`).exec(m[1]!)?.[1]);
    const left = px('left'), top = px('top');
    return { x0: left / K, y0: top / K, x1: (left + px('width')) / K, y1: (top + px('height')) / K };
  });
}
const close = (a: Box, b: Box) => (['x0', 'y0', 'x1', 'y1'] as const).every((k) => Math.abs(a[k] - b[k]) < 0.01);
const posOf = (line: string) => {
  const m = /\\pos\((-?\d+),(-?\d+)\)/.exec(line);
  return { x: Number(m![1]), y: Number(m![2]) };
};

describe('stage parity: DOM box = core box = ASS position', () => {
  for (const pos of [undefined, { x: 0.3, y: 0.42 }, { x: 0.72, y: 0.8 }, { x: 0, y: 1 }])
    for (const slot of ['upper', 'center', 'lower'] as const)
      it(`slot ${slot}, pos ${JSON.stringify(pos)}`, () => {
        const body = EditDraftBody.parse({
          clips: [{ assetId: 'a', inSec: 0, outSec: 4, overlays: [
            { kind: 'keyword', text: 'Wolle & Garn', startSec: 0, endSec: 4, slot, pos, presetId: 'kontur' },
            { kind: 'lower_third', text: 'Carola, Strickerin', startSec: 0, endSec: 4, slot: slot === 'lower' ? 'upper' : 'lower', pos: pos && { x: 1 - pos.x, y: 1 - pos.y }, size: 'L' },
            { kind: 'arrow', text: '', startSec: 0, endSec: 4, slot, pos: pos && { x: pos.y, y: pos.x }, direction: 'left' },
          ] }],
          hook: { source: 'free', text: 'So färbst du Wolle mit Zwiebelschalen', slot, pos, size: 'S' },
        });
        const looks: LookTokens[] = [
          styleTokens({ id: 'sb-l', version: 1, approvedAt: at, rules }, 'Avenir Next'),
          styleTokens(version, 'Avenir Next', { fontSource: 'design', elementPresets: usedPresetIds(body) }),
        ];
        for (const look of looks) {
          const fit = lookFit(look);
          const view = buildTimelineView(body, { fit });
          const html = renderToStaticMarkup(createElement(StageGraphics, { overlays: view.overlays, hook: view.hook, cue: null, look, k: K }));
          const dom = domBoxes(html, 'stage-overlay');
          const timed = timedElements(body, buildTimeline(body.clips), fit);
          const ass = overlayAss(timed, look).events;
          expect(dom).toHaveLength(3);
          view.overlays.forEach((o, i) => {
            expect(close(dom[i]!, o.box), `${o.kind} DOM ${JSON.stringify(dom[i])} core ${JSON.stringify(o.box)}`).toBe(true);
          });
          // ASS: keyword and arrow at the box centre, lower third text at the box edge + inset, hook at its centre
          const [kw, lt, arrow] = view.overlays;
          expect(posOf(ass.find((e) => /,Keyword(P\d)?,/.test(e))!)).toEqual({ x: Math.round((kw!.box.x0 + kw!.box.x1) / 2), y: Math.round((kw!.box.y0 + kw!.box.y1) / 2) });
          expect(posOf(ass.find((e) => /\\frz/.test(e))!)).toEqual({ x: Math.round((arrow!.box.x0 + arrow!.box.x1) / 2), y: Math.round((arrow!.box.y0 + arrow!.box.y1) / 2) });
          expect(posOf(ass.find((e) => /,LowerThird(P\d)?,/.test(e))!).x).toBe(Math.round(lt!.box.x0 + 36));
          const hookDom = domBoxes(html, 'stage-hook')[0]!;
          expect(close(hookDom, view.hook!.layout.box)).toBe(true);
          expect(posOf(ass.find((e) => /,Hook(P\d)?,/.test(e))!)).toEqual({ x: view.hook!.layout.x, y: view.hook!.layout.y });
        }
      });
});
