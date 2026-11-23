import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedStrategy } from './helpers';

/**
 * Etappe 20: a draft in the editor (a reel) → Wochenboard → „Woche füllen“ (Mock) → the reel suggestion „Übernehmen“ → drag
 * the reel to another day → „gepostet“ (her click, with link) → „Öffnen“ jumps into the video editor of its project. Empty
 * days stay neutral; nothing is posted.
 */
test('Woche: Woche füllen (Mock) → Reel übernehmen → per Drag auf anderen Tag → gepostet → Sprung in den Editor', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedStrategy(request, { ifMissing: true });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-week-'));
  const take = path.join(dir, 'take-3s.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take]);
  const project = await (await request.post('/api/projects', { data: { title: 'Wochen-Test', kind: 'PERSONAL_CONTENT' } })).json();
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Wochen-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(take);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert', { timeout: 30000 });

  // the board: Overview tile → Woche
  await page.goto('/');
  await page.getByTestId('overview-week').click();
  await expect(page.getByRole('heading', { level: 1, name: /Deine Woche/ })).toBeVisible();
  await expect(page.getByTestId('week-day')).toHaveCount(7);
  await expect(page.getByTestId('week-rhythm')).toContainText('nur Orientierung');
  await expect(page.locator('body')).not.toContainText(/verpasst|Streak|überfällig/i);

  // „Woche füllen“ (mock) → suggestions → take over the reel
  await page.getByTestId('week-fill').click();
  const reelSuggestion = page.getByTestId('week-suggestion').filter({ hasText: 'Reel' }).first();
  await expect(reelSuggestion).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('week-fill-panel')).toContainText('MOCK');
  await reelSuggestion.getByTestId('suggestion-accept').click();
  const reel = page.locator('[data-testid="board-item"][data-kind="reel"]').first();
  await expect(reel).toBeVisible();
  const fromDay = await reel.locator('xpath=ancestor::section[@data-testid="week-day"]').getAttribute('data-date');
  const days = await page.getByTestId('week-day').evaluateAll((els) => els.map((e) => e.getAttribute('data-date')!));
  const target = days[(days.indexOf(fromDay!) + 3) % 7]!;

  // drag the reel onto another day
  await reel.dragTo(page.locator(`[data-testid="week-day"][data-date="${target}"]`));
  await expect(page.locator(`[data-testid="week-day"][data-date="${target}"] [data-testid="board-item"][data-kind="reel"]`)).toHaveCount(1, { timeout: 10000 });
  const moved = page.locator(`[data-testid="week-day"][data-date="${target}"] [data-testid="board-item"][data-kind="reel"]`);

  // she posted it herself: status „gepostet“ with the link
  await moved.getByTestId('board-item-status').selectOption('posted');
  const form = moved.getByTestId('board-post-form');
  await form.getByLabel('Link (optional)').fill('https://www.instagram.com/reel/test/');
  await form.getByTestId('board-post-confirm').click();
  await expect(moved.getByText(/^gepostet \d/)).toBeVisible();
  const board = await (await request.get(`/api/board?week=${target}`)).json();
  const item = board.days.flatMap((d: { items: { kind: string; status: string; posted: { permalink: string } | null; projectId: string }[] }) => d.items).find((i: { kind: string }) => i.kind === 'reel');
  expect(item).toMatchObject({ status: 'posted', posted: { permalink: 'https://www.instagram.com/reel/test/' } });

  // jump into the editor of its material
  await moved.getByTestId('board-item-open').click();
  await expect(page).toHaveURL(/\/video-studio\?project=/);
  await expect(page.getByRole('heading', { level: 1, name: /Video Studio/ })).toBeVisible();
  await expect(page.getByLabel('Projekt', { exact: true })).toHaveValue(item.projectId);

  expect(errors).toEqual([]);
  await expect.poll(async () => (await request.delete(`/api/projects/${project.id}`)).status(), { timeout: 30000 }).toBe(200);
});
