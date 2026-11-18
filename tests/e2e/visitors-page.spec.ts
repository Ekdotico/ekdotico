// The page for a visitor who is not signed in (FR-AU-93; register D327 to D330):
// at the root, with no redirect, no cookie, the approved text, and the links;
// and a person signed in reaches their documents there as before. The
// contact address is unset in the test environment (D329), so the line is the
// owner's "list-only" one.
import { expect, test } from './fixtures.ts';
import { newPerson, signUp } from './account.ts';

test('a visitor at the root gets the page, at the same address, with no cookie', async ({
  page,
  request,
}) => {
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headersArray().filter(({ name }) => name.toLowerCase() === 'set-cookie')).toEqual([]);
  expect((await request.head('/', { maxRedirects: 0 })).status()).toBe(200);

  await page.goto('/');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ekdotico is in Closed α');
  await expect(
    page.getByText(
      'Ekdotico is being tested by a small group, and accounts are by invitation. Each invitation is sent by a person on the team.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('To ask for one, add your email address to the list.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('write to')).toHaveCount(0);
  await expect(page.getByText('Already invited?')).toBeVisible();

  const add = page.getByRole('link', { name: 'Add your email address' });
  await expect(add).toHaveAttribute('href', 'https://alpha.ekdoti.co');
  await expect(add).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  expect(await page.context().cookies()).toEqual([]);

  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/sign-in');
});

test('the internal page answers 404 when it is asked for by name', async ({ request }) => {
  expect((await request.get('/visitors-page', { maxRedirects: 0 })).status()).toBe(404);
});

test('a person signed in reaches their documents at the root, not the page of visitors', async ({ page }) => {
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await expect(page.getByText('Ekdotico is in Closed α')).toHaveCount(0);
});
