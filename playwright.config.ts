import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { APP_ORIGIN } from './tests/e2e/origin.ts';

// The end-to-end tests run on Chromium. The other three browsers of NFR-IC-05
// join when the suite covers the release.
//
// The tests always run on a production build of this checkout: a server that is
// already listening is never reused. CI builds in its own step.

// What the tests and the server they drive must agree on. This file is loaded
// once by the runner and once by each worker; the runner chooses, and a worker
// inherits the runner's environment.
//
// The local sink of email, where a test reads the link of an invitation: a
// fresh directory for each run.
process.env.E2E_EMAIL_SINK ??= mkdtempSync(join(tmpdir(), 'ekdotico-e2e-mail-'));
// The key of the signed admission requests, for this run and nothing else.
process.env.E2E_ADMISSION_SECRET ??= 'a-test-value-for-the-end-to-end-tests-and-nothing-else';
// The database. On a development machine it is the local one of README.md,
// provisioned and migrated. Where an administrator's connection is given, as
// in CI, which has no such database, the run makes one of its own, as the
// integration tests do.
if (!process.env.E2E_DATABASE_URL) {
  process.env.E2E_DATABASE_URL = process.env.ADMIN_DATABASE_URL
    ? (await import('./tests/integration/database.ts')).createDatabase('e2e').appUrl
    : 'postgresql://ekdotico_app:local-app@localhost:5432/ekdotico';
}

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: APP_ORIGIN },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.CI ? 'pnpm start' : 'pnpm build && pnpm start',
    url: `${APP_ORIGIN}/api/health`,
    // The process environment wins over .env.local, which a development
    // machine has and CI has not. The secrets are for this run and nothing else.
    env: {
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN,
      // `next start` listens where PORT says.
      PORT: new URL(APP_ORIGIN).port,
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET: 'a-secret-for-the-smoke-tests-and-nothing-else',
      ADMISSION_SECRET: process.env.E2E_ADMISSION_SECRET,
      EMAIL_SINK_DIRECTORY: process.env.E2E_EMAIL_SINK,
      // With no trusted proxy every request without a session shares one count
      // of 20 a minute (docs/operations/deployment.md), which one run of the
      // tests would use up.
      RATE_LIMIT_SESSIONLESS_PER_ADDRESS: '100000/60',
      // The same for the requests for a password reset, 10 an hour, which
      // the runs of an afternoon would use up between them.
      RATE_LIMIT_RESET_PER_ADDRESS: '100000/3600',
    },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
