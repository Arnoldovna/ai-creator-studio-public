import { crc32, deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { seedStrategy } from './helpers';

/**
 * Etappe 14 „Meine Marke“: confirm an observation → „ins Design System“ → colour role set → Meine Marke shows it with
 * its origin → edit and save (active version) → the video editor shows „Look aus Meine Marke (Style Bible vN)“.
 * Runs after smoke.spec.ts (file order), which expects an empty Style Lab.
 */
test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3100' });
  await seedStrategy(ctx, { ifMissing: true });
  await ctx.dispose();
});

/** A small RGB PNG with two flat colours (terracotta left, dark green right). */
function png(w = 8, h = 8): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, (_, x) => (x < w / 2 ? [200, 85, 61] : [32, 48, 42])).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('Meine Marke: observation → ins Design System → colour role → save → video editor uses the look', async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Style Lab: upload, analyse (mock), confirm the colour observation
  await page.goto('/style-lab');
  await page.getByTestId('file-input').setInputFiles({ name: 'marke.png', mimeType: 'image/png', buffer: png() });
  const card = page.getByTestId('reference-card').filter({ hasText: 'marke.png' });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: /KI-Analyse/ }).click();
  await page.getByRole('tab', { name: /KI-Analyse & Review/ }).click();
  const analysis = page.getByTestId('analysis-card').filter({ hasText: 'marke.png' });
  const colourObs = analysis.getByTestId('observation').filter({ hasText: 'Technische Farbstichprobe' });
  await colourObs.getByRole('button', { name: 'Bestätigen' }).click();
  await page.getByLabel('nur offene Vorschläge').uncheck();
  const confirmed = page.getByTestId('analysis-card').filter({ hasText: 'marke.png' }).getByTestId('observation').filter({ hasText: 'Technische Farbstichprobe' });
  await expect(confirmed).toContainText('bestätigt');

  // „ins Design System übernehmen“: colour → role Akzent
  const chip = confirmed.getByTestId('adopt-color').first();
  const hex = (await chip.textContent())!.match(/#[0-9A-F]{6}/)![0];
  await chip.click();
  await confirmed.getByLabel(`Farbrolle für ${hex}`).selectOption('accent');
  await confirmed.getByRole('button', { name: 'Ins Design System' }).click();
  await expect(page.getByRole('status')).toContainText(`${hex} ist jetzt „Akzent“ in Meine Marke`);
  // the observation also goes into the guidelines
  await confirmed.getByTestId('adopt-guideline').click();
  await expect(page.getByRole('status')).toContainText('In Meine Marke übernommen');

  // Meine Marke: reachable from the navigation, shows the role with its origin
  await page.getByRole('navigation').getByRole('link', { name: 'Meine Marke' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Meine Marke/ })).toBeVisible();
  const accent = page.getByTestId('color-accent');
  await expect(accent.getByTestId('color-hex')).toHaveText(hex);
  await expect(accent.getByTestId('origin')).toContainText('bestätigte Beobachtung');
  await expect(accent.getByTestId('origin')).toContainText('Technische Farbstichprobe');
  await expect(page.getByTestId('brand-leitlinien').getByRole('textbox')).toHaveValue(/Technische Farbstichprobe/);
  const version = (await page.getByTestId('brand-version').textContent())!.match(/v(\d+)/)![1]!;
  // contrast badges are shown with the colour roles
  await expect(page.getByTestId('color-onSurface')).toContainText(/Text auf Fläche: \d+\.\d:1/);
  // overlay style preview (DOM) from the core geometry
  await expect(page.getByTestId('stage-preview')).toContainText('Hook aus'); // wrapped into lines like the ASS

  // derive: before/after, nothing stored until „Speichern“
  await page.getByTestId('brand-derive').click();
  await expect(page.getByTestId('brand-proposal')).toContainText('deterministisch');
  await page.getByTestId('brand-proposal').getByRole('button', { name: 'Verwerfen' }).click();
  // AI suggestion is labelled mock
  await page.getByTestId('brand-suggest').click();
  await expect(page.getByTestId('brand-proposal')).toContainText('MOCK');
  await page.getByTestId('brand-proposal').getByRole('button', { name: 'Verwerfen' }).click();

  // edit: hook in upper case, save → new active version
  await page.getByLabel('Hook: Schreibweise').selectOption('upper');
  await expect(page.getByTestId('stage-preview')).toContainText('HOOK AUS');
  await page.getByTestId('brand-save').click();
  const next = String(Number(version) + 1);
  await expect(page.getByRole('status')).toContainText(`Style Bible v${next}`);
  await expect(page.getByTestId('brand-version')).toContainText(`Style Bible v${next} · aktiv`);
  await page.reload();
  await expect(page.getByLabel('Hook: Schreibweise')).toHaveValue('upper');
  await expect(page.getByTestId('color-accent').getByTestId('color-hex')).toHaveText(hex);

  // exact specimen through FFmpeg + libass (only when the installed FFmpeg has libass)
  const ff = await (await request.get('/api/status')).json();
  if (JSON.stringify(ff).includes('"subtitles":true')) {
    await page.getByTestId('specimen-button').click();
    await expect(page.getByTestId('specimen-image')).toBeVisible({ timeout: 30_000 });
  }

  // Video editor: a free cut pins the active version and says where the look comes from
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-fx-'))).find((f) => f.endsWith('landscape.mp4'))!;
  await request.post('/api/projects', { data: { title: 'Marken-Reel', kind: 'PERSONAL_CONTENT' } });
  await page.getByRole('navigation').getByRole('link', { name: /Video Studio/ }).click();
  await page.getByLabel('Projekt', { exact: true }).selectOption({ label: 'Marken-Reel' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip);
  await expect(page.getByTestId('footage-item')).toContainText('0:03');
  await page.getByTestId('view-classic').click(); // Etappe 12: the editor is the default view
  const planner = page.getByTestId('edit-planner');
  await planner.getByTestId('free-cut').getByRole('button', { name: '+ Clip' }).click();
  await expect(planner.getByTestId('look-line')).toContainText(`Look aus Meine Marke (Style Bible v${next})`);
  await expect(planner.getByTestId('ep-preset')).toBeVisible();
  await expect(planner.getByLabel('Schrift (Hook, Overlays)')).toHaveValue('__design');
  await planner.getByTestId('look-line').getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: /Meine Marke/ })).toBeVisible();
  expect(errors).toEqual([]);
});
