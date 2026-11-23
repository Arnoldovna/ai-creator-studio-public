import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'test/server-only-stub.ts'),
    },
  },
  // STUDIO_DEFAULTS_DIR=off: tests never read or write the private standard folder (defaults tests use a temp dir).
  // STUDIO_AUTO_PREPARE=off: uploads in tests do not queue the Etappe-12 preparation (prepare.test.ts switches it on).
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000, fileParallelism: false, env: { STUDIO_DEFAULTS_DIR: 'off', STUDIO_AUTO_PREPARE: 'off' } },
});
