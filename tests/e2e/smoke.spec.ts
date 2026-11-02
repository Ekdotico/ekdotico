import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from './fixtures.ts';
import { AUTH_SECRET } from './origin.ts';

// NFR-SE-05, FR-AU-07: a path that is not on the allow-list requires a session,
// and a visitor without one is sent to sign in and returned afterwards.
test('a page is not served without a session', async ({ request }) => {
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe('/sign-in?return=%2F');
});

test('an API route answers 401 without a session', async ({ request }) => {
  const response = await request.get('/api/anything');
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe('unauthenticated');
});

test('the health check answers without a session and returns nothing', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe('');
});

// Register A102. Left alone, Next.js logs a failed instrumentation hook, stays
// up, and answers 500; the process has to exit instead.
test('the web application refuses to start without FOUNDING_TEAM_EMAILS', () => {
  // Next.js reads .env.local, which a development machine has and CI has not.
  test.skip(existsSync('.env.local'), 'the setting cannot be absent while .env.local sets it');
  const env = { ...process.env };
  delete env.FOUNDING_TEAM_EMAILS;
  const started = spawnSync('pnpm', ['exec', 'next', 'start', '-p', '3999'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(started.stderr).toContain('FOUNDING_TEAM_EMAILS is not set');
  expect(started.status).toBe(1);
});

// docs/operations/deployment.md, item 9. The build of this run holds the
// development rewrite of `/collab` (playwright.config.ts), and `next start`
// serves the rewrites of the build whatever the environment says: started
// where the origin is not on localhost, the process has to exit.
test('the web application refuses to start away from localhost on a build that holds the development rewrite', () => {
  // Next.js itself and not through pnpm: were the start not refused, the end of the wait would stop the server it left.
  const started = spawnSync('node', ['node_modules/next/dist/bin/next', 'start', '-p', '3997'], {
    env: {
      ...process.env,
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN: 'https://app.example.test',
      // The setting itself is absent here: it is the build that is refused.
      COLLAB_PROXY_TARGET: '',
      // Away from localhost a transport has to be named, and no test of an end-to-end run names Brevo
      // (tests/unit/processors.test.ts). The sink is refused there too (register D270), but by a check that
      // comes after the build's (src/instrumentation.ts), which is the refusal this test is of.
      EMAIL_TRANSPORT: 'sink',
      EMAIL_SINK_DIRECTORY: process.env.E2E_EMAIL_SINK,
      TRUSTED_PROXY_COUNT: '1',
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(started.stderr).toContain('This build passes /collab to the collaboration server itself');
  expect(started.status).toBe(1);
});
