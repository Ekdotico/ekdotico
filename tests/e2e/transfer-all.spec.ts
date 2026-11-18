// Transferring the ownership of all documents, on the deletion screen and in the pages of the people it reaches
// (FR-AU-92, FR-AU-58, FR-ED-47, FR-ED-42; NFR-IC-19): the states of the documents, the control with its choice
// and its one confirmation that names the numbers, the offers the Editor sees and accepts, and the document that
// is the Editor's afterwards. The words are those of docs/plan/slice-24.md, section 7 (for the owner's approval),
// and FR-AU-92's own; written out here and not taken from the code under test.
import { expect, test, type Page } from './fixtures.ts';
import {
  expectNoSidewaysScroll,
  mailFor,
  newPerson,
  screens,
  signUp,
  watchOrigins,
  type Person,
} from './account.ts';
import { accept, CONFIRMATION, invite, shareNew } from './sharing.ts';

async function enter(page: Page, person: Person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}

const screen = async (page: Page) => {
  await page.goto('/settings/delete-account');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Delete account');
};

test('the Owner offers the ownership of all documents to the longest-standing Editor, who accepts one and sees the email', async ({
  page,
  browser,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const ada = await enter(page, { ...newPerson(), name: 'Ada Owner' });
  const id = await shareNew(page);
  const bea = { ...newPerson(), name: 'Bea Editor' };
  const beaContext = await browser.newContext();
  const theirs = await beaContext.newPage();
  await enter(theirs, bea);
  await invite(page, [bea.email], 'Editor');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(bea.email));
  await accept(theirs, bea.email, id);

  await screen(page);
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { level: 2, name: 'Transfer ownership of all documents' }),
  ).toBeVisible();
  await expect(
    main.getByRole('heading', { level: 3, name: 'Your documents and their offers' }),
  ).toBeVisible();
  const list = main.getByRole('list').filter({ hasText: 'Untitled document' });
  await expect(list.getByRole('listitem')).toHaveText(['Untitled documentNot offered yet.']);
  await expectNoSidewaysScroll(page);
  await screens(page, 'transfer');

  // The control, the choice preselected so that the action and its confirmation are two clicks, the numbers.
  const open = main.getByRole('button', { name: 'Transfer ownership of all documents' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Transfer ownership of all documents' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'To the longest-standing Editor' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'To one person' })).not.toBeChecked();
  await expect(dialog.locator('#transfer-statement').getByRole('paragraph')).toHaveText([
    'You are offering the ownership of 1 document, each to its longest-standing Editor.',
    'Ownership changes only when an Editor accepts. You stay the Owner of each document until then. Each offer is open for 14 days.',
  ]);
  await expect(dialog).toHaveAccessibleDescription(/^You are offering the ownership of 1 document/);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await screens(page, 'transfer-dialog');

  // "To one person" shows the Editors of the account's documents, and the number each would be offered.
  await dialog.getByRole('radio', { name: 'To one person' }).check();
  // No person is put in the place of one who is not chosen: the action waits until one is.
  await expect(dialog.getByRole('combobox', { name: 'Person' })).toHaveValue('');
  await expect(dialog.locator('#transfer-statement').getByRole('paragraph')).toHaveText([
    'Choose a person to see how many documents can be offered to them.',
  ]);
  await expect(dialog.getByRole('button', { name: 'Offer ownership' })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Person' }).selectOption({ label: 'Bea Editor (1 document)' });
  await expect(dialog.locator('#transfer-statement').getByRole('paragraph').first()).toHaveText(
    'You are offering the ownership of 1 document to Bea Editor.',
  );
  await dialog.getByRole('radio', { name: 'To the longest-standing Editor' }).check();

  // Escape offers nothing and gives focus back.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  await open.click();
  // FR-AU-92, D285: the confirmation asks for the password.
  await dialog.getByLabel('Current password').fill(ada.password);
  await dialog.getByRole('button', { name: 'Offer 1 document' }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole('status').filter({ hasText: 'Ownership of 1 document offered.' })).toHaveText(
    'Ownership of 1 document offered. The Editor has been told by a notification and by email.',
  );
  await expect(list.getByRole('listitem')).toHaveText([
    /^Untitled documentOffered to Bea Editor, open until \d{1,2} \w{3} \d{4}, \d{2}:\d{2}\.$/,
  ]);

  // The Editor is told by a notification, with the title, and by one email that names no document.
  await theirs.goto('/notifications');
  await expect(theirs.getByText('Ada Owner offered you ownership of Untitled document.')).toBeVisible();
  const email = (
    await mailFor(bea.email, /has offered you ownership of a document that you edit in Ekdotico/)
  ).found;
  expect(email).not.toBe('');
  await theirs.getByRole('link', { name: 'Open the offer' }).click();
  await theirs.getByRole('button', { name: 'Accept' }).click();
  await theirs.waitForURL(`**/documents/${id}`);

  // The Owner's screen: the account owns nothing, the document is listed as accepted, and the deletion is offered.
  await screen(page);
  await expect(main.getByRole('heading', { level: 2, name: 'What is replaced' })).toBeVisible();
  expect(elsewhere).toEqual([]);
  await beaContext.close();
});

test('an account that owns a document without an Editor is told so, and has no offer to make', async ({
  page,
}) => {
  await enter(page);
  await page.getByRole('button', { name: 'New document' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  await page.goto('/');
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await screen(page);
  const main = page.getByRole('main');
  await expect(
    main.getByText('Without an Editor. Give a collaborator the Editor role, or clear it.'),
  ).toBeVisible();
  await expect(main.getByText('No new offer can be made in this way.').first()).toBeVisible();
  await expect(main.getByRole('button', { name: 'Transfer ownership of all documents' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
