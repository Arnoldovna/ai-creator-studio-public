import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Etappe 19: stories through the services – Story Writer (mock, sources, estimate without a run, personal projects only),
 * media checked against the store (rights, project, length), revisions, the real render (PNG and MP4 through FFmpeg +
 * libass: safe zones free of text, the AI label inside the safe zone, no font fallback, clip length and sound), the ZIP
 * (files, sticker notes, labelling note; refused with an error) and deletion (board link nulled, project cascade).
 */
const run = promisify(execFile);
let dir: string;
let ff: string | null = null;
let libass = false;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-stories-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', STUDIO_DEFAULTS_DIR: 'off', VIDEO_WORKER_CONCURRENCY: '1', STUDIO_AUTO_PREPARE: 'off' });
  const f = await import('@/server/ffmpeg');
  ff = await f.ffmpegPath();
  libass = (await f.ffmpegStatus()).subtitles;
});
afterAll(async () => {
  delete process.env.VIDEO_WORKER_CONCURRENCY;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const BG = '#F6F3EC', PRIMARY = '#2E4A3B', ACCENT = '#E8B04A', SURFACE = '#1F2617', IMG = '#2050F0';

async function brand() {
  const core = await import('@studio/core');
  const { write, now } = await import('@/server/store');
  const o = { source: 'manual' as const };
  const col = (hex: string) => ({ hex, origin: o });
  const design = core.DesignSystem.parse({
    colors: { primary: col(PRIMARY), accent: col(ACCENT), surface: col(SURFACE), onSurface: col('#FFFFFF'), onAccent: col('#111111'), onVideo: col('#FFFFFF'), background: col(BG) },
    typography: core.defaultTypography(), presets: [core.defaultPreset()], defaultPresetId: 'marke',
  });
  await write((db) => {
    for (const v of db.styleBibles) v.status = 'archived';
    const n = db.styleBibles.length + 1;
    db.styleBibles.push({ id: `sb-19-${n}`, profileId: 'profile-personal', version: n, status: 'approved', createdAt: now(), approvedAt: now(), rules: { name: 'Marke', visual: { palette: [ACCENT, PRIMARY], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [], design } as never });
  });
}

async function setup() {
  const projects = await import('@/server/services/projects');
  const content = await import('@/server/services/content');
  const project = await projects.createProject({ title: 'Morgenstricken', kind: 'PERSONAL_CONTENT' });
  const { concepts } = await content.generateConcepts({ projectId: project.id, topic: 'Morgenstricken', verifiedFacts: ['Ich stricke seit 3 Jahren jeden Morgen.'] });
  return { project, concept: concepts[0]! };
}

/** A finished reel of the project: a real 6 s MP4 (test picture + tone), as a render record. */
async function reel(projectId: string, opts: { ai?: boolean } = {}) {
  const { write, now, newId } = await import('@/server/store');
  const media = await import('@/server/media');
  const id = newId();
  const rel = `renders/${projectId}/${id}.mp4`;
  const abs = media.absolutePath(rel);
  await (await import('node:fs/promises')).mkdir(path.dirname(abs), { recursive: true });
  await run(ff!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', abs]);
  await write((db) => {
    db.renders.push({ id, projectId, editPlanId: 'none', jobId: 'j', status: 'pending_review', storagePath: rel, size: 1, sha256: id, durationSec: 6, loudness: null, disclosures: opts.ai ? ['KI-generierte Bildelemente'] : [], error: null, reviewNote: '', createdAt: now(), finishedAt: now(), reviewedAt: null });
  });
  return id;
}

async function image(origin: 'own' | 'generated' | null, color = IMG) {
  const refs = await import('@/server/services/references');
  const png = path.join(dir, `img-${color.slice(1)}-${origin}.png`);
  await run(ff!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${color.slice(1)}:s=600x400`, '-frames:v', '1', '-y', png]);
  const { reference } = await refs.createReference(new File([await readFile(png)], `foto-${origin}.png`, { type: 'image/png' }), null);
  if (origin) await refs.updateReference(reference.id, { usage: { origin, source: '' } });
  return reference.id;
}

const counts = async () => {
  const { read } = await import('@/server/store');
  return read((db) => ({ runs: db.agentRuns.filter((r) => r.useCase === 'story_writing').length, stories: db.stories.length }));
};

describe('stories: writer, sources, media checks, revisions', () => {
  it('estimate runs nothing; a concept becomes 4 stories of one batch (mock, logged run, lineage); client projects 409', async () => {
    const svc = await import('@/server/services/stories');
    await brand();
    const { project, concept } = await setup();
    const before = await counts();
    const est = await svc.estimateStories(project.id, { source: { kind: 'concept', id: concept.id } });
    expect(est.estimate).toMatchObject({ mode: 'mock', estCostUsd: 0 });
    expect(await counts()).toEqual(before);
    const r = await svc.createStories(project.id, { source: { kind: 'concept', id: concept.id } });
    expect(r.mock).toBe(true);
    expect(r.ids).toHaveLength(4);
    expect(await counts()).toEqual({ runs: before.runs + 1, stories: before.stories + 4 });
    expect(new Set(r.stories.map((s) => s.batchId)).size).toBe(1);
    expect(r.stories.map((s) => s.kind)).toEqual(['teaser', 'question', 'quote', 'progress']);
    expect(r.notes).toContain('[MOCK]');
    const one = await svc.getStory(project.id, r.ids[0]!);
    expect(one.story).toMatchObject({ origin: 'agent', mock: true, revision: 1, styleBibleVersionId: expect.stringMatching(/^sb-19-/) });
    expect(one.story.body.kicker).toBe('Bald auf dem Kanal');
    const projects = await import('@/server/services/projects');
    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Garn GmbH' } });
    await expect(svc.createStories(client.id, { source: { kind: 'note', text: 'Eine Notiz für den Kunden.' } })).rejects.toMatchObject({ status: 409 });
    await expect(svc.createManualStory(client.id, {})).rejects.toMatchObject({ status: 409 });
    expect((await svc.listStories(client.id)).available).toBe(false);
  });

  it('a carousel becomes a teaser with its first slide as card; only her usable material is offered', async () => {
    if (!ff) return;
    const svc = await import('@/server/services/stories');
    const carousels = await import('@/server/services/carousels');
    const { project } = await setup();
    const c = await carousels.createCarousel(project.id, { source: { kind: 'note', text: 'Mein Morgen mit Wolle. Eine Reihe zählt schon. Das Handy bleibt im Flur.' } });
    const own = await image('own', '#30A050');
    const noRights = await image(null, '#A03050');
    const r = await svc.createStories(project.id, { source: { kind: 'carousel', id: c.carousel.id }, count: 5 });
    const teaser = await svc.getStory(project.id, r.ids[0]!);
    expect(teaser.story.body).toMatchObject({ kind: 'teaser', kicker: 'Neues Karussell', fit: 'card', media: { kind: 'carousel_slide', carouselId: c.carousel.id, n: 1 } });
    expect(teaser.media).toMatchObject({ problem: null, ai: false, aspect: 0.8 });
    const keys = teaser.options.map((o) => o.key);
    expect(keys).toContain(`ref:${own}`);
    expect(keys).not.toContain(`ref:${noRights}`); // no rights given → never offered
    const bts = await svc.getStory(project.id, r.ids[3]!);
    expect(bts.story.body.media).toEqual({ kind: 'image', imageId: own });
    // media of another project or without rights are problems (checked against the store, also on save)
    const other = await (await import('@/server/services/projects')).createProject({ title: 'Anderes', kind: 'PERSONAL_CONTENT' });
    const foreignReel = await reel(other.id);
    const body = structuredClone(teaser.story.body);
    const saved = await svc.saveStory(project.id, teaser.story.id, { baseRevision: 1, body: { ...body, media: { kind: 'frame', renderId: foreignReel, atSec: 1 }, fit: 'full' } });
    expect(saved.story.revision).toBe(2);
    expect(saved.review.issues.find((i) => i.level === 'error')?.message).toMatch(/gibt es in diesem Projekt nicht/);
    const noR = await svc.saveStory(project.id, teaser.story.id, { baseRevision: 2, body: { ...body, media: { kind: 'image', imageId: noRights } } });
    expect(noR.review.errors).toBeGreaterThan(0);
    await expect(svc.saveStory(project.id, teaser.story.id, { baseRevision: 2, body })).rejects.toMatchObject({ status: 409, code: 'stale_revision' });
    // a clip longer than 15 s never passes the schema
    await expect(svc.saveStory(project.id, teaser.story.id, { baseRevision: 3, body: { ...body, media: { kind: 'clip', source: 'render', id: foreignReel, startSec: 0, durationSec: 16 } } })).rejects.toThrow();
  });
});

async function pixels(file: string, seek = file.endsWith('.mp4') ? ['-ss', '0.5'] : []) {
  const { stdout: probe } = await run((await import('@/server/ffmpeg').then((m) => m.ffprobePath()))!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  const [w, h] = probe.trim().split(',').map(Number) as [number, number];
  const { stdout } = await run(ff!, ['-hide_banner', '-loglevel', 'error', ...seek, '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const buf = stdout as unknown as Buffer;
  return { w, h, at: (x: number, y: number) => [buf[(y * w + x) * 3]!, buf[(y * w + x) * 3 + 1]!, buf[(y * w + x) * 3 + 2]!] as const };
}
const near = (p: readonly number[], hex: string, tol = 40) => [1, 3, 5].every((i, k) => Math.abs(p[k]! - parseInt(hex.slice(i, i + 2), 16)) <= tol);

describe('real story render (FFmpeg + libass) and export', () => {
  it('PNG: covered areas stay free of text, the AI label sits in the safe zone, no font fallback; MP4 clip ≤ 15 s with sound; ZIP', async () => {
    if (!ff || !libass) return console.log('[libass] FFmpeg ohne libass – übersprungen');
    const core = await import('@studio/core');
    const svc = await import('@/server/services/stories');
    const render = await import('@/server/services/storyRender');
    await brand();
    const { project } = await setup();
    const ai = await image('generated', IMG);
    const reelId = await reel(project.id);

    // 1) text only (quote, long text at the bottom): top and bottom bands are pure background
    const quote = await svc.createManualStory(project.id, { kind: 'quote' });
    const qBody = { ...quote.story.body, textPos: 'bottom' as const, kicker: 'Notiz an mich', title: 'Eine Reihe am Morgen ist besser als keine – auch wenn der Tag laut wird.', body: 'Das nehme ich mit in die Woche.' };
    const q = await svc.saveStory(project.id, quote.story.id, { baseRevision: 1, body: qBody });
    expect(q.review.errors).toBe(0);
    expect(core.insideSafeZone(core.layoutIgStory(q.story.body, q.look, q.media))).toBe(true);
    const r1 = await render.renderStory(project.id, quote.story.id);
    console.log(`[libass] Story (Zitat): warnings ${JSON.stringify(r1.render.warnings)}`);
    expect(r1.render.warnings).toEqual([]);
    expect(r1.render.mime).toBe('image/png');
    const p1 = await pixels(path.join(dir, r1.render.storagePath));
    expect([p1.w, p1.h]).toEqual([1080, 1920]);
    for (let y = 0; y < core.IG_STORY_SAFE.top; y += 4) for (let x = 0; x < 1080; x += 9) expect(near(p1.at(x, y), BG, 12), `top ${x},${y}: ${p1.at(x, y).join(',')}`).toBe(true);
    for (let y = 1920 - core.IG_STORY_SAFE.bottom; y < 1920; y += 4) for (let x = 0; x < 1080; x += 9) expect(near(p1.at(x, y), BG, 12), `bottom ${x},${y}`).toBe(true);
    let text = 0;
    for (let y = core.IG_STORY_SAFE.top; y < 1920 - core.IG_STORY_SAFE.bottom; y += 3) for (let x = 60; x < 1020; x += 3) if (!near(p1.at(x, y), BG, 30)) text++;
    expect(text).toBeGreaterThan(200); // the text is drawn (inside the safe zone)

    // 2) a generated photo full bleed: the label (black box, white text) inside the safe zone; the photo covers the canvas
    const bts = await svc.createManualStory(project.id, { kind: 'bts', media: { kind: 'image', imageId: ai } });
    const b2 = await svc.saveStory(project.id, bts.story.id, { baseRevision: 1, body: { ...bts.story.body, kicker: 'Hinter den Kulissen', title: 'Atelier am Morgen' } });
    expect(b2.review.ai).toBe(true);
    const layout = core.layoutIgStory(b2.story.body, b2.look, b2.media);
    const label = layout.elements.find((e) => e.type === 'label')!;
    expect(label.box.y0).toBeGreaterThanOrEqual(core.IG_STORY_SAFE.top);
    const r2 = await render.renderStory(project.id, bts.story.id);
    expect(r2.render.warnings).toEqual([]);
    const p2 = await pixels(path.join(dir, r2.render.storagePath));
    expect(near(p2.at(540, 100), IMG)).toBe(true); // the photo runs into the covered area (media may)
    expect(near(p2.at(540, 1880), IMG)).toBe(true);
    expect(near(p2.at(label.box.x0 + 3, label.box.y0 + 3), '#000000', 30)).toBe(true);
    let white = 0;
    for (let y = label.box.y0; y < label.box.y1; y += 2) for (let x = label.box.x0; x < label.box.x1; x += 2) if (near(p2.at(x, y), '#FFFFFF', 40)) white++;
    expect(white).toBeGreaterThan(20);
    const pill = layout.elements.find((e) => e.type === 'rect' && e.layer === 'over')!;
    expect(near(p2.at(pill.box.x0 + 4, pill.box.y0 + 4), SURFACE, 30)).toBe(true); // text box in her surface colour

    // 3) a clip of the reel: 1080×1920 MP4, 3 s, with sound
    const clip = await svc.createManualStory(project.id, { kind: 'teaser', media: { kind: 'clip', source: 'render', id: reelId, startSec: 1, durationSec: 3 } });
    await svc.saveStory(project.id, clip.story.id, { baseRevision: 1, body: { ...clip.story.body, kicker: 'Neues Reel', title: 'Mein Morgen mit Wolle' } });
    const r3 = await render.renderStory(project.id, clip.story.id);
    expect(r3.render.mime).toBe('video/mp4');
    const probe = path.join(dir, r3.render.storagePath);
    const { stdout: streams } = await run((await import('@/server/ffmpeg').then((m) => m.ffprobePath()))!, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', probe]);
    const info = JSON.parse(streams) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
    expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920 });
    expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
    expect(Number(info.format.duration)).toBeGreaterThan(2.8);
    expect(Number(info.format.duration)).toBeLessThanOrEqual(3.2);
    // content-addressed: an unchanged story is served without drawing again
    const again = await render.storyFile(project.id, clip.story.id);
    expect(again.abs).toBe(probe);

    // 4) ZIP in her order: 01.png, 02.png, 03.mp4, notes (sticker), labelling note
    const withSticker = await svc.getStory(project.id, quote.story.id);
    await svc.saveStory(project.id, quote.story.id, { baseRevision: withSticker.story.revision, body: { ...withSticker.story.body, sticker: { kind: 'poll', prompt: 'Strickst du morgens?', options: ['Ja', 'Nein'] } } });
    const pkg = await render.storiesPackage(project.id, [quote.story.id, bts.story.id, clip.story.id]);
    expect(pkg.entries.map((e) => e.name)).toEqual(['01.png', '02.png', '03.mp4', 'notizen.txt', 'KENNZEICHNUNG.txt']);
    const notes = pkg.entries.find((e) => e.name === 'notizen.txt') as { data: string };
    expect(notes.data).toContain('Umfrage in Instagram setzen – Text: „Strickst du morgens?“ – Antworten: Ja / Nein');
    expect(notes.data).toContain('das Studio postet nichts');
    expect((pkg.entries.find((e) => e.name === 'KENNZEICHNUNG.txt') as { data: string }).data).toContain('02.png');
    const { prepareZip, zipStream } = await import('@/server/zip');
    const chunks: Uint8Array[] = [];
    for await (const ch of zipStream(await prepareZip(pkg.entries))) chunks.push(ch);
    const zip = path.join(dir, 'stories.zip');
    await (await import('node:fs/promises')).writeFile(zip, Buffer.concat(chunks));
    await run('unzip', ['-tq', zip]);
    // an overflow blocks the export
    const long = await svc.createManualStory(project.id, { kind: 'quote' });
    await svc.saveStory(project.id, long.story.id, { baseRevision: 1, body: { ...long.story.body, title: 'Donaudampfschifffahrtsgesellschaftskapitänsmützenband' } });
    await expect(render.storiesPackage(project.id, [long.story.id])).rejects.toMatchObject({ status: 409, code: 'story_problems' });
  });
});

describe('stories: deletion', () => {
  it('deleting a story nulls its board link; deleting the project removes stories and their files', async () => {
    const svc = await import('@/server/services/stories');
    const board = await import('@/server/services/board');
    const { read } = await import('@/server/store');
    const { project } = await setup();
    const s = await svc.createManualStory(project.id, { kind: 'progress', title: 'Fortschritt' });
    const item = await board.createItem({ date: '2026-11-20', ref: { kind: 'story', id: s.story.id } });
    expect(item).toMatchObject({ kind: 'story', slot: 'story', title: 'Fortschritt', status: 'in_progress' });
    await svc.deleteStoryRecord(project.id, s.story.id);
    expect(await read((db) => db.boardItems.find((b) => b.id === item.id)?.ref)).toBeNull();
    const s2 = await svc.createManualStory(project.id, { kind: 'bts' });
    await (await import('@/server/services/projects')).deleteProject(project.id);
    expect(await read((db) => db.stories.some((x) => x.id === s2.story.id))).toBe(false);
    expect(await read((db) => db.boardItems.find((b) => b.id === item.id))).toMatchObject({ projectId: null, ref: null });
  });
});
