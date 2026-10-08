// The change of the name and of the email address in the account settings,
// and the page that the confirmation link opens (FR-AU-03, FR-AU-87 (b), (e),
// FR-AU-88, FR-AU-90; the owner's answer to Q3 of the plan).
import { expect, test, type Page } from '@playwright/test';
import {
  SIGN_IN_REFUSED,
  alertOn,
  expectNoSidewaysScroll,
  mailFor,
  newPerson,
  screens,
  signIn,
  signUp,
  watchOrigins,
} from './account.ts';
import { APP_ORIGIN } from './origin.ts';

// The fixed texts, written out here and not taken from the code under test.
// FR-AU-87 (b), around the link, which stands on a line of its own.
const CONFIRM_EMAIL = (link: string) =>
  `Subject: Confirm your new email address for Ekdotico\n` +
  `[^]*\n\nYou asked to change the email address of your Ekdotico account to this address\\. To confirm, open this link:\n${link}\nThe link works once and is valid for 1 hour\\. If you did not ask for this, you can ignore this email, and nothing changes\\.$`;
// FR-AU-87 (e), as it reads until the contact address exists.
const NOTICE_EMAIL =
  /Subject: The email address of your Ekdotico account was changed\n[^]*\n\nThe email address of your Ekdotico account was changed, and this address no longer signs in to it\. If you did not change it, contact the Ekdotico team\.$/;
// The application's own words (the owner's answer to Q6 of the plan).
const ASKED =
  'Ekdotico sends a confirmation link only to an address that can become the address of this account. If the new address can, it receives an email with a link that works once and is valid for 1 hour. The address of the account stays as it is until that link is opened.';
const NOT_VALID =
  'This link is no longer valid. A link to confirm a new email address works once and is valid for 1 hour. Ask for a new one in the account settings.';
const NAMES = (email: string) =>
  `This link changes the email address of an Ekdotico account to ${email}. After the change, the account signs in with this address, and every other session of the account ends.`;
const DONE = (email: string) =>
  `The email address of the Ekdotico account is now ${email}. Sign-in uses this address from now on, and every other session of the account has ended.`;

const firstScreen = { level: 1, name: 'Documents' } as const;
const LINK = /\/confirm-address\/[A-Za-z0-9_-]{43}/;

/** An account that has acknowledged the notice, signed in on this page. */
async function ready(page: Page, person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  return person;
}

