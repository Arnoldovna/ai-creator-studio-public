import { describe, expect, it } from 'vitest';
import { buildLoudnessMeasure, buildRender, disclosureLabels, EditPlanBody, MAX_SEGMENTS, parseLoudness, renderSegments, validateEditPlan, type EditAssetInfo } from '../src/edit';
import { buildTimeline } from '../src/timeline';

const scenes = [
  { shotType: 'talking_head' as const, origin: 'real' as const },
  { shotType: 'product' as const, origin: 'real' as const },
  { shotType: 'b_roll' as const, origin: 'generated' as const },
];
const assets = new Map<string, EditAssetInfo>([
  ['a', { origin: 'own', durationSec: 10, hasAudio: true, hasVideo: true }],
  ['b', { origin: 'client', durationSec: 4, hasAudio: false, hasVideo: true }],
  ['g', { origin: 'generated', durationSec: 5, hasAudio: false, hasVideo: true }],
  ['n', { origin: 'own', durationSec: null, hasAudio: true, hasVideo: true }],
  ['v', { origin: 'own', durationSec: 8, hasAudio: true, hasVideo: false }],
]);
const ctx = { scenes, assets, projectKind: 'PERSONAL_CONTENT' as const };
const clip = (x: Record<string, unknown>) => ({ sceneIndex: 0, assetId: 'a', inSec: 0, outSec: 2, ...x });

describe('validateEditPlan', () => {
  it('accepts a cut, sums the duration and warns about silent footage and uncovered scenes', () => {
    const v = validateEditPlan({ clips: [clip({ inSec: 1.23456, outSec: 3.5 }), clip({ sceneIndex: 1, assetId: 'b', outSec: 4 })] }, ctx);
    expect(v.durationSec).toBe(6.265);
    expect(v.body.loudness).toBe('streaming_-14');
    expect(v.body.clips[0]).toMatchObject({ inSec: 1.235, subtitle: '', briefId: null });
    expect(v.disclosures).toEqual([]);
    expect(v.warnings.join(' ')).toMatch(/ohne Ton/);
    expect(v.warnings.join(' ')).toMatch(/Ohne Clip: Szene 3/);
  });

  it.each([
    [{ sceneIndex: 5 }, /Szene 6 gibt es/],
    [{ assetId: 'x' }, /Footage nicht gefunden/],
    [{ inSec: 2, outSec: 2.1 }, /mindestens 0.2 s/],
    [{ outSec: 10.2 }, /hinter dem Ende/],
    [{ assetId: 'n' }, /Dauer des Footage unbekannt/],
    [{ assetId: 'v' }, /ohne Videospur/],
    [{ sceneIndex: 1, assetId: 'g', briefId: 'brief-1' }, /Produktszenen/],
    [{ sceneIndex: 2, assetId: 'g' }, /ohne freigegebenen Asset-Brief/],
  ])('rejects %j', (x, msg) => {
    expect(() => validateEditPlan({ clips: [clip(x)] }, ctx)).toThrow(msg);
  });

  it('accepts exactly 0.2 s despite float steps (1.1 → 1.3)', () => {
    expect(validateEditPlan({ clips: [clip({ inSec: 1.1, outSec: 1.3 })] }, ctx).durationSec).toBe(0.2);
  });

  it('rejects cuts over 180 s and empty plans', () => {
    const long = Array.from({ length: 19 }, () => clip({ outSec: 10 }));
    expect(() => validateEditPlan({ clips: long }, ctx)).toThrow(/höchstens 180 s/);
    expect(() => validateEditPlan({ clips: [] }, ctx)).toThrow();
  });

  it('labels generated clips and client work, and needs client consent for AI in client projects', () => {
    const plan = { clips: [clip({ sceneIndex: 2, assetId: 'g', briefId: 'brief-1' })] };
    expect(validateEditPlan(plan, ctx).disclosures).toEqual(['KI-generierte Bildelemente']);
    expect(validateEditPlan(plan, ctx).clips[0]!.disclosure).toBe('KI-generierte Bildelemente');
    expect(() => validateEditPlan(plan, { ...ctx, projectKind: 'UGC_CLIENT' })).toThrow(/Zustimmung der Kundin/);
    expect(validateEditPlan(plan, { ...ctx, projectKind: 'UGC_CLIENT', clientConsentNote: 'Mail vom 12.11.' }).disclosures).toEqual(['Anzeige', 'KI-generierte Bildelemente']);
  });
});

