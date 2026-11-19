// Orientation (UI audit F04, F21): the Sharing page names its document and leads back to it, and the
// header's links are a labelled landmark that marks the current page. Written, not yet run.
import { expect, test } from './fixtures.ts';
import { newPerson, signUp } from './account.ts';
import { shareNew } from './sharing.ts';

test('the Sharing page names its document and links back to it; the header marks the current page', async ({
  page,
}) => {
  test.slow();
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Documents' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Account settings' })).not.toHaveAttribute('aria-current');

  const id = await shareNew(page);
  await expect(page.getByText('Document: Untitled document')).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Documents' })).not.toHaveAttribute('aria-current');
  await page.getByRole('link', { name: 'Back to document' }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${id}$`));

  await nav.getByRole('link', { name: 'Account settings' }).click();
  await expect(nav.getByRole('link', { name: 'Account settings' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Documents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
});
