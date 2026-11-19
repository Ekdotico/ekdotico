// Clearing the documents, on the deletion screen and in the pages of the people it reaches (FR-AU-91, FR-AU-58,
// FR-ED-42, FR-ED-36; NFR-IC-19): the control, the confirmation that names the number and the people and asks for the
// password, the documents that wait for their day and the means to cancel them, the notice and the email of the
// collaborators, the lists, and the notice of the deletion. What a page that is open does (FR-ED-40 (i)) needs the
// collaboration server, and is in tests/e2e/editor.spec.ts. The words are those of docs/plan/slice-23.md, section 6
// (for the owner's approval), and FR-AU-91's own; written out here and not taken from the code under test.
import { expect, test, type Page } from './fixtures.ts';
import {
  alertOn,
  expectNoSidewaysScroll,
  mailFor,
  newPerson,
  screens,
  SIGN_IN_REFUSED,
  signUp,
  watchOrigins,
  type Person,
} from './account.ts';
import { accept, CONFIRMATION, invite, runClearing, shareNew } from './sharing.ts';

const DATE = '\\d{1,2} \\w{3} \\d{4}, \\d{2}:\\d{2}';

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

/** The Owner's document with an Editor and a Viewer, each in a context of their own, all signed in and accepted. */
async function shared(page: Page, browser: import('@playwright/test').Browser) {
  const owner = await enter(page, { ...newPerson(), name: 'Ada Owner' });
  const id = await shareNew(page);
  const bea = { ...newPerson(), name: 'Bea Editor' };
  const cy = { ...newPerson(), name: 'Cy Viewer' };
  const [beaContext, cyContext] = [await browser.newContext(), await browser.newContext()];
  const [theirs, his] = [await beaContext.newPage(), await cyContext.newPage()];
  await enter(theirs, bea);
  await enter(his, cy);
  await invite(page, [bea.email], 'Editor');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(bea.email));
  await invite(page, [cy.email], 'Viewer');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(cy.email));
  await accept(theirs, bea.email, id);
  await accept(his, cy.email, id);
  return { owner, id, theirs, his, bea, cy, contexts: [beaContext, cyContext] };
}

