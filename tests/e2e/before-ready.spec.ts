// A control that works by script alone, pressed before the page's script has
// taken over the markup the server sent (FR-AU-88, NFR-IC-19). The scripts of
// the build are held back here, as a slow connection or a server that has
// just started holds them back: the page is on the screen and is not yet
// ready. Each such control is disabled until it is (src/components/ready.ts),
// so a press waits and then works once; left enabled, the press did nothing,
// or the form posted itself to the address of its page.
import { expect, test, type Page } from './fixtures.ts';
import { NOTICE_TITLE, invite, newPerson } from './account.ts';

const HELD_MS = 1500;

/** Holds back every script of the build that this page asks for from now on. */
async function holdScripts(page: Page) {
  await page.route('**/_next/static/**/*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HELD_MS));
    await route.continue();
  });
}

test('the controls of the first screens work when they are pressed before the page is ready', async ({
  page,
}) => {
  test.slow();
  const person = newPerson();
  const link = await invite(person.email);
  await holdScripts(page);

  // The sign-up form: filled and sent at once. Sent by the browser itself, it
  // would post the password to the address of the page.
  const posted: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posted.push(new URL(request.url()).pathname);
  });
  // Not until the page has loaded, which waits for the scripts held back.
  await page.goto(link, { waitUntil: 'commit' });
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeDisabled();
  await page.getByLabel('Name').fill(person.name);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await create.click();

  // The notice, on a page that has just been loaded: its one control.
  await expect(page.getByRole('heading', { level: 1, name: NOTICE_TITLE })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByRole('button', { name: 'Continue' }).click();

  // The first screen, loaded again by the notice: the way to sign out.
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');

  // Every request that changed something was made by the page's script, to a route.
  expect(posted).toEqual(['/api/sign-up', '/api/account/onboarding/acknowledgement', '/api/auth/sign-out']);
});
