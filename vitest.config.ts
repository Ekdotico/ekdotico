import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      // Integration tests need the local services of README.md and are run one file at a time.
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], fileParallelism: false } },
    ],
  },
});
