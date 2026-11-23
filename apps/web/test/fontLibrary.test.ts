import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Etappe 16b: the font library through the services – installed Mac fonts (fake fc-list + a real run), the Google Fonts
 * catalogue and „Hinzufügen“ against a local fake server (licence note, checksum, host check, offline), the exact specimen
 * with a non-standard Mac font and a Google font through real libass (no fallback, no warning), and word-by-word subtitles
 * in a still frame of the draft (pixel sampling: the spoken word is in the accent at the right moment).
 */
const run = promisify(execFile);
const FIX = path.join(__dirname, 'fixtures', 'fonts');
const CORE_FIX = path.join(__dirname, '..', '..', '..', 'packages', 'core', 'test', 'fixtures');
let dir: string;
let server: Server;
let base = '';
const g = globalThis as unknown as { __studioGoogleCatalog?: unknown };

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-fontlib-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', STUDIO_DEFAULTS_DIR: 'off', VIDEO_WORKER_CONCURRENCY: '1' });
  const bebas = await readFile(path.join(FIX, 'BebasNeue-Regular.ttf'));
  const meta = await readFile(path.join(CORE_FIX, 'google-metadata.json'), 'utf8');
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, type: string, body: string | Buffer) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    if (u.pathname === '/metadata/fonts') return send(200, 'application/json', meta);
    if (u.pathname === '/css2') {
      const family = (u.searchParams.get('family') ?? '').split(':')[0];
      const face = (url: string, weight = 400) => `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n  src: url(${url}) format('truetype');\n}\n`;
      if (family === 'Bebas Neue') return send(200, 'text/css', face(`${base}/s/bebasneue/v16/bebas.ttf`));
      if (family === 'Anton') return send(200, 'text/css', face('https://evil.example/anton.ttf'));
      if (family === 'Caveat') return send(200, 'text/css', face(`${base}/s/caveat/v1/not-a-font.ttf`, 400) + face(`${base}/s/caveat/v1/not-a-font.ttf`, 700));
      if (family === 'Montserrat') return send(200, 'text/css', face(`${base}/s/bebasneue/v16/bebas.ttf`, 700));
      return send(400, 'text/plain', 'bad family');
    }
    if (u.pathname === '/s/bebasneue/v16/bebas.ttf') return send(200, 'font/ttf', bebas);
    if (u.pathname === '/s/caveat/v1/not-a-font.ttf') return send(200, 'font/ttf', Buffer.from('<html>nope</html>'.padEnd(64, ' ')));
    send(404, 'text/plain', 'nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const k of ['GOOGLE_FONTS_METADATA_URL', 'GOOGLE_FONTS_CSS_URL', 'GOOGLE_FONTS_FILE_HOSTS', 'FC_LIST', 'SYSTEM_PROFILER', 'VIDEO_WORKER_CONCURRENCY']) delete process.env[k];
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const useFake = () => Object.assign(process.env, { GOOGLE_FONTS_METADATA_URL: `${base}/metadata/fonts`, GOOGLE_FONTS_CSS_URL: `${base}/css2`, GOOGLE_FONTS_FILE_HOSTS: new URL(base).host });

describe('installed Mac fonts', () => {
  it('lists the fonts of a fake fc-list; without any source a clear error', async () => {
    const sf = await import('@/server/services/systemFonts');
    const fake = path.join(dir, 'fake-fc-list.sh');
    await writeFile(fake, `#!/bin/sh\ncat '${path.join(CORE_FIX, 'fc-list.txt')}'\n`);
    await chmod(fake, 0o755);
    process.env.FC_LIST = fake;
    sf.resetSystemFontCache();
    const list = await sf.listSystemFonts();
    expect(list.source).toBe('fc-list');
    expect(list.families.map((f) => f.family)).toEqual(['Avenir Next', 'Curly Font', 'Georgia', 'Impact', 'Rockwell']);
    Object.assign(process.env, { FC_LIST: 'off', SYSTEM_PROFILER: 'off' });
    const none = await sf.listSystemFonts({ refresh: true });
    expect(none).toMatchObject({ source: 'none', families: [] });
    expect(none.error).toMatch(/Keine Schriftliste/);
    delete process.env.FC_LIST; delete process.env.SYSTEM_PROFILER;
    sf.resetSystemFontCache();
  });

  it('a real run on this Mac (fc-list or system_profiler) finds more than the studio list, Rockwell among them', async () => {
    const sf = await import('@/server/services/systemFonts');
    const t0 = Date.now();
    const list = await sf.listSystemFonts({ refresh: true });
    console.log(`[fonts] ${list.source}: ${list.families.length} Familien, ${list.families.reduce((n, f) => n + f.faces.length, 0)} Schnitte, ${Date.now() - t0} ms`);
    if (process.platform !== 'darwin') return;
    expect(list.families.length).toBeGreaterThan(50);
    expect(list.families.some((f) => f.family === 'Rockwell' && f.faces.some((x) => x.ref === 'mac:Rockwell-Bold'))).toBe(true);
    // cached: the second call does not run the tool again
    const t1 = Date.now();
    expect(await sf.listSystemFonts()).toBe(list);
    expect(Date.now() - t1).toBeLessThan(50);
  });
});

describe('Google Fonts (local fake server)', () => {
  it('offline without a stored catalogue: 503 with a clear message', async () => {
    const gf = await import('@/server/services/googleFonts');
    Object.assign(process.env, { GOOGLE_FONTS_METADATA_URL: 'http://127.0.0.1:9/metadata/fonts', GOOGLE_FONTS_CSS_URL: 'http://127.0.0.1:9/css2' });
    g.__studioGoogleCatalog = null;
    await expect(gf.searchGoogleCatalog({})).rejects.toMatchObject({ status: 503, message: expect.stringContaining('Keine Verbindung zu Google Fonts') });
  });

  it('searches the catalogue (category, quick pick), keeps a dated copy and uses it when offline', async () => {
    const gf = await import('@/server/services/googleFonts');
    useFake();
    g.__studioGoogleCatalog = null;
    const all = await gf.searchGoogleCatalog({});
    expect(all.stale).toBe(false);
    expect(all.curated.map((f) => f.family)).toEqual(['Montserrat', 'Bebas Neue', 'Anton', 'Playfair Display', 'Caveat', 'Shrikhand']);
    expect((await gf.searchGoogleCatalog({ category: 'handwriting' })).results.map((f) => f.family)).toEqual(['Caveat']);
    expect((await gf.searchGoogleCatalog({ q: 'bebas' })).results.map((f) => f.family)).toEqual(['Bebas Neue']);
    // the dated copy on disk serves when the network is gone
    const disk = JSON.parse(await readFile(path.join(dir, 'cache', 'google-fonts', 'metadata.json'), 'utf8')) as { fetchedAt: string };
    await writeFile(path.join(dir, 'cache', 'google-fonts', 'metadata.json'), JSON.stringify({ ...disk, fetchedAt: '2020-01-01T00:00:00.000Z', text: await readFile(path.join(CORE_FIX, 'google-metadata.json'), 'utf8') }));
    g.__studioGoogleCatalog = null;
    process.env.GOOGLE_FONTS_METADATA_URL = 'http://127.0.0.1:9/metadata/fonts';
    const offline = await gf.searchGoogleCatalog({ q: 'caveat' });
    expect(offline).toMatchObject({ stale: true, fetchedAt: '2020-01-01T00:00:00.000Z' });
    expect(offline.results.map((f) => f.family)).toEqual(['Caveat']);
    useFake();
    g.__studioGoogleCatalog = null;
  });

  it('„Hinzufügen“ downloads the TTF, checks it, stores checksum and the licence note automatically; again = duplicate', async () => {
    const gf = await import('@/server/services/googleFonts');
    useFake();
    const { fonts } = await gf.addGoogleFont({ family: 'Bebas Neue' });
    expect(fonts).toHaveLength(1);
    const f = fonts[0]!.font;
    const bytes = await readFile(path.join(FIX, 'BebasNeue-Regular.ttf'));
    expect(f).toMatchObject({ family: 'Bebas Neue', postscriptName: 'BebasNeue-Regular', assName: 'Bebas Neue Regular', weight: 400, italic: false, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(f.origin).toMatchObject({ kind: 'google', family: 'Bebas Neue', weight: 400, licenseId: 'OFL-1.1', licenseUrl: 'https://openfontlicense.org', url: `${base}/s/bebasneue/v16/bebas.ttf` });
    expect(f.license).toMatch(/^SIL Open Font License 1\.1 \(https:\/\/openfontlicense\.org\) · Google Fonts „Bebas Neue“ \(Stand \d{4}-\d{2}-\d{2}\) · https:\/\/fonts\.google\.com\/specimen\/Bebas\+Neue · Datei /);
    expect(await readFile(path.join(dir, f.storagePath))).toEqual(bytes);
    expect((await gf.addGoogleFont({ family: 'Bebas Neue' })).fonts[0]!.duplicate).toBe(true);
    // in the studio list for type roles and elements
    const { allowedFonts } = await import('@/server/services/fonts');
    const { read } = await import('@/server/store');
    expect(await read((db) => allowedFonts(db).find((x) => x.ref === `custom:${f.id}`)?.label)).toBe('Bebas Neue Regular (Google Fonts)');
    expect((await gf.searchGoogleCatalog({ q: 'bebas' })).added).toEqual([{ id: f.id, family: 'Bebas Neue', weight: 400 }]);
  });

  it('refuses a file from another host, a file that is no font, a file of another family and unknown families', async () => {
    const gf = await import('@/server/services/googleFonts');
    useFake();
    await expect(gf.addGoogleFont({ family: 'Anton' })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('unerwartetem Server') });
    await expect(gf.addGoogleFont({ family: 'Caveat' })).rejects.toMatchObject({ status: 415 });
    await expect(gf.addGoogleFont({ family: 'Montserrat', weights: [700] })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('nicht „Montserrat“') });
    await expect(gf.addGoogleFont({ family: 'Gibt Es Nicht' })).rejects.toMatchObject({ status: 404 });
    await expect(gf.addGoogleFont({ family: "Evil'); x" })).rejects.toThrow();
    const { read } = await import('@/server/store');
    expect(await read((db) => db.fonts.map((x) => x.family))).toEqual(['Bebas Neue']);
  });

  it('the preview file is fetched by the server and cached', async () => {
    const gf = await import('@/server/services/googleFonts');
    useFake();
    const a = await gf.googlePreview('Bebas Neue', '400');
    expect(Buffer.from(a.subarray(0, 4)).toString('hex')).toBe('00010000');
    server.close(); // closed for new connections: the second call comes from the cache
    const b = await gf.googlePreview('Bebas Neue', '400');
    expect(b.length).toBe(a.length);
    await new Promise<void>((r) => server.listen(Number(new URL(base).port), '127.0.0.1', () => r()));
  });

  it.runIf(process.env.FONTS_REAL === '1')('real download from Google Fonts (FONTS_REAL=1): Montserrat Bold, OFL, real libass without fallback', async () => {
    const gf = await import('@/server/services/googleFonts');
    for (const k of ['GOOGLE_FONTS_METADATA_URL', 'GOOGLE_FONTS_CSS_URL', 'GOOGLE_FONTS_FILE_HOSTS']) delete process.env[k];
    g.__studioGoogleCatalog = null;
    await rm(path.join(dir, 'cache', 'google-fonts'), { recursive: true, force: true });
    const cat = await gf.searchGoogleCatalog({ q: 'Montserrat' });
    console.log(`[fonts] Google-Katalog echt: ${cat.total} Familien`);
    const { fonts } = await gf.addGoogleFont({ family: 'Montserrat', weights: [700] });
    expect(fonts[0]!.font).toMatchObject({ family: 'Montserrat', weight: 700, origin: { kind: 'google', licenseId: 'OFL-1.1' } });
    expect(fonts[0]!.font.origin!.url).toMatch(/^https:\/\/fonts\.gstatic\.com\/s\/montserrat\/v\d+\//);
    console.log(`[fonts] ${fonts[0]!.font.assName} · ${fonts[0]!.font.license}`);
    // the real static Google file through real libass: exactly this face, no fallback
    const { ffmpegStatus } = await import('@/server/ffmpeg');
    const ff = await ffmpegStatus();
    if (ff.available && ff.subtitles) {
      const ds = await import('@/server/services/designSystem');
      const design = structuredClone((await ds.getDesignState()).design);
      design.typography.hook = { ...design.typography.hook, font: `custom:${fonts[0]!.font.id}` };
      const spec = await ds.renderSpecimen({ design });
      console.log(`[libass] Montserrat Bold (Google, echt): warnings ${JSON.stringify(spec.warnings)}`);
      expect(spec.warnings).toEqual([]);
    }
    useFake();
    g.__studioGoogleCatalog = null;
  });
});

const ffmpegReady = async () => {
  const { ffmpegStatus } = await import('@/server/ffmpeg');
  const s = await ffmpegStatus();
  return s.available && s.subtitles;
};
const hasRockwell = async () => {
  const sf = await import('@/server/services/systemFonts');
  return (await sf.listSystemFonts()).families.some((f) => f.faces.some((x) => x.ref === 'mac:Rockwell-Bold'));
};

describe('real libass with a Mac font and a Google font', () => {
  it('specimen: hook in Rockwell Bold (installed), keyword in Bebas Neue (Google, fontsdir) – no fallback, no warning; a missing Mac font warns', async () => {
    if (!(await ffmpegReady()) || !(await hasRockwell())) return console.log('[libass] FFmpeg ohne libass oder Rockwell nicht installiert – übersprungen');
    const ds = await import('@/server/services/designSystem');
    const { read } = await import('@/server/store');
    const bebas = await read((db) => db.fonts.find((f) => f.family === 'Bebas Neue')!);
    const state = await ds.getDesignState();
    const design = structuredClone(state.design);
    design.typography.hook = { ...design.typography.hook, font: 'mac:Rockwell-Bold', face: { family: 'Rockwell', style: 'Bold', weight: 700, italic: false } };
    design.typography.keyword = { ...design.typography.keyword, font: `custom:${bebas.id}` };
    const a = await ds.renderSpecimen({ design });
    console.log(`[libass] Rockwell + Bebas: warnings ${JSON.stringify(a.warnings)}`);
    expect(a.warnings).toEqual([]);
    expect((await ds.renderSpecimen({ design })).warnings).toEqual([]); // cached, same check
    // a TrueType Mac face as libass gets it from the picker (English full name): exactly Georgia-Bold, no warning …
    const sf = await import('@/server/services/systemFonts');
    const georgia = (await sf.listSystemFonts()).families.find((f) => f.family === 'Georgia')?.faces.find((x) => x.postscriptName === 'Georgia-Bold');
    if (georgia) {
      expect(georgia.assName).toBe('Georgia Bold');
      design.typography.lowerThird = { ...design.typography.lowerThird, font: 'mac:Georgia-Bold', face: { family: 'Georgia', style: georgia.style, weight: 700, italic: false, assName: georgia.assName } };
      const c = await ds.renderSpecimen({ design });
      expect(c.warnings).toEqual([]);
      // … Gegenprobe (review finding): by its PostScript name alone CoreText/libass does not find it and falls back
      design.typography.lowerThird = { ...design.typography.lowerThird, face: { family: 'Georgia', style: 'Bold', weight: 700, italic: false } };
      const d = await ds.renderSpecimen({ design });
      console.log(`[libass] Georgia-Bold nur per PostScript-Name: ${JSON.stringify(d.warnings)}`);
      expect(d.warnings.join(' ')).toMatch(/Georgia-Bold/);
      design.typography.lowerThird = { ...design.typography.lowerThird, face: { family: 'Georgia', style: 'Bold', weight: 700, italic: false, assName: 'Georgia Bold' } };
    }
    // Gegenprobe: a Mac font that is not installed is reported (libass falls back silently otherwise)
    design.typography.hook = { ...design.typography.hook, font: 'mac:GibtEsNicht-Bold', face: { family: 'Gibt Es Nicht', style: 'Bold', weight: 700, italic: false } };
    const b = await ds.renderSpecimen({ design });
    expect(b.warnings.join(' ')).toMatch(/GibtEsNicht-Bold/);
  });
});

describe('word-by-word subtitles in a still frame of the draft (real FFmpeg + libass)', () => {
  it('the spoken word is drawn in the accent at its moment; the hook has its own Google font and pops', async () => {
    if (!(await ffmpegReady())) return console.log('[libass] FFmpeg ohne libass – übersprungen');
    const ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const drafts = await import('@/server/services/editDraft');
    const preview = await import('@/server/services/editPreview');
    const { write, read, now, newId } = await import('@/server/store');
    const ACCENT = '#E03A1E';
    const project = await projects.createProject({ title: 'Karaoke', kind: 'PERSONAL_CONTENT' });
    const file = path.join(dir, 'take.mp4');
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x30343A:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file]);
    const { asset } = await footage.uploadFootage(project.id, new Blob([await readFile(file)]).stream(), { name: 'take.mp4', origin: 'own' }, null);
    // a transcript with two words (left and right half of the line), white text, accent highlight
    const body = { language: 'de', segments: [{ startSec: 0, endSec: 3, text: 'WOLLE WOLLE', words: [{ startSec: 0.2, endSec: 1.4, text: 'WOLLE' }, { startSec: 1.6, endSec: 2.8, text: 'WOLLE' }] }] };
    const tid = newId();
    const storagePath = `transcripts/${project.id}/${tid}.json`;
    await mkdir(path.join(dir, 'transcripts', project.id), { recursive: true });
    await writeFile(path.join(dir, storagePath), JSON.stringify(body));
    await write((db) => {
      db.transcripts.push({ id: tid, projectId: project.id, assetId: asset.id, version: 99, parentId: null, source: 'user_edit', model: null, language: 'de', storagePath, segmentCount: 1, createdAt: now() });
      const rules = { name: 'Marke', visual: { palette: [ACCENT, '#1E2A8C'], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [] };
      db.styleBibles.forEach((v) => { if (v.status === 'approved') v.status = 'archived'; });
      db.styleBibles.push({ id: 'sb-16b', profileId: 'profile-personal', version: 50, status: 'approved', createdAt: now(), approvedAt: now(), rules: rules as never });
    });
    const bebas = await read((db) => db.fonts.find((f) => f.family === 'Bebas Neue')!);
    const draft = {
      clips: [{ assetId: asset.id, inSec: 0, outSec: 3 }], loudness: 'off', subtitles: 'burn', subtitleMode: 'karaoke', subtitleWords: 2, subtitleY: 0.72,
      hook: { source: 'free', text: 'Socken', endSec: 0.5, anim: 'pop', font: { ref: `custom:${bebas.id}` } },
    };
    const v = await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body: draft });
    expect(v.issues!.errors).toEqual([]);
    const px = async (t: number) => {
      const f = await preview.renderDraftFrame(project.id, { t: String(t), size: 'full' });
      expect(f.fontWarnings).toEqual([]);
      const out = path.join(dir, `f-${t}.png`);
      await writeFile(out, f.png);
      const { stdout } = await run(ff, ['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      const buf = stdout as unknown as Buffer;
      return (x: number, y: number) => [buf[(y * 1080 + x) * 3]!, buf[(y * 1080 + x) * 3 + 1]!, buf[(y * 1080 + x) * 3 + 2]!];
    };
    const near = (p: number[], hex: string, tol = 45) => [1, 3, 5].every((i, k) => Math.abs(p[k]! - parseInt(hex.slice(i, i + 2), 16)) <= tol);
    /** Accent pixels in the subtitle band (bottom edge at 72 % = y 1382), left and right of the centre. */
    const accent = (p: (x: number, y: number) => number[]) => {
      let left = 0, right = 0;
      for (let y = 1280; y < 1390; y += 2) for (let x = 90; x < 990; x += 2) if (near(p(x, y), ACCENT)) { if (x < 540) left++; else right++; }
      return { left, right };
    };
    const w1 = accent(await px(0.8)), w2 = accent(await px(2.2));
    console.log(`[karaoke] t=0.8 ${JSON.stringify(w1)} · t=2.2 ${JSON.stringify(w2)}`);
    expect(w1.left).toBeGreaterThan(200);
    expect(w1.right).toBeLessThan(20);
    expect(w2.right).toBeGreaterThan(200);
    expect(w2.left).toBeLessThan(20);
    // lines mode (Gegenprobe in the same draft): no accent in the band
    await drafts.putEditDraft(project.id, { scriptId: null, revision: v.draft!.revision, body: { ...draft, subtitleMode: 'lines' } });
    const plain = accent(await px(0.8));
    expect(plain.left + plain.right).toBeLessThan(20);
  });
});
