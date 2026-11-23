import { expect, test } from '@playwright/test';
import { seedStrategy } from './helpers';

test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3100' });
  await seedStrategy(ctx, { ifMissing: true });
  await ctx.dispose();
});

const seconds = (s: string | null) => {
  const m = /(\d+):(\d+(?:\.\d+)?) \/ (\d+):(\d+(?:\.\d+)?)/.exec(s ?? '');
  return m ? { t: Number(m[1]) * 60 + Number(m[2]), total: Number(m[3]) * 60 + Number(m[4]) } : { t: NaN, total: NaN };
};

test('Editor (Etappe 12): upload → editor opens → thumbnails, waveform, transcript → scrub → trim by drag → split/undo by keyboard → reload keeps it → render', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-fx-'))).find((f) => f.endsWith('landscape.mp4'))!;
  const project = await (await request.post('/api/projects', { data: { title: 'Editor-Test', kind: 'PERSONAL_CONTENT' } })).json();

  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Editor-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip);

  // no further click: the editor holds the new footage as a Freier Schnitt, preparation runs by itself
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('clip-thumb').first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('clip-wave').first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('stage-video')).toHaveCount(1);
  await expect(page.getByTestId('editor-transcript').getByRole('button').first()).toBeVisible({ timeout: 60000 });
  await expect(page.getByTestId('editor-transcript')).toContainText('MOCK'); // mock transcript, labelled
  await expect(page.getByTestId('frame-check').locator('video')).toHaveCount(2);
  await expect(page.getByTestId('save-status')).toContainText('gespeichert');
  const time = page.getByTestId('timeline-time');
  expect(seconds(await time.textContent()).total).toBeCloseTo(3, 1);

  // scrub: click on the ruler in the middle → playhead and stage video follow
  await page.getByTestId('timeline').scrollIntoViewIfNeeded();
  const ruler = page.getByTestId('timeline-ruler');
  const clipBox = (await page.getByTestId('timeline-clip').boundingBox())!;
  const rb = (await ruler.boundingBox())!;
  await page.getByTestId('timeline').scrollIntoViewIfNeeded();
  await page.mouse.click(clipBox.x + clipBox.width / 2, rb.y + rb.height / 2);
  await expect.poll(async () => seconds(await time.textContent()).t).toBeGreaterThan(1.2);
  await expect.poll(() => page.getByTestId('stage-video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10000 }).toBeGreaterThan(1.2);

  // trim: drag the Out edge to the left (ripple, autosaved)
  const handle = page.getByTestId('trim-out');
  await handle.scrollIntoViewIfNeeded();
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - clipBox.width / 3, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => seconds(await time.textContent()).total).toBeLessThan(2.6);
  await page.getByTestId('timeline').scrollIntoViewIfNeeded();
  const trimmed = seconds(await time.textContent()).total;
  await expect(page.getByTestId('save-status')).toContainText('gespeichert');

  // keyboard: S splits at the playhead, ⌘/Strg+Z undoes it
  const rb2 = (await ruler.boundingBox())!;
  await page.mouse.click(rb2.x + 10, rb2.y + rb2.height / 2); // playhead near the start…
  await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight'); // …plus 16 frames
  await page.keyboard.press('s');
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1);
  await expect(page.getByTestId('save-status')).toContainText('gespeichert');

  // reload: nothing is lost (the draft lives on the server)
  await page.reload();
  await page.getByLabel('Projekt').selectOption({ label: 'Editor-Test' });
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1);
  await expect.poll(async () => seconds(await page.getByTestId('timeline-time').textContent()).total).toBeCloseTo(trimmed, 2);
  const draft = await (await request.get(`/api/projects/${project.id}/edit-draft?scriptId=`)).json();
  expect(draft.draft.body.clips[0].outSec).toBeLessThan(2.6);

  // render straight from the draft: version snapshot + FFmpeg render
  await page.getByLabel('Lautheit').selectOption('off');
  await expect(page.getByTestId('save-status')).toContainText('gespeichert');
  await page.getByTestId('render-draft').click();
  const item = page.getByTestId('editor-render-item').first();
  await expect(item).toContainText('v1');
  await expect(item.getByText('fertig', { exact: true })).toBeVisible({ timeout: 120000 });
  await expect(item.locator('video')).toBeVisible();
  const plans = await (await request.get(`/api/projects/${project.id}/edit-plans`)).json();
  expect(plans.plans[0]).toMatchObject({ scriptId: null, status: 'approved', version: 1 });
  expect(plans.plans[0].durationSec).toBeCloseTo(trimmed, 1);
  await request.delete(`/api/projects/${project.id}`);
});

test('Editor: a stale tab gets a conflict instead of overwriting; problems are shown, not refused', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { title: 'Konflikt-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const put = (revision: number, body: unknown) => request.put(`/api/projects/${project.id}/edit-draft`, { data: { scriptId: null, revision, body } });
  const r1 = await put(0, { clips: [{ assetId: 'gone', inSec: 0, outSec: 1 }] });
  expect(r1.status()).toBe(200);
  expect(r1.headers().etag).toBe('"r1"');
  expect((await r1.json()).issues.errors.join(' ')).toMatch(/Footage nicht gefunden/);
  expect((await put(0, { clips: [] })).status()).toBe(409);

  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Konflikt-Test' });
  await expect(page.getByTestId('draft-issues')).toContainText('Footage nicht gefunden');
  await expect(page.getByTestId('render-draft')).toBeDisabled();
  // another tab saves meanwhile; this one then edits → conflict banner, nothing overwritten
  expect((await put(1, { clips: [] })).status()).toBe(200);
  await page.getByTestId('timeline-clip').first().getByRole('button').first().click();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('draft-conflict')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Andere Fassung laden' }).click();
  await expect(page.getByTestId('timeline-clip')).toHaveCount(0);
  await request.delete(`/api/projects/${project.id}`);
});
