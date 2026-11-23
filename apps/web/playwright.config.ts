import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const dataDir = path.join(os.tmpdir(), `studio-e2e-${Date.now()}`);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  webServer: [{
    // Etappe 16b: a local stand-in for Google Fonts (metadata fixture, CSS2, the Bebas Neue file) – E2E never goes online
    command: 'node e2e/fake-google-fonts.mjs',
    url: 'http://127.0.0.1:3199/health',
    reuseExistingServer: false,
    timeout: 20_000,
  }, {
    // Requires `pnpm build` first (production smoke test).
    command: 'pnpm exec next start --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100/api/status',
    reuseExistingServer: false,
    timeout: 60_000,
    // Explicit values win over apps/web/.env.local, so tests never use real keys or budget.
    env: {
      STUDIO_DATA_DIR: dataDir, AI_PROVIDER: 'mock', TRANSCRIPTION: 'mock', HIGGSFIELD: 'mock', HIGGSFIELD_MONTHLY_CREDITS: '100', STUDIO_ACCESS_TOKEN: '', STUDIO_JOB_TOKEN: 'e2e-job-token',
      AI_MONTHLY_BUDGET_USD: '0', OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CONFIDENTIAL_ALLOWED_FAMILIES: '', STUDIO_DEFAULTS_DIR: 'off',
      GOOGLE_FONTS_METADATA_URL: 'http://127.0.0.1:3199/metadata/fonts', GOOGLE_FONTS_CSS_URL: 'http://127.0.0.1:3199/css2', GOOGLE_FONTS_FILE_HOSTS: '127.0.0.1:3199',
    },
  }],
});
