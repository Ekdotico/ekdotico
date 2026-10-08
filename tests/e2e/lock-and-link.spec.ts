// The lock of an account after failed sign-ins, and the page that the sign-in
// link of its email opens (FR-AU-81, FR-AU-87 (h), FR-AU-88; register D115;
// A104, assumed). The server of the tests locks at the fifth failure
// (playwright.config.ts), since every request of a run comes from one network
// address, which is allowed five.
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
  type Person,
} from './account.ts';
import { APP_ORIGIN } from './origin.ts';

// The fixed texts, written out here and not taken from the code under test.
// FR-AU-87 (h), around the link and the time, with the number of this server.
const LOCK_EMAIL = (link: string) =>
  `Subject: Sign-in to your Ekdotico account is locked for 1 hour\n` +
  `[^]*\n\nSign-in to your Ekdotico account is locked for 1 hour, because sign-in to it failed 5 times within an hour\\. To sign in now, open this link:\n${link}\nIt works once, until [0-9]{2}:[0-9]{2} UTC on [0-9]{4}-[0-9]{2}-[0-9]{2}, and it lifts the lock\\. If the failed attempts were not yours, set a new password from the sign-in page\\.$`;
// FR-AU-81.
const NOT_VALID =
  'This link is no longer valid. Sign in with your email address and password, or set a new password from the sign-in page.';
// The application's own words (the owner's answer to Q6 of the plan).
const NAMES = (email: string) =>
  `This link signs in to the Ekdotico account with the email address ${email}, and lifts the lock on sign-in to it.`;
const OTHER_ACCOUNT = 'This browser is signed in to another account. Signing in here ends that session.';

const firstScreen = { level: 1, name: 'Signed in' } as const;
const LINK = /\/sign-in\/link\/[A-Za-z0-9_-]{43}/;

/** An account that has acknowledged the notice, signed in on this page. */
async function ready(page: Page, person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  return person;
}

/** Five failed sign-ins for the address, by requests of this origin: the fifth locks the account. */
async function lock(page: Page, person: Person) {
  for (let n = 0; n < 5; n++) {
    const refused = await page.request.post('/api/auth/sign-in/email', {
      headers: { origin: APP_ORIGIN },
      data: { email: person.email, password: `${person.password} wrong` },
    });
    expect(refused.status()).toBe(401);
  }
  return mailFor(person.email, LINK);
}

test('a locked account is refused like any other, and the link of the email signs the person in once', async ({
  page,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = await ready(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');

  const { found: link, text } = await lock(page, person);
  // FR-AU-87 (h): the fixed text, with the link on a line of its own.
  expect(text).toMatch(new RegExp(LOCK_EMAIL(`${APP_ORIGIN}${link}`.replaceAll('.', '\\.'))));

  // FR-AU-81: the right password is refused with the one statement.
  await signIn(page, person);
  await expect(alertOn(page)).toHaveText(SIGN_IN_REFUSED);

  // The link opens a page that names the address and carries one control.
  const opened = await page.goto(link);
  expect(opened!.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page).toHaveTitle('Sign in – Ekdotico');
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  await expect(page.getByText(NAMES(person.email))).toBeVisible();
  await expect(page.getByText(OTHER_ACCOUNT)).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveText(['Sign in']);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('link')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'lock-link');

  // "Opening the page alone changes nothing": no session, and the link stands.
  expect((await page.request.get('/api/anything')).status()).toBe(401);
  await page.reload();
  await expect(page.getByText(NAMES(person.email))).toBeVisible();

  // The one control, by the keyboard alone.
  await page.getByRole('button', { name: 'Sign in' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  await expect(page).toHaveURL('/');

  // The link works once.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  await page.goto(link);
  await expect(page.getByText(NOT_VALID)).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  // Part of the page from the first paint, and so no alert.
  await expect(alertOn(page)).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'lock-link-not-valid');

  // The lock is lifted and the counts are cleared: the password signs in at once.
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/sign-in');
  await signIn(page, person);
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  expect(elsewhere).toEqual([]);
});

test('the page says where the browser holds a session of another account, and a link used meanwhile is stated', async ({
  page,
  browser,
}) => {
  test.slow();
  const locked = await ready(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
  const { found: link } = await lock(page, locked);

  // Another person, signed in on this browser.
  await ready(page);
  await page.goto(link);
  await expect(page.getByText(NAMES(locked.email))).toBeVisible();
  await expect(page.getByText(OTHER_ACCOUNT)).toBeVisible();
  await screens(page, 'lock-link-other-account');

  // The link is used in another browser while this page is open.
  const elsewhere = await browser.newContext();
  const second = await elsewhere.newPage();
  await second.goto(link);
  await second.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    second
      .getByRole('heading', { level: 1, name: NOTICE_TITLE })
      .or(second.getByRole('heading', firstScreen)),
  ).toBeVisible();
  await elsewhere.close();

  // The control then states that the link no longer works, announced and in focus (FR-AU-88).
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(alertOn(page)).toHaveText(NOT_VALID);
  await expect(alertOn(page)).toBeFocused();
  await expect(page.getByRole('button')).toHaveCount(0);
  // A link that no longer works ends nothing: the other person is still signed in.
  await page.goto('/');
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
});
