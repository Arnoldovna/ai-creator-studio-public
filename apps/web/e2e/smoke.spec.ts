import { expect, test } from '@playwright/test';
import { seedStrategy } from './helpers';

// Etappe 10: no strategy gate any more; an active strategy is seeded so pillars exist (public phase here).
test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3100' });
  await seedStrategy(ctx, { ifMissing: true });
  await ctx.dispose();
});

// 2x1 PNG: one orange and one dark pixel
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGN4cOz/8ROMAAmEAy8Bj3cnAAAAAElFTkSuQmCC', 'base64');

test('navigation: all modules reachable, planned modules clearly labelled', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Dein Studio/ })).toBeVisible();
  await expect(page.getByText(/Demo-\/Mock-Modus/)).toBeVisible();
  for (const [label, heading] of [
    ['Strategie', /Strategie zuerst/], ['Style Lab', /Deine Referenzen/], ['Content Lab', /Content mit Konzept/], ['Rückblick', /Rückblick/],
    ['UGC Projects', /Projekte & Kunden/], ['Settings', /Einstellungen/], ['Karussells', /Aus einer Idee/],
    ['Woche', /Deine Woche/], ['Stories', /Stories aus dem/], ['Video Studio', /Video Studio/],
  ] as const) {
    await page.getByRole('navigation').getByRole('link', { name: new RegExp(label) }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  await expect(page.getByText(/NOCH NICHT MÖGLICH/)).toBeVisible(); // Video Studio: what the cut cannot do yet
  // Model router: dry-run decisions per use case are visible, nothing is called in mock mode
  await page.getByRole('navigation').getByRole('link', { name: /Settings/ }).click();
  const routes = page.getByTestId('routing-table');
  await expect(routes).toContainText('Vorschau');
  await expect(routes.getByRole('row')).toHaveCount(18); // header + 17 use cases (Etappe 15: studio_chat, 16: edit_direction, 18: carousel_writing, 19: story_writing, 20: week_planning)
  await expect(routes).toContainText('Referenzbild-Analyse');
  await expect(routes).toContainText('gesperrt'); // confidential client data without allowlist
  // Settings card „Standard“ (Etappe 10): visible; the e2e server runs with STUDIO_DEFAULTS_DIR=off and says so
  const defaults = page.getByTestId('defaults-card');
  await expect(defaults.getByRole('heading', { name: 'Standard' })).toBeVisible();
  await expect(defaults).toContainText('Aus (STUDIO_DEFAULTS_DIR=off).');
  await expect(defaults.getByRole('button', { name: 'Jetzt sichern' })).toHaveCount(0);
  // one backup export with everything (no separate private export)
  await expect(page.getByTestId('export-buttons').getByRole('link')).toHaveCount(1);
});

