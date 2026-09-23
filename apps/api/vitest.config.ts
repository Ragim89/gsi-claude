import { defineConfig } from 'vitest/config';

/**
 * Unit tests: pure functions only, no database, no network. They run in milliseconds and are
 * the ones that must never be skipped. Database-backed tests live in vitest.integration.config.ts.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    reporters: 'default',
  },
});
