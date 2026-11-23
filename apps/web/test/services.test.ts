import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { styleBibleToMarkdown } from '@studio/core';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-test-'));
  process.env.STUDIO_DATA_DIR = dir;
  process.env.AI_PROVIDER = 'mock';
  await seedApprovedStrategy();
  delete process.env.STUDIO_ACCESS_TOKEN;
});
afterAll(() => rm(dir, { recursive: true, force: true }));

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('auth', () => {
  it('allows only loopback without token, requires token otherwise', async () => {
    const { checkAccess, tokenDigest, checkJobToken } = await import('@/server/auth');
    expect(checkAccess({ host: '127.0.0.1:3000', cookie: undefined, authorization: null }).ok).toBe(true);
    expect(checkAccess({ host: 'studio.example.com', cookie: undefined, authorization: null }).ok).toBe(false);
    process.env.STUDIO_ACCESS_TOKEN = 'secret-token';
    expect(checkAccess({ host: '127.0.0.1', cookie: undefined, authorization: null }).ok).toBe(false);
    expect(checkAccess({ host: '127.0.0.1', cookie: tokenDigest('secret-token'), authorization: null }).ok).toBe(true);
    expect(checkAccess({ host: 'x', cookie: undefined, authorization: 'Bearer secret-token' }).ok).toBe(true);
    delete process.env.STUDIO_ACCESS_TOKEN;
    expect(checkJobToken('Bearer x')).toMatchObject({ ok: false, status: 503 });
    process.env.STUDIO_JOB_TOKEN = 'job';
    expect(checkJobToken('Bearer job').ok).toBe(true);
    expect(checkJobToken('Bearer nope')).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects cross-site writes (CSRF) but allows same-origin and non-browser clients', async () => {
    const { checkSameOrigin } = await import('@/server/auth');
    const host = '127.0.0.1:3000';
    expect(checkSameOrigin({ method: 'POST', host, origin: 'https://evil.example', secFetchSite: 'cross-site' })).toBe(false);
    expect(checkSameOrigin({ method: 'POST', host, origin: 'https://evil.example', secFetchSite: null })).toBe(false);
    expect(checkSameOrigin({ method: 'POST', host, origin: 'null', secFetchSite: null })).toBe(false);
    expect(checkSameOrigin({ method: 'POST', host, origin: null, secFetchSite: 'same-site' })).toBe(false);
    expect(checkSameOrigin({ method: 'POST', host, origin: 'http://127.0.0.1:3000', secFetchSite: 'same-origin' })).toBe(true);
    expect(checkSameOrigin({ method: 'POST', host, origin: null, secFetchSite: null })).toBe(true);
    expect(checkSameOrigin({ method: 'GET', host, origin: 'https://evil.example', secFetchSite: 'cross-site' })).toBe(true);
  });
});

describe('media validation', () => {
  it('sniffs magic bytes and rejects spoofed types', async () => {
    const { sniffMime, safeFileName, absolutePath } = await import('@/server/media');
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from('<html>hi</html>'))).toBeNull();
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);
    expect(sniffMime(ftyp('isom'))).toBe('video/mp4');
    expect(sniffMime(ftyp('qt  '))).toBe('video/quicktime');
    expect(sniffMime(ftyp('heic'))).toBeNull(); // iPhone photo, not a video
    expect(sniffMime(ftyp('M4A '))).toBeNull(); // audio
    const ftypWith = (major: string, compat: string[]) => {
      const body = Buffer.concat([Buffer.from(`ftyp${major}`), Buffer.alloc(4), ...compat.map((c) => Buffer.from(c))]);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(body.length + 4);
      return Buffer.concat([size, body, Buffer.alloc(16)]);
    };
    expect(sniffMime(ftypWith('M4A ', ['mp42', 'isom']))).toBeNull(); // audio listing mp4 brands
    expect(sniffMime(ftypWith('XAVC', ['mp42', 'iso6']))).toBe('video/mp4'); // camera MP4, unlisted major brand
    expect(sniffMime(ftypWith('heic', ['mif1', 'heic']))).toBeNull();
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(() => absolutePath('../outside.txt')).toThrow(/Speicherpfad/);
    const { createReference } = await import('@/server/services/references');
    await expect(createReference(new File([Buffer.from('<script>')], 'x.png', { type: 'image/png' }), null)).rejects.toThrow(/nicht unterstützt/);
  });
});

