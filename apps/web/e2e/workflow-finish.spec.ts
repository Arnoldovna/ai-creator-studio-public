import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Etappe 17 (runs after the other workflows): a draft in the editor → „Für CapCut exportieren“ (one click: render, clean
 * video, cover) → the ZIP downloads by itself → it holds the expected files with an SRT of the mock transcript and the text
 * sheet with her keyword. The QA button is disabled with its reason (TRANSCRIPTION=mock in E2E).
 */
test('CapCut-Paket: Entwurf → „Für CapCut exportieren“ → ZIP lädt → enthält Video ohne Text, SRT, Texte, Anleitung', async ({ page, request }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-finish-'));
  const ff = process.env.FFMPEG_PATH || 'ffmpeg';
  const take = path.join(dir, 'take-6s.mp4');
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take]);
  const project = await (await request.post('/api/projects', { data: { title: 'CapCut-Test', kind: 'PERSONAL_CONTENT' } })).json();

  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'CapCut-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(take);
  await expect(page.getByTestId('timeline-clip')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('transcript-word').first()).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');
  // a keyword at the playhead (text = the word under it), loudness off for speed
  await page.getByTestId('add-keyword').click();
  await page.getByLabel('Lautheit').selectOption('off');
  await expect(page.getByTestId('save-status')).toHaveText('Entwurf: gespeichert');

  const panel = page.getByTestId('finish-export').first();
  await expect(panel.getByTestId('finish-words')).toBeChecked();
  const download = page.waitForEvent('download', { timeout: 240000 });
  await panel.getByTestId('finish-start').click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('capcut-paket-capcut-test-v1.zip');
  const zip = path.join(dir, 'paket.zip');
  await dl.saveAs(zip);
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
  expect(names).toEqual(['ANLEITUNG.md', 'cover.png', 'projekt.fcpxml', 'texte.json', 'texte.txt', 'untertitel-woerter.srt', 'untertitel.srt', 'video-clean.mp4', 'video-mit-text.mp4'].sort());
  execFileSync('unzip', ['-tq', zip]);
  const text = (name: string) => execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8' });
  expect(text('untertitel.srt')).toMatch(/^1\r\n00:00:00,000 --> 00:00:0\d,\d{3}\r\nMOCK-Transkript/);
  const sheet = JSON.parse(text('texte.json'));
  expect(sheet).toMatchObject({ format: 'ai-creator-studio/texte', version: 1, picture: { width: 1080, height: 1920 } });
  expect(sheet.items).toEqual([expect.objectContaining({ kind: 'keyword', clip: 1 })]);
  expect(text('ANLEITUNG.md')).toContain('# In CapCut fertigstellen');
  expect(text('ANLEITUNG.md')).toContain('kein KI-Label eingebrannt');
  // the clean video is a real 1080×1920 MP4 and the ZIP link stays for a second download
  const clean = path.join(dir, 'clean.mp4');
  execFileSync('sh', ['-c', `unzip -p "${zip}" video-clean.mp4 > "${clean}"`]);
  const probe = execFileSync((process.env.FFPROBE_PATH || 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', clean], { encoding: 'utf8' }).trim().split('\n')[0];
  expect(probe).toBe('1080,1920');
  await expect(panel.getByTestId('finish-download')).toBeVisible();
  // the render list shows the render the one click made
  await expect(page.getByTestId('editor-render-item').first().getByText('fertig', { exact: true })).toBeVisible();
  // QA „fehlende Wörter“: needs whisper.cpp; with the mock transcription the button is off and says why
  await expect(panel.getByTestId('qa-start')).toBeDisabled();
  await expect(panel.getByTestId('qa-reason')).toContainText('Mock');
  expect(readFileSync(zip).subarray(0, 4).toString('hex')).toBe('504b0304');
  expect(errors).toEqual([]);
  await request.delete(`/api/projects/${project.id}`);
});
