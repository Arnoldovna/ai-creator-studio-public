import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedStrategy } from './helpers';

/**
 * Etappe 16 (runs after the chat workflow, its data does not touch the smoke tests): a transcribed 15-s take →
 * „Dramaturgie vorschlagen“ (MOCK) → story track and a grid of hook stills (FFmpeg) → choose a hook, deselect a beat →
 * „Übernehmen“ → the draft has clips per beat, the hook, ≥ 2 overlays in her preset and her own photo → render.
 */
test('KI-Dramaturgie: Vorschlag → Story-Spur + Hook-Raster mit Standbildern → Hook wählen, Beat abwählen → Übernehmen → Rendern', async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedStrategy(request, { ifMissing: true });
  // „Meine Marke“ as an active version (presets for the overlays)
  const ds = await (await request.get('/api/design-system')).json();
  if (ds.fresh || ds.legacy) expect((await request.put('/api/design-system', { data: { design: ds.design, baseVersionId: ds.version?.id ?? null } })).ok()).toBe(true);
  const presetId = (await (await request.get('/api/design-system')).json()).design.defaultPresetId as string;

  // a 15-s take (five mock sentences) and her own photo, marked as usable in videos
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-story-'));
  const ff = process.env.FFMPEG_PATH || 'ffmpeg';
  const take = path.join(dir, 'take-15s.mp4'), photo = path.join(dir, 'atelier.png');
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=15', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take]);
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2050F0:s=400x300', '-frames:v', '1', photo]);
  const ref = await (await request.post('/api/references', { multipart: { file: { name: 'atelier.png', mimeType: 'image/png', buffer: readFileSync(photo) } } })).json();
  expect((await request.patch(`/api/references/${ref.reference.id}`, { data: { usage: { origin: 'own', source: '' } } })).ok()).toBe(true);

  const project = await (await request.post('/api/projects', { data: { title: 'Dramaturgie-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const draft = async () => (await (await request.get(`/api/projects/${project.id}/edit-draft?scriptId=`)).json()).draft;
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Dramaturgie-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(take);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('transcript-word').first()).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');

  // the cost before the click (mock: free), nothing has changed yet
  const panel = page.getByTestId('story-panel');
  await expect(panel.getByTestId('story-estimate')).toContainText('MOCK');
  const before = await draft();
  await panel.getByTestId('story-propose').click();
  await expect(panel.getByTestId('story-beat')).toHaveCount(5, { timeout: 30000 });
  await expect(panel).toContainText('MOCK · kein LLM');
  expect((await draft()).revision).toBe(before.revision);
  // story track: five beats coloured by role, with labels; ghosts for the overlays, the image and the zooms
  await expect(page.getByTestId('track-story-beat')).toHaveCount(5);
  await expect(page.getByTestId('track-story-beat').first()).toContainText('Hook');
  await expect(page.getByTestId('story-ghost').first()).toBeVisible();
  await expect(panel.getByTestId('story-why').first()).toContainText('Warum');

  // hook grid: up to six exact stills, each a real PNG from the frame endpoint
  const hooks = panel.getByTestId('story-hook');
  const n = await hooks.count();
  expect(n).toBeGreaterThanOrEqual(3);
  expect(n).toBeLessThanOrEqual(6);
  const stills = panel.getByTestId('story-hook-still');
  for (let i = 0; i < n; i++) {
    await stills.nth(i).scrollIntoViewIfNeeded();
    await expect.poll(() => stills.nth(i).evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)), { timeout: 60000 }).toBe(540);
  }
  await hooks.nth(1).click();
  await expect(hooks.nth(1)).toHaveAttribute('aria-checked', 'true');
  const hookText = (await hooks.nth(1).locator('span').first().textContent())!.replace(/^\d+\.\s*/, '');

  // deselect the last beat (CTA); the list keeps it greyed out
  await panel.getByTestId('story-beat-toggle').nth(4).uncheck();
  await expect(panel.getByTestId('story-beat').nth(4)).toHaveAttribute('data-selected', 'false');

  await panel.getByTestId('story-apply').click();
  await expect(page.getByTestId('editor-notice')).toContainText('Dramaturgie übernommen', { timeout: 30000 });
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  const after = await draft();
  expect(after.revision).toBe(before.revision + 1);
  expect(after.body.clips).toHaveLength(4);
  expect(after.body.clips.every((c: { cuts: unknown[] }) => c.cuts.length === 0)).toBe(true);
  expect(after.body.hook).toMatchObject({ source: 'free', text: hookText });
  const overlays = after.body.clips.flatMap((c: { overlays: { presetId?: string }[] }) => c.overlays);
  expect(overlays.filter((o: { presetId?: string }) => o.presetId === presetId).length).toBeGreaterThanOrEqual(2);
  expect(after.body.clips.flatMap((c: { images?: unknown[] }) => c.images ?? [])).toHaveLength(1);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(4);
  await expect(page.getByTestId('track-image')).toHaveCount(1);
  await expect(page.getByTestId('track-hook')).toHaveCount(1);

  // the image on the stage at its time (her photo, below the label zone)
  await page.getByTestId('track-image').click();
  await expect(page.getByTestId('stage-image')).toHaveCount(1);
  await expect(page.getByTestId('image-inspector')).toContainText('Eigenes Foto');

  // ⌘Z takes the whole proposal back in one step, ⇧⌘Z brings it again
  await page.getByTestId('timeline-ruler').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.getByTestId('timeline-clip')).toHaveCount(4);
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');

  // render the dramaturgy cut
  await page.getByLabel('Lautheit').selectOption('off');
  await expect(page.getByTestId('save-status')).toContainText('gespeichert');
  await page.getByTestId('render-draft').click();
  const item = page.getByTestId('editor-render-item').first();
  await expect(item.getByText('fertig', { exact: true })).toBeVisible({ timeout: 180000 });
  const plans = await (await request.get(`/api/projects/${project.id}/edit-plans`)).json();
  expect(plans.plans[0].body.clips).toHaveLength(4);
  expect(errors).toEqual([]);
  await request.delete(`/api/projects/${project.id}`);
});
