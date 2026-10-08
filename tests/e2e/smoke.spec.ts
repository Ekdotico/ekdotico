import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

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
