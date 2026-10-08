import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

test('the application serves its page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Ekdotico' })).toBeVisible();
});

test('the health check answers without a session and returns nothing', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe('');
});

// Register A102. Left alone, Next.js logs a failed instrumentation hook, stays
// up, and answers 500; the process has to exit instead.
test('the web application refuses to start without FOUNDING_TEAM_EMAILS', () => {
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
