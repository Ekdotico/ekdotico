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
