// The transfer of ownership (FR-ED-47, FR-ED-42, FR-AU-13): the section of the
// sharing settings, the notification and the page of the offer, declining,
// accepting, withdrawing, and what each person's document list and sharing
// settings show afterwards. What a transfer does to a page that is open
// (FR-ED-40 (h)) needs the collaboration server, and is in
// tests/e2e/editor.spec.ts. The words are those of docs/plan/slice-17.md,
// section 7 (for the owner's approval), written out here.
import { expect, test, type Page } from './fixtures.ts';
import { expectNoSidewaysScroll, mailFor, newPerson, screens, signUp, type Person } from './account.ts';
import { accept, CONFIRMATION, invite, personRow, shareNew } from './sharing.ts';

const NO_LONGER_OPEN =
  'This offer is no longer open. The Editor accepted or declined it, the Owner withdrew it, or it expired. Open your notifications to see the offers that are open.';
const NOT_OPEN_TO_ACCOUNT =
  'This offer is not open to this account. Only the Editor it was made to can accept it. Open your notifications to see the offers made to you.';
const OFFERED = 'Ada Owner offered you ownership of Untitled document.';
const SENTENCE =
  'Offer ownership of this document to one of its Editors. Ownership changes only when they accept. If they accept, they become the Owner, you become an Editor, and the document moves to their personal workspace.';

async function enter(page: Page, person: Person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}

/** The Owner's document with an Editor and a Viewer, each in a context of their own, all signed in and accepted. */
async function shared(page: Page, browser: import('@playwright/test').Browser) {
  const ada = await enter(page, { ...newPerson(), name: 'Ada Owner' });
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
  await page.reload();
  await expect(page.getByText('3 of 10 people')).toBeVisible();
  return { id, theirs, his, bea, cy, ada, contexts: [beaContext, cyContext] };
}

/** The Owner chooses the Editor and confirms the offer in its dialog, with the password it asks for (FR-ED-47, D285). */
async function offerFromTheScreen(page: Page, owner: Person) {
  await page.getByRole('button', { name: 'Offer ownership' }).click();
  const dialog = page.getByRole('dialog', { name: 'Offer ownership' });
  await dialog.getByLabel('Current password').fill(owner.password);
  await dialog.getByRole('button', { name: 'Offer ownership' }).click();
  await expect(dialog).toBeHidden();
}

const section = (page: Page) => page.getByRole('heading', { level: 2, name: 'Transfer ownership' });
// `aria-live`, not `role="status"`, which the statement of the people holds alone on this page.
const said = (page: Page, line: string) => page.locator('[aria-live="polite"]').filter({ hasText: line });

