import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Etappe 19: Karussell vorhanden → „Stories daraus“ → „Stories vorschlagen“ (Mock) → Teaser mit Slide 1 als Karte, Schutz-
 * zonen sichtbar → Text direkt auf der Story ändern → speichern → PNG rendern → Auswahl als ZIP exportieren (PNGs + Notizen
 * für die Sticker). Nothing is posted.
 */
test('Stories: Karussell → Story-Teaser (Mock) → auf der Story bearbeiten → PNG → ZIP mit Sticker-Notizen', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const project = await (await request.post('/api/projects', { data: { title: 'Story-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const created = await request.post(`/api/projects/${project.id}/carousels`, { data: { source: { kind: 'note', text: 'Mein Morgen mit Wolle. Eine Reihe zählt schon. Das Handy bleibt im Flur.' } } });
  expect(created.ok()).toBe(true);
  const carousel = await created.json();

  // the carousel offers stories
  await page.goto(`/karussells?project=${project.id}&carousel=${carousel.carousel.id}`);
  await expect(page.getByTestId('carousel-editor')).toBeVisible();
  await page.getByTestId('carousel-to-stories').click();
  await expect(page.getByRole('heading', { level: 1, name: /Stories aus dem/ })).toBeVisible();
  const create = page.getByTestId('story-new');
  await expect(create.getByRole('radio', { name: 'Karussell' })).toHaveAttribute('aria-checked', 'true');
  await expect(create.getByTestId('story-estimate')).toContainText('MOCK');
  await create.getByTestId('story-create').click();

  // four suggestions, the teaser opens: slide 1 as a card, the covered areas shown, MOCK labelled
  await expect(page.getByTestId('story-item')).toHaveCount(4, { timeout: 20000 });
  const editor = page.getByTestId('story-editor');
  await expect(editor.getByText('MOCK · kein LLM').first()).toBeVisible();
  const canvas = editor.getByTestId('story-canvas');
  await expect(canvas).toHaveAttribute('aria-label', /NEUES KARUSSELL/);
  await expect(canvas.getByTestId('slide-image')).toBeVisible();
  await expect(editor.getByText('Instagram-Leiste (verdeckt)')).toBeVisible();
  await expect(editor.getByTestId('story-sticker-area')).toContainText('Link-Sticker');

  // edit the main text ON the story
  await canvas.locator('[data-field="title"]').click();
  const inline = editor.getByTestId('story-inline-editor');
  await expect(inline).toBeVisible();
  await inline.fill('Neues Karussell: mein ruhiger Morgen');
  await inline.press('Escape');
  await expect(canvas).toHaveAttribute('aria-label', /mein ruhiger Morgen/);
  await editor.getByTestId('story-save').click();
  await expect(editor.getByTestId('story-revision')).toContainText('Fassung 2');

  // the exact PNG (FFmpeg + libass)
  await editor.getByTestId('story-render').click();
  await expect(editor.getByTestId('story-output').locator('img')).toBeVisible({ timeout: 60000 });

  // export the four stories as ZIP (all selected after creation)
  await expect(page.getByTestId('story-select').first()).toBeChecked();
  const download = page.waitForEvent('download', { timeout: 90000 });
  await page.getByTestId('stories-export').click();
  const dl = await download;
  expect(dl.suggestedFilename()).toMatch(/^stories-.*-4\.zip$/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-stories-'));
  const zip = path.join(dir, 's.zip');
  await dl.saveAs(zip);
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  expect(names).toEqual(['01.png', '02.png', '03.png', '04.png', 'notizen.txt']);
  execFileSync('unzip', ['-tq', zip]);
  const notes = execFileSync('unzip', ['-p', zip, 'notizen.txt'], { encoding: 'utf8' });
  expect(notes).toContain('Link-Sticker in Instagram setzen');
  expect(notes).toContain('Umfrage in Instagram setzen');
  expect(notes).toContain('das Studio postet nichts');
  const probe = execFileSync((process.env.FFPROBE_PATH || 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: execFileSync('unzip', ['-p', zip, '01.png']), encoding: 'utf8' }).trim();
  expect(probe).toBe('1080,1920');

  expect(errors).toEqual([]);
  await expect.poll(async () => (await request.delete(`/api/projects/${project.id}`)).status(), { timeout: 30000 }).toBe(200);
});