test('the name is changed in the account settings, under the rule of the sign-up', async ({ page }) => {
  const elsewhere = watchOrigins(page);
  await ready(page);
  await page.goto('/settings');
  const part = page.getByRole('region', { name: 'Name' });
  const name = part.getByLabel('Name', { exact: true });
  await expect(name).toHaveValue('Test Person');
  await expect(name).toHaveAttribute('autocomplete', 'name');

  // A name that meets no rule is refused in words, at the head of the form and beside the field.
  await name.fill('   ');
  await part.getByRole('button', { name: 'Change name' }).click();
  const refusal = alertOn(page);
  await expect(refusal).toContainText('The name was not changed, because it does not meet its rule.');
  await expect(refusal).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expectNoSidewaysScroll(page);
  await screens(page, 'settings-name-fault');

  // By the keyboard alone. Markup is a name like any other, and is shown as the text it is.
  const typed = 'Ada <b>Lovelace</b>';
  await name.fill(typed);
  await name.press('Enter');
  await expect(part.getByRole('status')).toHaveText('The name is changed.');
  await expect(alertOn(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Name' }).getByLabel('Name', { exact: true })).toHaveValue(
    typed,
  );
  expect(elsewhere).toEqual([]);
});

test('the address is changed by a link sent to the new one, which is confirmed by a control and works once', async ({
  page,
  browser,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = await ready(page);
  const next = newPerson().email;

  // A second browser is signed in to the same account.
  const other = await (await browser.newContext()).newPage();
  await other.goto('/sign-in');
  await signIn(other, person);
  await expect(other.getByRole('heading', firstScreen)).toBeVisible();

  await page.goto('/settings');
  const part = page.getByRole('region', { name: 'Email address' });
  await expect(part.getByLabel('Current email address')).toHaveValue(person.email);
  const address = part.getByLabel('New email address');
  const password = part.getByLabel('Current password', { exact: true });
  await expect(password).toHaveAttribute('autocomplete', 'current-password');
  await expectNoSidewaysScroll(page);
  await screens(page, 'settings-address');

  // FR-AU-03: "after entering the current password". A wrong one is refused
  // with the one statement of FR-AU-81, announced, and nothing is sent.
  await address.fill(next);
  await password.fill(`${person.password} wrong`);
  await part.getByRole('button', { name: 'Change email address' }).click();
  const refusal = alertOn(page);
  await expect(refusal).toHaveText(SIGN_IN_REFUSED);
  await expect(refusal).toBeFocused();

  // The right one, by the keyboard alone: the one answer, as a status.
  await password.fill(person.password);
  await password.press('Enter');
  await expect(part.getByRole('status')).toHaveText(ASKED);
  await expect(alertOn(page)).toHaveCount(0);
  // The password does not stay in the page.
  await expect(password).toHaveValue('');
  await screens(page, 'settings-address-asked');

  // FR-AU-87 (b): the email to the new address, with its fixed text.
  const { found: link, text } = await mailFor(next, LINK);
  expect(text).toMatch(new RegExp(CONFIRM_EMAIL(`${APP_ORIGIN}${link}`.replaceAll('.', '\\.'))));

  // "Until then the old address stands": the settings still show it.
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Email address' }).getByLabel('Current email address'),
  ).toHaveValue(person.email);

  // The link is opened in a browser without a session, as a program that
  // fetches the links of an email would open it: a page with one control.
  const mailbox = await (await browser.newContext()).newPage();
  const strangers = watchOrigins(mailbox);
  const opened = await mailbox.goto(link);
  expect(opened!.headers()['referrer-policy']).toBe('no-referrer');
  await expect(mailbox).toHaveTitle('Confirm the new email address – Ekdotico');
  await expect(mailbox.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(mailbox.getByRole('heading', { level: 1 })).toHaveText('Confirm the new email address');
  await expect(mailbox.getByText(NAMES(next))).toBeVisible();
  // Nothing of the account but the new address: not the old one.
  await expect(mailbox.getByRole('main')).not.toContainText(person.email);
  await expect(mailbox.getByRole('button')).toHaveText(['Confirm the new address']);
  await expect(mailbox.getByRole('textbox')).toHaveCount(0);
  await expectNoSidewaysScroll(mailbox);
  await screens(mailbox, 'confirm-address');

  // "Opening the page alone changes nothing": read again, the old address
  // still stands and both sessions with it.
  await mailbox.reload();
  await expect(mailbox.getByText(NAMES(next))).toBeVisible();
  await other.goto('/settings');
  await expect(other).toHaveURL('/settings');

  // The one control, by the keyboard alone.
  await mailbox.getByRole('button', { name: 'Confirm the new address' }).focus();
  await mailbox.keyboard.press('Enter');
  await expect(mailbox.getByText(DONE(next))).toBeVisible();
  await expect(mailbox.getByRole('status')).toHaveText('The email address is changed.');
  await expect(mailbox.getByRole('button')).toHaveCount(0);
  await screens(mailbox, 'confirm-address-done');
  // It signed no one in: the way on leads to the sign-in page.
  await mailbox.getByRole('link', { name: 'Open Ekdotico' }).click();
  await expect(mailbox).toHaveURL(/\/sign-in/);

  // "Every other session of the account ends": the browser that confirmed
  // held none, so both browsers are signed out where they would change
  // something, at once.
  for (const browserPage of [page, other]) {
    const refused = await browserPage.request.post('/api/auth/update-user', {
      headers: { origin: APP_ORIGIN },
      data: { name: 'Another Name' },
    });
    expect(refused.status()).toBe(401);
  }

  // FR-AU-87 (e): the notice to the old address, which "no longer signs in".
  await mailFor(person.email, NOTICE_EMAIL);
  await signIn(mailbox, person);
  await expect(alertOn(mailbox)).toHaveText(SIGN_IN_REFUSED);
  await signIn(mailbox, { ...person, email: next });
  await expect(mailbox.getByRole('heading', firstScreen)).toBeVisible();
  await mailbox.goto('/settings');
  await expect(
    mailbox.getByRole('region', { name: 'Email address' }).getByLabel('Current email address'),
  ).toHaveValue(next);

  // The link works once: opened again, it shows the one statement, as part
  // of the page and no alert, and no control.
  await mailbox.goto(link);
  await expect(mailbox.getByText(NOT_VALID)).toBeVisible();
  await expect(mailbox.getByRole('button')).toHaveCount(0);
  await expectNoSidewaysScroll(mailbox);
  await screens(mailbox, 'confirm-address-not-valid');

  expect(elsewhere).toEqual([]);
  expect(strangers).toEqual([]);
  await other.context().close();
  await mailbox.context().close();
});

test('the browser that confirms under a session of the account stays signed in, and shows the new address', async ({
  page,
}) => {
  test.slow();
  const person = await ready(page);
  const next = newPerson().email;
  await page.goto('/settings');
  const part = page.getByRole('region', { name: 'Email address' });
  await part.getByLabel('New email address').fill(next);
  await part.getByLabel('Current password', { exact: true }).fill(person.password);
  await part.getByRole('button', { name: 'Change email address' }).click();
  await expect(part.getByRole('status')).toHaveText(ASKED);

  const { found: link } = await mailFor(next, LINK);
  await page.goto(link);
  await page.getByRole('button', { name: 'Confirm the new address' }).click();
  await expect(page.getByText(DONE(next))).toBeVisible();
  // Its own session stands, and its signed copy is the new one at once.
  await page.getByRole('link', { name: 'Open Ekdotico' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  await page.goto('/settings');
  await expect(
    page.getByRole('region', { name: 'Email address' }).getByLabel('Current email address'),
  ).toHaveValue(next);
});

test('a link that is not known shows the one statement, and no control', async ({ page }) => {
  const opened = await page.goto(`/confirm-address/${'x'.repeat(43)}`);
  expect(opened!.status()).toBe(200);
  expect(opened!.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Confirm the new email address');
  await expect(page.getByText(NOT_VALID)).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(alertOn(page)).toHaveCount(0);
});
