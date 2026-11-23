import { describe, expect, it } from 'vitest';
import {
  AI_DISCLOSURE, buildFrame, buildPreview, buildRender, buildTimeline, buildTimelineView, checkEditPlan, ClipImage, EditDraftBody, EditPlanBody, imageAlphaAt, imageBox,
  imageDisclosureLabels, imageLayers, ImageUsage, LABEL_ZONE, mergeLabelSpans, placeImage, removeImage, retimeImage, splitAt, timedImages, trimClip, addImageAt, updateImage, keepClearOfLabel,
  type EditAssetInfo, type ImageAssetInfo, type RenderClip,
} from '../src';

const assets = new Map<string, EditAssetInfo>([['a', { origin: 'own', durationSec: 10, hasAudio: true, hasVideo: true }]]);
const images = new Map<string, ImageAssetInfo>([
  ['own', { kind: 'image', usage: { origin: 'own', source: '' } }],
  ['lic', { kind: 'image', usage: { origin: 'licensed', source: 'Unsplash-Lizenz, Foto von K. M.' } }],
  ['gen', { kind: 'image', usage: { origin: 'generated', source: '' } }],
  ['none', { kind: 'image', usage: null }],
  ['vid', { kind: 'video', usage: { origin: 'own', source: '' } }],
  ['gif', { kind: 'image', mime: 'image/gif', usage: { origin: 'own', source: '' } }],
]);
const ctx = (kind: 'PERSONAL_CONTENT' | 'UGC_CLIENT' = 'PERSONAL_CONTENT') => ({ scenes: null, assets, projectKind: kind, images });
const img = (x: Partial<ClipImage> = {}) => ({ referenceId: 'own', startSec: 1, endSec: 3, aspect: 1.5, ...x });
const body = (imgs: unknown[]) => ({ clips: [{ assetId: 'a', inSec: 0, outSec: 6, images: imgs }] });

