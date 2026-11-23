import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Etappe 18: the carousel generator through the services – sources (concept, script, finished reel, note), estimate without
 * a run, versions (edit, stale base, variant), personal projects only, the real PNG render (FFmpeg + libass with a Google
 * font file and an installed Mac font, no fallback; pixel checks: background, her image, the AI label on a generated
 * image), the ZIP (files, caption, labelling note; refused with an overflow) and the chat patch („Slide 2 kürzer“).
 */
const run = promisify(execFile);
const FIX = path.join(__dirname, 'fixtures', 'fonts');
let dir: string;
let ff: string | null = null;
let libass = false;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-carousel-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', STUDIO_DEFAULTS_DIR: 'off', VIDEO_WORKER_CONCURRENCY: '1', STUDIO_AUTO_PREPARE: 'off' });
  const f = await import('@/server/ffmpeg');
  ff = await f.ffmpegPath();
  libass = (await f.ffmpegStatus()).subtitles;
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const BG = '#F6F3EC', PRIMARY = '#2E4A3B', ACCENT = '#E8B04A', IMG = '#2050F0';

async function brand(opts: { titleFont?: string; bodyFont?: string; bodyFace?: { family: string; style: string; weight: number; italic: boolean } } = {}) {
  const core = await import('@studio/core');
  const { write, now } = await import('@/server/store');
  const o = { source: 'manual' as const };
  const col = (hex: string) => ({ hex, origin: o });
  const design = core.DesignSystem.parse({
    colors: { primary: col(PRIMARY), accent: col(ACCENT), surface: col('#1F2617'), onSurface: col('#FFFFFF'), onAccent: col('#111111'), onVideo: col('#FFFFFF'), background: col(BG) },
    typography: core.defaultTypography(), presets: [core.defaultPreset()], defaultPresetId: 'marke',
  });
  if (opts.titleFont) design.typography.carouselTitle = { ...design.typography.carouselTitle, font: opts.titleFont };
  if (opts.bodyFont) design.typography.carouselBody = { ...design.typography.carouselBody, font: opts.bodyFont, ...(opts.bodyFace ? { face: opts.bodyFace } : {}) };
  await write((db) => {
    for (const v of db.styleBibles) v.status = 'archived';
    const n = db.styleBibles.length + 1;
    db.styleBibles.push({ id: `sb-18-${n}`, profileId: 'profile-personal', version: n, status: 'approved', createdAt: now(), approvedAt: now(), rules: { name: 'Marke', visual: { palette: [ACCENT, PRIMARY], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [], design } as never });
  });
}

async function setup() {
  const projects = await import('@/server/services/projects');
  const content = await import('@/server/services/content');
  const project = await projects.createProject({ title: 'Morgenstricken', kind: 'PERSONAL_CONTENT' });
  const { concepts } = await content.generateConcepts({ projectId: project.id, topic: 'Morgenstricken', verifiedFacts: ['Ich stricke seit 3 Jahren jeden Morgen.'] });
  return { project, concept: concepts[0]! };
}

const counts = async () => {
  const { read } = await import('@/server/store');
  return read((db) => ({ runs: db.agentRuns.filter((r) => r.useCase === 'carousel_writing').length, carousels: db.carousels.length, versions: db.carouselVersions.length }));
};

describe('carousels: sources, versions, gates', () => {
  it('estimate runs nothing; a concept becomes a carousel (mock, logged run, version 1, lineage)', async () => {
    const svc = await import('@/server/services/carousels');
    await brand();
    const { project, concept } = await setup();
    const before = await counts();
    const est = await svc.estimateCarousel(project.id, { source: { kind: 'concept', id: concept.id }, framework: 'liste' });
    expect(est.estimate).toMatchObject({ mode: 'mock', estCostUsd: 0 });
    expect(await counts()).toEqual(before);
    const got = await svc.createCarousel(project.id, { source: { kind: 'concept', id: concept.id }, framework: 'liste' });
    expect(await counts()).toEqual({ runs: before.runs + 1, carousels: before.carousels + 1, versions: before.versions + 1 });
    expect(got.version).toMatchObject({ version: 1, status: 'active', origin: 'agent', mock: true });
    expect(got.version.body.slides.map((s) => s.kind)).toEqual(['title', 'list', 'cta']);
    expect(got.carousel.source).toMatchObject({ kind: 'concept', id: concept.id });
    expect(got.version.body.caption).toContain('[MOCK]');
    expect(got.version.styleBibleVersionId).toMatch(/^sb-18-/);
    expect(got.rules.sources).toContain('Ich stricke seit 3 Jahren jeden Morgen.');
    const { read } = await import('@/server/store');
    const runRec = await read((db) => db.agentRuns.find((r) => r.id === got.version.agentRunId)!);
    expect(runRec).toMatchObject({ agent: 'carousel_writer', useCase: 'carousel_writing', status: 'succeeded' });
  });
  it('script, note and finished reel (transcript in cut order) are sources; an unfinished reel and client projects are refused', async () => {
    const svc = await import('@/server/services/carousels');
    const content = await import('@/server/services/content');
    const projects = await import('@/server/services/projects');
    const { write, now, newId } = await import('@/server/store');
    const { project, concept } = await setup();
    const script = await content.selectConceptAndWrite(concept.id);
    const s = await svc.createCarousel(project.id, { source: { kind: 'script', id: script.id }, framework: 'prozess', slideCount: 6 });
    expect(s.version.body.slides).toHaveLength(6);
    const n = await svc.createCarousel(project.id, { source: { kind: 'note', text: 'Wolle am Abend bereitlegen. Handy im Flur lassen. Eine Reihe zählt schon.' }, framework: 'geschichte', format: 'square' });
    expect(n.version.body.format).toBe('square');
    expect(n.carousel.source.label).toMatch(/^Notiz/);
    // a finished reel: transcript segments inside the cut, in cut order
    const ids = { asset: newId(), plan: newId(), render: newId(), tr: newId() };
    const trPath = `transcripts/${project.id}/${ids.tr}.json`;
    await (await import('@/server/media')).writeBytes(trPath, new TextEncoder().encode(JSON.stringify({ language: 'de', segments: [
      { startSec: 0, endSec: 2, text: 'Vorher geschnitten.' }, { startSec: 3, endSec: 5, text: 'Ich stricke jeden Morgen eine Reihe.' }, { startSec: 5, endSec: 7, text: 'Das Handy bleibt im Flur.' },
    ] })));
    await write((db) => {
      db.mediaAssets.push({ id: ids.asset, projectId: project.id, name: 'take.mp4', mime: 'video/mp4', size: 1, sha256: 'x', storagePath: `footage/${project.id}/take.mp4`, origin: 'own', rightsNote: '', rightsConfirmedAt: now(), probe: null, status: 'probed', createdAt: now() });
      db.transcripts.push({ id: ids.tr, projectId: project.id, assetId: ids.asset, version: 1, parentId: null, source: 'mock', model: null, language: 'de', storagePath: trPath, segmentCount: 3, createdAt: now() });
      db.editPlans.push({ id: ids.plan, projectId: project.id, scriptId: null, version: 1, parentId: null, status: 'draft', body: { clips: [{ assetId: ids.asset, inSec: 2.5, outSec: 7, cuts: [], overlays: [], subtitle: '' }] } as never, durationSec: 4.5, disclosures: [], warnings: [], clientConsentNote: null, styleBibleVersionId: null, voiceGuideVersionId: null, createdAt: now(), approvedAt: null });
      db.renders.push({ id: ids.render, projectId: project.id, editPlanId: ids.plan, jobId: 'j', status: 'rendering', storagePath: null, size: null, sha256: null, durationSec: null, loudness: null, disclosures: [], error: null, reviewNote: '', createdAt: now(), finishedAt: null, reviewedAt: null });
    });
    await expect(svc.createCarousel(project.id, { source: { kind: 'render', id: ids.render } })).rejects.toMatchObject({ status: 409 });
    await write((db) => Object.assign(db.renders.find((r) => r.id === ids.render)!, { status: 'pending_review', storagePath: `renders/${project.id}/r.mp4` }));
    const r = await svc.createCarousel(project.id, { source: { kind: 'render', id: ids.render } });
    expect(r.carousel.source.text).toBe('Ich stricke jeden Morgen eine Reihe. Das Handy bleibt im Flur.');
    const list = await svc.listCarousels(project.id);
    expect(list.sources.renders.map((x) => x.id)).toEqual([ids.render]);
    expect(list.carousels).toHaveLength(3);
    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Garn GmbH' } });
    await expect(svc.createCarousel(client.id, { source: { kind: 'note', text: 'Eine Notiz für den Kunden.' } })).rejects.toMatchObject({ status: 409 });
    expect((await svc.listCarousels(client.id)).available).toBe(false);
  });
  it('an edit is a new active version; a save on an outdated base is refused; a variant changes only the layout', async () => {
    const svc = await import('@/server/services/carousels');
    const { project, concept } = await setup();
    const c = await svc.createCarousel(project.id, { source: { kind: 'concept', id: concept.id } });
    const body = structuredClone(c.version.body);
    body.slides[1]!.body = 'Mein eigener Text auf Slide 2.';
    const v2 = await svc.saveCarousel(project.id, c.carousel.id, { baseVersionId: c.version.id, body });
    expect(v2.version).toMatchObject({ version: 2, origin: 'user_edit', parentId: c.version.id });
    expect(v2.version.body.slides[1]!.body).toBe('Mein eigener Text auf Slide 2.');
    expect(v2.versions.map((x) => x.status)).toEqual(['active', 'archived']);
    await expect(svc.saveCarousel(project.id, c.carousel.id, { baseVersionId: c.version.id, body })).rejects.toMatchObject({ status: 409, code: 'stale_version' });
    const v3 = await svc.chooseVariant(project.id, c.carousel.id, { baseVersionId: v2.version.id, templateId: 'kontrast' });
    expect(v3.version).toMatchObject({ version: 3, origin: 'variant' });
    expect(v3.version.body.templateId).toBe('kontrast');
    expect(v3.version.body.slides).toEqual(v2.version.body.slides);
  });
});

async function pixels(file: string) {
  const { stdout: probe } = await run((await import('@/server/ffmpeg').then((m) => m.ffprobePath()))!, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = probe.trim().split(',').map(Number) as [number, number];
  const { stdout } = await run(ff!, ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  return { w, h, at: (x: number, y: number) => [buf[(y * w + x) * 3]!, buf[(y * w + x) * 3 + 1]!, buf[(y * w + x) * 3 + 2]!] as const };
}
const near = (p: readonly number[], hex: string, tol = 40) => [1, 3, 5].every((i, k) => Math.abs(p[k]! - parseInt(hex.slice(i, i + 2), 16)) <= tol);

describe('real PNG render (FFmpeg + libass) and export', () => {
  it('slides in a Google font file (Bebas Neue) and an installed Mac font render without fallback; image, AI label, ZIP', async () => {
    if (!ff || !libass) return console.log('[libass] FFmpeg ohne libass – übersprungen');
    const fonts = await import('@/server/services/fonts');
    const refs = await import('@/server/services/references');
    const svc = await import('@/server/services/carousels');
    const render = await import('@/server/services/carouselRender');
    const sf = await import('@/server/services/systemFonts');
    const bebas = await fonts.storeFont(await readFile(path.join(FIX, 'BebasNeue-Regular.ttf')), 'BebasNeue-Regular.ttf', () => ({
      note: 'SIL Open Font License 1.1 · Google Fonts „Bebas Neue“ (Test)',
      origin: { kind: 'google', family: 'Bebas Neue', weight: 400, url: 'https://fonts.gstatic.com/s/bebasneue/v16/test.ttf', licenseId: 'OFL-1.1', licenseUrl: 'https://openfontlicense.org', lastModified: '2026-01-01' },
    }));
    const rockwell = (await sf.listSystemFonts().catch(() => null))?.families.find((f) => f.family === 'Rockwell')?.faces.find((x) => x.ref === 'mac:Rockwell-Bold');
    await brand({ titleFont: `custom:${bebas.font.id}`, ...(rockwell ? { bodyFont: 'mac:Rockwell-Bold', bodyFace: { family: 'Rockwell', style: 'Bold', weight: 700, italic: false, ...(rockwell.assName ? { assName: rockwell.assName } : {}) } } : {}) });
    if (!rockwell) console.log('[libass] Rockwell nicht installiert – Text-Rolle bleibt Avenir Next');
    const png = path.join(dir, 'img.png');
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${IMG.slice(1)}:s=600x400`, '-frames:v', '1', '-y', png]);
    const { reference } = await refs.createReference(new File([await readFile(png)], 'atelier.png', { type: 'image/png' }), null);
    await refs.updateReference(reference.id, { usage: { origin: 'generated', source: '' } });
    const { project } = await setup();
    const c = await svc.createCarousel(project.id, { source: { kind: 'note', text: 'Mein Morgen mit Wolle. Eine Reihe zählt schon. Das Handy bleibt im Flur.' }, framework: 'problem_weg_ergebnis' });
    const body = structuredClone(c.version.body);
    body.slides[1] = { ...body.slides[1]!, kind: 'image_text', imageId: reference.id, title: 'Atelier am Morgen', body: '' };
    const saved = await svc.saveCarousel(project.id, c.carousel.id, { baseVersionId: c.version.id, body });
    // the AI image puts its label into the caption (added by the studio, never removed)
    expect(saved.version.body.caption.startsWith('KI-generierte Bildelemente · ')).toBe(true);
    expect(saved.review.aiSlides).toEqual([2]);

    const r = await render.renderCarousel(project.id, c.carousel.id);
    console.log(`[libass] Karussell Bebas Neue${rockwell ? ' + Rockwell Bold' : ''}: warnings ${JSON.stringify(r.render.warnings)}`);
    expect(r.render.warnings).toEqual([]);
    expect(r.render.files.map((f) => f.n)).toEqual([1, 2, 3, 4, 5]);
    const slide2 = await pixels(await render.slideFile(project.id, c.carousel.id, 2, null));
    expect([slide2.w, slide2.h]).toEqual([1080, 1350]);
    expect(near(slide2.at(10, 600), BG)).toBe(true); // background colour of „Klar“
    const core = await import('@studio/core');
    const layout = core.layoutSlide(saved.version.body, 1, saved.look, new Map(saved.images.map((i) => [i.id, { kind: 'image' as const, usage: i.usage, mime: i.mime }])));
    const imgEl = layout.elements.find((e) => e.type === 'image')!;
    expect(near(slide2.at(Math.round((imgEl.box.x0 + imgEl.box.x1) / 2), Math.round((imgEl.box.y0 + imgEl.box.y1) / 2)), IMG)).toBe(true); // her image, covering its box
    expect(near(slide2.at(imgEl.box.x0 + 3, imgEl.box.y1 - 3), IMG)).toBe(true);
    // the label: a black box at the top left with white text inside, only on the slide with the generated image
    const label = layout.elements.find((e) => e.type === 'label')!;
    expect(near(slide2.at(label.box.x0 + 3, label.box.y0 + 3), '#000000', 30)).toBe(true);
    let white = 0;
    for (let y = label.box.y0; y < label.box.y1; y += 2) for (let x = label.box.x0; x < label.box.x1; x += 2) if (near(slide2.at(x, y), '#FFFFFF', 40)) white++;
    expect(white).toBeGreaterThan(20);
    const slide1 = await pixels(await render.slideFile(project.id, c.carousel.id, 1, null));
    expect(near(slide1.at(label.box.x0 + 3, label.box.y0 + 3), BG)).toBe(true);
    // every text pixel stays inside the canvas margins (the width estimate is on the safe side)
    for (const s of [slide1]) for (let y = 100; y < 1250; y += 3) { expect(near(s.at(30, y), BG, 25)).toBe(true); expect(near(s.at(1050, y), BG, 25)).toBe(true); }

    // ZIP: 01..05.png, caption.txt, alt-text.txt, labelling note
    const pkg = await render.carouselPackage(project.id, c.carousel.id, null);
    expect(pkg.entries.map((e) => e.name)).toEqual(['01.png', '02.png', '03.png', '04.png', '05.png', 'caption.txt', 'alt-text.txt', 'KENNZEICHNUNG.txt']);
    const zip = await import('@/server/zip');
    const chunks: Uint8Array[] = [];
    for await (const ch of zip.zipStream(await zip.prepareZip(pkg.entries))) chunks.push(ch);
    const zipFile = path.join(dir, 'k.zip');
    await writeFile(zipFile, Buffer.concat(chunks));
    const { stdout: test } = await run('unzip', ['-t', zipFile]);
    expect(test).toMatch(/No errors detected/);
    const { stdout: caption } = await run('unzip', ['-p', zipFile, 'caption.txt']);
    expect(caption.startsWith('KI-generierte Bildelemente · ')).toBe(true);
    const { stdout: note } = await run('unzip', ['-p', zipFile, 'KENNZEICHNUNG.txt']);
    expect(note).toMatch(/Slide 2/);
    // the same render again draws nothing new (content-addressed)
    const again = await render.renderCarousel(project.id, c.carousel.id);
    expect(again.render.files.map((f) => f.key)).toEqual(r.render.files.map((f) => f.key));

    // an overflowing text blocks the export (409), the render still shows it
    const long = structuredClone(saved.version.body);
    long.slides[2] = { ...long.slides[2]!, kind: 'image_text', imageId: reference.id, title: 'Ein sehr langer Titel, '.repeat(6), body: 'Sehr viel Text, '.repeat(37) };
    long.format = 'square';
    await svc.saveCarousel(project.id, c.carousel.id, { baseVersionId: saved.version.id, body: long });
    await expect(render.carouselPackage(project.id, c.carousel.id, null)).rejects.toMatchObject({ status: 409, code: 'carousel_problems' });
    expect((await render.renderCarousel(project.id, c.carousel.id)).render.files).toHaveLength(5);

    // project deletion removes carousels, versions and PNGs
    const projects = await import('@/server/services/projects');
    const { read } = await import('@/server/store');
    await projects.deleteProject(project.id);
    expect(await read((db) => db.carousels.filter((x) => x.projectId === project.id).length + db.carouselVersions.filter((x) => x.projectId === project.id).length)).toBe(0);
    await expect(readFile(path.join(dir, r.render.files[0]!.storagePath))).rejects.toThrow();
  }, 120_000);
});

describe('review fix: slide PNG requests', () => {
  it('a slide is served from the last render without a new render or store write; a changed design renders again', async () => {
    if (!ff || !libass) return console.log('[libass] FFmpeg ohne libass – übersprungen');
    const svc = await import('@/server/services/carousels');
    const render = await import('@/server/services/carouselRender');
    const { read, write } = await import('@/server/store');
    await brand();
    const { project } = await setup();
    const c = await svc.createCarousel(project.id, { source: { kind: 'note', text: 'Wolle am Abend bereitlegen. Handy im Flur lassen. Eine Reihe zählt schon.' } });
    const r = await render.renderCarousel(project.id, c.carousel.id);
    const at = () => read((db) => db.carouselVersions.find((v) => v.id === r.versionId)!.render!.at);
    const before = await at();
    await new Promise((res) => setTimeout(res, 20));
    expect(await render.slideFile(project.id, c.carousel.id, 2, null)).toContain(r.render.files[1]!.key);
    expect(await at()).toBe(before); // no re-render, no write
    // another background colour in Meine Marke → other content keys → drawn again
    await write((db) => { const sb = db.styleBibles.find((v) => v.status === 'approved')!; (sb.rules as { design: { colors: { background: { hex: string } } } }).design.colors.background.hex = '#FFEEDD'; });
    const file = await render.slideFile(project.id, c.carousel.id, 2, null);
    expect(file).not.toContain(r.render.files[1]!.key);
    expect(await at()).not.toBe(before);
  });
});

describe('chat in the carousel context', () => {
  it('„Slide 2 kürzer“ and „mach daraus 4 Slides“ → proposals; applying one = a new version; a stale one is refused', async () => {
    const svc = await import('@/server/services/carousels');
    const chat = await import('@/server/services/chat');
    const { read } = await import('@/server/store');
    const { project, concept } = await setup();
    const c = await svc.createCarousel(project.id, { source: { kind: 'note', text: 'Mein Kopf war morgens schon voll, bevor ich überhaupt wach war. Jetzt lege ich die Wolle am Abend bereit. Das Handy bleibt im Flur. Eine Reihe zählt schon.' } });
    void concept;
    const thread = await chat.createThread({ scope: `carousel:${c.carousel.id}` });
    expect(thread.projectId).toBe(project.id);
    const { assistant } = await chat.sendMessage(thread.id, { text: 'Slide 2 kürzer und mach daraus 4 Slides' });
    expect(assistant.mock).toBe(true);
    expect(assistant.proposals.map((p) => p.kind)).toEqual(['carousel', 'carousel']);
    const [shorter, four] = assistant.proposals;
    expect(shorter!.changes[0]!.label).toBe('Slide 2 · Text');
    expect(four!.changes[0]).toMatchObject({ label: 'Anzahl Slides', before: '5', after: '4' });
    const applied = await chat.applyProposal(shorter!.id);
    expect(applied.kind).toBe('carousel');
    const after = await svc.getCarousel(project.id, c.carousel.id);
    expect(after.version).toMatchObject({ version: 2, origin: 'chat' });
    expect(after.version.body.slides[1]!.body).toBe(shorter!.changes[0]!.after);
    // the second card was made on version 1 → stale now
    await expect(chat.applyProposal(four!.id)).rejects.toMatchObject({ status: 409, code: 'stale_base' });
    // deleting the carousel removes its chat history
    await svc.deleteCarouselRecord(project.id, c.carousel.id);
    expect(await read((db) => db.chatThreads.some((t) => t.id === thread.id))).toBe(false);
  });
});
