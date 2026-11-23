import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { carouselFontTypes, fontFallbacks, IG_STORY_AI_LABEL, IG_STORY_KIND_LABEL, igStoryNotes, isHex, slideAss, type IgStoryLayout } from '@studio/core';
import { HttpError } from '../errors';
import { ffmpegStatus, runFfmpeg } from '../ffmpeg';
import { absolutePath, sha256File } from '../media';
import { must, now, read, write, type Db, type IgStoryRecord } from '../store';
import type { ZipEntry } from '../zip';
import { slideFile } from './carouselRender';
import { expectedFaces, fontsDir } from './fonts';
import { storyReviewOf } from './stories';

/**
 * Etappe 19: a story as PNG (still) or MP4 (clip ≤ 15 s) through FFmpeg + libass – the carousel's pipeline (Etappe 18):
 * colour → `under` ASS → her media (scaled to cover its box, cropped) → `over` ASS (text boxes, text, the AI label last).
 * A clip keeps its sound; its ASS events last as long as the clip. Files are content-addressed
 * (`stories/<project>/<story>/<sha256>.png|mp4`: both ASS files, background, media file hash + seek/length + box, font files,
 * FFmpeg version), so an unchanged story is never drawn twice.
 */

const folder = (projectId: string, storyId: string) => `stories/${projectId}/${storyId}`;
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const p = prev.catch(() => undefined).then(fn);
  locks.set(key, p);
  try { return await p; } finally { if (locks.get(key) === p) locks.delete(key); }
}

/** The media file of a story (absolute path, content hash, seek/length) – resolved from the store, never from the client. */
interface MediaInput { abs: string; sha256: string; seek: number | null; duration: number | null; box: { x0: number; y0: number; x1: number; y1: number } }

function plan(db: Db, projectId: string, storyId: string) {
  const s = must(db.stories.find((x) => x.id === storyId && x.projectId === projectId), 'Story');
  const r = storyReviewOf(db, s, s.body);
  const types = carouselFontTypes(r.look);
  const used = new Set(types.filter((t) => t.custom).map((t) => t.assName));
  const fontsHash = db.fonts.filter((f) => used.has(f.assName)).map((f) => f.sha256).sort().join(',');
  const m = s.body.media;
  // what the media element points at (the layout only shows usable media)
  let file: { storagePath: string; sha256: string } | null = null;
  let slide: { carouselId: string; n: number } | null = null;
  if (m.kind === 'image') { const ref = db.references.find((x) => x.id === m.imageId); if (ref) file = { storagePath: ref.storagePath, sha256: ref.sha256 }; }
  if (m.kind === 'frame' || (m.kind === 'clip' && m.source === 'render')) {
    const rid = m.kind === 'frame' ? m.renderId : m.id;
    const rr = db.renders.find((x) => x.id === rid && x.projectId === projectId);
    if (rr?.storagePath) file = { storagePath: rr.storagePath, sha256: rr.sha256 ?? rr.id };
  }
  if (m.kind === 'clip' && m.source === 'footage') { const a = db.mediaAssets.find((x) => x.id === m.id && x.projectId === projectId); if (a) file = { storagePath: a.storagePath, sha256: a.sha256 }; }
  if (m.kind === 'carousel_slide') slide = { carouselId: m.carouselId, n: m.n };
  return { s, ...r, fontsHash, customFonts: types.some((t) => t.custom), expected: expectedFaces(db, types), file, slide };
}
type Plan = ReturnType<typeof plan>;

async function mediaInput(p: Plan, projectId: string): Promise<MediaInput | null> {
  const el = p.layout.elements.find((e) => e.type === 'image');
  if (!el) return null;
  const m = p.s.body.media;
  if (p.slide) {
    const abs = await slideFile(projectId, p.slide.carouselId, p.slide.n, null);
    return { abs, sha256: await sha256File(abs), seek: null, duration: null, box: el.box };
  }
  if (!p.file) return null;
  return {
    abs: absolutePath(p.file.storagePath), sha256: p.file.sha256,
    seek: m.kind === 'frame' ? m.atSec : m.kind === 'clip' ? m.startSec : null, duration: m.kind === 'clip' ? m.durationSec : null, box: el.box,
  };
}

