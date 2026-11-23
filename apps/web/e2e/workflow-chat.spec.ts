import { expect, test } from '@playwright/test';
import { shiftColor } from '../../../packages/core/src/agents/studioChat';
import { seedStrategy } from './helpers';

test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3100' });
  await seedStrategy(ctx, { ifMissing: true });
  await ctx.dispose();
});

test('Chat (Etappe 15) auf Meine Marke: „mach den Akzent wärmer“ → Vorschlag mit Farbfeld → ohne Klick unverändert → Übernehmen → neue aktive Version', async ({ page, request }) => {
  const before = await (await request.get('/api/design-system')).json();
  const accent: string = before.design.colors.accent.hex;
  const warmer = shiftColor(accent, 'warmer');

  await page.goto('/meine-marke');
  await expect(page.getByTestId('brand-page')).toBeVisible();
  await page.getByTestId('chat-open').click();
  const panel = page.getByTestId('chat-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Meine Marke');
  await expect(page.getByTestId('chat-mock-note')).toBeVisible();
  await expect(page.getByTestId('chat-model')).toContainText('MOCK');

  await page.getByTestId('chat-input').fill('mach den Akzent wärmer');
  await page.getByTestId('chat-input').press('Enter');
  const reply = page.getByTestId('chat-assistant-message');
  await expect(reply).toHaveCount(1, { timeout: 30000 });
  await expect(reply).toContainText('[MOCK]');
  await expect(reply).toContainText('MOCK · kein LLM');
  const card = page.getByTestId('chat-proposal');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('chat-color-change')).toContainText(accent);
  await expect(card.getByTestId('chat-color-change')).toContainText(warmer);
  // without a click nothing changes
  expect((await (await request.get('/api/design-system')).json()).design.colors.accent.hex).toBe(accent);

  await card.getByTestId('chat-apply').click();
  await expect(card).toContainText('übernommen');
  const after = await (await request.get('/api/design-system')).json();
  expect(after.design.colors.accent.hex).toBe(warmer);
  expect(after.version.version).toBe((before.version?.version ?? 0) + 1);
  // the page shows the new active version; the history stays per page after a reload
  await expect(page.getByTestId('brand-version')).toContainText(`Style Bible v${after.version.version}`);
  await page.reload();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('chat-panel')).toBeVisible();
  await expect(page.getByTestId('chat-proposal')).toContainText('übernommen');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('chat-panel')).toHaveCount(0);
  // the strategy page has its own (empty) history
  await page.goto('/strategy');
  await page.getByTestId('chat-open').click();
  await expect(page.getByTestId('chat-panel')).toContainText('Strategie');
  await expect(page.getByTestId('chat-assistant-message')).toHaveCount(0);
});

test('Chat im Video-Editor: „Keyword ‚Ruhe‘ bei 3 s“ → Vorschlag → Übernehmen → Overlay auf der Bühne, ⌘Z nimmt es zurück', async ({ page, request }) => {
  test.setTimeout(240_000);
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const files = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-chat-')));
  const takes = ['landscape.mp4', 'portrait-rotated.mp4'].map((n) => files.find((f: string) => f.endsWith(n))!);
  const project = await (await request.post('/api/projects', { data: { title: 'Chat-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const draft = async () => (await (await request.get(`/api/projects/${project.id}/edit-draft?scriptId=`)).json()).draft;

  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Chat-Test' });
  // two 3-s takes: 3 s is the start of the second take
  await page.getByLabel('Videodateien auswählen').setInputFiles(takes[0]!);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await page.getByLabel('Videodateien auswählen').setInputFiles(takes[1]!);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(2, { timeout: 30000 });
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert', { timeout: 30000 });
  await expect(page.getByTestId('stage-overlay')).toHaveCount(0);

  await page.getByTestId('chat-open').click();
  await expect(page.getByTestId('chat-panel')).toContainText('Video-Editor');
  await page.getByTestId('chat-input').fill('Keyword ‚Ruhe‘ bei 3 s');
  await page.getByTestId('chat-send').click();
  const card = page.getByTestId('chat-proposal');
  await expect(card).toHaveCount(1, { timeout: 30000 });
  await expect(card).toContainText('Keyword „Ruhe“ bei 3,0 s');
  const rev = (await draft()).revision;
  expect((await draft()).body.clips.flatMap((c: { overlays: unknown[] }) => c.overlays)).toEqual([]);

  await card.getByTestId('chat-apply').click();
  await expect(card).toContainText('übernommen');
  await expect.poll(async () => (await draft()).revision).toBe(rev + 1);
  const overlays = (await draft()).body.clips.flatMap((c: { overlays: { kind: string; text: string }[] }) => c.overlays);
  expect(overlays).toEqual([expect.objectContaining({ kind: 'keyword', text: 'Ruhe' })]);
  // on the stage (the editor took the new revision over without a conflict)
  await page.getByTestId('chat-panel').getByLabel('Chat schließen (Esc)').click();
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  await expect(page.getByTestId('track-overlay')).toHaveCount(1);
  await page.getByTestId('track-overlay').first().click();
  await expect(page.getByTestId('stage-overlay')).toContainText('Ruhe');
  // undo is the previous draft state: ⌘Z removes it again and autosaves the next revision
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('track-overlay')).toHaveCount(0);
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  await expect.poll(async () => (await draft()).body.clips.flatMap((c: { overlays: unknown[] }) => c.overlays).length).toBe(0);
});