/** Opens "Clear all documents" and confirms with the password. */
async function clearAll(page: Page, password: string, named: string) {
  await page.getByRole('main').getByRole('button', { name: 'Clear all documents' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear all documents' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Current password').fill(password);
  await dialog.getByRole('button', { name: named }).click();
  return dialog;
}

test('an account whose documents are not shared clears them at once: the control, the confirmation, a wrong password, the deletion', async ({
  page,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const person = await enter(page);
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await screen(page);

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 2 })).toHaveText([
    'Transfer ownership of all documents',
    'Clear all documents',
  ]);
  await expect(main.getByRole('paragraph').first()).toHaveText(
    'This account owns 1 document. An account that owns a document cannot be deleted, because every document needs an Owner. Delete the document, transfer its ownership to an Editor who accepts it, or clear it, and then return to this page.',
  );
  await expect(
    main.getByText('Clearing deletes every document the account owns, permanently, at once'),
  ).toBeVisible();
  await expectNoSidewaysScroll(page);
  await screens(page, 'clearing');

  const open = main.getByRole('button', { name: 'Clear all documents' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Clear all documents' });
  await expect(dialog).toBeVisible();
  // What FR-AU-91 asks the confirmation to name and to say.
  await expect(dialog.locator('#clear-all-statement').getByRole('paragraph')).toHaveText([
    'This deletes 1 document permanently.',
    'It is not shared.',
    'A document that is not shared is deleted at once.',
    'No document can be restored once it is deleted.',
    'You can take a copy of a document first by draft export.',
    'Clearing does not delete the account. If you keep it, it has no documents until you create one.',
    'Enter your current password to confirm.',
  ]);
  await expect(dialog).toHaveAccessibleDescription(
    /^This deletes 1 document permanently\. It is not shared\./,
  );
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog.getByLabel('Email address')).toHaveValue(person.email);
  await expect(dialog.getByLabel('Email address')).not.toBeEditable();
  await expect(dialog.getByRole('textbox', { name: 'Code' })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'clearing-dialog');

  // Cancel deletes nothing and gives focus back.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  expect((await page.request.get('/api/documents')).status()).toBe(200);

  // A wrong password: the statement of FR-AU-81 at the head of the form; nothing was deleted; the field is empty.
  await clearAll(page, 'a wrong password, long enough', 'Delete 1 document permanently');
  await expect(alertOn(page)).toContainText(SIGN_IN_REFUSED);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Current password')).toHaveValue('');
  const listed = await (await page.request.get('/api/documents')).json();
  expect(listed.documents).toHaveLength(1);

  // The right one.
  await dialog.getByLabel('Current password').fill(person.password);
  // The statement lives only until the screen is read again. The page asks for that the moment the response is in,
  // and the deletion runs after the response: a quick one leaves the account owning nothing, and the page without
  // the control and its statement. Hold that one read of the page until the statement has been asserted, so that
  // the test does not race the deletion.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = 0;
  await page.route(
    (url) => url.pathname === '/settings/delete-account',
    async (route) => {
      if (route.request().headers()['rsc'] === '1') {
        holding += 1;
        await held;
      }
      await route.continue();
    },
  );
  const status = main.getByRole('status').filter({ hasText: 'being deleted now' });
  try {
    await dialog.getByRole('button', { name: 'Delete 1 document permanently' }).click();
    await expect(dialog).toBeHidden();
    await expect(status).toHaveText(
      '1 document is being deleted now. Ekdotico completes the deletion without you.',
    );
    await expect(status).toBeFocused();
    await screens(page, 'clearing-done');
    // The screen did ask to be read again, once: if the app stops doing so, the hold proves nothing.
    await expect.poll(() => holding).toBe(1);
  } finally {
    release();
  }
  // Completed without the user, a moment after the response: the account owns nothing, and the screen offers its deletion.
  await expect
    .poll(async () => (await (await page.request.get('/api/documents')).json()).documents.length, {
      timeout: 20_000,
    })
    .toBe(0);
  // The list above drops a document the moment it is claimed; the screen counts it until it is deleted permanently,
  // a little later. Read the screen again until it shows what the account may do now.
  await expect(async () => {
    await page.reload();
    await expect(main.getByRole('button', { name: 'Delete account' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(main.getByRole('button', { name: 'Clear all documents' })).toHaveCount(0);
  expect(elsewhere).toEqual([]);
});

test('a shared document waits for its day: the confirmation names the people, the collaborators are told and see it in their lists, the Owner cancels, clears again, and the day comes', async ({
  page,
  browser,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  const { owner, id, theirs, his, bea, cy, contexts } = await shared(page, browser);
  await screen(page);

  // The confirmation: the number, how many are shared and with how many people, the day, and the rest.
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Clear all documents' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear all documents' });
  const lines = dialog.locator('#clear-all-statement').getByRole('paragraph');
  await expect(lines.nth(0)).toHaveText('This deletes 1 document permanently.');
  await expect(lines.nth(1)).toHaveText('It is shared, with 2 people in all.');
  await expect(lines.nth(2)).toHaveText(
    new RegExp(
      `^The shared document is deleted on ${DATE}, 7 days from now, after its collaborators have been told\\.$`,
    ),
  );
  await expect(lines.nth(3)).toHaveText('No document can be restored once it is deleted.');
  await expect(lines.nth(4)).toHaveText(new RegExp(`^The account cannot be deleted before ${DATE}\\.$`));
  await expectNoSidewaysScroll(page);
  await screens(page, 'clearing-shared-dialog');
  await dialog.getByLabel('Current password').fill(owner.password);
  await dialog.getByRole('button', { name: 'Delete 1 document permanently' }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole('status').filter({ hasText: 'will be deleted on' })).toHaveText(
    new RegExp(`^1 document will be deleted on ${DATE}\\. Its collaborators have been told\\.$`),
  );

  // The Owner's screen lists it, with the day and the means to cancel it, and says when the account can be deleted.
  const waiting = main.getByRole('heading', { level: 2, name: 'Waiting for their day' });
  await expect(waiting).toBeVisible();
  await expect(main.getByRole('listitem').filter({ hasText: 'Will be deleted on' })).toContainText(
    'Untitled document',
  );
  await expect(main.getByText(new RegExp(`The account cannot be deleted before ${DATE}\\.`))).toBeVisible();
  await expect(main.getByRole('button', { name: 'Clear all documents' })).toHaveCount(0);
  await screens(page, 'clearing-waiting');

  // The collaborators: one notification and one email, naming no document in the email; the list says "Will be deleted".
  for (const [who, guest] of [
    [bea, theirs],
    [cy, his],
  ] as const) {
    await guest.goto('/notifications');
    const item = guest.getByRole('listitem').filter({ hasText: 'will be deleted by its Owner' });
    await expect(item).toContainText('Untitled document will be deleted by its Owner on');
    await expect(item).toContainText('You can take a draft export until then.');
    await expect(item.getByRole('link', { name: 'Open the document' })).toHaveAttribute(
      'href',
      `/documents/${id}`,
    );
    await expectNoSidewaysScroll(guest);
    // The link leads to the document, read-only, with the export that FR-AU-91 and FR-ED-44 (d) give every role in
    // the period: a Viewer's set gives it none otherwise.
    await item.getByRole('link', { name: 'Open the document' }).click();
    await expect(guest.getByRole('button', { name: 'Export as Markdown' })).toBeVisible();
    await guest.goBack();
    const mail = await mailFor(
      who.email,
      /The Owner of 1 document that you have access to in Ekdotico will delete it on [^.]+\./,
    );
    expect(mail.text).toContain('Subject: Documents you have access to in Ekdotico will be deleted');
    expect(mail.text).not.toContain('Untitled document');
    await guest.goto('/');
    await expect(guest.getByRole('listitem').first()).toContainText('Will be deleted on');
    await expect(guest.getByRole('button', { name: /Rename|Delete document/ })).toHaveCount(0);
  }
  await screens(theirs, 'notifications-clearing');
  // The Owner's own list says it, and offers neither the rename nor the deletion by hand.
  await page.goto('/');
  await expect(page.getByRole('listitem').first()).toContainText('Will be deleted on');
  await expect(page.getByRole('button', { name: /Rename|Delete document/ })).toHaveCount(0);

  // A request to change it is a 409 with the day.
  const refused = await page.request.patch(`/api/documents/${id}`, {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: { title: 'Another' },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.message).toMatch(
    new RegExp(
      `^This document will be deleted on ${DATE} UTC, so it cannot be changed\\. Nothing was changed\\.$`,
    ),
  );

  // The Owner cancels: the collaborators are told that it will not be deleted, and the notice of the day is gone.
  await screen(page);
  await main.getByRole('button', { name: 'Cancel deletion' }).click();
  await expect(main.getByRole('status').filter({ hasText: 'The deletion was cancelled.' })).toHaveText(
    'The deletion was cancelled. The people who hold a role on the document have been told that it will not be deleted.',
  );
  await expect(main.getByRole('heading', { level: 2, name: 'Waiting for their day' })).toHaveCount(0);
  await theirs.goto('/notifications');
  // The notice of the day is replaced (the invitation they accepted stays, as its subject does).
  await expect(theirs.getByRole('listitem').filter({ hasText: 'will be deleted by its Owner' })).toHaveCount(
    0,
  );
  await expect(theirs.getByRole('listitem').filter({ hasText: 'will not be deleted' })).toHaveText(
    /Untitled document will not be deleted\./,
  );
  await theirs.goto('/');
  await expect(theirs.getByRole('listitem').first()).not.toContainText('Will be deleted on');

  // Cleared again, and the day comes: the people are told that it was deleted, with the title, and nothing to open.
  await screen(page);
  await clearAll(page, owner.password, 'Delete 1 document permanently');
  await expect(main.getByRole('heading', { level: 2, name: 'Waiting for their day' })).toBeVisible();
  runClearing(owner.email, 8);
  for (const guest of [theirs, his]) {
    await guest.goto('/notifications');
    const item = guest.getByRole('listitem').filter({ hasText: 'was deleted by its Owner' });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Untitled document was deleted by its Owner. It cannot be restored.');
    await expect(item.getByRole('link')).toHaveCount(0);
    await expect(guest.getByRole('listitem').filter({ hasText: /will (not )?be deleted/ })).toHaveCount(0);
    await guest.goto('/');
    await expect(guest.getByText('No documents yet.')).toBeVisible();
    expect((await guest.request.get(`/api/documents/${id}`)).status()).toBe(404);
  }
  await screens(his, 'notifications-clearing-deleted');
  // The Owner's account owns nothing, and the screen offers its deletion.
  await screen(page);
  await expect(main.getByRole('button', { name: 'Delete account' })).toBeVisible();
  expect(elsewhere).toEqual([]);
  await Promise.all(contexts.map((context) => context.close()));
});
