import { defineConfig } from 'vitest/config';

// Tests that need Docker (Testcontainers Postgres, LocalStack) are named *.int.test.ts.
const INTEGRATION = 'tests/**/*.int.test.ts';

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [INTEGRATION],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [INTEGRATION],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
