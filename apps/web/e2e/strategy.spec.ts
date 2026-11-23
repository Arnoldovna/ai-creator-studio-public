import { expect, test } from '@playwright/test';
import { seedStrategy, STRATEGY_FIXTURE_JSON } from './helpers';

/** The smoke spec runs first and seeds a strategy; version numbers and the phase are read, not assumed. */
async function strategyState(request: import('@playwright/test').APIRequestContext) {
  const o = await (await request.get('/api/context')).json();
  const versions = o.versions.filter((v: { kind: string }) => v.kind === 'strategy');
  return { next: Math.max(0, ...versions.map((v: { version: number }) => v.version)) + 1, phase: o.phase as 'private_trial' | 'public', overview: o };
}

/** Invented profile; the „Lieblingswerkzeug“ line stands for what used to be the local-only part. */
const PROFILE_MD = '# Profil\n\n## Wer ich bin\n\nEine Person, die abends in ihrer Werkstatt Neues ausprobiert.\n\n## Notizen\n\n- Lieblingswerkzeug: der alte Handhobel aus dem Keller\n';

test('strategy page: drop strategy JSON + profile MD → preview → „Übernehmen“ → active; „Das liest die KI“ has a formerly local detail; edit → new active version', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { next } = await strategyState(page.request);
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: /Strategie/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Strategie zuerst/ })).toBeVisible();

  // two files into the drop zone: a preview, nothing stored yet
  const strategyJson = JSON.stringify({ ...JSON.parse(STRATEGY_FIXTURE_JSON), phase: 'public', longTermGoal: 'Reichweite, später Brand Deals', notes: 'Drehen nur am Wochenende.' }, null, 2);
  await page.getByTestId('context-files').setInputFiles([
    { name: 'strategie-v1.json', mimeType: 'application/json', buffer: Buffer.from(strategyJson) },
    { name: 'profil-kontext.md', mimeType: 'text/markdown', buffer: Buffer.from(PROFILE_MD) },
  ]);
  const preview = page.getByTestId('import-preview');
  await expect(preview.getByTestId('import-item')).toHaveCount(2);
  await expect(preview.getByLabel('Art von strategie-v1.json')).toHaveValue('strategy_json');
  await expect(preview.getByLabel('Art von profil-kontext.md')).toHaveValue('profile_md');
  await expect(preview).toContainText('2 unbekannte(s) Feld(er) unter „Weitere Felder“ übernommen.');
  await expect(preview).toContainText('Fernziel');
  expect((await strategyState(page.request)).next).toBe(next);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await preview.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(preview).toHaveCount(0);

  // active at once: read view rendered from the JSON, phase and long-term goal in the header
  const strategyDoc = page.getByTestId('doc-strategy');
  await expect(strategyDoc.getByTestId('doc-version')).toContainText(`v${next} · Abgelegt`);
  await expect(strategyDoc).toContainText('Aktiv');
  await expect(strategyDoc.getByTestId('doc-read').getByRole('heading', { name: 'Säulen' })).toBeVisible();
  await expect(strategyDoc.getByTestId('doc-read').locator('table').first()).toContainText('Werkstatt');
  await expect(page.getByTestId('long-term-goal')).toHaveText('Reichweite, später Brand Deals');
  await expect(page.getByTestId('phase')).toContainText('Öffentlich (eigene Entscheidung)');
  await page.getByRole('tab', { name: 'Profil', exact: true }).click();
  await expect(page.getByTestId('doc-profile').getByTestId('doc-read')).toContainText('Lieblingswerkzeug');

  // „Das liest die KI“: the whole document, including what used to be local (concrete no-gos, notes, the profile note)
  const ai = page.getByTestId('ai-text');
  await ai.locator('summary').click();
  await expect(ai.getByTestId('ai-text-agent')).toContainText('keine Arbeitgeber-Interna');
  await expect(ai.getByTestId('ai-text-agent')).toContainText('Drehen nur am Wochenende.');
  await expect(ai.getByTestId('ai-text-agent')).toContainText('Lieblingswerkzeug: der alte Handhobel');

  // edit the whole strategy JSON: live validation, then „Speichern“ → the next version, active at once
  await page.getByRole('tab', { name: 'Strategie', exact: true }).click();
  await strategyDoc.getByRole('tab', { name: 'Bearbeiten' }).click();
  const editor = strategyDoc.getByTestId('strategy-json');
  const text = await editor.inputValue();
  await editor.fill(`${text} kaputt`);
  await expect(strategyDoc.getByTestId('json-validation')).toContainText('Kein gültiges JSON');
  await expect(strategyDoc.getByRole('button', { name: 'Speichern', exact: true })).toBeDisabled();
  await editor.fill(text.replace('Drehen nur am Wochenende.', 'Drehen am Wochenende und mittwochs.'));
  await expect(strategyDoc.getByTestId('json-validation')).toContainText('✓ Gültig · 3 Säule(n)');
  await strategyDoc.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(strategyDoc.getByTestId('doc-version')).toContainText(`v${next + 1} · Bearbeitet`);
  await expect(strategyDoc.getByTestId('doc-read')).toContainText('Drehen am Wochenende und mittwochs.');
  await expect(ai.getByTestId('ai-text-agent')).toContainText('Drehen am Wochenende und mittwochs.');
  const state = await strategyState(page.request);
  expect(state.overview.active.strategy.version).toBe(next + 1);
  expect(state.overview.versions.find((v: { kind: string; version: number }) => v.kind === 'strategy' && v.version === next).status).toBe('archived');

  // profile: one Markdown editor, saving makes the next version active
  await page.getByRole('tab', { name: 'Profil', exact: true }).click();
  const profileDoc = page.getByTestId('doc-profile');
  await profileDoc.getByRole('tab', { name: 'Bearbeiten' }).click();
  await profileDoc.getByTestId('doc-markdown').fill(`${PROFILE_MD}- Kaffee vor dem Drehen\n`);
  await profileDoc.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(profileDoc.getByTestId('doc-read')).toContainText('Kaffee vor dem Drehen');
  await expect(ai.getByTestId('ai-text-agent')).toContainText('Kaffee vor dem Drehen');

  // versions: reactivate the imported strategy version
  await page.getByRole('tab', { name: 'Strategie', exact: true }).click();
  await strategyDoc.getByRole('tab', { name: /Versionen/ }).click();
  const row = strategyDoc.getByTestId('version-list').locator('li', { hasText: `v${next}` }).filter({ hasText: 'Archiviert' }).first();
  await row.getByRole('button', { name: 'Wieder aktivieren' }).click();
  await expect(strategyDoc.getByTestId('doc-version')).toContainText(`v${next} ·`);
  expect(errors).toEqual([]);
});

