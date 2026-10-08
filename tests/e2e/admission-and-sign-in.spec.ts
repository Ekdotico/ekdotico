// The path a person takes from an invitation to the first screen and back in
// again, and what the pages on it owe (FR-AU-55 to FR-AU-57, FR-AU-81,
// FR-AU-84, FR-AU-88, FR-AU-90, FR-AU-07).
import { expect, test } from '@playwright/test';
import {
  NOTICE_BODY,
  NOTICE_TITLE,
  NOT_OPEN,
  SIGN_IN_REFUSED,
  alertOn,
  expectNoSidewaysScroll,
  invite,
  newPerson,
  screens,
  signIn,
  signUp,
  watchOrigins,
} from './account.ts';

const noticeTitle = { level: 1, name: NOTICE_TITLE } as const;
// The list of documents (FR-ED-35), whose own tests are in documents.spec.ts.
const firstScreen = { level: 1, name: 'Documents' } as const;

test('from an invitation to the first screen, out, and in again', async ({ page }) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = newPerson();

  // FR-AU-90: the invitation's link opens the sign-up page, which shows the
  // invited address and does not let it be changed.
  await page.goto(invite(person.email));
  await expect(page).toHaveTitle('Create account – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create account');
  const address = page.getByLabel('Email address');
  await expect(address).toHaveValue(person.email);
  await expect(address).not.toBeEditable();
  // FR-AU-88: the attributes a password manager needs.
  await expect(address).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('Name')).toHaveAttribute('autocomplete', 'name');
  const password = page.getByLabel('Password', { exact: true });
  await expect(password).toHaveAttribute('autocomplete', 'new-password');
  // The page names no address that the token could leak to.
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expectNoSidewaysScroll(page);
  await screens(page, 'sign-up');

  // FR-AU-82: the password can be shown as typed, and pasted.
  await password.fill(person.password);
  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveValue(person.password);

  // FR-AU-82, FR-AU-88: a rule that is not met is stated at the head of the
  // form, where a screen reader announces it, and beside its field.
  await password.fill('short');
  await page.getByLabel('Name').fill(person.name);
  await page.getByRole('button', { name: 'Create account' }).click();
  const fault = alertOn(page);
  await expect(fault).toBeVisible();
  await expect(fault).toBeFocused();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  const stated = await password.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${stated!.split(' ').at(-1)}"]`)).not.toBeEmpty();
  await screens(page, 'sign-up-fault');

  // FR-AU-90: the account is created and the person is signed in. FR-AU-55:
  // the first screen is the Closed α notice, with its fixed text.
  await password.fill(person.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL('/');
  const title = page.getByRole('heading', noticeTitle);
  await expect(title).toHaveText(NOTICE_TITLE);
  await expect(page).toHaveTitle('Closed α – Ekdotico');
  await expect(page.getByRole('main').getByRole('paragraph')).toHaveText(NOTICE_BODY);
  // FR-AU-56: focus moves into it, and nothing outside it takes focus.
  await expect(title).toBeFocused();
  // FR-AU-55: one control, "Continue", and beside it only the means to sign out.
  await expect(page.getByRole('button')).toHaveText(['Continue', 'Sign out']);
  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'notice');

  // In place of the page's content: the content is not in the response at all.
  const underneath = await (await page.request.get('/')).text();
  expect(underneath).toContain('Continue');
  expect(underneath).not.toContain('New document');
  expect(underneath).not.toContain('No documents yet');

  // "Reloading a page or opening another address does not pass it."
  await page.reload();
  await expect(page.getByRole('heading', noticeTitle)).toBeVisible();
  await page.goto('/anything');
  await expect(page.getByRole('heading', noticeTitle)).toBeVisible();
  await expect(page.getByRole('heading')).toHaveCount(1);

  // It can be read and acknowledged by keyboard alone (FR-AU-56).
  await page.goto('/');
  await expect(page.getByRole('heading', noticeTitle)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeFocused();
  await page.keyboard.press('Enter');

  // "After the acknowledgement the user continues to the address they had asked for."
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  await expect(page).toHaveURL('/');
  await expect(page).toHaveTitle('Documents – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  // The content the notice stood in place of is in the response now.
  const acknowledged = await (await page.request.get('/')).text();
  expect(acknowledged).toContain('New document');
  expect(acknowledged).toContain('No documents yet');
  await expect(page.getByText(NOTICE_BODY)).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'first-screen');

  // An address that is no page says so, under the same header.
  const nowhere = await page.goto('/anything');
  expect(nowhere!.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await screens(page, 'not-found');
  await page.goto('/');

  // FR-AU-84: signing out ends the session at once.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  expect((await page.request.get('/api/anything')).status()).toBe(401);

  // FR-AU-07: a page asked for without a session leads to sign-in, and back.
  await page.goto('/documents?from=a-test');
  await expect(page).toHaveURL('/sign-in?return=%2Fdocuments%3Ffrom%3Da-test');

  // FR-AU-81: the one fixed statement, announced, for a wrong password.
  await signIn(page, person, `${person.password} wrong`);
  const refusal = alertOn(page);
  await expect(refusal).toHaveText(SIGN_IN_REFUSED);
  await expect(refusal).toBeFocused();
  await expect(page).toHaveURL('/sign-in?return=%2Fdocuments%3Ffrom%3Da-test');
  await screens(page, 'sign-in-fault');

  // The right one: returned to the address asked for, and FR-AU-56: the notice
  // is not shown again.
  await signIn(page, person);
  await expect(page).toHaveURL('/documents?from=a-test');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  await page.goto('/');
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  await expect(page.getByRole('heading', noticeTitle)).toHaveCount(0);

  // FR-AU-88: none of these pages asked another origin for anything.
  expect(elsewhere).toEqual([]);
});