describe('image overlays: geometry, rights, labels (Etappe 16)', () => {
  it('box from size step and aspect; the default centre never reaches into the label zone; a drag never does', () => {
    expect(imageBox({ aspect: 1.5, size: 'M' })).toEqual({ x0: 270, y0: 586, x1: 810, y1: 946 });
    const tall = imageBox({ aspect: 0.5, size: 'L' }); // 550 × 1100 portrait
    expect(tall.y1 - tall.y0).toBe(1100);
    expect(tall.y0).toBeGreaterThanOrEqual(LABEL_ZONE.y1);
    const p = placeImage({ aspect: 1, size: 'L' }, 540, 0);
    expect(imageBox({ aspect: 1, size: 'L', pos: p }).y0).toBeGreaterThanOrEqual(LABEL_ZONE.y1);
  });
  it('fades linearly in and out (150 ms) like the render', () => {
    const o = { startSec: 1, endSec: 2, fade: true };
    expect([imageAlphaAt(o, 0.9), imageAlphaAt(o, 1), imageAlphaAt(o, 1.075), imageAlphaAt(o, 1.5), imageAlphaAt(o, 1.925), imageAlphaAt(o, 2)]).toEqual([0, 0, 0.5, 1, 0.5, 0]);
    expect(imageAlphaAt({ ...o, fade: false }, 1)).toBe(1);
  });
  it('rights: own and licensed with source pass; no rights note, a video, a missing image and client projects fail', () => {
    expect(ImageUsage.safeParse({ origin: 'licensed', source: '' }).success).toBe(false);
    expect(checkEditPlan(body([img(), img({ referenceId: 'lic', startSec: 3.5, endSec: 5 })]), ctx()).errors).toEqual([]);
    const bad = checkEditPlan(body([img({ referenceId: 'none' }), img({ referenceId: 'vid', startSec: 3.2, endSec: 4 }), img({ referenceId: 'weg', startSec: 4.2, endSec: 5 })]), ctx()).errors.join(' ');
    expect(bad).toMatch(/nicht angegeben, ob es dein eigenes oder lizenziert/);
    expect(bad).toMatch(/Nur Bilder/);
    expect(bad).toMatch(/gibt es in der Bibliothek nicht/);
    // review fix: FFmpeg cannot loop a GIF as a still input – refused up front instead of a failing render
    expect(checkEditPlan(body([img({ referenceId: 'gif' })]), ctx()).errors.join(' ')).toMatch(/GIF/);
    expect(checkEditPlan(body([img()]), { ...ctx('UGC_CLIENT'), scenes: [{ shotType: 'talking_head', origin: 'real' }] }).errors.join(' ')).toMatch(/nur in eigenen Projekten/);
  });
  it('a free position in the label zone is an error; an image outside In/Out too', () => {
    const e = checkEditPlan(body([img({ pos: { x: 0.5, y: 0.05 } }), img({ startSec: 5, endSec: 7 })]), ctx()).errors.join(' ');
    expect(e).toMatch(/Bild 1: liegt im Bereich des KI-Labels/);
    expect(e).toMatch(/Bild 2: liegt außerhalb von In\/Out/);
  });
  it('a generated image needs the AI label while it is shown (existing disclosure logic extended)', () => {
    const v = checkEditPlan(body([img({ referenceId: 'gen' })]), ctx());
    expect(v.errors).toEqual([]);
    expect(v.result.disclosures).toEqual([AI_DISCLOSURE]);
    const tl = buildTimeline(v.result.body.clips);
    const labels = imageDisclosureLabels(timedImages(v.result.body, tl).images, (id) => images.get(id)?.usage?.origin === 'generated', AI_DISCLOSURE);
    expect(labels).toEqual([{ startSec: 1, endSec: 3, text: AI_DISCLOSURE }]);
    expect(checkEditPlan(body([img()]), ctx()).result.disclosures).toEqual([]);
    expect(mergeLabelSpans([{ startSec: 2, endSec: 4, text: 'x' }, { startSec: 0, endSec: 2, text: 'x' }])).toEqual([{ startSec: 0, endSec: 4, text: 'x' }]);
  });
  it('plans without images keep their body shape (no images key) and their FFmpeg arguments', () => {
    const plain = EditPlanBody.parse({ clips: [{ assetId: 'a', inSec: 0, outSec: 4 }] });
    expect('images' in plain.clips[0]!).toBe(false);
    expect('images' in checkEditPlan(plain, ctx()).result.body.clips[0]!).toBe(false);
    const clips: RenderClip[] = [{ path: '/x/a.mp4', hasAudio: true, inSec: 0, outSec: 4 }];
    const loud = { preset: 'streaming_-14' as const, measured: null };
    expect(buildRender(clips, '/o.mp4', loud, '/s.ass', null, [])).toEqual(buildRender(clips, '/o.mp4', loud, '/s.ass'));
    expect(buildPreview(clips, '/o.mp4', loud, '/s.ass', null, [])).toEqual(buildPreview(clips, '/o.mp4', loud, '/s.ass'));
    expect(buildFrame(clips[0]!, 1, '/f.png', '/s.ass', null, undefined, [])).toEqual(buildFrame(clips[0]!, 1, '/f.png', '/s.ass'));
  });
  it('render graph: images are extra looped inputs, overlaid BEFORE the ASS (label, text on top); the path never enters the graph', () => {
    const clips: RenderClip[] = [{ path: '/x/a.mp4', hasAudio: true, inSec: 0, outSec: 4 }];
    const layer = imageLayers(timedImages({ clips: [{ images: [ClipImage.parse(img({ endSec: 2.5 }))] }] }, buildTimeline([{ inSec: 0, outSec: 4 }])).images, () => '/lib/foto.jpg');
    const args = buildRender(clips, '/o.mp4', { preset: 'off', measured: null }, '/s.ass', null, layer);
    expect(args.slice(6, 14)).toEqual(['-loop', '1', '-framerate', '30', '-t', '3.000', '-i', '/lib/foto.jpg']);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain("[1:v:0]scale=540:360:flags=lanczos,format=rgba,fade=t=in:st=1.000:d=0.150:alpha=1,fade=t=out:st=2.350:d=0.150:alpha=1,setpts=PTS-STARTPTS[img0]");
    expect(graph).toContain("[vcat][img0]overlay=x=270:y=586:enable='between(t,1.000,2.500)':eof_action=pass[vimg0]");
    expect(graph.indexOf('overlay=')).toBeLessThan(graph.indexOf('subtitles='));
    expect(graph).toContain("[vimg0]subtitles=filename='/s.ass'[vsub]");
    expect(graph).not.toContain('foto.jpg');
    // still frame: only images visible at t, with their opacity at that moment
    const f = buildFrame(clips[0]!, 1.075, '/f.png', '/s.ass', null, undefined, layer);
    expect(f).toContain('/lib/foto.jpg');
    expect(f[f.indexOf('-filter_complex') + 1]).toContain('colorchannelmixer=aa=0.500');
    expect(buildFrame(clips[0]!, 3, '/f.png', '/s.ass', null, undefined, layer)).toEqual(buildFrame(clips[0]!, 3, '/f.png', '/s.ass'));
  });
  it('review fix: an image that grows into the label zone (size L in the inspector) is moved back below it', () => {
    const b = EditDraftBody.parse(body([img({ pos: { x: 0.5, y: 0.25 }, size: 'S' })]));
    const grown = updateImage(b, 0, 0, { size: 'L' });
    expect(imageBox(grown.clips[0]!.images![0]!).y0).toBeLessThan(LABEL_ZONE.y1);
    const fixed = keepClearOfLabel(grown);
    expect(imageBox(fixed.clips[0]!.images![0]!).y0).toBeGreaterThanOrEqual(LABEL_ZONE.y1);
  });
  it('timeline operations move images with their clip; view shows them; add/retime/remove', () => {
    const b = EditDraftBody.parse(body([img({ startSec: 1, endSec: 2 }), img({ referenceId: 'lic', startSec: 4, endSec: 5 })]));
    const split = splitAt(b, 3)!.body;
    expect(split.clips.map((c) => (c.images ?? []).map((x) => x.referenceId))).toEqual([['own'], ['lic']]);
    expect(trimClip(b, 0, 'out', 3, 10).droppedOverlays).toBe(1);
    expect(buildTimelineView(b).images.map((x) => [x.startSec, x.endSec])).toEqual([[1, 2], [4, 5]]);
    const added = addImageAt(EditDraftBody.parse({ clips: [{ assetId: 'a', inSec: 0, outSec: 6 }] }), 2, { referenceId: 'own', aspect: 1 });
    if ('error' in added) throw new Error(added.error);
    expect(added.body.clips[0]!.images).toEqual([expect.objectContaining({ startSec: 2, endSec: 4, size: 'M', fade: true })]);
    expect(retimeImage(added.body, 0, 0, 3, 5, 'move').clips[0]!.images![0]).toMatchObject({ startSec: 3, endSec: 5 });
    expect('images' in removeImage(added.body, 0, 0).clips[0]!).toBe(false);
    // review fix: a panorama (aspect 8) is clamped, not a thrown ZodError
    const pano = addImageAt(EditDraftBody.parse({ clips: [{ assetId: 'a', inSec: 0, outSec: 6 }] }), 2, { referenceId: 'own', aspect: 8 });
    expect('error' in pano ? pano.error : pano.body.clips[0]!.images![0]!.aspect).toBe(5);
  });
});