const clipEnd = (layout: IgStoryLayout, media: MediaInput | null) => (layout.mode === 'clip' && media?.duration ? media.duration : null);

/** The content key of a story render (no drawing). */
function jobOf(p: Plan, media: MediaInput | null, ff: string | null) {
  const end = clipEnd(p.layout, media);
  const { under, over } = slideAss(p.layout, p.look, end ? { endSec: end + 0.5 } : {});
  const key = createHash('sha256').update(JSON.stringify({ under, over, bg: p.layout.bg, media: media ? [media.sha256, media.seek, media.duration, media.box] : null, fonts: p.fontsHash, ff, mode: p.layout.mode })).digest('hex');
  return { under, over, key, end, ext: p.layout.mode === 'clip' ? 'mp4' as const : 'png' as const };
}

async function draw(p: Plan, media: MediaInput | null, job: ReturnType<typeof jobOf>, rel: string): Promise<{ file: string; warnings: string[] }> {
  const file = absolutePath(`${rel}/${job.key}.${job.ext}`);
  try {
    await stat(file);
    const warnings = await readFile(`${file}.warnings.json`, 'utf8').then((t) => JSON.parse(t) as string[], () => []);
    if (!warnings.length) return { file, warnings };
  } catch { /* not drawn yet */ }
  const work = absolutePath(`${rel}/${job.key}.${process.pid}.${Date.now()}`);
  const underFile = `${work}.under.ass`, overFile = `${work}.over.ass`, out = `${work}.${job.ext}`;
  const chars = /['\\:[\],;]/;
  if (chars.test(work) || (p.customFonts && chars.test(fontsDir()))) throw new HttpError(409, 'Der Datenordner-Pfad enthält Zeichen, die der FFmpeg-Filter nicht verarbeitet.');
  if (!isHex(p.layout.bg)) throw new HttpError(400, 'Hintergrundfarbe ungültig.');
  if (p.layout.mode === 'clip' && !media) throw new HttpError(409, 'Für eine Clip-Story fehlt das Video (oder es ist nicht nutzbar).');
  await Promise.all([writeFile(underFile, job.under, 'utf8'), writeFile(overFile, job.over, 'utf8')]);
  try {
    const { width: W, height: H } = p.layout;
    const dur = job.end ?? 1;
    const args = ['-f', 'lavfi', '-i', `color=c=0x${p.layout.bg.slice(1)}:s=${W}x${H}:d=${dur}:r=30`];
    // the media path is an input argument; the filtergraph carries only our numbers and our own file names
    if (media) {
      if (media.seek != null) args.push('-ss', media.seek.toFixed(3));
      if (media.duration != null) args.push('-t', media.duration.toFixed(3));
      args.push('-i', media.abs);
    }
    const graph = [`[0:v]subtitles=filename='${underFile}'[u0]`];
    let last = 'u0';
    if (media) {
      const w = media.box.x1 - media.box.x0, h = media.box.y1 - media.box.y0;
      graph.push(`[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1${job.ext === 'mp4' ? ',fps=30' : ''}[m]`);
      graph.push(`[u0][m]overlay=${media.box.x0}:${media.box.y0}:eof_action=${job.ext === 'mp4' ? 'endall' : 'repeat'}[u1]`);
      last = 'u1';
    }
    graph.push(`[${last}]subtitles=filename='${overFile}'${p.customFonts ? `:fontsdir='${fontsDir()}'` : ''}[out]`);
    const tail = job.ext === 'mp4'
      ? ['-map', '[out]', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-t', dur.toFixed(3), '-movflags', '+faststart', '-y', out]
      : ['-map', '[out]', '-frames:v', '1', '-y', out];
    const { stderr } = await runFfmpeg([...args, '-filter_complex', graph.join(';'), ...tail], { loglevel: 'info', keepStderr: 256 * 1024, durationSec: job.end });
    await rename(out, file);
    const warnings = fontFallbacks(stderr, p.expected);
    await writeFile(`${file}.warnings.json`, JSON.stringify(warnings), 'utf8').catch(() => undefined);
    return { file, warnings };
  } finally {
    await Promise.all([rm(underFile, { force: true }), rm(overFile, { force: true }), rm(out, { force: true })]);
  }
}

/**
 * `POST …/stories/[sid]/render`: the story as PNG or MP4. Problems of the content (overflow, rights) do not stop the render
 * – the picture shows them; the export refuses them. Font fallbacks come back as warnings.
 */
export async function renderStory(projectId: string, storyId: string) {
  const ff = await ffmpegStatus();
  if (!ff.available || !ff.subtitles) throw new HttpError(409, 'Stories brauchen FFmpeg mit libass (Filter „subtitles“). FFmpeg mit libass installieren (brew install ffmpeg-full).');
  return locked(storyId, async () => {
    const p = await read((db) => plan(db, projectId, storyId));
    const media = await mediaInput(p, projectId);
    const job = jobOf(p, media, ff.version);
    await mkdir(absolutePath(folder(projectId, storyId)), { recursive: true });
    const drawn = await draw(p, media, job, folder(projectId, storyId));
    const render: NonNullable<IgStoryRecord['render']> = {
      at: now(), revision: p.s.revision, key: job.key, storagePath: `${folder(projectId, storyId)}/${job.key}.${job.ext}`, sha256: await sha256File(drawn.file),
      mime: job.ext === 'mp4' ? 'video/mp4' : 'image/png', warnings: [...new Set([...p.lookWarnings, ...drawn.warnings])],
    };
    const old = await write((db) => {
      const s = db.stories.find((x) => x.id === storyId);
      const prev = s?.render ?? null;
      if (s) s.render = render;
      return prev;
    });
    // one file per story is enough (older content keys go)
    if (old && old.storagePath !== render.storagePath) await Promise.all([rm(absolutePath(old.storagePath), { force: true }), rm(`${absolutePath(old.storagePath)}.warnings.json`, { force: true })]);
    return { render, review: p.review };
  });
}

/** `GET …/stories/[sid]/file`: the current PNG/MP4 (served straight when the content key still matches, else rendered). */
export async function storyFile(projectId: string, storyId: string): Promise<{ abs: string; mime: string }> {
  const ff = await ffmpegStatus();
  const p = await read((db) => plan(db, projectId, storyId));
  const stored = p.s.render;
  if (stored) {
    const job = jobOf(p, await mediaInput(p, projectId), ff.version);
    const abs = absolutePath(stored.storagePath);
    if (stored.key === job.key && (await stat(abs).then(() => true, () => false))) return { abs, mime: stored.mime };
  }
  const r = await renderStory(projectId, storyId);
  return { abs: absolutePath(r.render.storagePath), mime: r.render.mime };
}

const pad = (n: number) => String(n).padStart(2, '0');
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'stories';

/**
 * `GET …/stories/export?ids=a,b`: ZIP with `01.png`/`02.mp4` … in her order, `notizen.txt` (sticker to set, her notes) and –
 * when a story shows generated material – `KENNZEICHNUNG.txt`. Refused (409 `story_problems`) while a story has errors.
 */
export async function storiesPackage(projectId: string, ids: readonly string[]): Promise<{ filename: string; entries: ZipEntry[] }> {
  const unique = [...new Set(ids)].slice(0, 20);
  if (!unique.length) throw new HttpError(400, 'Keine Story gewählt.');
  const pre = await read((db) => unique.map((id) => plan(db, projectId, id)));
  const errors = pre.flatMap((p, i) => p.review.issues.filter((x) => x.level === 'error').map((x) => `Story ${i + 1} („${p.s.title}“): ${x.message}`));
  if (errors.length) throw new HttpError(409, `Export nicht möglich: ${errors.join(' · ')}`, 'story_problems');
  const entries: ZipEntry[] = [];
  const notes: { file: string; title: string; body: IgStoryRecord['body']; ai: boolean }[] = [];
  for (const [i, p] of pre.entries()) {
    const f = await storyFile(projectId, p.s.id);
    const name = `${pad(i + 1)}.${f.mime === 'video/mp4' ? 'mp4' : 'png'}`;
    entries.push({ name, file: f.abs });
    notes.push({ file: name, title: p.s.title, body: p.s.body, ai: p.layout.aiImage });
  }
  entries.push({ name: 'notizen.txt', data: igStoryNotes(notes) });
  const ai = notes.filter((n) => n.ai);
  if (ai.length) {
    entries.push({
      name: 'KENNZEICHNUNG.txt',
      data: [
        `Diese Stories zeigen KI-generiertes Material: ${ai.map((n) => `${n.file} (${IG_STORY_KIND_LABEL[n.body.kind]})`).join(', ')}.`,
        `„${IG_STORY_AI_LABEL}“ ist im sicheren Bereich eingebrannt – bitte nicht überdecken (auch nicht mit Stickern).`,
        'Beim Posten zusätzlich das KI-Label von Instagram setzen („Mit KI erstellt“, je nach App-Version).',
        '',
      ].join('\n'),
    });
  }
  return { filename: `stories-${slug(pre[0]!.s.title)}-${pre.length}.zip`, entries };
}

/**
 * `GET …/stories/media?key=`: a still of a story medium for the browser preview (her library image, a rendered carousel
 * slide, a frame of a reel or footage). Frames are cached under `stories/<project>/previews/`.
 */
export async function mediaPreview(projectId: string, key: string): Promise<{ abs: string; mime: string }> {
  const m = /^(ref|slide|frame|clip):(.+)$/.exec(key);
  if (!m) throw new HttpError(400, 'Unbekanntes Medium.');
  const [, kind, rest] = m as unknown as [string, string, string];
  if (kind === 'slide') {
    const [cid, n] = rest.split(':');
    const num = Number(n);
    if (!cid || !Number.isInteger(num) || num < 1 || num > 10) throw new HttpError(400, 'Slide ungültig.');
    await read((db) => must(db.carousels.find((c) => c.id === cid && c.projectId === projectId), 'Karussell'));
    return { abs: await slideFile(projectId, cid, num, null), mime: 'image/png' };
  }
  const src = await read((db) => {
    if (kind === 'ref') {
      const r = must(db.references.find((x) => x.id === rest && x.kind === 'image'), 'Bild');
      return { storagePath: r.storagePath, sha256: r.sha256, mime: r.mime, at: null as number | null };
    }
    const parts = rest.split(':');
    const [srcKind, id, at] = kind === 'frame' ? ['render', parts[0], parts[1]] : [parts[0], parts[1], parts[2]];
    const sec = Number(at);
    if (!id || !Number.isFinite(sec) || sec < 0 || sec > 36_000) throw new HttpError(400, 'Zeitpunkt ungültig.');
    if (srcKind === 'render') {
      const r = must(db.renders.find((x) => x.id === id && x.projectId === projectId), 'Reel');
      if (!r.storagePath) throw new HttpError(409, 'Das Reel ist nicht fertig gerendert.');
      return { storagePath: r.storagePath, sha256: r.sha256 ?? r.id, mime: 'video/mp4', at: sec };
    }
    if (srcKind !== 'footage') throw new HttpError(400, 'Unbekanntes Medium.');
    const a = must(db.mediaAssets.find((x) => x.id === id && x.projectId === projectId), 'Video');
    return { storagePath: a.storagePath, sha256: a.sha256, mime: a.mime, at: sec };
  });
  if (src.at == null) return { abs: absolutePath(src.storagePath), mime: src.mime };
  const name = createHash('sha256').update(`${src.sha256}@${src.at.toFixed(2)}`).digest('hex');
  const rel = `stories/${projectId}/previews`;
  const file = absolutePath(`${rel}/${name}.jpg`);
  if (await stat(file).then(() => true, () => false)) return { abs: file, mime: 'image/jpeg' };
  await mkdir(absolutePath(rel), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.jpg`;
  try {
    await runFfmpeg(['-ss', src.at.toFixed(3), '-i', absolutePath(src.storagePath), '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', '-y', tmp]);
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
  return { abs: file, mime: 'image/jpeg' };
}

/** Removes the files of a story (after its record is gone). */
export const deleteStoryFiles = (projectId: string, storyId: string) => rm(absolutePath(folder(projectId, storyId)), { recursive: true, force: true }).catch(() => undefined);
