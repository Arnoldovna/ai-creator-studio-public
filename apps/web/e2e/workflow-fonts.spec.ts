import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedStrategy } from './helpers';

/**
 * Etappe 16b: Meine Marke → Google Font „Bebas Neue“ hinzufügen (local fake server, see e2e/fake-google-fonts.mjs) → as
 * hook font → save → the editor's stage draws the hook in it → subtitles „Wort für Wort“ (the spoken word in the accent) →
 * „Standbild prüfen“ gives the FFmpeg frame without a font warning. On a Mac also: a font installed on this Mac as keyword.
 */
test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3100' });
  await seedStrategy(ctx, { ifMissing: true });
  await ctx.dispose();
});

test('Schrift-Bibliothek: Google Font hinzufügen → Hook-Schrift → Editor zeigt sie → Wort für Wort → Standbild', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/meine-marke');
  await expect(page.getByRole('heading', { level: 1, name: /Meine Marke/ })).toBeVisible();
  const hookRow = page.getByTestId('type-hook');
  await hookRow.getByTestId('font-picker-type-hook-toggle').click();
  await hookRow.getByTestId('font-tab-google').click();
  // the quick pick shows typical reel fonts before any search
  await expect(hookRow.getByTestId('google-row-Bebas Neue')).toBeVisible();
  await hookRow.getByTestId('font-google-search').fill('Bebas');
  await expect(hookRow.getByTestId('font-google-list').locator('li')).toHaveCount(1);
  await hookRow.getByTestId('google-add-Bebas Neue').click();
  // picked right away; the picker closes and names the font
  await expect(hookRow.getByTestId('font-picker-type-hook-toggle')).toContainText('Bebas Neue', { timeout: 20000 });
  // licence note set automatically, visible in her fonts
  await page.getByTestId('fonts-manager').locator('summary').click();
  await expect(page.getByTestId('fonts-manager')).toContainText('SIL Open Font License 1.1');
  await expect(page.getByTestId('fonts-manager')).toContainText('Google Fonts „Bebas Neue“');

  // a font installed on this Mac as keyword font (macOS only: fc-list/system_profiler)
  if (process.platform === 'darwin') {
    const kwRow = page.getByTestId('type-keyword');
    await kwRow.getByTestId('font-picker-type-keyword-toggle').click();
    await kwRow.getByTestId('font-tab-mac').click();
    await kwRow.getByTestId('font-mac-search').fill('Rockwell');
    const pick = kwRow.getByTestId('mac-pick-Rockwell');
    if (await pick.isVisible({ timeout: 15000 }).catch(() => false)) {
      await kwRow.getByLabel('Rockwell: Schnitt').selectOption('Rockwell-Bold');
      await pick.click();
      await expect(kwRow.getByTestId('font-picker-type-keyword-toggle')).toContainText('Rockwell');
    } else {
      await kwRow.getByTestId('font-picker-type-keyword-toggle').click();
    }
  }
  // the hook pops by default (role default in Meine Marke)
  await hookRow.getByTestId('type-hook-anim').selectOption('pop');
  await page.getByTestId('brand-save').click();
  await expect(page.getByRole('status')).toContainText('Gespeichert');

  // the editor: a take, a hook in Bebas Neue, subtitles word by word
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-fonts-'));
  const take = path.join(dir, 'take-6s.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x30343A:size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take]);
  const project = await (await request.post('/api/projects', { data: { title: 'Schrift-Test', kind: 'PERSONAL_CONTENT' } })).json();
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Schrift-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(take);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('transcript-word').first()).toBeVisible({ timeout: 90000 });
  await page.getByTestId('add-hook').click();
  const hook = page.getByTestId('stage-hook');
  await expect(hook).toBeVisible();
  await expect(hook).toHaveAttribute('data-font', 'Bebas Neue');
  // the browser really loaded the file (her font folder, @font-face by family)
  await expect.poll(() => page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('40px "Bebas Neue"'); }), { timeout: 15000 }).toBe(true);
  expect(await hook.locator('span').first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Bebas Neue');

  await page.getByLabel('Untertitel', { exact: true }).selectOption('burn');
  await page.getByTestId('subtitle-mode').selectOption('karaoke');
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  const sub = page.getByTestId('stage-subtitle');
  await expect(sub).toHaveAttribute('data-mode', 'karaoke');
  // the playhead in the first word: that word is lit in the accent, the others are not
  await expect(sub).toHaveAttribute('data-active', '0');
  const colours = await sub.getByTestId('stage-subtitle-word').evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  expect(colours.length).toBeGreaterThan(1);
  expect(colours[0]).not.toBe(colours[1]);

  await page.getByTestId('still-check').click();
  const still = page.getByTestId('stage-still').locator('img');
  await expect(still).toBeVisible({ timeout: 60000 });
  await expect.poll(() => still.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 20000 }).toBe(540);
  await expect(page.getByTestId('frame-font-warnings')).toHaveCount(0);
  expect(errors).toEqual([]);
  // the project goes away (a background job of the take may still run: retry until the delete is accepted), so later specs
  // do not find it selected in the Video Studio
  await expect.poll(async () => (await request.delete(`/api/projects/${project.id}`)).status(), { timeout: 60000, intervals: [500, 1000, 2000] }).toBe(200);
});
