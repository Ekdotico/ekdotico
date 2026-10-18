// Sharing a document (FR-ED-21, FR-ED-37, FR-ED-42): inviting from the
// sharing settings, the uniform confirmation, the email and the notification,
// accepting and declining, revoking and sending again, expiry, and the limit
// of ten people. A Viewer's editor that does not write (FR-ED-39) needs the
// collaboration server, and is in tests/e2e/editor.spec.ts.
import { expect, test, type Page } from './fixtures.ts';
import { mailFor, newPerson, signUp, type Person } from './account.ts';
import {
  CONFIRMATION,
  expire,
  invite,
  INVITATION_LINK,
  LIMIT,
  NO_LONGER_OPEN,
  NOT_OPEN_TO_ACCOUNT,
  pendingRow,
  shareNew,
} from './sharing.ts';

async function enter(page: Page, person: Person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}

test('an invitation by email and notification, accepted as Viewer', async ({ page, browser }) => {
  test.slow();
  const owner = await enter(page);
  const id = await shareNew(page);
  const invitee = newPerson();
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await enter(theirs, invitee);

  // One confirmation for each address, the same whether or not it has an account.
  const nobody = `nobody-${Date.now()}@example.com`;
  await invite(page, [invitee.email, nobody], 'Viewer');
  const status = page.getByRole('status');
  await expect(status.getByRole('paragraph')).toHaveText([CONFIRMATION(invitee.email), CONFIRMATION(nobody)]);
  await expect(page.getByText('3 of 10 people')).toBeVisible();
  await expect(pendingRow(page, invitee.email)).toContainText('Viewer');
  await expect(pendingRow(page, nobody)).toBeVisible();

  // The notification, with its unread count in the header of every page.
  await theirs.reload();
  const header = theirs.getByRole('link', { name: /^Notifications/ });
  await expect(header).toHaveAccessibleName('Notifications 1 unread');
  await header.click();
  await expect(theirs.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect(theirs.getByText(`${owner.name} invited you to a document as Viewer.`)).toBeVisible();
  await theirs.getByRole('button', { name: 'Mark as read' }).click();
  await expect(theirs.getByText('Unread', { exact: true })).toBeHidden();
  await expect(header).toHaveAccessibleName('Notifications');

  // The email carries the link; the link opens the invitation for this account alone.
  const { found: link } = await mailFor(invitee.email, INVITATION_LINK);
  const path = new URL(link).pathname;
  await page.goto(path);
  await expect(page.getByText(NOT_OPEN_TO_ACCOUNT)).toBeVisible();
  await theirs.goto(path);
  await expect(theirs.getByRole('heading', { level: 1, name: 'Invitation to a document' })).toBeVisible();
  await expect(theirs.getByText(`${owner.name} invited you to a document as Viewer.`)).toBeVisible();
  await theirs.getByRole('button', { name: 'Accept' }).click();
  await theirs.waitForURL(`**/documents/${id}`);

  // The shared document is in the Viewer's list, without the Owner's controls.
  await theirs.goto('/');
  await expect(theirs.getByRole('link', { name: 'Untitled document' })).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Delete document' })).toHaveCount(0);
  // Accepted once: the link leads to the document.
  await theirs.goto(path);
  await theirs.waitForURL(`**/documents/${id}`);
  await other.close();
});

test('declined, revoked, sent again, and expired invitations', async ({ page, browser }) => {
  test.slow();
  await enter(page);
  await shareNew(page);
  const [declining, revoked, again, expiring] = [newPerson(), newPerson(), newPerson(), newPerson()];
  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [n, person] of [declining, revoked, again, expiring].entries()) await enter(pages[n]!, person);
  await invite(page, [declining.email, revoked.email, again.email, expiring.email]);
  await expect(page.getByText('5 of 10 people')).toBeVisible();

  // Declined from the notification list (the owner's answer to Q2): the notification goes.
  const [theirs] = pages as [Page];
  await theirs.goto('/notifications');
  await theirs.getByRole('link', { name: 'Open the invitation' }).click();
  await theirs.getByRole('button', { name: 'Decline' }).click();
  await expect(theirs.getByText('Invitation declined.')).toBeVisible();
  await theirs.goto('/notifications');
  await expect(theirs.getByText('There are no notifications.')).toBeVisible();

  // Revoked: the link is no longer open.
  const revokedLink = new URL((await mailFor(revoked.email, INVITATION_LINK)).found).pathname;
  await pendingRow(page, revoked.email).getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('status')).toHaveText(`Invitation to ${revoked.email} revoked.`);
  await expect(pendingRow(page, revoked.email)).toHaveCount(0);
  await pages[1]!.goto(revokedLink);
  await expect(pages[1]!.getByText(NO_LONGER_OPEN)).toBeVisible();

  // Sent again: a new link, and the first no longer open.
  const firstLink = new URL((await mailFor(again.email, INVITATION_LINK)).found).pathname;
  await pendingRow(page, again.email).getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('status')).toHaveText(CONFIRMATION(again.email));
  let secondLink = firstLink;
  await expect
    .poll(async () => (secondLink = new URL((await mailFor(again.email, INVITATION_LINK)).found).pathname))
    .not.toBe(firstLink);
  await pages[2]!.goto(firstLink);
  await expect(pages[2]!.getByText(NO_LONGER_OPEN)).toBeVisible();
  await pages[2]!.goto(secondLink);
  await expect(pages[2]!.getByRole('button', { name: 'Accept' })).toBeVisible();

  // Expired: no longer open, and out of the list and the count.
  const expiringLink = new URL((await mailFor(expiring.email, INVITATION_LINK)).found).pathname;
  expire(expiring.email);
  await pages[3]!.goto(expiringLink);
  await expect(pages[3]!.getByText(NO_LONGER_OPEN)).toBeVisible();
  await pages[3]!.goto('/notifications');
  await expect(pages[3]!.getByText('There are no notifications.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('2 of 10 people')).toBeVisible();
  for (const context of contexts) await context.close();
});

test('a document holds ten people, the Owner and pending invitations counted', async ({ page }) => {
  await enter(page);
  await shareNew(page);
  const stamp = Date.now();
  const nine = Array.from({ length: 9 }, (_, n) => `ten-${stamp}-${n}@example.com`);
  await invite(page, nine);
  await expect(page.getByText('10 of 10 people')).toBeVisible();
  await invite(page, [`ten-${stamp}-tenth@example.com`]);
  await expect(page.getByRole('alert').filter({ hasText: LIMIT })).toBeVisible();
  await expect(page.getByText('10 of 10 people')).toBeVisible();
});
