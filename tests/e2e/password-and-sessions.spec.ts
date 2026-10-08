// The reset of a password by an emailed link, its change in the account
// settings, and the list of sessions with the means to end them (FR-AU-85,
// FR-AU-86, FR-AU-87 (c), (d), FR-AU-88; NFR-I18-06).
import { expect, test, type Page } from '@playwright/test';
import {
  NOTICE_TITLE,
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
// FR-AU-86.
const RESET_REQUESTED =
  'If this address belongs to an account, Ekdotico has sent it an email with a link to set a new password.';
// FR-AU-87 (c), around the link, and (d).
const RESET_EMAIL = (link: string) =>
  `Subject: Set a new password for Ekdotico\n` +
  `[^]*\n\nYou asked to set a new password for your Ekdotico account. To set it, open this link: ${link}. The link works once and is valid for 1 hour. If you did not ask for this, you can ignore this email, and your password stays as it is.$`;
const NOTICE_EMAIL =
  /Subject: The password of your Ekdotico account was changed\n[^]*\n\nThe password of your Ekdotico account was changed\. If you did not change it, set a new password from the sign-in page\.$/;
// The application's own words (the owner's answer to Q6 of the plan).
const NOT_VALID =
  'This link is no longer valid. A link to set a new password works once and is valid for 1 hour. Ask for a new one.';
const RESET_DONE =
  'The password is changed, and every session of the account has ended. Sign in with the new password.';
const CHANGED = 'The password is changed. Every other session of this account has ended.';
const UNAUTHENTICATED = 'This request needs a signed-in session. Sign in and try again.';

const noticeTitle = { level: 1, name: NOTICE_TITLE } as const;
const firstScreen = { level: 1, name: 'Documents' } as const;

/** An account that has acknowledged the notice, signed in on this page. */
async function ready(page: Page, person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  return person;
}

test('a password is reset by an emailed link, which works once, and the old password no longer signs in', async ({
  page,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = await ready(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');

  // FR-AU-86: from the sign-in page to the reset page, which needs no session.
  await page.getByRole('link', { name: 'Set a new password' }).click();
  await expect(page).toHaveURL('/reset-password');
  await expect(page).toHaveTitle('Set a new password – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set a new password');
  const address = page.getByLabel('Email address');
  await expect(address).toHaveAttribute('autocomplete', 'username');
  await expectNoSidewaysScroll(page);
  await screens(page, 'reset-request');

  await address.fill(person.email);
  await page.getByRole('button', { name: 'Send link' }).click();
  // The fixed statement takes the form's place and takes focus (FR-AU-88).
  const statement = page.getByRole('status');
  await expect(statement).toHaveText(RESET_REQUESTED);
  await expect(statement).toBeFocused();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await screens(page, 'reset-requested');

  // FR-AU-87 (c): the email, with its fixed text, and in it the link.
  const { found: link, text } = await mailFor(person.email, /\/reset-password\/[A-Za-z0-9_-]{43}/);
  expect(text).toMatch(new RegExp(RESET_EMAIL(`${APP_ORIGIN}${link}`.replaceAll('.', '\\.'))));

  // The link opens a page that names the account and sets a new password.
  await page.goto(link);
  await expect(page).toHaveTitle('Set a new password – Ekdotico');
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  const account = page.getByLabel('Email address');
  await expect(account).toHaveValue(person.email);
  await expect(account).not.toBeEditable();
  const password = page.getByLabel('New password', { exact: true });
  await expect(password).toHaveAttribute('autocomplete', 'new-password');
  await expectNoSidewaysScroll(page);
  await screens(page, 'reset');

  // FR-AU-82, FR-AU-88: a rule that is not met is stated at the head of the
  // form, announced, and beside the field. The link is not spent by it.
  await password.fill('short');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(alertOn(page)).toBeFocused();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await screens(page, 'reset-fault');

  const renewed = `${person.password} new`;
  await password.fill(renewed);
  await page.getByRole('button', { name: 'Set password' }).click();
  const done = page.getByRole('status');
  await expect(done).toHaveText(RESET_DONE);
  await expect(done).toBeFocused();
  await screens(page, 'reset-done');

  // FR-AU-87 (d): the notice of a changed password.
  await mailFor(person.email, NOTICE_EMAIL);

  // "A reset … does not sign the person in": every page still asks for a sign-in.
  expect((await page.request.get('/api/anything')).status()).toBe(401);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/sign-in');

  // The old password is refused, and the new one signs in.
  await signIn(page, person);
  await expect(alertOn(page)).toHaveText(SIGN_IN_REFUSED);
  await signIn(page, person, renewed);
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();

  // The link works once: opened again, it shows the one statement and the way to a new link.
  await page.goto(link);
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(NOT_VALID);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Set a new password' })).toHaveAttribute(
    'href',
    '/reset-password',
  );
  await expectNoSidewaysScroll(page);
  await screens(page, 'reset-not-valid');

  // FR-AU-88: none of these pages asked another origin for anything.
  expect(elsewhere).toEqual([]);
});

test('a link that was used while its page was open is answered with the statement, announced', async ({
  page,
  browser,
}) => {
  const person = await ready(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await page.goto('/reset-password');
  await page.getByLabel('Email address').fill(person.email);
  await page.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByRole('status')).toHaveText(RESET_REQUESTED);
  const { found: link } = await mailFor(person.email, /\/reset-password\/[A-Za-z0-9_-]{43}/);

  // A second browser has the page open while the first sets the password.
  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await expect(other.getByLabel('New password', { exact: true })).toBeVisible();

  await page.goto(link);
  await page.getByLabel('New password', { exact: true }).fill(`${person.password} new`);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('status')).toHaveText(RESET_DONE);

  await other.getByLabel('New password', { exact: true }).fill(`${person.password} other`);
  await other.getByRole('button', { name: 'Set password' }).click();
  await expect(alertOn(other)).toHaveText(NOT_VALID);
  await expect(other.getByRole('textbox')).toHaveCount(0);
  await other.context().close();
});

test('the reset page answers an address without an account as any other, by keyboard alone', async ({
  page,
}) => {
  const elsewhere = watchOrigins(page);
  await page.goto('/reset-password');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email address')).toBeFocused();
  await page.keyboard.type(newPerson().email);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send link' })).toBeFocused();
  await page.keyboard.press('Enter');
  const statement = page.getByRole('status');
  await expect(statement).toHaveText(RESET_REQUESTED);
  await expect(statement).toBeFocused();
  // From the statement the keyboard reaches the way back to sign-in.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeFocused();
  await page.waitForLoadState('networkidle');
  expect(elsewhere).toEqual([]);
});

test('a link that is not known shows the statement and nothing to fill in', async ({ page }) => {
  await page.goto(`/reset-password/${'x'.repeat(43)}`);
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(NOT_VALID);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
});

test.describe('the account settings', () => {
  // NFR-I18-06: a time is shown in the zone the browser reports, whatever the server's.
  test.use({ timezoneId: 'Pacific/Auckland' });

  test('list the sessions, end another one, and change the password, which ends the others', async ({
    page,
    browser,
  }) => {
    test.slow();
    const elsewhere = watchOrigins(page);
    const person = await ready(page);

    // A second browser signs in to the same account.
    const other = await (await browser.newContext()).newPage();
    await other.goto('/sign-in');
    await signIn(other, person);
    await expect(other.getByRole('heading', firstScreen)).toBeVisible();
    await other.goto('/settings');

    // FR-AU-85: from the header to the settings, which list both sessions.
    await page.getByRole('link', { name: 'Account settings' }).click();
    await expect(page).toHaveURL('/settings');
    await expect(page).toHaveTitle('Account settings – Ekdotico');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account settings');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Password',
      'Two-factor authentication',
      'Sessions',
    ]);
    const sessions = page.getByRole('main').getByRole('listitem');
    await expect(sessions).toHaveCount(2);
    // Which one is in use, in words; the browser and the system; no network address.
    await expect(sessions.filter({ hasText: 'This session' })).toHaveCount(1);
    await expect(sessions.first()).toContainText(/Chrome on \w+/);
    await expect(page.getByRole('main')).not.toContainText(/\d+\.\d+\.\d+\.\d+/);
    // When each began and was last renewed, in the browser's own time zone.
    const times = sessions.first().locator('time');
    await expect(times).toHaveCount(2);
    const began = await times.first().getAttribute('datetime');
    await expect(times.first()).toHaveText(
      new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Pacific/Auckland',
      }).format(new Date(began!)),
    );
    await expectNoSidewaysScroll(page);
    await screens(page, 'settings');

    // "The user can end any one of them": the other one, in one action.
    await sessions
      .filter({ hasNotText: 'This session' })
      .getByRole('button', { name: 'End session' })
      .click();
    await expect(sessions).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'End other sessions' })).toHaveCount(0);

    // The ended session is refused at once where it would change something,
    // and its browser is signed out.
    const refused = await other.request.post('/api/auth/revoke-other-sessions', {
      headers: { origin: APP_ORIGIN },
    });
    expect(refused.status()).toBe(401);
    expect((await refused.json()).error.message).toBe(UNAUTHENTICATED);
    await other.goto('/settings');
    await expect(other).toHaveURL('/sign-in?return=%2Fsettings');

    // The other browser signs in again, and is listed again.
    await signIn(other, person);
    await expect(other).toHaveURL('/settings');
    await page.reload();
    await expect(sessions).toHaveCount(2);

    // FR-AU-85: the change of the password requires the current one.
    // In its own part of the page: the part for two-factor authentication asks for the password too.
    const current = page
      .getByRole('region', { name: 'Password' })
      .getByLabel('Current password', { exact: true });
    const next = page.getByLabel('New password', { exact: true });
    await expect(current).toHaveAttribute('autocomplete', 'current-password');
    await expect(next).toHaveAttribute('autocomplete', 'new-password');
    const renewed = `${person.password} new`;
    await current.fill(`${person.password} wrong`);
    await next.fill(renewed);
    await page.getByRole('button', { name: 'Change password' }).click();
    const refusal = alertOn(page);
    await expect(refusal).toHaveText(SIGN_IN_REFUSED);
    await expect(refusal).toBeFocused();
    await screens(page, 'settings-fault');

    await current.fill(person.password);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status')).toHaveText(CHANGED);
    await expect(alertOn(page)).toHaveCount(0);
    // Neither password stays in the page.
    await expect(current).toHaveValue('');
    await expect(next).toHaveValue('');
    // "Every other session of the account ends": the list holds this one alone,
    // and the other browser can change nothing.
    await expect(sessions).toHaveCount(1);
    await other.getByRole('button', { name: 'End other sessions' }).click();
    await expect(other).toHaveURL('/sign-in');
    await other.context().close();
    // FR-AU-87 (d): the notice.
    await mailFor(person.email, NOTICE_EMAIL);

    // The session in use stands, and the new password signs in.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/sign-in');
    await signIn(page, person);
    await expect(alertOn(page)).toHaveText(SIGN_IN_REFUSED);
    await signIn(page, person, renewed);
    await expect(page.getByRole('heading', firstScreen)).toBeVisible();

    expect(elsewhere).toEqual([]);
  });

  test('ending the session in use signs its browser out', async ({ page }) => {
    await ready(page);
    await page.goto('/settings');
    await page.getByRole('main').getByRole('button', { name: 'End session' }).click();
    await expect(page).toHaveURL('/sign-in');
    expect((await page.request.get('/api/anything')).status()).toBe(401);
  });

  test('are held back, like every page, until the notice is acknowledged', async ({ page }) => {
    await signUp(page, newPerson());
    await page.goto('/settings');
    await expect(page.getByRole('heading', noticeTitle)).toBeVisible();
    await expect(page.getByRole('heading')).toHaveCount(1);
    const underneath = await (await page.request.get('/settings')).text();
    expect(underneath).not.toContain('Change password');
    expect(underneath).not.toContain('End session');
  });
});
