import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      // Integration tests need the local services of README.md and are run one file at a time.
      // A test hashes a password several times and waits on PostgreSQL and Valkey, so the
      // 5 seconds of the default are passed on a loaded machine with nothing at fault; a test
      // that needs longer still says so itself.
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
