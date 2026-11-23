import { expect, test, type Page } from '@playwright/test';
import { overlayBox, LABEL_ZONE, type Box } from '../../../packages/core/src/overlayLayout';
import { seedStrategy } from './helpers';

test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3100' });
  await seedStrategy(ctx, { ifMissing: true });
  await ctx.dispose();
});

/** Box of a stage element in PlayRes pixels (1080×1920), measured in the browser. */
async function playResBox(page: Page, testId: string, nth = 0) {
  const stage = (await page.getByTestId('editor-stage').boundingBox())!;
  const b = (await page.getByTestId(testId).nth(nth).boundingBox())!;
  const k = stage.width / 1080;
  return { x0: (b.x - stage.x) / k, y0: (b.y - stage.y) / k, x1: (b.x + b.width - stage.x) / k, y1: (b.y + b.height - stage.y) / k };
}
const near = (a: Box, b: Box, tol = 2) => (['x0', 'y0', 'x1', 'y1'] as const).every((k) => Math.abs(a[k] - b[k]) <= tol);

test('Overlays (Etappe 13): + Keyword → at once on the stage (same box as the core) → drag → inspector text → still frame → transcript selection → render', async ({ page, request }) => {
  test.setTimeout(300_000);
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-ov-'))).find((f: string) => f.endsWith('landscape.mp4'))!;
  const project = await (await request.post('/api/projects', { data: { title: 'Overlay-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const draft = async () => (await (await request.get(`/api/projects/${project.id}/edit-draft?scriptId=`)).json()).draft.body;

  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Overlay-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('stage-video')).toHaveCount(1, { timeout: 60000 });
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  // own project: the classic view is only a fallback link
  await expect(page.getByTestId('view-classic')).toContainText('Fallback');

  // + Keyword at the playhead: visible on the stage at once, selected, inspector open
  await page.getByTestId('add-keyword').click();
  const overlay = page.getByTestId('stage-overlay');
  await expect(overlay).toHaveCount(1);
  await expect(page.getByTestId('overlay-inspector')).toBeVisible();
  await expect(page.getByTestId('track-overlay')).toHaveCount(1);
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  let body = await draft();
  const o0 = body.clips[0].overlays[0];
  expect(o0).toMatchObject({ kind: 'keyword', slot: 'center' });
  // the DOM box is the core box (the one the ASS uses)
  expect(near(await playResBox(page, 'stage-overlay'), overlayBox({ kind: 'keyword', text: o0.text, slot: 'center' }))).toBe(true);

  // drag it down on the stage: a free position, below the label zone, the DOM box follows the core box
  const ob = (await overlay.boundingBox())!;
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await page.mouse.down();
  await page.mouse.move(ob.x + ob.width / 2 - 40, ob.y + ob.height / 2 + 120, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  await expect.poll(async () => (await draft()).clips[0].overlays[0].pos?.y ?? 0).toBeGreaterThan(0.45);
  body = await draft();
  const o1 = body.clips[0].overlays[0];
  expect(near(await playResBox(page, 'stage-overlay'), overlayBox({ kind: 'keyword', text: o1.text, slot: o1.slot, pos: o1.pos }))).toBe(true);
  // a drag towards the top never reaches the AI-label zone
  const ob2 = (await overlay.boundingBox())!;
  await page.mouse.move(ob2.x + ob2.width / 2, ob2.y + ob2.height / 2);
  await page.mouse.down();
  await page.mouse.move(ob2.x + ob2.width / 2, 0, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  expect((await playResBox(page, 'stage-overlay')).y0).toBeGreaterThanOrEqual(LABEL_ZONE.y1 - 1);

  // inspector: change the text → stage and draft follow
  const text = page.getByTestId('ins-text');
  await text.fill('Wolle färben');
  await text.press('Enter');
  await expect(overlay).toContainText('Wolle färben');
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  await expect.poll(async () => (await draft()).clips[0].overlays[0].text).toBe('Wolle färben');
  await page.getByTestId('ins-size-L').click();
  await expect.poll(async () => (await draft()).clips[0].overlays[0].size).toBe('L');

  // still frame through FFmpeg + ASS: an image comes
  await page.getByTestId('still-check').click();
  const still = page.getByTestId('stage-still').locator('img');
  await expect(still).toBeVisible({ timeout: 60000 });
  await expect.poll(() => still.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(540);
  await page.getByTestId('close-exact').click();

  // frame check of the first and last frame with text and label (FFmpeg)
  await page.getByTestId('edge-check').click();
  await expect(page.getByTestId('edge-frame')).toHaveCount(2, { timeout: 60000 });

  // timeline: drag the block's right edge to the left → shorter (in source time of its clip)
  const before = (await draft()).clips[0].overlays[0];
  await page.getByTestId('timeline').scrollIntoViewIfNeeded();
  const edge = (await page.getByTestId('overlay-edge-end').first().boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x - 120, edge.y + edge.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  await expect.poll(async () => (await draft()).clips[0].overlays[0].endSec).toBeLessThan(before.endSec - 0.1);

  // transcript (mock): Shift+click marks words → „Als Keyword“ puts them on the stage, „Schneiden“ cuts them
  const words = page.getByTestId('transcript-word');
  await expect(words.first()).toBeVisible({ timeout: 60000 });
  await words.nth(0).click();
  await words.nth(1).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('transcript-actions')).toBeVisible();
  await page.getByTestId('tr-lower-third').click();
  await expect.poll(async () => (await draft()).clips[0].overlays.length).toBe(2);
  expect((await draft()).clips[0].overlays[1].kind).toBe('lower_third');

  // render: the draft (with free position and size) renders through FFmpeg
  await page.getByLabel('Lautheit').selectOption('off');
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  const issues = page.getByTestId('draft-issues');
  if (await issues.isVisible()) expect(await issues.textContent()).not.toMatch(/Vor dem Rendern lösen/);
  await page.getByTestId('render-draft').click();
  const item = page.getByTestId('editor-render-item').first();
  await expect(item.getByText('fertig', { exact: true })).toBeVisible({ timeout: 180000 });
  const plans = await (await request.get(`/api/projects/${project.id}/edit-plans`)).json();
  expect(plans.plans[0].body.clips[0].overlays[0]).toMatchObject({ text: 'Wolle färben', size: 'L' });
  expect(plans.plans[0].body.clips[0].overlays[0].pos).toBeTruthy();
  await request.delete(`/api/projects/${project.id}`);
});

test('Exakte Vorschau: the whole cut as a 540×960 FFmpeg video in the stage frame', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-pv-'))).find((f: string) => f.endsWith('landscape.mp4'))!;
  const project = await (await request.post('/api/projects', { data: { title: 'Vorschau-Test', kind: 'PERSONAL_CONTENT' } })).json();
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Vorschau-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('stage-video')).toHaveCount(1, { timeout: 60000 });
  await page.getByTestId('add-hook').click();
  await expect(page.getByTestId('stage-hook')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  await page.getByTestId('exact-preview').click();
  const video = page.getByTestId('stage-exact').locator('video');
  await expect(video).toBeVisible({ timeout: 120000 });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20000 }).toBe(540);
  await request.delete(`/api/projects/${project.id}`);
});

test('Suggestions: a measured pause is a ghost block; nothing is cut until she accepts it', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-gh-')), 'pause.mp4');
  // 4 s with 1.4 s of silence in the middle (the pause scan finds it, the pacing suggestion shortens it)
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-af', "volume=enable='between(t,1.2,2.6)':volume=0", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', clip]);
  const project = await (await request.post('/api/projects', { data: { title: 'Pausen-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const draft = async () => (await (await request.get(`/api/projects/${project.id}/edit-draft?scriptId=`)).json()).draft.body;
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Pausen-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  const ghost = page.getByTestId('ghost-suggestion');
  // the mock transcript spreads words over the whole clip (a pause is never cut over a word): her correction keeps the
  // text without word timings, then the measured pause is offered (low confidence, never „sicher“)
  const media = async () => (await (await request.get(`/api/projects/${project.id}/edit-draft?scriptId=`)).json()).media[0];
  await expect.poll(async () => { const m = await media(); return !!m.transcript && !!m.silences; }, { timeout: 90000 }).toBe(true);
  const t = await media();
  const tr = await (await request.get(`/api/footage/${t.id}/transcript`)).json();
  const edited = await request.post(`/api/transcripts/${tr.id}`, { data: { texts: tr.body.segments.map((x: { text: string }) => `${x.text} (korrigiert)`) } });
  expect(edited.ok()).toBe(true);
  await expect.poll(async () => (await draft()).clips.length).toBe(1);
  const c0 = (await draft()).clips[0];
  const sug = await (await request.get(`/api/projects/${project.id}/cut-suggestions?assetId=${c0.assetId}&inSec=${c0.inSec}&outSec=${c0.outSec}`)).json();
  expect(sug.suggestions.map((x: { kind: string; safe: boolean }) => [x.kind, x.safe])).toEqual([['pause', false]]);
  await page.reload();
  await page.getByLabel('Projekt').selectOption({ label: 'Pausen-Test' });
  await expect(ghost.first()).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  expect((await draft()).clips[0].cuts).toEqual([]); // shown, never applied by itself
  await ghost.first().getByTestId('ghost-accept').click();
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  await expect.poll(async () => (await draft()).clips[0].cuts.length).toBe(1);
  expect((await draft()).clips[0].cuts[0].reason).toBe('pause');
  await expect(ghost).toHaveCount(0); // the accepted one is now a cut
  await page.keyboard.press('ControlOrMeta+z');
  await expect(ghost.first()).toBeVisible();
  await page.getByTestId('reject-all').click();
  await expect(ghost).toHaveCount(0);
  await expect.poll(async () => (await draft()).clips[0].cuts.length).toBe(0);

  // review fix: the subtitle height of a version survives loading and saving it again in the classic view (fallback)
  expect((await draft()).subtitleY).toBe(0.72);
  const dv = await (await request.get(`/api/projects/${project.id}/edit-draft?scriptId=`)).json();
  expect((await request.post(`/api/projects/${project.id}/edit-draft/render`, { data: { scriptId: null, revision: dv.draft.revision, mode: 'save' } })).ok()).toBe(true);
  await page.getByTestId('view-classic').click();
  const planner = page.getByTestId('edit-planner');
  await planner.getByTestId('edit-plan').first().getByRole('button', { name: 'Laden' }).click();
  await planner.getByRole('button', { name: 'Als neue Version speichern' }).click();
  await expect.poll(async () => (await (await request.get(`/api/projects/${project.id}/edit-plans`)).json()).plans.length).toBe(2);
  const plans = (await (await request.get(`/api/projects/${project.id}/edit-plans`)).json()).plans;
  expect(plans[0].version).toBe(2);
  expect(plans[0].body.subtitleY).toBe(0.72);
  await request.delete(`/api/projects/${project.id}`);
});
