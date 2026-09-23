import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Integration tests: run against a real PostgreSQL database (`gsi_test`), created and migrated
 * by test/global-setup.ts. They boot the actual Nest application, so Row-Level Security,
 * guards, validation and SQL are all exercised exactly as in production.
 *
 * SWC rather than the default esbuild transform: NestJS injects dependencies through
 * `design:paramtypes` metadata, which esbuild does not emit, and every constructor would
 * arrive empty.
 *
 * Run them with: docker compose --profile test run --rm test
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        // Nest resolves constructor parameters from design:paramtypes; without these two
        // flags every injected dependency arrives as undefined.
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    // One database, shared fixtures: parallel files would race on the same rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    reporters: 'default',
  },
});