test('content lab: „Was an die KI geht“ shows the whole active document (incl. the former local part), no confidential routing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedStrategy(page.request, { terms: [{ term: 'Beispielstadt', category: 'home_location' }] });
  const res = await page.request.post('/api/projects', { data: { title: 'Werkstatt-Reels', kind: 'PERSONAL_CONTENT' } });
  expect(res.ok()).toBe(true);
  const project = await res.json();
  await page.goto('/content-lab');
  await page.locator('#project').selectOption(project.id);
  const panel = page.getByTestId('ai-context-preview');
  await expect(panel).toContainText('Was an die KI geht');
  await expect(panel.locator('pre')).toContainText('"name": "Werkstatt"');
  await expect(panel).toContainText('das vollständige aktive Strategie- und Profil-Dokument');
  await expect(panel).toContainText('Mock-Modus: es wird nichts gesendet.');
  // Etappe 10: her own context may go to every model
  await expect(panel).not.toContainText('nur Modelle ohne Datenspeicherung');
  await expect(panel.getByTestId('confidential-blocked')).toHaveCount(0);
  await expect(panel.locator('pre')).toContainText('keine Arbeitgeber-Interna');
  await expect(panel.locator('pre')).toContainText('Beispielstadt');
  expect(errors).toEqual([]);
  await page.request.delete(`/api/projects/${project.id}`);
});

