import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';

/** The invented, neutral strategy fixture (shared with the core tests). */
export const STRATEGY_FIXTURE_JSON = readFileSync(path.resolve(import.meta.dirname, '../../../packages/core/test/fixtures/strategy-import.json'), 'utf8');

let seeds = 0;
/**
 * Saves an active strategy through the API the way the editor does it since Etappe 11: the whole document in one
 * PUT. Each call changes the notes, so it always creates a new active version.
 */
export async function seedStrategy(request: APIRequestContext, { phase = 'public', terms = [], ifMissing = false }: { phase?: 'private_trial' | 'public'; terms?: { term: string; category: string }[]; ifMissing?: boolean } = {}) {
  if (ifMissing) {
    const { active } = await (await request.get('/api/context')).json();
    if (active.strategy) return { strategyVersionId: active.strategy.id as string };
  }
  const json = JSON.stringify({
    ...JSON.parse(STRATEGY_FIXTURE_JSON), summary: 'Kurze Werkstatt- und Alltagsvideos, ehrlich und ohne Perfektion.', phase,
    sensitiveTerms: terms, notes: `E2E-Fassung ${Date.now()}-${++seeds}`,
  });
  const res = await request.put('/api/context/strategy', { data: { json } });
  expect(res.ok()).toBe(true);
  const { version } = await res.json();
  expect(version.status).toBe('approved'); // „Aktiv“
  return { strategyVersionId: version.id as string };
}