test('full flow: upload → rate → analyse → review → style bible → concepts → script → analytics', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Style Lab: upload + rate
  await page.goto('/style-lab');
  await page.getByTestId('file-input').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('reference-card')).toHaveCount(1);
  await expect(page.getByTestId('ref-count')).toContainText('01');
  await expect(page.getByTestId('reference-card').locator('img')).toBeVisible();
  await page.getByRole('button', { name: 'Bewerten ↗' }).click();
  await page.getByLabel('Mag ich · Merkmale').fill('warme Schatten, grobe Typo');
  await page.getByLabel('Mag ich nicht').fill('Neonfilter');
  await page.getByRole('radio', { name: 'Farbe 5' }).click();
  await page.getByRole('button', { name: 'Merkmale speichern' }).click();
  await expect(page.getByTestId('reference-card')).toContainText('warme Schatten');

  // AI analysis (mock) + human review gate
  await page.getByRole('button', { name: /KI-Analyse/ }).click();
  await expect(page.getByRole('button', { name: /Vorschläge prüfen/ })).toBeVisible();
  await page.getByRole('button', { name: /Vorschläge prüfen/ }).click();
  await expect(page.getByTestId('analysis-card')).toContainText('MOCK');
  const first = page.getByTestId('observation').first();
  await first.getByRole('button', { name: 'Bestätigen' }).click();
  await page.getByLabel('nur offene Vorschläge').uncheck();
  await expect(page.getByTestId('observation').first()).toContainText('bestätigt');

  // Style Bible
  await page.getByRole('tab', { name: 'Style Bible & Voice' }).click();
  await page.getByLabel('Name deiner Designsprache').fill('Curious Editorial');
  await page.getByLabel('Visuelle Leitbegriffe').fill('grafisch, warm');
  // Style Director: suggestion only, applied to the form on request
  await page.getByRole('button', { name: /KI-Vorschlag aus Beobachtungen/ }).click();
  const styleSuggestion = page.getByTestId('suggestion-style');
  await expect(styleSuggestion).toContainText('MOCK');
  await expect(page.getByTestId('style-preview')).toContainText('Erstelle zuerst deine Style Bible');
  await styleSuggestion.getByRole('button', { name: 'In Formular übernehmen' }).click();
  await expect(styleSuggestion.getByRole('button', { name: '✓ Im Formular' })).toBeVisible();
  await expect(page.getByLabel('Name deiner Designsprache')).toHaveValue('Curious Editorial');
  await expect(page.getByLabel('Visuelle Leitbegriffe')).toHaveValue(/grafisch\nwarm/);
  // Etappe 10: saving makes the version active at once (no separate approval)
  await page.getByRole('button', { name: /Style Bible aus Formular speichern/ }).click();
  await expect(page.getByTestId('style-preview')).toContainText('VERSION 1 · AKTIV');
  await expect(page.getByTestId('style-preview')).toContainText('Neonfilter');
  await expect(page.getByTestId('style-preview')).toContainText('Aktiv für Content-Agenten');
  await expect(page.getByRole('button', { name: /Version freigeben/ })).toHaveCount(0);
  await page.getByLabel('So klinge ich').fill('neugierig, direkt');
  await page.getByLabel(/Eigene Texte analysieren/).fill('Ich hab heute die Maschine neu eingefädelt. Klingt banal? War es nicht.\n\nDu kennst das bestimmt: ein Faden, drei Knoten.');
  await page.getByRole('button', { name: /Stimme analysieren/ }).click();
  const voiceSuggestion = page.getByTestId('suggestion-voice');
  await expect(voiceSuggestion).toContainText('stellt Fragen – „Klingt banal?“');
  await voiceSuggestion.getByRole('button', { name: 'Merkmale übernehmen' }).click();
  await expect(page.getByLabel('So klinge ich')).toHaveValue(/neugierig\ndirekt\n/);
  await page.getByRole('button', { name: 'Voice Guide aus Formular speichern' }).click();
  await expect(page.getByText('Voice-Versionen')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '↓ Markdown' }).click();
  expect((await download).suggestedFilename()).toBe('curious-editorial-style-bible-v1.md');

  // Content Lab
  await page.getByRole('navigation').getByRole('link', { name: /Content Lab/ }).click();
  await expect(page.getByText(/Curious Editorial v1 \(aktiv\)/)).toBeVisible();
  await page.getByLabel('Produkt oder Thema').fill('meine Strickmaschine');
  await page.getByLabel(/Verifizierte Fakten/).fill('Die Maschine hat 200 Nadeln');
  // Research from own sources → adopt a quoted fact into the brief
  const research = page.getByTestId('research-panel');
  await research.getByRole('button', { name: /Recherche aus eigenen Quellen/ }).click();
  await research.getByLabel('Quelle 1 Titel').fill('Handbuch');
  await research.getByLabel('Quelle 1 Text').fill('Die Strickmaschine arbeitet mit Lochkarten. Muster werden so wiederholbar.');
  await research.getByRole('button', { name: /Aus meinen Quellen recherchieren/ }).click();
  await expect(research.getByTestId('research-report')).toContainText('„Die Strickmaschine arbeitet mit Lochkarten.“');
  await research.getByRole('button', { name: 'Zitat als verifizierten Fakt übernehmen' }).click();
  await expect(page.getByLabel(/Verifizierte Fakten/)).toHaveValue('Die Maschine hat 200 Nadeln\nDie Strickmaschine arbeitet mit Lochkarten.');
  await page.getByLabel('Videolänge').selectOption('45');
  await page.getByLabel('Format').selectOption('voiceover');
  await page.getByLabel('Säule (optional)').selectOption({ label: 'Werkstatt' });
  await page.getByRole('button', { name: /Drei Konzepte erstellen/ }).click();
  await expect(page.getByTestId('concept-card')).toHaveCount(3);
  await expect(page.getByTestId('concept-card').nth(1)).toContainText('Säule Werkstatt');
  // Etappe 10: no FitCheck – the concept goes straight to the script
  await page.getByTestId('concept-card').nth(1).getByRole('button', { name: /Skript daraus bauen/ }).click();
  await expect(page.getByTestId('fit-check')).toHaveCount(0);
  const editor = page.getByTestId('script-editor');
  await expect(editor).toContainText('VOICEOVER · 45 SEKUNDEN');
  await expect(editor.getByTestId('scene')).toHaveCount(4);
  await editor.getByLabel('CTA', { exact: true }).fill('Was soll ich als Nächstes stricken?');
  await editor.getByRole('button', { name: 'Als neue Version speichern' }).click();
  await expect(editor.getByRole('list', { name: 'Skriptversionen' }).getByRole('button')).toHaveCount(2);
  // own project: one click, no claims checkbox, no strategy check
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  await expect(editor.getByTestId('strategy-gate')).toHaveCount(0);
  await editor.getByRole('button', { name: /Skript freigeben/ }).click();
  await expect(editor.getByText('freigegeben', { exact: true })).toBeVisible();

  // QA, cinematic direction and caption for the approved version (drafts; her own caption needs no confirmation)
  const agents = editor.getByTestId('script-agents');
  await agents.getByRole('button', { name: /Skript prüfen/ }).click();
  await expect(agents.getByTestId('output-qa')).toContainText('MOCK');
  await agents.getByRole('button', { name: /Dreh planen/ }).click();
  await expect(agents.getByTestId('output-storyboard')).toContainText('Shotlist');
  await agents.getByRole('button', { name: /Caption schreiben/ }).click();
  const copyCard = agents.getByTestId('output-copy');
  await expect(copyCard.getByTestId('caption')).toBeVisible();
  await expect(copyCard.getByRole('checkbox')).toHaveCount(0);
  await expect(copyCard.getByRole('button', { name: /Caption freigeben/ })).toBeEnabled();
  await copyCard.getByRole('button', { name: /Caption freigeben/ }).click();
  await expect(copyCard.getByText('freigegeben', { exact: true })).toBeVisible();

  // Rückblick (public phase here): publication linked to script version + manual insight
  await page.getByRole('navigation').getByRole('link', { name: /Rückblick/ }).click();
  await page.getByLabel('Beitrag / Reel').fill('Strick-Reel #1');
  await page.getByLabel(/Skriptversion/).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Veröffentlichung speichern' }).click();
  await expect(page.getByTestId('publication')).toContainText('Style: Curious Editorial v1');
  await page.getByLabel('Erreichte Accounts *').fill('1200');
  await page.getByLabel('Views *').fill('1800');
  await page.getByLabel('Saves *').fill('35');
  await page.getByLabel('Shares *').fill('21');
  await page.getByRole('button', { name: /Ergebnis speichern/ }).click();
  await expect(page.getByTestId('publication')).toContainText('2,92 %');
  await expect(page.getByText(/Experiment-Hypothese/)).toBeVisible();
  // Growth Analyst: draft report, then explicitly used for ideation
  const growth = page.getByTestId('growth-panel');
  await growth.getByRole('button', { name: /Growth-Analyse erstellen/ }).click();
  await expect(growth.getByTestId('growth-report')).toContainText('4,67 %'); // (35+21)/1200
  await growth.getByRole('button', { name: /Für Ideation verwenden/ }).click();
  await expect(growth.getByText('für Ideation', { exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});

test('Style Bible: „Bearbeiten“ right at the active version → „Speichern“ makes a new active version', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/style-lab');
  await page.getByRole('tab', { name: 'Style Bible & Voice' }).click();
  const preview = page.getByTestId('style-preview');
  const before = await (await page.request.get('/api/style')).json();
  const active = before.versions.find((v: { status: string }) => v.status === 'approved');
  expect(active).toBeTruthy();
  const next = Math.max(...before.versions.map((v: { version: number }) => v.version)) + 1;
  await expect(preview).toContainText(`VERSION ${active.version} · AKTIV`);
  await preview.getByRole('button', { name: 'Bearbeiten' }).click();
  const rules = preview.getByTestId('style-rules-editor');
  await expect(preview).toContainText(`VERSION ${active.version} BEARBEITEN`);
  // chips are editable in place, new ones are added below
  await rules.getByLabel('Visuelle Eigenschaften 1', { exact: true }).fill('grafisch-klar');
  await rules.getByLabel('Neu: Visuelle Eigenschaften').fill('texturbetont');
  await rules.getByTestId('chips-Visuelle Eigenschaften').getByRole('button', { name: '+ hinzufügen' }).click();
  await rules.getByRole('button', { name: 'Speichern' }).click();
  await expect(preview).toContainText(`VERSION ${next} · AKTIV`);
  await expect(preview).toContainText('grafisch-klar');
  await expect(preview).toContainText('texturbetont');
  await expect(preview).toContainText('Aktiv für Content-Agenten');
  const after = await (await page.request.get('/api/style')).json();
  expect(after.versions.filter((v: { status: string }) => v.status === 'approved').map((v: { version: number }) => v.version)).toEqual([next]);
  expect(after.versions.find((v: { id: string }) => v.id === active.id).status).toBe('archived'); // history stays
  expect(errors).toEqual([]);
});

