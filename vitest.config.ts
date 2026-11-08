import { defineConfig } from 'vitest/config';

/**
 * One vitest run covers every workspace. Each workspace is a separate "project"
 * so results are grouped by package. Integration tests (which need PostgreSQL)
 * are added as their own project in Phase 7.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './shared',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'device',
          root: './device',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'server',
          root: './server',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        // Real PostgreSQL (TEST_DATABASE_URL). Files run one at a time: they share the database.
        test: {
          name: 'integration',
          root: './server',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