test('the Owner offers ownership from the sharing settings, the Editor declines, is offered again, and accepts', async ({
  page,
  browser,
}) => {
  test.slow();
  const { id, theirs, his, bea, ada, contexts } = await shared(page, browser);

  // The section, to the Owner: the sentence, the Editors alone to choose from, and the control.
  await expect(section(page)).toBeVisible();
  await expect(page.getByText(SENTENCE)).toBeVisible();
  const choice = page.getByRole('combobox', { name: 'Editor', exact: true });
  await expect(choice.locator('option')).toHaveText(['Bea Editor']);
  await screens(page, 'transfer-section');
  await expectNoSidewaysScroll(page);
  // An Editor sees none of it: the transfer is the Owner's alone.
  await theirs.goto(`/documents/${id}/sharing`);
  await expect(theirs.getByRole('heading', { level: 1, name: 'Sharing' })).toBeVisible();
  await expect(theirs.getByRole('heading', { name: 'Transfer ownership' })).toHaveCount(0);

  // The confirmation states what happens before anything does, and opens on Cancel, which offers nothing.
  await page.getByRole('button', { name: 'Offer ownership' }).click();
  const dialog = page.getByRole('dialog', { name: 'Offer ownership' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toContainText('Bea Editor');
  await expect(dialog).toContainText(
    'You are asking this Editor to accept ownership of this document. You stay the Owner until they accept. If they accept, they become the Owner, you become an Editor, and the document moves to their personal workspace. Everything else stays as it is. The offer is open for 14 days.',
  );
  await screens(page, 'transfer-confirmation');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Withdraw offer')).toHaveCount(0);
  await theirs.goto('/notifications');
  await expect(theirs.getByText(OFFERED)).toHaveCount(0);

  // Offered: said, with focus on what was said (WCAG 2.4.3), and the open offer in place of the form.
  await offerFromTheScreen(page, ada);
  await expect(said(page, 'Ownership offered to Bea Editor.')).toBeFocused();
  await expect(page.getByText('Ownership of this document is offered to Bea Editor.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw offer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Offer ownership' })).toHaveCount(0);
  await screens(page, 'transfer-open-offer');

  // The Editor: the notification, with the unread count in the header, and the page of the offer.
  await theirs.reload();
  const header = theirs.getByRole('link', { name: /^Notifications/ });
  await expect(header).toHaveAccessibleName('Notifications 2 unread');
  await header.click();
  await expect(theirs.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect(theirs.getByText(OFFERED)).toBeVisible();
  await screens(theirs, 'transfer-notification');
  const open = theirs.getByRole('link', { name: 'Open the offer' });
  const offerPath = (await open.getAttribute('href'))!;
  expect(offerPath).toMatch(/^\/ownership-offers\/[A-Za-z0-9_-]+$/);

  // The email: the fixed text, with the notification list as its link, and no title.
  const { text } = await mailFor(bea.email, /An offer of ownership of a document in Ekdotico/);
  expect(text).toContain(
    'Ada Owner has offered you ownership of a document that you edit in Ekdotico. To accept or decline, open your notifications in Ekdotico:\n',
  );
  // D307: the link stands on a line of its own.
  expect(text).toMatch(/Ekdotico:\n[^\s]+\/notifications\nThe offer is open until /);
  expect(text).toContain(
    'If you accept, you become the Owner of the document and Ada Owner becomes an Editor.',
  );
  expect(text).not.toContain('Untitled');

  await open.click();
  await expect(theirs.getByRole('heading', { level: 1, name: 'Offer of ownership' })).toBeVisible();
  const body = theirs.getByRole('paragraph').filter({ hasText: 'has offered you ownership of' });
  await expect(body).toContainText(
    'Ada Owner has offered you ownership of Untitled document. If you accept, you become the Owner of the document and Ada Owner becomes an Editor. The document moves to your personal workspace. The offer is open until',
  );
  await screens(theirs, 'transfer-offer-page');
  await expectNoSidewaysScroll(theirs);

  // Another account is told only that the offer is not open to it, and the account that offered it likewise.
  await his.goto(offerPath);
  await expect(his.getByRole('heading', { level: 1, name: 'Offer of ownership' })).toBeVisible();
  await expect(his.getByText(NOT_OPEN_TO_ACCOUNT)).toBeVisible();
  await page.goto(offerPath);
  await expect(page.getByText(NOT_OPEN_TO_ACCOUNT)).toBeVisible();

  // Declined: said, with focus on it; the notification goes and the Owner may offer again.
  await theirs.getByRole('button', { name: 'Decline' }).click();
  await expect(theirs.getByText('Offer declined.')).toBeVisible();
  await expect(theirs.getByText('Offer declined.')).toBeFocused();
  await theirs.goto('/notifications');
  await expect(theirs.getByText(OFFERED)).toHaveCount(0);
  await theirs.goto(offerPath);
  await expect(theirs.getByText(NO_LONGER_OPEN)).toBeVisible();
  await page.goto(`/documents/${id}/sharing`);
  await expect(page.getByRole('combobox', { name: 'Editor', exact: true })).toBeVisible();
  await expect(page.getByText('Withdraw offer')).toHaveCount(0);

  // Offered again, and accepted from the notification: the document is the Editor's, and goes to its page.
  await offerFromTheScreen(page, ada);
  await expect(said(page, 'Ownership offered to Bea Editor.')).toBeVisible();
  await theirs.goto('/notifications');
  const secondPath = (await theirs.getByRole('link', { name: 'Open the offer' }).getAttribute('href'))!;
  expect(secondPath).not.toBe(offerPath);
  await theirs.getByRole('link', { name: 'Open the offer' }).click();
  await theirs.getByRole('button', { name: 'Accept' }).click();
  await theirs.waitForURL(`**/documents/${id}`);

  // Bea is the Owner: the document is hers to delete and to offer on, and its sharing settings say so.
  await theirs.goto('/');
  await expect(theirs.getByRole('button', { name: 'Delete document' })).toBeVisible();
  await theirs.goto(`/documents/${id}/sharing`);
  await expect(personRow(theirs, 'Bea Editor')).toContainText('Bea Editor, Owner');
  await expect(personRow(theirs, 'Ada Owner')).toContainText('Ada Owner, Editor');
  await expect(section(theirs)).toBeVisible();
  await expect(theirs.getByRole('heading', { level: 2, name: 'Permissions' })).toBeVisible();
  await expect(theirs.getByRole('heading', { name: 'Leave document' })).toHaveCount(0);
  await theirs.goto('/notifications');
  await expect(theirs.getByText(OFFERED)).toHaveCount(0);
  // The link of the offer that was accepted leads her to the document she holds; that of the declined one says it is over.
  await theirs.goto(offerPath);
  await expect(theirs.getByText(NO_LONGER_OPEN)).toBeVisible();
  await theirs.goto(secondPath);
  await theirs.waitForURL(`**/documents/${id}`);

  // Ada is an Editor: the document stays in her list without the Owner's controls, and she may leave.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Untitled document' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete document' })).toHaveCount(0);
  await page.goto(`/documents/${id}/sharing`);
  await expect(personRow(page, 'Ada Owner')).toContainText('Ada Owner, Editor');
  await expect(page.getByRole('heading', { name: 'Transfer ownership' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Leave document' })).toBeVisible();
  // The Viewer's role is as it was.
  await expect(personRow(page, 'Cy Viewer')).toContainText('Cy Viewer, Viewer');
  for (const context of contexts) await context.close();
});

test('the Owner withdraws the offer, and the Editor’s link and notification are over', async ({
  page,
  browser,
}) => {
  test.slow();
  const { theirs, ada, contexts } = await shared(page, browser);
  await offerFromTheScreen(page, ada);
  await expect(said(page, 'Ownership offered to Bea Editor.')).toBeVisible();
  await theirs.goto('/notifications');
  const offerPath = (await theirs.getByRole('link', { name: 'Open the offer' }).getAttribute('href'))!;

  await page.getByRole('button', { name: 'Withdraw offer' }).click();
  await expect(said(page, 'Offer of ownership to Bea Editor withdrawn.')).toBeFocused();
  // The open offer is gone and the form is back: the Owner may offer again.
  await expect(page.getByRole('button', { name: 'Withdraw offer' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Editor', exact: true })).toBeVisible();

  await theirs.goto(offerPath);
  await expect(theirs.getByText(NO_LONGER_OPEN)).toBeVisible();
  await theirs.goto('/notifications');
  await expect(theirs.getByText(OFFERED)).toHaveCount(0);
  await expect(theirs.getByRole('link', { name: /^Notifications/ })).toHaveAccessibleName(
    'Notifications 1 unread',
  );
  // Nothing was transferred.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Delete document' })).toBeVisible();
  for (const context of contexts) await context.close();
});

test('an Editor who is made a Viewer is offered nothing, and the offer is over', async ({
  page,
  browser,
}) => {
  test.slow();
  const { id, theirs, ada, contexts } = await shared(page, browser);
  await offerFromTheScreen(page, ada);
  await expect(said(page, 'Ownership offered to Bea Editor.')).toBeVisible();
  await theirs.goto('/notifications');
  const offerPath = (await theirs.getByRole('link', { name: 'Open the offer' }).getAttribute('href'))!;

  // The Owner makes the Editor a Viewer: the offer ends without anyone's action (FR-ED-47).
  await page.goto(`/documents/${id}/sharing`);
  const row = personRow(page, 'Bea Editor');
  const change = row.getByRole('button', { name: 'Change role' });
  // A choice made before the page's script has taken over reaches no handler, and the script then puts the old role
  // back: the button stays disabled. Choose again until the button is enabled, which only a choice it heard does.
  await expect(async () => {
    await row.getByRole('combobox', { name: 'Role of Bea Editor' }).selectOption('viewer');
    await expect(change).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await change.click();
  await expect(page.getByRole('status')).toHaveText('Role of Bea Editor changed to Viewer.');
  await expect(page.getByText('This document has no Editor to offer ownership to.')).toBeVisible();
  await theirs.goto(offerPath);
  await expect(theirs.getByText(NO_LONGER_OPEN)).toBeVisible();
  for (const context of contexts) await context.close();
});
