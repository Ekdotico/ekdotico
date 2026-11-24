// The Onboarding paper (FR-ED-49), given to a new account once and opened in the editor as any document is,
// against the real collaboration server: the editor takes its text from the server, so a page without that
// server shows no text (the specs that open an editor start it themselves, tests/e2e/collab.ts).
import { expect, test, type Page } from './fixtures.ts';
import { newPerson, signUp } from './account.ts';
import { startCollab, stopCollab } from './collab.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => startCollab());
test.afterAll(stopCollab);

/** What the main region of the page says, for a failure to carry: what the page showed when the editor was not there. */
async function shown(page: Page): Promise<string> {
  const main = await page
    .getByRole('main')
    .innerText({ timeout: 2000 })
    .catch(() => '(no main region)');
  return `${page.url()}: ${main.replace(/\s+/g, ' ').slice(0, 600)}`;
}

test('a new account is given the Onboarding paper once, as an ordinary document of its own', async ({
  page,
}) => {
  test.slow();
  await signUp(page, newPerson(), undefined, { paper: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  const row = page.getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Onboarding');
  await expect(page.getByText('No documents yet.')).toHaveCount(0);

  // Once: a reload does not make a second.
  await page.reload();
  await expect(page.getByRole('listitem')).toHaveCount(1);

  // It opens as any document does, and holds the paper. The editor is a textbox, whose content is not in the
  // tree of roles: found as editor.spec.ts finds it, once the connection has brought the stored state.
  await page.getByRole('link', { name: 'Onboarding' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  const editor = page.getByRole('textbox', { name: 'Document text' });
  try {
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'In sync' })).toBeVisible({ timeout: 20_000 });
    await expect(editor.locator('h3[data-level="2"]').filter({ hasText: 'Welcome to Ekdotico α' })).toBeVisible({
      timeout: 20_000,
    });
  } catch (error) {
    throw new Error(`${(error as Error).message}\nThe page shows: ${await shown(page)}`);
  }
  await expect(page.getByText('This document could not be shown')).toHaveCount(0);
});
