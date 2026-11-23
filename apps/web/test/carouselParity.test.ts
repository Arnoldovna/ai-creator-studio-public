import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { assEmFactor, CarouselBody, carouselLook, defaultPreset, defaultTypography, DesignSystem, layoutCarousel, slideAss, TEMPLATE_IDS, type CarouselImageInfo } from '@studio/core';
import { SlideCanvas } from '@/components/carousel/SlideCanvas';

/**
 * Etappe 18 parity: the browser preview of a slide draws every text line where the PNG (ASS `\pos`) draws it – same anchor
 * x, same vertical centre, same size (CSS size = ASS size × the font's factor) – and every box (decoration, image, label)
 * at the core's pixels. Server-rendered, no browser needed.
 */
const o = { source: 'manual' as const };
const col = (hex: string) => ({ hex, origin: o });
const design = DesignSystem.parse({
  colors: { primary: col('#2E4A3B'), accent: col('#E8B04A'), surface: col('#1F2617'), onSurface: col('#FFFFFF'), onAccent: col('#111111'), onVideo: col('#FFFFFF'), background: col('#F6F3EC') },
  typography: defaultTypography(), presets: [defaultPreset()], defaultPresetId: 'marke',
});
const { look } = carouselLook(design);
const images = new Map<string, CarouselImageInfo>([['ai', { kind: 'image', usage: { origin: 'generated', source: '' }, mime: 'image/png' }]]);
const body = (templateId: (typeof TEMPLATE_IDS)[number], format: 'portrait' | 'square') => CarouselBody.parse({
  templateId, format, slides: [
    { id: 's1', kind: 'title', title: 'Warum ich jeden Morgen stricke', body: 'Eine Stunde, bevor der Tag laut wird.' },
    { id: 's2', kind: 'list', title: 'Was mir hilft', items: ['Wolle am Vorabend bereitlegen', 'Handy im Flur lassen', 'Eine Reihe zählt schon'] },
    { id: 's3', kind: 'image_text', title: 'Atelier', body: 'Licht von links.', imageId: 'ai' },
    { id: 's4', kind: 'before_after', title: 'Mythos?', items: ['Nur im Winter.', 'Das ganze Jahr.'], tone: 'accent' },
    { id: 's5', kind: 'cta', title: 'Was hilft dir morgens?', body: 'Speicher dir das.' },
  ],
});
const W = 540, K = W / 1080;
const px = (style: string, k: string) => Number(new RegExp(`(?:^|;)${k}:(-?[\\d.]+)(?:px)?`).exec(style)?.[1]);

describe('carousel preview parity: DOM line = ASS position', () => {
  for (const templateId of TEMPLATE_IDS) for (const format of ['portrait', 'square'] as const) {
    it(`${templateId} ${format}`, () => {
      const b = body(templateId, format);
      for (const layout of layoutCarousel(b, look, images)) {
        const html = renderToStaticMarkup(createElement(SlideCanvas, { layout, look, width: W }));
        // text containers in document order, each with its lines
        const blocks = [...html.matchAll(/<div data-testid="slide-text"[^>]*style="([^"]*)"[^>]*>(.*?)<\/div><\/div>|<div data-testid="slide-text"[^>]*style="([^"]*)"[^>]*><\/div>/g)];
        const dom: { x: number; y: number; size: number }[] = [];
        for (const m of blocks) {
          const outer = m[1] ?? m[3]!;
          const ox = px(outer, 'left'), oy = px(outer, 'top');
          for (const l of (m[2] ?? '').matchAll(/<div data-testid="slide-line" data-align="(left|center|right)" style="([^"]*)"/g)) {
            const s = l[2]!;
            const left = ox + px(s, 'left'), w = px(s, 'width'), top = oy + px(s, 'top'), h = px(s, 'height');
            const x = l[1] === 'left' ? left : l[1] === 'right' ? left + w : left + w / 2;
            dom.push({ x: x / K, y: (top + h / 2) / K, size: h / K });
          }
        }
        const ass = slideAss(layout, look).over.split('\n').filter((x) => x.startsWith('Dialogue: 2,'));
        expect(dom.length, `${templateId} ${format} slide ${layout.index + 1}`).toBe(ass.length);
        ass.forEach((line, i) => {
          const m = /\\pos\((-?\d+),(-?\d+)\)\\fs(\d+)/.exec(line)!;
          expect(Math.abs(dom[i]!.x - Number(m[1]))).toBeLessThan(0.51);
          expect(Math.abs(dom[i]!.y - Number(m[2]))).toBeLessThan(0.51);
          expect(Math.abs(dom[i]!.size - Number(m[3]))).toBeLessThan(0.01);
        });
        // boxes: decoration, image and the AI label at the core's pixels; font size = ASS size × factor
        const rects = [...html.matchAll(/<(?:div|img)\b[^>]*>/g)].map((t) => t[0]).filter((t) => /data-testid="slide-(?:rect|image|placeholder|ai-label)"/.test(t)).map((t) => /style="([^"]*)"/.exec(t)![1]!);
        const coreBoxes = layout.elements.filter((e) => e.type !== 'text').map((e) => e.box);
        expect(rects.length).toBe(coreBoxes.length);
        rects.forEach((st, i) => {
          const c = coreBoxes[i]!;
          expect(Math.abs(px(st, 'left') / K - c.x0)).toBeLessThan(0.01);
          expect(Math.abs(px(st, 'top') / K - c.y0)).toBeLessThan(0.01);
          expect(Math.abs(px(st, 'width') / K - (c.x1 - c.x0))).toBeLessThan(0.01);
        });
        if (layout.aiImage) expect(html).toContain('KI-generiert');
      }
      const first = renderToStaticMarkup(createElement(SlideCanvas, { layout: layoutCarousel(b, look, images)[0]!, look, width: W }));
      const title = layoutCarousel(b, look, images)[0]!.elements.find((e) => e.type === 'text' && e.field === 'title')!;
      if (title.type === 'text') expect(first).toContain(`font-size:${title.size * assEmFactor('Avenir Next') * K}px`);
    });
  }
});
