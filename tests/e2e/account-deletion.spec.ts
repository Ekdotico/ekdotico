// The deletion screen and the confirmation (FR-AU-58; FR-AU-81, FR-AU-88; NFR-IC-19): where the
// account owns a document, the page states how many and offers nothing to delete; where it owns none,
// the page says what is replaced and what is kept before it asks for anything, the confirmation opens
// on the way that deletes nothing, a wrong password is the statement of FR-AU-81 at the head of the
// form, and the right one deletes: the page says so, and the account can no longer sign in.
import { expect, test, type Page } from './fixtures.ts';
import {
  alertOn,
  expectNoSidewaysScroll,
  newPerson,
  screens,
  SIGN_IN_REFUSED,
  signIn,
  signUp,
  watchOrigins,
} from './account.ts';
import { APP_ORIGIN } from './origin.ts';

// The texts, written out here and not taken from the code under test. FR-AU-58 gives none of the
// words but "Deleted account": they are the application's, for the owner's approval.
const LEAD = 'Deleting the account ends your access to Ekdotico, and it cannot be undone.';
const REPLACED = [
  'Your name and your email address are cleared. Nothing from which you could be found is put in their place.',
  'Your password, your two-factor authentication, and every session are deleted. No one can sign in to the account again.',
  'Your roles on other people’s documents end, and your pending invitations and offers of ownership end.',
  'Wherever Ekdotico would show your name, it shows “Deleted account”.',
];
const KEPT = [
  'What you wrote in other people’s documents stays in them.',
  'The records that refer to the account stay, without a name or an address: invitations, notifications, and the security log, which is kept for a limited time.',
  'The time of the deletion, and your acknowledgement of the Closed α notice.',
];
const BEFORE =
  'Ekdotico carries out the deletion without you, in steps, and repeats a step that does not complete. From the moment you confirm, you are signed out and the account cannot be used.';
const STATEMENT =
  'Deleting this account signs you out everywhere, closes every open connection, and clears your name and email address. This cannot be undone. Enter your current password to confirm.';
const DONE =
  'The account is being deleted. Ekdotico has ended your access and completes the deletion without you. You can close this page.';
const OWNS_ONE =
  'This account owns 1 document. An account that owns a document cannot be deleted, because every document needs an Owner. Delete the document, or transfer its ownership to an Editor who accepts it, and then return to this page.';

async function enter(page: Page) {
  const person = newPerson();
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}

async function openTheScreen(page: Page) {
  await page.getByRole('link', { name: 'Account settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Account settings' })).toBeVisible();
  const section = page.getByRole('region', { name: 'Delete account' });
  await expect(section.getByRole('paragraph').first()).toHaveText(
    'Deleting the account cannot be undone. The page for deleting it says what is replaced and what is kept.',
  );
  await section.getByRole('link', { name: 'Open the page for deleting the account' }).click();
  await expect(page).toHaveURL('/settings/delete-account');
  await expect(page).toHaveTitle('Delete account – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delete account');
}

test('an account that owns a document is told how many, and is offered no deletion; the route refuses as well', async ({
  page,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = await enter(page);
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);

  await openTheScreen(page);
  await expect(page.getByRole('main').getByRole('paragraph')).toHaveText([OWNS_ONE]);
  await expect(page.getByRole('button', { name: 'Delete account' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'delete-account-owns');

  // "The refusal is made on the server, by the route that deletes an account, and does not rest on
  // what the screen offers": asked for directly, with the right password, it is a 409.
  const refused = await page.request.delete('/api/account', {
    headers: { origin: APP_ORIGIN, 'content-type': 'application/json' },
    data: { password: person.password },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).documents).toBe(1);
  // The account is as it was: still signed in.
  expect((await page.request.get('/api/documents')).status()).toBe(200);
  expect(elsewhere).toEqual([]);
});

test('an account that owns none: what is replaced and what is kept, then the confirmation, and the deletion', async ({
  page,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = await enter(page);
  await openTheScreen(page);

  // Before the control: what happens, what cannot be undone (rule 13 of the instructional register).
  const main = page.getByRole('main');
  await expect(main.getByRole('paragraph')).toHaveText([LEAD, BEFORE]);
  await expect(main.getByRole('heading', { level: 2 })).toHaveText(['What is replaced', 'What is kept']);
  await expect(main.getByRole('listitem')).toHaveText([...REPLACED, ...KEPT]);
  await expectNoSidewaysScroll(page);
  await screens(page, 'delete-account');

  const open = main.getByRole('button', { name: 'Delete account' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Delete account' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('paragraph').first()).toHaveText(STATEMENT);
  await expect(dialog).toHaveAccessibleDescription(STATEMENT);
  // Focus opens on the way that deletes nothing; the address is there for a password manager and is read only.
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeFocused();
  await expect(dialog.getByLabel('Email address')).toHaveValue(person.email);
  await expect(dialog.getByLabel('Email address')).not.toBeEditable();
  await expect(dialog.getByLabel('Current password')).toHaveAttribute('autocomplete', 'current-password');
  await expect(dialog.getByRole('textbox', { name: 'Code' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'delete-account-dialog');

  // Cancel and Escape delete nothing, and give focus back.
  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await page.request.get('/api/documents')).status()).toBe(200);

  // A wrong password: the statement of FR-AU-81 at the head of the form, announced, with focus on it.
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Current password').fill('a wrong password, long enough');
  await dialog.getByRole('button', { name: 'Delete account' }).click();
  const fault = alertOn(page);
  await expect(fault).toContainText(SIGN_IN_REFUSED);
  await expect(dialog).toBeVisible();
  await screens(page, 'delete-account-refused');
  // Nothing was deleted, and the password is not kept in the page.
  expect((await page.request.get('/api/documents')).status()).toBe(200);

  // The right one, by keyboard alone.
  await dialog.getByLabel('Current password').fill(person.password);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  const status = page.getByRole('status').filter({ hasText: 'The account is being deleted.' });
  await expect(status).toHaveText(DONE);
  await expect(status).toBeFocused();
  await expect(main.getByRole('button', { name: 'Delete account' })).toHaveCount(0);
  await screens(page, 'delete-account-done');

  // From the confirmation the account makes no request, and signs in nowhere (FR-AU-58 (a)).
  expect((await page.request.get('/api/documents')).status()).toBe(401);
  await page.goto('/sign-in');
  await signIn(page, person);
  await expect(alertOn(page)).toContainText(SIGN_IN_REFUSED);
  await expect(page).toHaveURL('/sign-in');
  expect(elsewhere).toEqual([]);
});
