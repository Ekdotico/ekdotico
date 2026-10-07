import { defineConfig, devices } from '@playwright/test';

// The walking skeleton runs one smoke test on Chromium. The other three
// browsers of NFR-IC-05 join when the suite covers the release.
export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:3000' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm start',
    url: 'http://127.0.0.1:3000/api/health',
    env: { FOUNDING_TEAM_EMAILS: '' },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