describe('end-to-end service flow (mock provider)', () => {
  it('reference → review gate → style bible → concepts → script versions → publication lineage', async () => {
    const refs = await import('@/server/services/references');
    const style = await import('@/server/services/style');
    const content = await import('@/server/services/content');
    const analytics = await import('@/server/services/analytics');
    const projects = await import('@/server/services/projects');

    const { reference, duplicate } = await refs.createReference(new File([PNG], 'poster.png', { type: 'image/png' }), JSON.stringify(['#e0a040', 'bad', '#202020']));
    expect(duplicate).toBe(false);
    expect(reference.palette).toEqual(['#E0A040', '#202020']);
    expect((await refs.createReference(new File([PNG], 'again.png', { type: 'image/png' }), null)).duplicate).toBe(true);
    await refs.updateReference(reference.id, { likes: ['warme Schatten'], dislikes: ['Neon'], ratings: { color: 5 } });
    await expect(refs.updateReference(reference.id, { ratings: { color: 9 } })).rejects.toThrow();

    const analysis = await refs.analyzeReference(reference.id);
    expect(analysis.mock).toBe(true);
    expect(analysis.observations.every((o) => o.decision === 'pending')).toBe(true);

    // Pending observations must not reach the Style Bible.
    const v1 = await style.createStyleVersion({ name: 'Curious Editorial', traits: 'grafisch' });
    expect(v1.rules.approvedObservationIds).toEqual([]);
    const placeholder = analysis.observations.find((o) => o.statement.startsWith('[MOCK]'))!;
    const color = analysis.observations.find((o) => o.dimension === 'color')!;
    await refs.reviewObservation(color.id, { decision: 'approved', feedback: 'passt' });
    await refs.reviewObservation(placeholder.id, { decision: 'rejected', feedback: 'Platzhalter' });
    const v2 = await style.createStyleVersion({ name: 'Curious Editorial', traits: 'grafisch' });
    expect(v2.version).toBe(2);
    expect(v2.rules.approvedObservationIds).toEqual([color.id]);
    expect(v2.rules.visual.avoid).toContain('Neon');
    expect(styleBibleToMarkdown(v2, null)).toContain('Style Bible v2');
    await style.approveVersion('style', v2.id);
    const voice = await style.createVoiceVersion({ traits: 'neugierig, direkt', avoid: 'Clickbait', example: 'Ich probier das einfach mal.' });
    await style.approveVersion('style', v1.id);
    const st = await style.getStyleState();
    expect(st.versions.find((v) => v.id === v2.id)!.status).toBe('archived');
    expect(st.current!.id).toBe(v1.id);

    const [project] = await projects.listProjects();
    const gen = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project!.id, topic: 'Strickmaschine', verifiedFacts: ['Die Maschine hat 200 Nadeln'], format: 'product_demo', lengthSeconds: 15 });
    expect(gen.concepts).toHaveLength(3);
    expect(gen.concepts[0]!.styleBibleVersionId).toBe(v1.id);
    expect(gen.concepts[0]!.voiceGuideVersionId).toBe(voice.id);

    await passFit(gen.concepts[1]!.id);
    const s1 = await content.selectConceptAndWrite(gen.concepts[1]!.id);
    expect(s1.version).toBe(1);
    expect(s1.body.scenes.at(-1)!.endSecond).toBe(15);
    const edited = { ...s1.body, verifiedClaims: [...s1.body.verifiedClaims, 'Macht dich 10x schneller'], cta: 'Neuer CTA' };
    const s2 = await content.saveScriptEdit(s1.id, edited);
    expect(s2.version).toBe(2);
    expect(s2.parentId).toBe(s1.id);
    expect(s2.body.claimsToVerify).toContain('Macht dich 10x schneller');
    // Etappe 10, personal project: open claims are only a hint, approval is one click without a checkbox
    // (client projects keep both gates: see „UGC client claims …“ below)
    expect((await content.setScriptStatus(s2.id, 'approved')).status).toBe('approved');
    // Review finding: a flagged claim that still stands in the dialogue cannot be "removed" from the list.
    const inDialogue = structuredClone(s2.body);
    inDialogue.scenes[0]!.dialogue += ' Macht dich 10x schneller!';
    const s2b = await content.saveScriptEdit(s2.id, inDialogue);
    const s2c = await content.saveScriptEdit(s2b.id, { ...s2b.body, claimsToVerify: [] });
    expect(s2c.body.claimsToVerify).toContain('Macht dich 10x schneller');
    const s3 = await content.saveScriptEdit(s2c.id, { ...s2c.body, scenes: s2c.body.scenes.map((sc, i) => (i === 0 ? { ...sc, dialogue: sc.dialogue.replace(' Macht dich 10x schneller!', '') } : sc)), claimsToVerify: [] });
    expect(s3.body.claimsToVerify).toEqual([]);
    const approved = await content.setScriptStatus(s3.id, 'approved');
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeTruthy();
    // Invalid timing → 400 with message, not 500.
    const badTiming = structuredClone(s3.body);
    badTiming.scenes[0]!.endSecond = badTiming.scenes[0]!.startSecond;
    await expect(content.saveScriptEdit(s3.id, badTiming)).rejects.toMatchObject({ status: 400 });
    await expect(content.saveScriptEdit(s3.id, { ...s3.body, scenes: [] })).rejects.toThrow();

    const pub = await analytics.createPublication({ projectId: project!.id, title: 'Reel 1', publishedAt: '2026-11-14', scriptVersionId: s3.id });
    expect(pub.conceptId).toBe(gen.concepts[1]!.id);
    expect(pub.styleBibleVersionId).toBe(v1.id);
    expect(pub.hook).toBe(s3.body.selectedHook);
    const snap = await analytics.addSnapshot({ publicationId: pub.id, window: '7d', metrics: { reach: 1000, views: 1500, saves: 30, shares: 20 } });
    expect(snap.rates.savesSharesPerReachPct).toBe(5);
    const a = await analytics.getAnalytics();
    expect(a.publications[0]!.lineage).toMatchObject({ concept: gen.concepts[1]!.body.title, scriptVersion: 5, styleVersion: 'Curious Editorial v1' });
    expect(a.insight!.sampleSize).toBe(1);

    // The growth hypothesis is passed to ideation but style rules are untouched.
    const gen2 = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project!.id, topic: 'Wolle' });
    expect(gen2.context.growthHypothesis).toMatch(/Experiment-Hypothese/);
    expect((await style.getStyleState()).current!.rules).toEqual(v1.rules);

    // Cascade deletes
    await refs.deleteReference(reference.id);
    expect((await refs.listReferences()).length).toBe(0);
    await projects.deleteProject(project!.id);
    expect((await analytics.getAnalytics()).publications.length).toBe(0);
    const db = JSON.parse(await readFile(path.join(dir, 'db.json'), 'utf8'));
    expect(db.agentRuns.length).toBeGreaterThanOrEqual(4);
    expect(db.agentRuns.every((r: { provider: string }) => r.provider === 'mock')).toBe(true);
  });

  it('UGC client claims are allowed as verified claims', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const p = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'K', product: 'Serum', productClaims: ['Vegan zertifiziert'] } });
    const gen = await content.generateConcepts({ pillarId: 'werkstatt', projectId: p.id, topic: 'Serum' });
    expect(gen.warnings.join(' ')).not.toMatch(/ohne verifizierte Fakten/);
    await passFit(gen.concepts[0]!.id);
    const s = await content.selectConceptAndWrite(gen.concepts[0]!.id);
    expect(s.body.verifiedClaims).toEqual(['Vegan zertifiziert']);
    // client work keeps the claim gate: open claims, a flagged claim still in the text, and the explicit confirmation
    const claimed = await content.saveScriptEdit(s.id, { ...s.body, verifiedClaims: [...s.body.verifiedClaims, 'Macht dich 10x schöner'] });
    expect(claimed.body.claimsToVerify).toContain('Macht dich 10x schöner');
    await expect(content.setScriptStatus(claimed.id, 'approved', { claimsReviewed: true })).rejects.toThrow(/ungeprüfte Claims/);
    const inText = structuredClone(claimed.body);
    inText.scenes[0]!.dialogue += ' Macht dich 10x schöner!';
    const still = await content.saveScriptEdit(claimed.id, { ...inText, claimsToVerify: [] });
    await expect(content.setScriptStatus(still.id, 'approved', { claimsReviewed: true })).rejects.toThrow(/Ungeprüfte Claims stehen noch im Text/);
    const clean = await content.saveScriptEdit(still.id, { ...still.body, scenes: still.body.scenes.map((sc, i) => (i === 0 ? { ...sc, dialogue: sc.dialogue.replace(' Macht dich 10x schöner!', '') } : sc)), claimsToVerify: [] });
    await expect(content.setScriptStatus(clean.id, 'approved')).rejects.toThrow(/Bestätigung fehlt/);
    expect((await content.setScriptStatus(clean.id, 'approved', { claimsReviewed: true })).status).toBe('approved');
    // Review finding: a partial PATCH must not wipe description or client brief.
    await projects.updateProject(p.id, { description: 'Herbstkampagne' });
    const renamed = await projects.updateProject(p.id, { title: 'Kunde (neu)' });
    expect(renamed.description).toBe('Herbstkampagne');
    expect(renamed.client?.productClaims).toEqual(['Vegan zertifiziert']);
    const merged = await projects.updateProject(p.id, { client: { briefing: 'Neu' } });
    expect(merged.client).toMatchObject({ briefing: 'Neu', product: 'Serum', productClaims: ['Vegan zertifiziert'] });
  });

  it('jobs are idempotent', async () => {
    const { runJob } = await import('@/server/services/jobs');
    let calls = 0;
    const fn = async () => ({ n: ++calls });
    const a = await runJob('wf', 'key-12345678', {}, fn);
    const b = await runJob('wf', 'key-12345678', {}, fn);
    expect(calls).toBe(1);
    expect(b.replayed).toBe(true);
    expect(b.job.result).toEqual(a.job.result);
    // Review finding: concurrent calls with the same key must run the agent only once.
    let slow = 0;
    const slowFn = async () => { slow++; await new Promise((r) => setTimeout(r, 30)); return { ok: true }; };
    const results = await Promise.allSettled([runJob('wf', 'key-concurrent', {}, slowFn), runJob('wf', 'key-concurrent', {}, slowFn)]);
    expect(slow).toBe(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(runJob('other', 'key-12345678', {}, fn)).rejects.toThrow(/anderen Workflow/);
  });
});

describe('ffmpeg keyframes (real binary)', () => {
  it('extracts keyframes from a generated test video and analyses it', async () => {
    const { ffmpegPath, extractKeyframes } = await import('@/server/ffmpeg');
    const bin = await ffmpegPath();
    expect(bin).toBeTruthy();
    const video = path.join(dir, 'clip.mp4');
    await promisify(execFile)(bin!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-y', video]);
    const frames = await extractKeyframes(video, 4);
    expect(frames).toHaveLength(4);
    expect(frames[0]!.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const refs = await import('@/server/services/references');
    const { reference } = await refs.createReference(new File([await readFile(video)], 'clip.mp4', { type: 'video/mp4' }), null);
    expect(reference.kind).toBe('video');
    const res = await refs.analyzeReference(reference.id);
    expect(res.analysis.keyframeIds).toHaveLength(6);
    expect(res.observations.some((o) => o.dimension === 'motion' && o.statement.includes('6 Keyframes'))).toBe(true);
  });
});