test('APIs: workflow endpoints require token and are idempotent; uploads are validated', async ({ request }) => {
  expect((await request.post('/api/jobs/content-generation', { data: {} })).status()).toBe(401);
  // CSRF: a cross-site page must not be able to write (review finding)
  const csrf = await request.post('/api/projects', { data: { title: 'evil', kind: 'PERSONAL_CONTENT' }, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  expect(csrf.status()).toBe(403);
  const projects = await (await request.get('/api/projects')).json();
  const body = { idempotencyKey: 'e2e-content-0001', payload: { brief: { projectId: projects[0].id, topic: 'n8n Test', pillarId: 'werkstatt' } } };
  const headers = { Authorization: 'Bearer e2e-job-token' };
  const a = await (await request.post('/api/jobs/content-generation', { data: body, headers })).json();
  const b = await (await request.post('/api/jobs/content-generation', { data: body, headers })).json();
  expect(a.result.conceptIds).toHaveLength(3);
  expect(b.replayed).toBe(true);
  const bad = await request.post('/api/references', { multipart: { file: { name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload=alert(1)>') } } });
  expect(bad.status()).toBe(400);
  const invalid = await request.post('/api/content/concepts', { data: { projectId: projects[0].id, topic: '' } });
  expect(invalid.status()).toBe(400);
  // media is streamed with Range support (video seeking without full downloads)
  const refs = await (await request.get('/api/references')).json();
  const ref = refs[0];
  const full = await request.get(`/api/media/${ref.id}`);
  expect(full.status()).toBe(200);
  expect(full.headers()['accept-ranges']).toBe('bytes');
  const part = await request.get(`/api/media/${ref.id}`, { headers: { range: 'bytes=0-7' } });
  expect(part.status()).toBe(206);
  expect(part.headers()['content-range']).toBe(`bytes 0-7/${ref.size}`);
  expect((await part.body()).equals((await full.body()).subarray(0, 8))).toBe(true);
  expect((await request.get(`/api/media/${ref.id}`, { headers: { range: `bytes=${ref.size + 10}-` } })).status()).toBe(416);
});

test('Video Studio: own footage needs no rights checkbox; licensed footage needs confirmed rights and a source; streams, lists and deletes', async ({ page }) => {
  // MP4 `ftyp` header + padding: accepted as video, not decodable (probe warning expected)
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2'), Buffer.alloc(4096)]);
  await page.goto('/video-studio');
  const picker = page.getByLabel('Videodateien auswählen');
  // Etappe 10: „Eigene Aufnahme“ (the default) carries the rights implicitly
  await expect(page.getByRole('checkbox', { name: /Rechte an diesem Material/ })).toHaveCount(0);
  await expect(page.getByText('Eigene Aufnahme: Die Rechte liegen bei dir, keine Bestätigung nötig.')).toBeVisible();
  await expect(page.getByTestId('upload-blocked')).toHaveCount(0);
  await expect(picker).toBeEnabled();
  // licensed material: confirmation and source stay mandatory
  await page.getByLabel('Herkunft').selectOption({ label: 'Lizenziert' });
  await expect(picker).toBeDisabled(); // rights not confirmed yet
  await expect(page.getByTestId('upload-blocked')).toContainText('Rechte'); // the drop zone says why it is locked
  await page.getByRole('checkbox', { name: /Rechte an diesem Material/ }).check();
  await expect(picker).toBeDisabled(); // licence note missing
  await page.getByLabel('Lizenz / Quelle').fill('Eigene Lizenz, Rechnung 42');
  await expect(page.getByTestId('upload-blocked')).toHaveCount(0);
  await picker.setInputFiles({ name: 'take1.mp4', mimeType: 'video/mp4', buffer: mp4 });
  const item = page.getByTestId('footage-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('take1.mp4');
  await expect(item).toContainText('Lizenziert');
  await expect(item).toContainText('Rechnung 42');
  await expect(item).toContainText(/ffprobe/);
  await item.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.getByTestId('footage-item')).toHaveCount(0);
});

test('Video Studio: worker self-test runs in the background, a long one can be cancelled', async ({ page }) => {
  await page.goto('/video-studio');
  const jobs = page.getByTestId('video-jobs');
  await page.getByLabel('Worker-Test:').selectOption({ label: '10 min Testbild' });
  await jobs.getByRole('button', { name: 'Test starten' }).click();
  const job = page.getByTestId('video-job').first();
  await expect(job).toContainText('läuft', { timeout: 15000 });
  await expect(job.getByRole('progressbar')).toBeVisible();
  await job.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(job).toContainText('abgebrochen', { timeout: 15000 });

  await page.getByLabel('Worker-Test:').selectOption({ label: '10 s Testbild' });
  await jobs.getByRole('button', { name: 'Test starten' }).click();
  await expect(page.getByTestId('video-job').first()).toContainText(/fertig.*danach gelöscht/s, { timeout: 60000 });
});

test('Video Studio: EDL editor lists the script scenes and refuses unknown footage', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { title: 'Schnitt-Test', kind: 'PERSONAL_CONTENT' } })).json();
  const { concepts } = await (await request.post('/api/content/concepts', { data: { projectId: project.id, topic: 'Morgenroutine', lengthSeconds: 15, pillarId: 'werkstatt' } })).json();
  const script = await (await request.post(`/api/content/concepts/${concepts[0].id}/script`)).json();
  // an EDL needs footage with a known duration; an unknown asset is refused with a clear reason
  const bad = await request.post(`/api/projects/${project.id}/edit-plans`, { data: { scriptId: script.id, body: { clips: [{ sceneIndex: 0, assetId: 'nope', inSec: 0, outSec: 1 }] } } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/Footage nicht gefunden/);

  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Schnitt-Test' });
  await page.getByTestId('view-classic').click(); // Etappe 12: the editor is the default view
  const planner = page.getByTestId('edit-planner');
  await expect(planner.getByTestId('edit-scene')).toHaveCount(script.body.scenes.length);
  await expect(planner).toContainText('Kein Footage mit bekannter Dauer');
  await expect(planner.getByRole('button', { name: 'Als neue Version speichern' })).toBeDisabled();
  await request.delete(`/api/projects/${project.id}`);
});

test('Video Studio: transcribe a real clip (labelled mock), correct the transcript as a new version', async ({ page, request }) => {
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-fx-'))).find((f) => f.endsWith('landscape.mp4'))!;
  const project = await (await request.post('/api/projects', { data: { title: 'Transkript-Test', kind: 'PERSONAL_CONTENT' } })).json();
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Transkript-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip); // own footage: no rights checkbox
  const item = page.getByTestId('footage-item');
  await expect(item).toContainText('landscape.mp4');
  // Etappe 12: the transcription starts by itself after the preparation (no click)
  await expect(item).toContainText('MOCK-Transkript', { timeout: 60000 });
  await item.getByRole('button', { name: 'Transkript', exact: true }).click();
  const editor = page.getByTestId('transcript-editor');
  await expect(editor).toContainText('MOCK · kein echtes Transkript');
  await editor.getByLabel('Segment 1').fill('Heute zeige ich euch, wie ich Wolle färbe.');
  await editor.getByRole('button', { name: 'Korrektur speichern' }).click();
  await expect(editor).toContainText('Transkript v2');
  await expect(item).toContainText('MOCK-Transkript (korrigiert)'); // a corrected mock stays labelled
  await request.delete(`/api/projects/${project.id}`);
});

test('Video Studio end to end: upload → transcript → take match → EDL → render → review (real FFmpeg, mock transcript)', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-fx-'))).find((f) => f.endsWith('landscape.mp4'))!;
  const project = await (await request.post('/api/projects', { data: { title: 'Ende-zu-Ende', kind: 'PERSONAL_CONTENT' } })).json();
  const { concepts } = await (await request.post('/api/content/concepts', { data: { projectId: project.id, topic: 'Wolle färben', lengthSeconds: 15, pillarId: 'werkstatt' } })).json();
  const script = await (await request.post(`/api/content/concepts/${concepts[0].id}/script`)).json();
  const dialogue: string = script.body.scenes[0].dialogue;

  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Ende-zu-Ende' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip); // own footage: no rights checkbox
  const item = page.getByTestId('footage-item');
  await expect(item).toContainText('0:03'); // real ffprobe duration
  await expect(item).toContainText('MOCK-Transkript', { timeout: 60000 }); // Etappe 12: transcribed automatically
  // the user corrects the transcript with what was said in the take
  await item.getByRole('button', { name: 'Transkript', exact: true }).click();
  await page.getByTestId('transcript-editor').getByLabel('Segment 1').fill(dialogue);
  await page.getByTestId('transcript-editor').getByRole('button', { name: 'Korrektur speichern' }).click();
  await expect(item).toContainText('MOCK-Transkript (korrigiert)');

  // take matching pre-fills the EDL; the user saves (Etappe 10: no script or plan approval in her own project)
  await page.getByTestId('view-classic').click(); // Etappe 12: the editor is the default view
  const planner = page.getByTestId('edit-planner');
  await planner.getByRole('button', { name: 'Takes vorschlagen' }).click();
  // scene 1 is matched to the corrected take (other scenes may match shared words, too)
  await expect(planner.getByTestId('edit-scene').first().getByTestId('edit-clip')).toHaveCount(1);
  await expect(planner.getByTestId('edit-scene').first().getByTestId('edit-clip')).toContainText('Treffer 100 %');
  await planner.getByLabel('Lautheit').selectOption('off');
  await planner.getByRole('button', { name: 'Als neue Version speichern' }).click();
  const plan = planner.getByTestId('edit-plan').first();
  await expect(plan).toContainText('Entwurf');
  await expect(plan.getByRole('button', { name: 'Freigeben' })).toHaveCount(0);
  await expect(plan.getByTestId('strategy-gate')).toHaveCount(0);
  expect((await (await request.get(`/api/content?projectId=${project.id}`)).json()).scripts.find((x: { id: string }) => x.id === script.id).status).toBe('draft');

  // „Rendern“ right at the saved draft (implicit approval), in the background, then the optional review
  await plan.getByRole('button', { name: 'Rendern' }).click();
  const render = planner.getByTestId('render').first();
  await expect(render).toContainText('wartet auf Prüfung', { timeout: 120000 });
  await expect(render.locator('video')).toBeVisible();
  await expect(render).toContainText('Die Prüfung ist optional.');
  await render.getByRole('button', { name: 'Freigeben' }).click();
  await expect(render).toContainText('freigegeben');
  // the approved render cannot be deleted and keeps its footage
  await expect(render.getByRole('button', { name: 'Löschen' })).toHaveCount(0);
  await request.delete(`/api/projects/${project.id}`);
});

test('Video Studio: Freier Schnitt without a script — whole clip, manual cut, zoom, save → render directly, review (real FFmpeg)', async ({ page, request }) => {
  test.setTimeout(180_000);
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-fx-'))).find((f) => f.endsWith('landscape.mp4'))!;
  const project = await (await request.post('/api/projects', { data: { title: 'Freier-Schnitt', kind: 'PERSONAL_CONTENT' } })).json();
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Freier-Schnitt' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip); // own footage: no rights checkbox
  await expect(page.getByTestId('footage-item')).toContainText('0:03');

  // no script in the project: the planner offers the free cut directly
  await page.getByTestId('view-classic').click(); // Etappe 12: the editor is the default view
  const planner = page.getByTestId('edit-planner');
  await expect(planner.getByLabel('Grundlage')).toHaveValue('__free');
  await expect(planner.getByTestId('free-cut-note')).toBeVisible();
  await planner.getByTestId('free-cut').getByRole('button', { name: '+ Clip' }).click();
  const row = planner.getByTestId('edit-clip');
  await expect(row).toHaveCount(1);
  await expect(row.getByLabel('Out (s)')).not.toHaveValue('0'); // the whole clip by default
  await row.getByText('Schnitt, Zoom & Overlays').click();
  await row.getByLabel('Schnitt von (s)').fill('1');
  await row.getByLabel('bis (s)').fill('1.5');
  await row.getByRole('button', { name: 'Schnitt hinzufügen' }).click();
  await expect(row.getByTestId('clip-cut')).toContainText('1.00–1.50 s');
  await row.getByLabel('Zoom').selectOption('push_in');
  await expect(row).toContainText('1 Schnitt');
  // hook, overlays and look: honest about libass and the style source (no fake preview)
  await expect(planner.getByTestId('look-line')).toContainText(/Platzhalter|Style Bible v\d+/);
  const caps = await (await request.get(`/api/projects/${project.id}/edit-plans`)).json();
  if (!caps.capabilities.overlays) {
    await expect(planner.getByTestId('hook-editor')).toContainText('libass');
    await expect(planner.getByTestId('hook-editor').getByRole('checkbox')).toBeDisabled();
    await expect(row.getByTestId('overlay-editor').getByRole('button', { name: /ab Player-Position/ })).toBeDisabled();
  } else {
    const hookEditor = planner.getByTestId('hook-editor');
    await hookEditor.getByRole('checkbox').first().check();
    await expect(planner.getByLabel(/Eigener Hook/)).toBeVisible();
    // Etappe 10: a free hook needs no claim confirmation, and it sits at the top by default
    await planner.getByLabel(/Eigener Hook/).fill('Mein Morgen mit Wolle');
    await expect(hookEditor.getByRole('checkbox')).toHaveCount(1); // only the on/off switch
    await expect(hookEditor.locator('#ep-hook-slot')).toHaveValue('upper');
    await hookEditor.getByRole('checkbox').first().uncheck();
  }
  await planner.getByLabel('Lautheit').selectOption('off');
  await planner.getByRole('button', { name: 'Als neue Version speichern' }).click();
  const plan = planner.getByTestId('edit-plan').first();
  await expect(plan).toContainText('Freier Schnitt');
  await expect(plan).toContainText('1 Schnitt · Push-in');
  // Etappe 10: no FitCheck, no separate approval – „Rendern“ right at the saved version
  await expect(plan.getByTestId('strategy-gate')).toHaveCount(0);
  await expect(plan.getByRole('button', { name: 'Freigeben' })).toHaveCount(0);
  await plan.getByRole('button', { name: 'Rendern' }).click();
  await expect(plan).toContainText('freigegeben'); // the render approved the plan implicitly
  const render = planner.getByTestId('render').first();
  await expect(render).toContainText('wartet auf Prüfung', { timeout: 120000 });
  await render.getByRole('button', { name: 'Freigeben' }).click();
  await expect(render).toContainText('freigegeben');
  // loading the version brings back its cut and zoom
  await plan.getByRole('button', { name: 'Laden' }).click();
  await expect(planner.getByTestId('edit-clip').getByLabel('Zoom')).toHaveValue('push_in');
  const clips = planner.getByTestId('edit-clip');
  const first = clips.nth(0);
  await expect(first.getByTestId('clip-cut')).toHaveCount(1);
  const video = planner.locator('video').first();
  const at = () => video.evaluate((v: HTMLVideoElement) => v.currentTime);
  // previewing a cut of a clip that is NOT shown: the player switches to it (reloads) and starts 0.5 s before the cut
  await planner.getByTestId('free-cut').getByRole('button', { name: '+ Clip' }).click();
  await expect(clips).toHaveCount(2);
  await clips.nth(1).getByLabel('In (s)').fill('0.2'); // clip 2 shown with another start: switching back reloads the video
  await expect(video).toHaveAttribute('src', /#t=0\.2$/);
  await first.getByRole('button', { name: '▶ ab 0,5 s davor' }).click();
  await expect(video).toHaveAttribute('src', /#t=0$/);
  await expect.poll(at, { timeout: 10000 }).toBeCloseTo(0.5, 1);
  // a cut start set in clip 1 does not carry over to clip 2
  await planner.getByRole('button', { name: 'Schnitt ab Position' }).click();
  await clips.nth(1).getByRole('button', { name: 'Vorschau' }).click();
  await expect(planner.getByRole('button', { name: 'Schnitt bis Position' })).toBeDisabled();
  await clips.nth(1).getByRole('button', { name: 'Entfernen' }).click();
  await expect(clips).toHaveCount(1);
  // moving Out before the cut removes it with a visible notice instead of a failing save
  await first.getByLabel('Out (s)').fill('0.8');
  await first.getByLabel('Out (s)').blur();
  await expect(planner.getByRole('status')).toContainText('Außerhalb des neuen In/Out entfernt – Clip 1: 1 Schnitt');
  await expect(first.getByTestId('clip-cut')).toHaveCount(0);
  await request.delete(`/api/projects/${project.id}`);
});

test('Video Studio: filler and pause suggestions load per clip, honestly labelled, nothing pre-selected', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { makeFixtures } = await import('../../../scripts/make-video-fixtures.mjs');
  const { mkdtempSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const clip = makeFixtures(mkdtempSync(path.join(os.tmpdir(), 'e2e-fx-'))).find((f) => f.endsWith('landscape.mp4'))!;
  const project = await (await request.post('/api/projects', { data: { title: 'Füllwort-Test', kind: 'PERSONAL_CONTENT' } })).json();
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'Füllwort-Test' });
  await page.getByLabel('Videodateien auswählen').setInputFiles(clip); // own footage: no rights checkbox
  await expect(page.getByTestId('footage-item')).toContainText('0:03');
  await page.getByTestId('view-classic').click(); // Etappe 12: the editor is the default view
  const planner = page.getByTestId('edit-planner');
  await planner.getByTestId('free-cut').getByRole('button', { name: '+ Clip' }).click();
  const row = planner.getByTestId('edit-clip');
  await row.getByText('Schnitt, Zoom & Overlays').click();
  const panel = row.getByTestId('cut-suggestions');
  // Etappe 12: the transcription (labelled mock here, with the silence scan) starts by itself after the upload
  await expect.poll(async () => {
    await panel.getByRole('button', { name: /Vorschläge laden|Neu laden/ }).click();
    return panel.textContent();
  }, { timeout: 60000 }).toContain('Stille gemessen unter');
  await expect(panel.getByTestId('mock-transcript-note')).toContainText('Demo-Transkript (Mock-Modus)'); // mock transcript, said plainly
  await expect(panel).toContainText('Ohne DTW-Wortzeiten');
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await request.delete(`/api/projects/${project.id}`);
});

test('Video Studio: generated B-roll is labelled mock, needs a project opt-in and a credit budget', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { title: 'B-Roll-Test', kind: 'PERSONAL_CONTENT' } })).json();
  // without opt-in nothing can be quoted (the gate is in the API, not only in the UI)
  const refused = await request.post(`/api/projects/${project.id}/ai-broll`, { data: { action: 'quote', storyboardId: 'x', briefIndex: 0, model: 'seedance_2_5', durationSec: 5 } });
  expect(refused.status()).toBe(409);
  await page.goto('/video-studio');
  await page.getByLabel('Projekt').selectOption({ label: 'B-Roll-Test' });
  const panel = page.getByTestId('ai-broll');
  await expect(panel).toContainText('MOCK · keine echten Credits');
  await expect(panel).toContainText('Monat: 0 / 100 Credits gebunden');
  const optIn = panel.getByRole('checkbox', { name: /KI-B-Roll erlauben/ });
  await optIn.click(); // saved on the server, then shown as checked
  await expect(optIn).toBeChecked();
  await panel.getByLabel('Projektbudget (Credits)').fill('40');
  await panel.getByRole('button', { name: 'Speichern' }).click();
  await expect(panel.getByTestId('ai-broll-budget')).toContainText('Projekt: 0 / 40');
  await expect(panel).toContainText('Keine freigegebenen KI-Asset-Briefs');
});

