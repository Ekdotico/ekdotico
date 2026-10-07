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
    env: { FOUNDING_TEAM_EMAILS: '' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
