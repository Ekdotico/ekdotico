import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Some unit tests build documents of thousands of tables or megabytes of code and take
      // up to 3 seconds alone; run beside the other files on a loaded machine they passed the
      // default 5 seconds with nothing at fault. A test that measures its own time says so.
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], testTimeout: 20_000 } },
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