describe('cuts, zoom and the scriptless plan (Etappe 8)', () => {
  it('parses old bodies with do-nothing defaults and normalises cuts (sorted, merged)', () => {
    const old = EditPlanBody.parse({ clips: [{ sceneIndex: 0, assetId: 'a', inSec: 0, outSec: 2 }] });
    expect(old.clips[0]).toMatchObject({ cuts: [], zoom: { kind: 'none', amount: 1.1, punchOnCuts: false } });
    const b = EditPlanBody.parse({ clips: [clip({ outSec: 9, cuts: [{ startSec: 5, endSec: 6 }, { startSec: 1, endSec: 2, reason: 'filler', word: 'ähm' }, { startSec: 1.5, endSec: 3 }] })] });
    expect(b.clips[0]!.cuts).toEqual([{ startSec: 1, endSec: 3, reason: 'filler', word: 'ähm' }, { startSec: 5, endSec: 6, reason: 'manual', word: '' }]);
  });

  it.each([
    [{ cuts: [{ startSec: 2, endSec: 1 }] }, /Ende muss nach dem Anfang/],
    [{ zoom: { kind: 'push_in', punchOnCuts: true } }, /nicht mit Push-in/],
    [{ zoom: { kind: 'punch_in', amount: 1.2 } }, /./],
    [{ zoom: { kind: 'punch_in', amount: 1.02 } }, /./],
  ])('refuses invalid effects %j', (x, msg) => {
    expect(() => EditPlanBody.parse({ clips: [clip(x)] })).toThrow(msg);
  });

  it.each([
    [{ inSec: 1, outSec: 4, cuts: [{ startSec: 0.5, endSec: 1.5 }] }, /außerhalb von In\/Out/],
    [{ inSec: 0, outSec: 4, cuts: [{ startSec: 0.1, endSec: 1 }] }, /Stück unter 0.2 s/],
    [{ inSec: 0, outSec: 4, cuts: [{ startSec: 0, endSec: 4 }] }, /ganzen Clip/],
  ])('rejects cuts %j', (x, msg) => {
    expect(() => validateEditPlan({ clips: [clip(x)] }, ctx)).toThrow(msg);
  });

  it('counts the duration after cuts and caps the total number of pieces', () => {
    const v = validateEditPlan({ clips: [clip({ inSec: 0, outSec: 6, cuts: [{ startSec: 1, endSec: 1.5 }, { startSec: 3, endSec: 4 }] })] }, ctx);
    expect(v.durationSec).toBe(4.5);
    expect(v.body.clips[0]!.cuts).toHaveLength(2); // carried through the validator's rebuild
    // 31 cuts → 32 pieces per clip; two clips → 64 > 60
    const many = Array.from({ length: 31 }, (_, k) => ({ startSec: 0.25 + k * 0.3, endSec: 0.3 + k * 0.3 }));
    const ok = validateEditPlan({ clips: [clip({ outSec: 10, cuts: many })] }, ctx);
    expect(buildTimeline(ok.body.clips).segments).toHaveLength(32);
    expect(() => validateEditPlan({ clips: [clip({ outSec: 10, cuts: many }), clip({ outSec: 10, cuts: many })] }, ctx)).toThrow(new RegExp(`64 Stücke.*höchstens ${MAX_SEGMENTS}`));
  });

  it('validates a scriptless plan without scenes, refuses it for client work and refuses generated clips in it', () => {
    const free = validateEditPlan({ clips: [{ assetId: 'a', inSec: 0, outSec: 10 }, clip({ sceneIndex: 4, assetId: 'b', outSec: 4 })] }, { ...ctx, scenes: null });
    expect(free.body.clips.map((c) => c.sceneIndex)).toEqual([null, null]);
    expect(free.warnings.join(' ')).not.toMatch(/Ohne Clip/);
    expect(() => validateEditPlan({ clips: [clip({})] }, { ...ctx, scenes: null, projectKind: 'UGC_CLIENT' })).toThrow(/Kundenprojekte brauchen ein freigegebenes Skript/);
    expect(() => validateEditPlan({ clips: [clip({ assetId: 'g', briefId: 'brief-1' })] }, { ...ctx, scenes: null })).toThrow(/nur in Schnittplänen mit Skript/);
    expect(() => validateEditPlan({ clips: [{ assetId: 'a', inSec: 0, outSec: 1 }] }, ctx)).toThrow(/Szene fehlt/);
  });

  it('puts the AI label over the whole output span of a generated clip with cuts, merged with its neighbour', () => {
    expect(disclosureLabels([
      { origin: 'own', inSec: 0, outSec: 2 },
      { origin: 'generated', inSec: 0, outSec: 5, cuts: [{ startSec: 1, endSec: 2 }] },
      { origin: 'generated', inSec: 0, outSec: 1 },
      { origin: 'own', inSec: 0, outSec: 1 },
    ])).toEqual([{ startSec: 2, endSec: 7, text: 'KI-generierte Bildelemente' }]);
  });

  it('renders the exact segments of a cut: inputs, 12 ms fades after atrim, push-in continued across the cut', () => {
    const body = EditPlanBody.parse({ clips: [clip({ outSec: 4, cuts: [{ startSec: 1, endSec: 1.5 }], zoom: { kind: 'push_in' } })] });
    const segs = renderSegments(buildTimeline(body.clips), body.clips, [{ path: '/d/a.mp4', hasAudio: true }]);
    const args = buildRender(segs, '/w/o.mp4', { preset: 'off', measured: null });
    expect(args.slice(0, 12)).toEqual(['-ss', '0.000', '-t', '1.000', '-i', '/d/a.mp4', '-ss', '1.500', '-t', '2.500', '-i', '/d/a.mp4']);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('apad,atrim=duration=1.000,afade=t=out:st=0.988:d=0.012[a0]');
    expect(graph).toContain('apad,atrim=duration=2.500,afade=t=in:st=0:d=0.012[a1]');
    expect(graph).toContain("scale=w='2*trunc(1080*(1+0.100*min((t+0.000)/3.500,1))/2)'");
    expect(graph).toContain("scale=w='2*trunc(1080*(1+0.100*min((t+1.000)/3.500,1))/2)'");
    expect(graph).not.toContain('\\'); // no backslash escapes inside the quoted expressions
    // the measure pass uses identical inputs and the identical audio chains (same fades)
    const measure = buildLoudnessMeasure(segs, 'streaming_-14');
    expect(measure.slice(0, 12)).toEqual(args.slice(0, 12));
    const audio = (g: string) => g.split(';').filter((p) => /\[a\d\]$/.test(p));
    expect(audio(measure[measure.indexOf('-filter_complex') + 1]!)).toEqual(audio(graph));
  });

  it('builds punch-in from one even factor and alternates it at cuts; push-out runs backwards', () => {
    const body = EditPlanBody.parse({ clips: [
      clip({ outSec: 6, cuts: [{ startSec: 1, endSec: 1.5 }, { startSec: 3, endSec: 3.5 }], zoom: { kind: 'none', amount: 1.03, punchOnCuts: true } }),
      clip({ outSec: 2, zoom: { kind: 'punch_in', amount: 1.15 } }),
      clip({ outSec: 2, zoom: { kind: 'push_out', amount: 1.05 } }),
    ] });
    const segs = renderSegments(buildTimeline(body.clips), body.clips, body.clips.map(() => ({ path: '/d/a.mp4', hasAudio: false })));
    expect(segs.map((s) => s.zoom ?? null)).toEqual([
      null, { kind: 'static', factor: 1.03 }, null,
      { kind: 'static', factor: 1.15 },
      { kind: 'push_out', amount: 1.05, offsetSec: 0, clipSec: 2 },
    ]);
    const graph = buildRender(segs, '/w/o.mp4', { preset: 'off', measured: null }).find((a) => a.includes('concat='))!;
    expect(graph).toContain('[1:v:0]setpts=PTS-STARTPTS,scale=1112:1978:force_original_aspect_ratio=increase,crop=1080:1920,fps=30');
    expect(graph).toContain('[3:v:0]setpts=PTS-STARTPTS,scale=1242:2208:force_original_aspect_ratio=increase,crop=1080:1920,fps=30');
    expect(graph).toContain('(1+0.050*(1-min((t+0.000)/2.000,1)))');
    expect(graph).not.toMatch(/anullsrc[^;]*afade/); // silence gets no fades
  });

  it('old plans without the new fields produce the same FFmpeg arguments as before', () => {
    const plain = [{ path: '/data/a.mp4', hasAudio: true, inSec: 1.5, outSec: 3 }, { path: '/data/b.mov', hasAudio: false, inSec: 0, outSec: 2 }, { path: '/data/a.mp4', hasAudio: true, inSec: 5, outSec: 6.25 }];
    const body = EditPlanBody.parse({ clips: plain.map((c) => ({ sceneIndex: 0, assetId: c.path, inSec: c.inSec, outSec: c.outSec })) });
    const viaTimeline = renderSegments(buildTimeline(body.clips), body.clips, plain);
    const opts = { preset: 'streaming_-14' as const, measured: null };
    expect(buildRender(viaTimeline, '/work/out.mp4', opts)).toEqual(buildRender(plain, '/work/out.mp4', opts));
  });
});

