// The path a person takes from an invitation to the first screen and back in
// again, and what the pages on it owe (FR-AU-55 to FR-AU-57, FR-AU-81,
// FR-AU-84, FR-AU-88, FR-AU-90, FR-AU-07).
import { expect, test } from '@playwright/test';
import {
  NOTICE_BODY,
  NOTICE_TITLE,
  NOT_OPEN,
  SIGN_IN_REFUSED,
  admission,
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
const firstScreen = { level: 1, name: 'Signed in' } as const;
// A page of a signed-in account and an address that is no page, each with words
// of its content that the Closed α notice does not hold (FR-AU-55).
const CONTENT = [
  ['/', 'documents are planned'],
  ['/anything', 'No page of Ekdotico has this address'],
] as const;
// Asked for as a page, and as the data Next.js sends to a page it already holds.
const WAYS: Record<string, string>[] = [{}, { RSC: '1' }];

test('from an invitation to the first screen, out, and in again', async ({ page }) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = newPerson();

  // FR-AU-90: the invitation's link opens the sign-up page, which shows the
  // invited address and does not let it be changed.
  await page.goto(await invite(person.email));
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

  // A request too long to be read is a fault of the request and not of the
  // invitation: it is stated at the head of the form, and the form stays,
  // with what was typed. (The statement names the name, so the field is found
  // by its role.)
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  const long = 'n'.repeat(5000);
  await password.fill(person.password);
  await name.fill(long);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(fault).toHaveText(
    'The account was not created, because the request is longer than a name and a password can make it. Shorten the name or the password and try again.',
  );
  await expect(fault).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create account');
  await expect(name).toHaveValue(long);
  await expect(address).toHaveValue(person.email);
  await expect(page.getByText(NOT_OPEN)).toHaveCount(0);
  await name.fill(person.name);

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

  // In place of the page's content: the content is not in the response at all,
  // as a page or as the data Next.js sends a page it already holds (`RSC: 1`).
  // The same four requests find the content after the acknowledgement, below.
  const underneath = await (await page.request.get('/')).text();
  expect(underneath).toContain('Continue');
  for (const [path, content] of CONTENT) {
    for (const headers of WAYS) {
      expect(await (await page.request.get(path, { headers })).text()).not.toContain(content);
    }
  }

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
  await expect(page).toHaveTitle('Signed in – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByText(NOTICE_BODY)).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'first-screen');
  // The control of the check made while the notice was due: the content is
  // what those requests return now.
  for (const [path, content] of CONTENT) {
    for (const headers of WAYS) {
      expect(await (await page.request.get(path, { headers })).text()).toContain(content);
    }
  }

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
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(NOT_OPEN);
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
  const link = await invite(person.email);

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
  await expect(other.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(NOT_OPEN);
  await other.context().close();
});

// FR-AU-89 (b), (c), through the server as it runs: the command lists and
// revokes, and the link of a revoked invitation creates nothing.
test('the team lists the invitations and revokes one, whose link is then not open', async ({ page }) => {
  const person = newPerson();
  const link = await invite(person.email);
  await page.goto(link);
  await expect(page.getByLabel('Name')).toBeVisible();

  const listed = admission('list');
  expect(listed.status).toBe(200);
  const { invitations } = listed.answer as { invitations: { id: string; email?: string; state: string }[] };
  const mine = invitations.filter((invitation) => invitation.email === person.email);
  expect(mine.map((invitation) => invitation.state)).toEqual(['pending']);
  // Neither the token nor the link is returned.
  expect(JSON.stringify(listed.answer)).not.toContain(link.split('/').at(-1));

  const revoked = admission('revoke', mine[0]!.id);
  expect(revoked.status).toBe(200);
  expect(revoked.answer).toMatchObject({ id: mine[0]!.id, state: 'revoked' });
  expect(admission('list').answer).toMatchObject({
    invitations: expect.arrayContaining([expect.objectContaining({ id: mine[0]!.id, state: 'revoked' })]),
  });

  // The page that was open: its form gives way to the statement.
  await page.getByLabel('Name').fill(person.name);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(alertOn(page)).toHaveText(NOT_OPEN);
  // And the link, opened again.
  await page.goto(link);
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(NOT_OPEN);
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('the sign-in page offers sign-up to no one, and asks no other origin for anything', async ({ page }) => {
  const elsewhere = watchOrigins(page);
  await page.goto('/sign-in');
  await expect(page).toHaveTitle('Sign in – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  // FR-AU-57. One link, to the page that asks for a password reset (FR-AU-86).
  await expect(page.getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('link')).toHaveText('Set a new password');
  await expect(page.getByRole('link')).toHaveAttribute('href', '/reset-password');
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

// Every route answers in JSON and none redirects (src/components/send.ts). A
// redirect is an intermediary's, to a page of its own that answers 200: followed,
// that page would be read as a sign-in that succeeded.
test('a redirect in place of the answer is a fault, and never a sign-in', async ({ page }) => {
  await page.route('**/api/auth/sign-in/email', (route) =>
    route.fulfill({ status: 302, headers: { location: '/sign-in?from=an-intermediary' } }),
  );
  await page.goto('/sign-in?return=%2Fdocuments');
  await signIn(page, newPerson());
  await expect(alertOn(page)).toHaveText(
    'The request did not reach Ekdotico. Check the connection and try again.',
  );
  await expect(page).toHaveURL('/sign-in?return=%2Fdocuments');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
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
    // FR-AU-07: and only ever to a path of this origin, whatever the address says.
    for (const target of ['//example.com/', 'https://example.com/', '/\\example.com']) {
      const sent = await page.request.get(`/sign-in?return=${encodeURIComponent(target)}`, {
        maxRedirects: 0,
      });
      expect(sent.status(), target).toBe(307);
      expect(sent.headers().location, target).toBe('/');
    }
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