test('Model Lab: compare two models (mock), rate, pin a model', async ({ page }) => {
  await page.goto('/model-lab');
  const lab = page.getByTestId('model-lab');
  await expect(lab).toContainText('MOCK');
  const models = page.getByRole('list', { name: 'Modelle' });
  await models.getByRole('checkbox').nth(0).check();
  await models.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: 'Vergleich starten' }).click();
  await expect(page.getByTestId('eval-result')).toHaveCount(2);
  const first = page.getByTestId('eval-result').first();
  await first.getByRole('radio', { name: 'Genauigkeit 4' }).click();
  await first.getByRole('button', { name: 'Bewertung speichern' }).click();
  await expect(first.getByText(/Score \d+ %/)).toBeVisible();
  await page.getByLabel('Bevorzugtes Modell für Content-Strategie').selectOption({ label: 'Meta Muse Spark 1.3' });
  await expect(page.getByTestId('preferences')).toContainText('festgelegt');

  // Use cases wired in Etappe 4 are comparable too: content QA on a script version, growth on own metrics
  await page.getByLabel('Aufgabe').selectOption({ label: 'Content-QA (Claims, Style, Voice)' });
  await expect(page.getByLabel('Skriptversion')).toBeVisible();
  await models.getByRole('checkbox').nth(0).check();
  await models.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: 'Vergleich starten' }).click();
  await expect(page.getByTestId('eval-run')).toContainText('(v1)');
  await expect(page.getByTestId('eval-result').first()).toContainText('summary:');

  await page.getByLabel('Aufgabe').selectOption({ label: 'Growth-Analyse' });
  await expect(page.getByTestId('eval-state-input')).toContainText('Kundenprojekte sind ausgeschlossen');
  await models.getByRole('checkbox').nth(0).check();
  await models.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: 'Vergleich starten' }).click();
  await expect(page.getByTestId('eval-run')).toContainText('Eigene Messwerte');
  await expect(page.getByTestId('eval-result').first()).toContainText('[MOCK]');
});
