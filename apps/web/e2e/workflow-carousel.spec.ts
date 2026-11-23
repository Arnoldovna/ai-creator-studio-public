import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Etappe 18: Konzept → „Karussell daraus“ → „Karussell erstellen“ (Mock) → Slides sichtbar → Text auf Slide 2 direkt auf der
 * Slide ändern → speichern → anderen Look wählen → exakte PNGs → ZIP exportieren (01..05.png, caption.txt) → Chat „Slide 3
 * kürzer“ → Übernehmen = neue Version. Nothing is posted.
 */
test('Karussell: Konzept → erstellen (Mock) → Slide 2 auf der Slide bearbeiten → Look wählen → PNG → ZIP → Chat', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const project = await (await request.post('/api/projects', { data: { title: 'Karussell-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const other = await (await request.post('/api/projects', { data: { title: 'Karussell-Test 2', kind: 'PERSONAL_CONTENT' } })).json();
  const concepts = await request.post('/api/content/concepts', { data: { projectId: project.id, topic: 'Morgenstricken', verifiedFacts: ['Ich stricke seit 3 Jahren jeden Morgen.'] } });
  expect(concepts.ok()).toBe(true);

  // Content Lab: the concept offers a carousel
  await page.goto('/content-lab');
  await page.getByLabel('Projekt').selectOption({ label: 'Karussell-Test · Persönlich' });
  await expect(page.getByTestId('concept-card')).toHaveCount(3);
  await page.getByTestId('concept-card').first().getByTestId('concept-carousel').click();
  await expect(page.getByRole('heading', { level: 1, name: /Aus einer Idee/ })).toBeVisible();
  const create = page.getByTestId('carousel-new');
  await expect(create.getByRole('radio', { name: 'Konzept' })).toHaveAttribute('aria-checked', 'true');
  await expect(create.getByTestId('carousel-estimate')).toContainText('MOCK');
  await create.getByTestId('carousel-create').click();

  // slides visible (problem → way → result: 5), mock labelled
  const editor = page.getByTestId('carousel-editor');
  await expect(editor.getByTestId('slide-thumb')).toHaveCount(5, { timeout: 20000 });
  await expect(editor.getByText('MOCK · kein LLM').first()).toBeVisible();
  await expect(editor.getByTestId('slide-big')).toBeVisible();

  // slide 2: click its text ON the slide and change it
  await editor.getByTestId('slide-thumb').nth(1).click();
  await editor.getByTestId('slide-big').locator('[data-field="body"]').click();
  const inline = editor.getByTestId('slide-inline-editor');
  await expect(inline).toBeVisible();
  await inline.fill('Mein Kopf war morgens voll. Jetzt stricke ich zuerst eine Reihe.');
  await inline.press('Escape');
  await expect(inline).toHaveCount(0);
  // the slide's lines joined (aria-label): the new text is on the slide
  await expect(editor.getByTestId('slide-big')).toHaveAttribute('aria-label', /Jetzt stricke ich zuerst eine Reihe\./);
  // review fix: switching the project asks first; „Abbrechen“ keeps her unsaved edit
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
  await page.getByLabel('Projekt').selectOption({ label: 'Karussell-Test 2' });
  expect(asked).toContain('Ungespeicherte Änderungen');
  await expect(page.getByLabel('Projekt')).toHaveValue(project.id);
  await expect(editor.getByText('ungespeichert')).toBeVisible();
  await editor.getByTestId('carousel-save').click();
  await expect(editor.getByTestId('carousel-version')).toHaveText('v2 · deine Änderung');

  // three other looks side by side → choose „Kontrast“
  const variants = editor.getByTestId('carousel-variants');
  await expect(variants.locator('[data-testid^="variant-choose-"]')).toHaveCount(3);
  await variants.getByTestId('variant-choose-kontrast').click();
  await expect(editor.getByTestId('carousel-version')).toHaveText('v3 · anderer Look');

  // exact PNGs (FFmpeg + libass)
  await editor.getByTestId('carousel-render').click();
  await expect(editor.getByTestId('carousel-pngs').locator('img')).toHaveCount(5, { timeout: 60000 });

  // ZIP
  const download = page.waitForEvent('download', { timeout: 60000 });
  await editor.getByTestId('carousel-export').click();
  const dl = await download;
  expect(dl.suggestedFilename()).toMatch(/^karussell-.*-v3\.zip$/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-carousel-'));
  const zip = path.join(dir, 'k.zip');
  await dl.saveAs(zip);
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  expect(names).toEqual(['01.png', '02.png', '03.png', '04.png', '05.png', 'caption.txt', 'alt-text.txt']);
  execFileSync('unzip', ['-tq', zip]);
  expect(execFileSync('unzip', ['-p', zip, 'caption.txt'], { encoding: 'utf8' })).toContain('[MOCK]');
  const list = await (await request.get(`/api/projects/${project.id}/carousels`)).json();
  const saved = await (await request.get(`/api/projects/${project.id}/carousels/${list.carousels[0].id}`)).json();
  expect(saved.version.body.templateId).toBe('kontrast');
  expect(saved.version.body.slides[1].body).toBe('Mein Kopf war morgens voll. Jetzt stricke ich zuerst eine Reihe.');

  // chat in the carousel context: „Slide 2 kürzer“ → card → Übernehmen → a new version
  await editor.getByTestId('chat-open').click();
  await expect(page.getByTestId('chat-panel')).toContainText('Karussell');
  await page.getByTestId('chat-input').fill('Slide 2 kürzer');
  await page.getByTestId('chat-input').press('Enter');
  const card = page.getByTestId('chat-proposal');
  await expect(card).toContainText('Slide 2 kürzer', { timeout: 20000 });
  await card.getByTestId('chat-apply').click();
  await expect(editor.getByTestId('carousel-version')).toHaveText('v4 · Chat', { timeout: 20000 });
  await expect(editor.getByTestId('slide-big')).toHaveAttribute('aria-label', /Mein Kopf war morgens voll\./);
  await expect(editor.getByTestId('slide-big')).not.toHaveAttribute('aria-label', /Jetzt stricke ich/);
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
  // leave no project behind for the following workflows
  await expect.poll(async () => (await request.delete(`/api/projects/${project.id}`)).status(), { timeout: 30000 }).toBe(200);
  await expect.poll(async () => (await request.delete(`/api/projects/${other.id}`)).status(), { timeout: 30000 }).toBe(200);
});
