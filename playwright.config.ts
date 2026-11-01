import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { APP_ORIGIN, APP_PORT, AUTH_SECRET, COLLAB_PORT } from './tests/e2e/origin.ts';

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
// The channel on which the web application tells the collaboration server of a change
// (src/lib/collab/events.ts): Valkey is shared by every run on the machine, so a run has one of its own.
process.env.E2E_EVENTS_CHANNEL ??= `ekdotico:collab-events:e2e-${randomBytes(6).toString('hex')}`;
// The one address on the list of the founding team (FR-AU-83): an address no
// earlier run used, since the database of a development machine keeps its
// accounts. Written with a capital: the list is compared without regard to case.
process.env.E2E_FOUNDER ??= `E2E-Founder-${randomBytes(6).toString('hex')}@example.com`;
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
  // Four files start the collaboration server of their own, on the one port the application's rewrite names
  // (tests/e2e/collab.ts), so they do not run at the same time: the images wait for the editor, the
  // footnotes for the images, and the export for the footnotes.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/editor.spec.ts', '**/images.spec.ts', '**/footnotes.spec.ts', '**/export.spec.ts'],
    },
    { name: 'editor', use: { ...devices['Desktop Chrome'] }, testMatch: '**/editor.spec.ts' },
    {
      name: 'images',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/images.spec.ts',
      dependencies: ['editor'],
    },
    {
      name: 'footnotes',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/footnotes.spec.ts',
      dependencies: ['images'],
    },
    {
      name: 'export',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/export.spec.ts',
      dependencies: ['footnotes'],
    },
  ],
  webServer: {
    // Built here, in CI too, and not in a step before: the build holds the
    // rewrite that serves `/collab` (COLLAB_PROXY_TARGET below), which a build
    // made without these settings does not have.
    command: 'pnpm build && pnpm start',
    url: `${APP_ORIGIN}/api/health`,
    // The process environment wins over .env.local, which a development
    // machine has and CI has not. The secrets are for this run and nothing else.
    env: {
      // `next start` listens where PORT says: 3000, or E2E_PORT (tests/e2e/origin.ts).
      PORT: APP_PORT,
      FOUNDING_TEAM_EMAILS: process.env.E2E_FOUNDER,
      APP_ORIGIN,
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET,
      // The editor reaches the collaboration server on the application's own
      // origin, as on a development machine (README.md): the tests of the
      // editor start that server themselves (tests/e2e/collab.ts).
      COLLAB_PROXY_TARGET: `http://127.0.0.1:${COLLAB_PORT}`,
      // FR-ED-23: 30 seconds where unset; a test waits for the error state.
      COLLAB_ERROR_AFTER_MS: '6000',
      // FR-EX-36: 30 seconds where unset; the test of a client that stops reading waits for it.
      EXPORT_IDLE_SECONDS: '3',
      ADMISSION_SECRET: process.env.E2E_ADMISSION_SECRET,
      COLLAB_EVENTS_CHANNEL: process.env.E2E_EVENTS_CHANNEL,
      // The sink, whatever a .env.local or the shell says: a run of the tests sends no real email (register D262).
      EMAIL_TRANSPORT: 'sink',
      EMAIL_SINK_DIRECTORY: process.env.E2E_EMAIL_SINK,
      // The object store of the images (FR-ED-08, NFR-SE-18), where the run is given one: the local store of
      // compose.yaml, or the one CI starts. Without it the application stores no image and the tests of
      // images say so and are skipped (tests/e2e/images.spec.ts).
      ...Object.fromEntries(
        [
          'IMAGE_STORAGE_ENDPOINT',
          'IMAGE_STORAGE_BUCKET',
          'IMAGE_STORAGE_ACCESS_KEY_ID',
          'IMAGE_STORAGE_SECRET_ACCESS_KEY',
          'IMAGE_STORAGE_REGION',
        ].flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
      ),
      // With no trusted proxy every request without a session shares one count
      // of 20 a minute (docs/operations/deployment.md), which one run of the
      // tests would use up.
      RATE_LIMIT_SESSIONLESS_PER_ADDRESS: '100000/60',
      // The same for the requests for a password reset, 10 an hour, which
      // the runs of an afternoon would use up between them.
      RATE_LIMIT_RESET_PER_ADDRESS: '100000/3600',
      // And for the admission endpoints, 60 a minute in all (NFR-SE-07). A
      // run asks for some forty invitations within its minute, and the count
      // is kept in Valkey under a key that every run shares, so a run begun
      // within a minute of another was answered 429. The limit itself is
      // tested against a count of its own (tests/integration).
      RATE_LIMIT_ADMISSION: '100000/60',
      // And for the lock of FR-AU-81. Every request of a run comes from one
      // network address, which is allowed five failed sign-ins for an email
      // address in 15 minutes: left so, that limit would refuse by itself at
      // the failure that locks, and a test could not tell the two apart. It
      // is put out of the way, and the fifth failure for an address is the
      // one that locks (tests/e2e/lock-and-link.spec.ts). No other test
      // counts on the five: the abandoned second steps of two-factor.spec.ts
      // count one failure each.
      RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: '50/900',
      RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: '5/3600',
    },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
