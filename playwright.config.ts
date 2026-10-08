import { defineConfig, devices } from '@playwright/test';

// The walking skeleton runs its smoke tests on Chromium. The other three
// browsers of NFR-IC-05 join when the suite covers the release.
//
// The tests always run on a production build of this checkout: a server that is
// already listening is never reused. CI builds in its own step.
export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:3000' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.CI ? 'pnpm start' : 'pnpm build && pnpm start',
    url: 'http://127.0.0.1:3000/api/health',
    // No page of the smoke tests reaches the database: the address is the local
    // development one of README.md. The secret is for this run and nothing else.
    env: {
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN: 'http://127.0.0.1:3000',
      DATABASE_URL: 'postgresql://ekdotico_app:local-app@localhost:5432/ekdotico',
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET: 'a-secret-for-the-smoke-tests-and-nothing-else',
    },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