test('an invitation that is not open shows the fixed statement and nothing to fill in', async ({ page }) => {
  const elsewhere = watchOrigins(page);
  // 43 characters of the alphabet a token is made of, and no invitation's.
  await page.goto(`/sign-up/${'x'.repeat(43)}`);
  await expect(page.getByRole('main').getByRole('paragraph')).toHaveText(NOT_OPEN);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'sign-up-not-open');
  expect(elsewhere).toEqual([]);
});

test('an invitation that was accepted is not open, to its own link or to a second submission', async ({
  page,
  browser,
}) => {
  const person = newPerson();
  const link = invite(person.email);

  // A second browser has the page open while the first accepts.
  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await expect(other.getByLabel('Name')).toBeVisible();

  await signUp(page, person, link);

  await other.getByLabel('Name').fill('Another Person');
  await other.getByLabel('Password', { exact: true }).fill(newPerson().password);
  await other.getByRole('button', { name: 'Create account' }).click();
  // The form gives way to the statement, which a screen reader announces.
  await expect(alertOn(other)).toHaveText(NOT_OPEN);
  await expect(other.getByRole('textbox')).toHaveCount(0);

  await other.reload();
  await expect(other.getByRole('main').getByRole('paragraph')).toHaveText(NOT_OPEN);
  await other.context().close();
});

test('the sign-in page offers sign-up to no one, and asks no other origin for anything', async ({ page }) => {
  const elsewhere = watchOrigins(page);
  await page.goto('/sign-in');
  await expect(page).toHaveTitle('Sign in – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  // FR-AU-57. No link at all: the reset page is a later slice.
  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(/sign up|create account|invitation/i);
  // FR-AU-88: each field has a visible label and the attribute a password manager fills by.
  await expect(page.getByLabel('Email address')).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
  await expect(page.getByText('Email address', { exact: true })).toBeVisible();
  await expect(page.getByText('Password', { exact: true })).toBeVisible();
  await expect(alertOn(page)).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'sign-in');
  await page.waitForLoadState('networkidle');
  expect(elsewhere).toEqual([]);
});

test('an address that belongs to no account is answered as a wrong password is', async ({ page }) => {
  await page.goto('/sign-in');
  await signIn(page, newPerson());
  await expect(alertOn(page)).toHaveText(SIGN_IN_REFUSED);
  await expect(page).toHaveURL('/sign-in');
});

test.describe('with an account', () => {
  test.describe.configure({ mode: 'serial' });
  const person = newPerson();

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    await signUp(await context.newPage(), person);
    await context.close();
  });

  test('sign-in by keyboard alone', async ({ page }) => {
    await page.goto('/sign-in');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Email address')).toBeFocused();
    await page.keyboard.type(person.email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await page.keyboard.type(person.password);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
    await page.keyboard.press('Enter');
    // The account has not acknowledged the notice: it is the first screen.
    await expect(page.getByRole('heading', noticeTitle)).toBeFocused();
    await expect(page).toHaveURL('/');
  });

  // FR-AU-07, and src/lib/http.ts: only ever a path of this origin.
  for (const target of ['//example.com/', 'https://example.com/', '/\\example.com']) {
    test(`sign-in does not return to ${target}`, async ({ page }) => {
      const elsewhere = watchOrigins(page);
      await page.goto(`/sign-in?return=${encodeURIComponent(target)}`);
      await signIn(page, person);
      await expect(page.getByRole('heading', noticeTitle)).toBeVisible();
      await expect(page).toHaveURL('/');
      expect(elsewhere).toEqual([]);
    });
  }

  test('a browser that holds a session is sent on from the sign-in page', async ({ page }) => {
    await page.goto('/sign-in');
    await signIn(page, person);
    await expect(page.getByRole('heading', noticeTitle)).toBeVisible();
    await page.goto('/sign-in?return=%2Fanything');
    await expect(page).toHaveURL('/anything');
  });

  test('the notice gives way to sign-out, and is shown again at the next sign-in', async ({ page }) => {
    await page.goto('/sign-in');
    await signIn(page, person);
    await expect(page.getByRole('heading', noticeTitle)).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/sign-in');
    await signIn(page, person);
    await expect(page.getByRole('heading', noticeTitle)).toBeVisible();
  });
});