describe('FFmpeg graph', () => {
  const a = { path: '/data/a.mp4', hasAudio: true }, b = { path: '/data/b.mov', hasAudio: false };
  const clips = [{ ...a, inSec: 1.5, outSec: 3 }, { ...b, inSec: 0, outSec: 2 }, { ...a, inSec: 5, outSec: 6.25 }];

  it('renders frame-exact with re-encode, silence for clips without audio and two-pass loudnorm', () => {
    const measured = { input_i: '-20.1', input_tp: '-3.2', input_lra: '5', input_thresh: '-30.4', target_offset: '0.3' };
    expect(buildRender(clips, '/work/out.mp4', { preset: 'streaming_-14', measured })).toMatchSnapshot();
    const off = buildRender(clips, '/work/out.mp4', { preset: 'off', measured: null });
    expect(off[off.indexOf('-filter_complex') + 1]).toMatch(/\[acat\]anull\[aout\]$/);
  });

  it('measures loudness on the audio graph only', () => {
    const args = buildLoudnessMeasure(clips, 'quiet_-16');
    expect(args.slice(-4)).toEqual(['[aout]', '-f', 'null', '-']);
    expect(args[args.indexOf('-filter_complex') + 1]).not.toMatch(/\[\d+:v/);
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(/loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json/);
  });

  it('parses the loudnorm report and refuses silence (-inf)', () => {
    const report = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-23.54",\n\t"input_tp" : "-6.11",\n\t"input_lra" : "1.20",\n\t"input_thresh" : "-33.6",\n\t"output_i" : "-14.0",\n\t"target_offset" : "0.02"\n}\n`;
    expect(parseLoudness(report)).toEqual({ input_i: '-23.54', input_tp: '-6.11', input_lra: '1.2', input_thresh: '-33.6', target_offset: '0.02' });
    expect(parseLoudness(report.replace('"-23.54"', '"-inf"'))).toBeNull();
    expect(parseLoudness('no report')).toBeNull();
  });
});

describe('contracts/edit-plan.json', () => {
  it('matches the Zod schema (regenerate with UPDATE_CONTRACTS=1)', async () => {
    const { z } = await import('zod');
    const { EditPlanBody } = await import('../src/edit');
    const { readFile, writeFile } = await import('node:fs/promises');
    const file = new URL('../../../contracts/edit-plan.json', import.meta.url);
    const expected = `${JSON.stringify({ title: 'Edit Plan (EDL) v1', ...z.toJSONSchema(EditPlanBody, { io: 'input' }) }, null, 2)}\n`;
    if (process.env.UPDATE_CONTRACTS) await writeFile(file, expected);
    expect(await readFile(file, 'utf8')).toBe(expected);
  });
});