test('own project: briefing without a pillar → concepts → script → caption, no checkbox, no FitCheck, a sensitive term blocks nothing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedStrategy(page.request, { terms: [{ term: 'Musterfirma GmbH', category: 'employer' }] });
  const project = await (await page.request.post('/api/projects', { data: { title: 'Ohne-Hürden', kind: 'PERSONAL_CONTENT' } })).json();
  await page.goto('/content-lab');
  await page.locator('#project').selectOption(project.id);
  await expect(page.getByLabel('Ziel', { exact: true })).toHaveValue('practice'); // „Üben & Freude“ for her own content
  await expect(page.getByLabel('Säule (optional)')).toHaveValue(''); // the pillar stays empty
  await page.getByLabel('Produkt oder Thema').fill('Werkbank ordnen');
  await page.getByRole('button', { name: /Drei Konzepte erstellen/ }).click();
  await expect(page.getByTestId('concept-card')).toHaveCount(3);
  await expect(page.getByTestId('concept-card').first()).not.toContainText('Säule');
  await expect(page.getByTestId('strategy-gate')).toHaveCount(0);
  await page.getByTestId('concept-card').first().getByRole('button', { name: /Skript daraus bauen/ }).click();
  await expect(page.getByTestId('fit-check')).toHaveCount(0);

  // the script is written; a term from her list is no blocker and no hint any more
  const editor = page.getByTestId('script-editor');
  await expect(editor.getByTestId('scene').first()).toBeVisible();
  await editor.getByLabel('Dialog').first().fill('Das habe ich bei Musterfirma GmbH gelernt.');
  await editor.getByRole('button', { name: 'Als neue Version speichern' }).click();
  await expect(editor.getByRole('list', { name: 'Skriptversionen' }).getByRole('button')).toHaveCount(2);
  await expect(editor.getByTestId('strategy-gate')).toHaveCount(0);
  await expect(editor.getByTestId('lint-findings')).toHaveCount(0);

  // caption for the draft script: no approved script needed, no confirmation checkbox
  const agents = editor.getByTestId('script-agents');
  await agents.getByRole('button', { name: /Caption schreiben/ }).click();
  const copyCard = agents.getByTestId('output-copy');
  await expect(copyCard.getByTestId('caption')).toBeVisible();
  await expect(copyCard.getByRole('checkbox')).toHaveCount(0);
  await copyCard.getByRole('button', { name: /Caption freigeben/ }).click();
  await expect(copyCard.getByText('freigegeben', { exact: true })).toBeVisible();

  // script approval: one click, no claims checkbox
  await expect(editor.getByRole('checkbox')).toHaveCount(0);
  await editor.getByRole('button', { name: /Skript freigeben/ }).click();
  await expect(editor.getByText('freigegeben', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
  await page.request.delete(`/api/projects/${project.id}`);
});

test('strategy gate (client project): a home address in a concept blocks „Skript daraus bauen“ until released with a reason in the UI', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const project = await (await page.request.post('/api/projects', { data: { title: 'Kunden-Gate', kind: 'UGC_CLIENT', client: { clientName: 'Garnladen', productClaims: [] } } })).json();
  const gen = await page.request.post('/api/content/concepts', { data: { projectId: project.id, topic: 'Garn vom Musterweg 12', lengthSeconds: 15 } });
  expect(gen.ok()).toBe(true);
  await page.goto('/content-lab');
  // Etappe 15: the pick can race the page's own project load (it reset to the first project); select until it sticks
  await expect(async () => {
    await page.locator('#project').selectOption(project.id);
    await expect(page.locator('#project')).toHaveValue(project.id, { timeout: 1000 });
    await expect(page.getByTestId('concept-card').first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  const card = page.getByTestId('concept-card').first();
  const gate = card.getByTestId('strategy-gate');
  await expect(gate).toContainText('Kundenprojekt: Grenz-Prüfung');
  await expect(gate.getByTestId('lint-findings')).toContainText('Kategorie „Wohnort“');
  const build = card.getByRole('button', { name: /Skript daraus bauen/ });
  await expect(build).toBeDisabled();
  // release every finding of this concept with a reason (stored with the override)
  for (let i = 0; i < 6 && (await gate.getByRole('button', { name: /Bewusst trotzdem/ }).count()) > 0; i++) {
    await gate.getByRole('button', { name: /Bewusst trotzdem/ }).first().click();
    await gate.getByLabel('Begründung').fill('Die Ladenadresse steht im Kundenbriefing.');
    await gate.getByRole('button', { name: 'Bewusst freigeben' }).click();
    await expect(gate.getByTestId('override-form')).toHaveCount(0);
  }
  await expect(gate).toContainText('keine offenen Punkte');
  await expect(build).toBeEnabled();
  await build.click();
  const editor = page.getByTestId('script-editor');
  await expect(editor.getByTestId('scene').first()).toBeVisible();
  // client work keeps the script approval with the claims checkbox
  const approve = editor.getByRole('button', { name: /Skript freigeben/ });
  await expect(approve).toBeDisabled();
  await expect(editor.getByLabel(/keine unbelegten Produktaussagen/)).toBeVisible();

  // a project with content keeps its kind: the select is disabled with the reason (the server answers 409)
  await page.goto('/ugc-projects');
  await page.getByTestId('project-card').filter({ hasText: 'Kunden-Gate' }).getByRole('button', { name: 'Bearbeiten' }).click();
  await expect(page.locator('#pKind')).toBeDisabled();
  await expect(page.getByText('Typ fest: Das Projekt hat schon Briefings')).toBeVisible();
  const kindSwitch = await page.request.patch(`/api/projects/${project.id}`, { data: { kind: 'PERSONAL_CONTENT' } });
  expect(kindSwitch.status()).toBe(409);
  expect(errors).toEqual([]);
  await page.request.delete(`/api/projects/${project.id}`);
});

test('Rückblick: a session without video is logged and trended; growth is paused in „Private Erprobung“ and back after saving „Öffentlich“', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedStrategy(page.request, { phase: 'private_trial' });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('link', { name: /Rückblick/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Rückblick/ })).toBeVisible();

  // Self-check without a video: joy, „nicht vor der Kamera“ stays ticked, a note
  const log = page.getByTestId('self-assessment');
  await expect(log.getByLabel('Wofür?')).toHaveValue('session');
  await expect(log.getByLabel('Fertig?')).toHaveCount(0); // only with a piece
  await log.getByRole('radio', { name: 'Freude 4' }).click();
  await log.getByLabel('Säule (optional)').selectOption({ label: 'Werkstatt' });
  await log.getByLabel('Notiz (optional)').fill('Ruhige Session, nur geübt.');
  await log.getByRole('button', { name: 'Selbstcheck speichern' }).click();
  const entry = log.getByTestId('self-assessment-entry').first();
  await expect(entry).toContainText('Session ohne Video');
  await expect(entry).toContainText('Freude 4/5');
  await expect(entry).toContainText('nicht vor der Kamera');
  await expect(entry).toContainText('Ruhige Session, nur geübt.');
  const trend = page.getByTestId('self-assessment-trend');
  await expect(trend.getByRole('img')).toBeVisible();
  await trend.getByText('Als Tabelle').click();
  const thisWeek = trend.getByTestId('trend-table').locator('tbody tr').last();
  await expect(thisWeek.locator('td').nth(2)).toHaveText('1'); // sessions
  await expect(thisWeek.locator('td').nth(4)).toHaveText('4'); // joy average
  // Pillar mix: plain text, no pressure; a session is not a finished piece
  const mix = page.getByTestId('pillar-mix');
  await expect(mix).toContainText('Werkstatt: 0 fertige Stücke (Ziel ca. 45 %)');
  await expect(mix).toContainText('Nur zur Orientierung – ändert nichts automatisch.');
  await expect(mix).not.toContainText('zurück');

  // Reach numbers: collapsed and labelled; the Growth Analyst is replaced by a plain label
  const reach = page.getByTestId('reach-section');
  await expect(reach.locator('summary')).toContainText('Reichweiten-Zahlen (pausiert in der privaten Erprobungsphase)');
  expect(await reach.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  await reach.locator('summary').click();
  await expect(reach.getByTestId('growth-paused')).toHaveText('Growth-Analyse pausiert – Phase wird in der Strategie festgelegt.');
  await expect(page.getByTestId('growth-panel')).toHaveCount(0);
  await expect(reach.getByLabel('Beitrag / Reel')).toBeEditable(); // publication entry stays usable

  // Content Lab: growth hints and growth goals are paused for her own content
  const projects: { id: string; kind: string }[] = await (await page.request.get('/api/projects')).json();
  await page.getByRole('navigation').getByRole('link', { name: /Content Lab/ }).click();
  await page.locator('#project').selectOption(projects.find((p) => p.kind === 'PERSONAL_CONTENT')!.id);
  await expect(page.getByTestId('growth-feedback-paused')).toHaveText('Growth-Hinweise pausiert (private Erprobung).');
  await expect(page.getByLabel('Ziel', { exact: true }).locator('option', { hasText: 'Passende neue Follower gewinnen' })).toHaveCount(0);

  // Only saving a strategy version with phase „public“ changes the phase (active at once)
  await page.getByRole('navigation').getByRole('link', { name: /Strategie/ }).click();
  const doc = page.getByTestId('doc-strategy');
  await doc.getByRole('tab', { name: 'Bearbeiten' }).click();
  const editor = doc.getByTestId('strategy-json');
  await editor.fill((await editor.inputValue()).replace('"phase": "private_trial"', '"phase": "public"'));
  await doc.getByRole('button', { name: 'Speichern', exact: true }).click();
  await page.getByTestId('ai-text').locator('summary').click();
  await expect(page.getByTestId('ai-text-agent')).toContainText('"phase": "public"');
  await expect(page.getByTestId('phase')).toContainText('Öffentlich (eigene Entscheidung)');

  await page.getByRole('navigation').getByRole('link', { name: /Rückblick/ }).click();
  await expect(page.getByTestId('reach-section').locator('summary')).toHaveText('Reichweiten-Zahlen');
  await expect(page.getByTestId('growth-panel')).toBeVisible();
  await expect(page.getByTestId('growth-paused')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('own project: a newer strategy version blocks nothing – storyboard and caption of an earlier script are approved directly', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { phase } = await strategyState(page.request);
  await seedStrategy(page.request, { phase });
  const project = await (await page.request.post('/api/projects', { data: { title: 'Strategie-Wechsel', kind: 'PERSONAL_CONTENT' } })).json();
  const gen = await page.request.post('/api/content/concepts', { data: { projectId: project.id, topic: 'Werkbank ölen', pillarId: 'werkstatt', lengthSeconds: 15 } });
  expect(gen.ok()).toBe(true);
  const concept = (await gen.json()).concepts[0];
  const script = await (await page.request.post(`/api/content/concepts/${concept.id}/script`)).json();
  expect((await page.request.post(`/api/scripts/${script.id}/agents/storyboard`)).ok()).toBe(true);
  expect((await page.request.post(`/api/scripts/${script.id}/agents/copy`)).ok()).toBe(true);
  // a new strategy version becomes active after the script was written
  await seedStrategy(page.request, { phase });

  await page.goto('/content-lab');
  await page.locator('#project').selectOption(project.id);
  const show = page.getByTestId('concept-card').first().getByRole('button', { name: 'Skripte ansehen' });
  if (await show.isVisible()) await show.click();
  const board = page.getByTestId('output-storyboard');
  const copy = page.getByTestId('output-copy');
  await expect(board.getByTestId('strategy-gate')).toHaveCount(0);
  await expect(copy.getByTestId('strategy-gate')).toHaveCount(0);
  await expect(copy.getByRole('checkbox')).toHaveCount(0);
  await copy.getByRole('button', { name: /Caption freigeben/ }).click();
  await expect(copy.getByText('freigegeben', { exact: true })).toBeVisible();
  // the storyboard keeps its confirmation only when it contains AI asset briefs (step before paid Higgsfield jobs)
  const needsConfirm = (await board.getByRole('checkbox').count()) > 0;
  if (needsConfirm) await board.getByRole('checkbox').check();
  await board.getByRole('button', { name: /Drehplan freigeben/ }).click();
  await expect(board.getByText('freigegeben', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await page.request.delete(`/api/projects/${project.id}`);
});
