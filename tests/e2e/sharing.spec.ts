// Sharing a document (FR-ED-21, FR-ED-37, FR-ED-38, FR-ED-42): inviting from
// the sharing settings, the uniform confirmation, the email and the
// notification, accepting and declining, revoking and sending again, expiry,
// the limit of ten people, and changing a role, removing a collaborator and
// leaving. A Viewer's editor that does not write (FR-ED-39), and what a
// removal, a leave and a change of role do to an open page (FR-ED-40), need the
// collaboration server, and are in tests/e2e/editor.spec.ts.
import { expect, test, type Page } from './fixtures.ts';
import { expectNoSidewaysScroll, mailFor, newPerson, screens, signUp, type Person } from './account.ts';
import {
  accept,
  CONFIRMATION,
  chooseRole,
  expire,
  invite,
  INVITATION_LINK,
  LIMIT,
  NO_LONGER_OPEN,
  NOT_OPEN_TO_ACCOUNT,
  pendingRow,
  personRow,
  remind,
  setPermissions,
  setRole,
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
  await expect(
    theirs.getByText(
      `${owner.name} (${owner.email}) invited you to the document Untitled document as Viewer.`,
    ),
  ).toBeVisible();
  await theirs.getByRole('button', { name: 'Mark as read' }).click();
  // WCAG 2.4.3: the button goes; focus moves to the link of the same notification.
  await expect(theirs.getByRole('link', { name: 'Open the invitation' })).toBeFocused();
  await expect(theirs.getByText('Unread', { exact: true })).toBeHidden();
  await expect(header).toHaveAccessibleName('Notifications');

  // The email carries the link; the link opens the invitation for this account alone.
  const { found: link } = await mailFor(invitee.email, INVITATION_LINK);
  const path = new URL(link).pathname;
  await page.goto(path);
  await expect(page.getByText(NOT_OPEN_TO_ACCOUNT)).toBeVisible();
  await theirs.goto(path);
  await expect(theirs.getByRole('heading', { level: 1, name: 'Invitation to a document' })).toBeVisible();
  await expect(
    theirs.getByText(
      `${owner.name} (${owner.email}) invited you to the document Untitled document as Viewer.`,
    ),
  ).toBeVisible();
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
  await expect(theirs.getByText('Invitation declined.')).toBeFocused();
  await theirs.goto('/notifications');
  await expect(theirs.getByText('There are no notifications.')).toBeVisible();

  // Revoked: the link is no longer open.
  const revokedLink = new URL((await mailFor(revoked.email, INVITATION_LINK)).found).pathname;
  await pendingRow(page, revoked.email).getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('status')).toHaveText(`Invitation to ${revoked.email} revoked.`);
  // WCAG 2.4.3: the row and its button are gone; focus is on what was said.
  await expect(page.getByRole('status')).toBeFocused();
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

test('the one reminder 3 days before the expiry, by email and in the list, once', async ({
  page,
  browser,
}) => {
  test.slow();
  const owner = await enter(page);
  await shareNew(page);
  const invitee = newPerson();
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await enter(theirs, invitee);
  await invite(page, [invitee.email]);
  await expect(pendingRow(page, invitee.email)).toBeVisible();
  await mailFor(invitee.email, INVITATION_LINK);

  // The timer, run twice 12 days in: one email, one notification (FR-ED-48).
  remind(invitee.email);
  remind(invitee.email);
  const reminder = await mailFor(
    invitee.email,
    /Subject: Your invitation to a document in Ekdotico expires soon/,
  );
  expect(reminder.text).toContain(
    `${owner.name} (${owner.email}) invited you to a document in Ekdotico as Editor. The invitation expires on `,
  );
  expect(reminder.text).toMatch(/open your notifications in Ekdotico:\nhttps?:\/\/[^\s]+\/notifications$/);

  await theirs.goto('/notifications');
  await expect(
    theirs.getByText(`Reminder: ${owner.name} (${owner.email}) invited you to a document as Editor.`),
  ).toBeVisible();
  await expect(theirs.getByText(/The invitation expires on .+\./)).toHaveCount(1);
  await expect(theirs.getByRole('link', { name: 'Open the invitation' })).toHaveCount(2);
  await screens(theirs, 'notifications-reminder');
  await theirs.getByRole('link', { name: 'Open the invitation' }).first().click();
  await expect(theirs.getByRole('heading', { level: 1, name: 'Invitation to a document' })).toBeVisible();
  await other.close();
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

// FR-ED-38, FR-ED-44 (b): the controls over the people, and what each statement says. The words are
// those of docs/plan/slice-15.md, §7 (for the owner's approval), written out here.
test('the Owner changes a role and removes a collaborator, a collaborator leaves, and a removed person is invited again', async ({
  page,
  browser,
}) => {
  test.slow();
  await enter(page, { ...newPerson(), name: 'Ada Owner' });
  const id = await shareNew(page);
  const bea = { ...newPerson(), name: 'Bea Editor' };
  const cy = { ...newPerson(), name: 'Cy Viewer' };
  const [beaContext, cyContext] = [await browser.newContext(), await browser.newContext()];
  const [theirs, his] = [await beaContext.newPage(), await cyContext.newPage()];
  await enter(theirs, bea);
  await enter(his, cy);
  await invite(page, [bea.email]);
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(bea.email));
  await invite(page, [cy.email], 'Viewer');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(cy.email));
  await accept(theirs, bea.email, id);
  await accept(his, cy.email, id);
  const firstLink = (await mailFor(cy.email, INVITATION_LINK)).found;
  await page.reload();
  await expect(page.getByText('3 of 10 people')).toBeVisible();

  // Each collaborator has a role control, "Change role" (off until another role is chosen), and "Remove".
  const bea$ = personRow(page, 'Bea Editor');
  const cy$ = personRow(page, 'Cy Viewer');
  await expect(bea$).toContainText('Bea Editor, Editor');
  await expect(cy$).toContainText('Cy Viewer, Viewer');
  await expect(cy$.getByRole('combobox', { name: 'Role of Cy Viewer' })).toHaveValue('viewer');
  await expect(cy$.getByRole('button', { name: 'Change role' })).toBeDisabled();
  await expect(cy$.getByRole('button', { name: 'Remove Cy Viewer' })).toBeVisible();
  await screens(page, 'sharing-people-owner');

  // A role is changed, and what was done is said, with focus on the statement (WCAG 2.4.3).
  await chooseRole(cy$, 'Cy Viewer', 'editor');
  await cy$.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByRole('status')).toHaveText('Role of Cy Viewer changed to Editor.');
  await expect(page.getByRole('status')).toBeFocused();
  await expect(cy$).toContainText('Cy Viewer, Editor');
  await chooseRole(cy$, 'Cy Viewer', 'viewer');
  await cy$.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByRole('status')).toHaveText('Role of Cy Viewer changed to Viewer.');
  await expect(cy$).toContainText('Cy Viewer, Viewer');

  // An Editor holds no permission to act on the people: Bea sees them, and no control over them.
  await theirs.goto(`/documents/${id}/sharing`);
  await expect(theirs.getByRole('heading', { level: 1, name: 'Sharing' })).toBeVisible();
  await expect(theirs.getByText('3 of 10 people')).toBeVisible();
  await expect(theirs.getByRole('combobox')).toHaveCount(0);
  await expect(theirs.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(theirs.getByRole('button', { name: 'Change role' })).toHaveCount(0);
  // Nor does the Owner have the section of one who leaves (FR-ED-38: "The Owner cannot ... leave").
  await expect(page.getByRole('heading', { name: 'Leave document' })).toHaveCount(0);

  // A removal asks first, says what happens, and opens on Cancel, which removes no one.
  await cy$.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove collaborator' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toContainText('Cy Viewer');
  await expect(dialog).toContainText(
    'Removing this collaborator ends their access to the document and closes their open connections to it. Their edits stay in the document. They can be invited again.',
  );
  await screens(page, 'sharing-remove-confirmation');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(cy$).toBeVisible();
  await expect(page.getByText('3 of 10 people')).toBeVisible();

  await cy$.getByRole('button', { name: 'Remove' }).click();
  await dialog.getByRole('button', { name: 'Remove collaborator' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toHaveText('Cy Viewer removed from this document.');
  await expect(page.getByRole('status')).toBeFocused();
  await expect(cy$).toHaveCount(0);
  await expect(page.getByText('2 of 10 people')).toBeVisible();
  // The document is no longer Cy's: it leaves the list, and the address is no page.
  await his.goto('/');
  await expect(his.getByRole('link', { name: 'Untitled document' })).toHaveCount(0);
  await his.goto(`/documents/${id}`);
  await expect(his.getByText('Page not found')).toBeVisible();

  // A removed person may be invited again: a new invitation is a new grant.
  await invite(page, [cy.email], 'Viewer');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(cy.email));
  await accept(his, cy.email, id, firstLink);
  await his.goto('/');
  await expect(his.getByRole('link', { name: 'Untitled document' })).toBeVisible();

  // Bea leaves: the section, the statement before the control, and a confirmation that opens on Cancel.
  await theirs.goto(`/documents/${id}/sharing`);
  await expect(theirs.getByRole('heading', { level: 2, name: 'Leave document' })).toBeVisible();
  // (The same sentence stands in the confirmation, which is closed: the first is the section's.)
  await expect(
    theirs
      .getByText(
        'Leaving removes this document from your list of documents and closes your open connections to it. Your edits stay in the document. You can be invited again.',
      )
      .first(),
  ).toBeVisible();
  await screens(theirs, 'sharing-leave');
  await expectNoSidewaysScroll(theirs);
  await theirs.getByRole('button', { name: 'Leave document' }).click();
  const leaving = theirs.getByRole('dialog', { name: 'Leave document' });
  await expect(leaving.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await leaving.getByRole('button', { name: 'Cancel' }).click();
  await expect(theirs.getByRole('heading', { level: 2, name: 'Leave document' })).toBeVisible();
  await theirs.getByRole('button', { name: 'Leave document' }).click();
  await leaving.getByRole('button', { name: 'Leave document' }).click();
  await theirs.waitForURL('**/');
  await expect(theirs.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await expect(theirs.getByRole('link', { name: 'Untitled document' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('2 of 10 people')).toBeVisible();
  await expect(personRow(page, 'Bea Editor')).toHaveCount(0);
  await beaContext.close();
  await cyContext.close();
});

// FR-ED-42, S15-2: a change of role and a removal are in the notification list of the person they
// are about, and in no one else's. The words are those of docs/plan/presence-row.md, §5 (for the
// owner's approval), written out here.
test('a change of role and a removal are notified to the person affected, and never to the Owner who acted, and a leave is notified to no one', async ({
  page,
  browser,
}) => {
  test.slow();
  await enter(page, { ...newPerson(), name: 'Ada Owner' });
  const id = await shareNew(page);
  const cy = { ...newPerson(), name: 'Cy Viewer' };
  const bea = { ...newPerson(), name: 'Bea Editor' };
  const [cyContext, beaContext] = [await browser.newContext(), await browser.newContext()];
  const [his, theirs] = [await cyContext.newPage(), await beaContext.newPage()];
  await enter(his, cy);
  await enter(theirs, bea);
  await invite(page, [cy.email], 'Viewer');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(cy.email));
  await invite(page, [bea.email]);
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(bea.email));
  await accept(his, cy.email, id);
  await accept(theirs, bea.email, id);
  await page.reload();

  const notifications = async (who: Page) => {
    await who.goto('/notifications');
    await expect(who.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  };

  // A change of role: Cy is told, with the title as it stands and a link to the document.
  const cy$ = personRow(page, 'Cy Viewer');
  await chooseRole(cy$, 'Cy Viewer', 'editor');
  await cy$.getByRole('button', { name: 'Change role' }).click();
  await expect(page.getByRole('status')).toHaveText('Role of Cy Viewer changed to Editor.');
  await notifications(his);
  const changed = his.getByText('Your role on Untitled document was changed to Editor.');
  await expect(changed).toBeVisible();
  const item = his.getByRole('listitem').filter({ has: changed });
  await expect(item.getByRole('link', { name: 'Open the document' })).toHaveAttribute(
    'href',
    `/documents/${id}`,
  );
  await expect(item.getByText('Unread', { exact: true })).toBeVisible();
  await screens(his, 'notifications-role-changed');
  await item.getByRole('button', { name: 'Mark as read' }).click();
  // WCAG 2.4.3: the button goes; focus moves to the link of the same notification.
  await expect(item.getByRole('link', { name: 'Open the document' })).toBeFocused();
  await expect(item.getByText('Unread', { exact: true })).toBeHidden();

  // The Owner who acted, and Bea who was not touched, are told nothing.
  await notifications(page);
  await expect(page.getByText('There are no notifications.')).toBeVisible();
  await notifications(theirs);
  await expect(theirs.getByText(/Your role on|You no longer have access/)).toHaveCount(0);

  // A removal: Cy is told, in words that name no document and with no link; the change of role goes with the role.
  await page.goto(`/documents/${id}/sharing`);
  await personRow(page, 'Cy Viewer').getByRole('button', { name: 'Remove' }).click();
  await page
    .getByRole('dialog', { name: 'Remove collaborator' })
    .getByRole('button', { name: 'Remove collaborator' })
    .click();
  await expect(page.getByRole('status')).toHaveText('Cy Viewer removed from this document.');
  await notifications(his);
  const removed = his.getByText('You no longer have access to a document.');
  await expect(removed).toBeVisible();
  await expect(his.getByText(/Your role on/)).toHaveCount(0);
  const gone = his.getByRole('listitem').filter({ has: removed });
  await expect(gone.getByRole('link')).toHaveCount(0);
  await expect(his.locator('a[href*="/documents/"]')).toHaveCount(0);
  await screens(his, 'notifications-removed');
  await gone.getByRole('button', { name: 'Mark as read' }).click();
  // No link to take the focus: it moves to the words of the notification.
  await expect(removed).toBeFocused();
  await expectNoSidewaysScroll(his);

  // A leave tells no one: not the Owner, and not the one who left.
  await theirs.goto(`/documents/${id}/sharing`);
  await theirs.getByRole('button', { name: 'Leave document' }).click();
  await theirs
    .getByRole('dialog', { name: 'Leave document' })
    .getByRole('button', { name: 'Leave document' })
    .click();
  await theirs.waitForURL('**/');
  await notifications(theirs);
  await expect(theirs.getByText(/You no longer have access|Your role on/)).toHaveCount(0);
  await notifications(page);
  await expect(page.getByText('There are no notifications.')).toBeVisible();
  await cyContext.close();
  await beaContext.close();
});

// FR-ED-44 (b), as the page shows it: the Owner has given Editors the permissions, and an Editor
// then acts on a Viewer and is offered nothing over another Editor or oneself.
test('an Editor who is given the permissions acts on a Viewer, and is offered nothing over an Editor or over oneself', async ({
  page,
  browser,
}) => {
  test.slow();
  await enter(page, { ...newPerson(), name: 'Ada Owner' });
  const id = await shareNew(page);
  const bea = { ...newPerson(), name: 'Bea Editor' };
  const dan = { ...newPerson(), name: 'Dan Editor' };
  const cy = { ...newPerson(), name: 'Cy Viewer' };
  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext()));
  const [beas, dans, cys] = await Promise.all(contexts.map((context) => context.newPage()));
  await enter(beas!, bea);
  await enter(dans!, dan);
  await enter(cys!, cy);
  await invite(page, [bea.email, dan.email]);
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(dan.email));
  await invite(page, [cy.email], 'Viewer');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(cy.email));
  await accept(beas!, bea.email, id);
  await accept(dans!, dan.email, id);
  await accept(cys!, cy.email, id);

  // The Owner gives Editors the permission, in the database of the run. The screen that gives it is
  // tested in tests/e2e/permissions.spec.ts; here it would be one more page to drive and wait for.
  setPermissions(id, ['document.collaborators.roles', 'document.collaborators.remove']);
  await beas!.goto(`/documents/${id}/sharing`);
  await expect(beas!.getByText('4 of 10 people')).toBeVisible();
  // Over the Viewer, both controls; over the other Editor, and over oneself, none.
  const viewer = personRow(beas!, 'Cy Viewer');
  await expect(viewer.getByRole('combobox', { name: 'Role of Cy Viewer' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Remove' })).toBeVisible();
  await expect(personRow(beas!, 'Dan Editor').getByRole('button')).toHaveCount(0);
  await expect(personRow(beas!, 'Bea Editor').getByRole('button')).toHaveCount(0);

  // The visible words stay "Remove" and "Change role"; each button is named for the person (WCAG 2.5.3, 2.4.6).
  await expect(viewer.getByRole('button', { name: 'Remove Cy Viewer' })).toHaveText('Remove');
  await expect(viewer.getByRole('button', { name: 'Change role of Cy Viewer' })).toHaveText('Change role');

  // A refusal is stated by itself, and is met from there (WCAG 2.4.3, 4.1.3): the Owner made Cy an Editor
  // since this page was read, so the Editor's request over an Editor is refused with a 403.
  setRole(id, cy.email, 'editor');
  await chooseRole(viewer, 'Cy Viewer', 'editor');
  await viewer.getByRole('button', { name: 'Change role of Cy Viewer' }).click();
  const refused = beas!.getByRole('alert').filter({ hasText: 'never on an Editor' });
  await expect(refused).toContainText(
    'The role of this account on the document can act on a Reviewer or a Viewer and never on an Editor. The Owner of the document can act on an Editor.',
  );
  await expect(refused).toBeFocused();
  // Not the error of a field, and not a change.
  await expect(beas!.getByRole('status')).toHaveText('');
  await expect(personRow(beas!, 'Cy Viewer').getByRole('button')).toHaveCount(0);
  setRole(id, cy.email, 'viewer');
  await beas!.reload();

  // The Editor raises the Viewer to Editor, and then has no control over that person (FR-ED-44 (b)).
  await chooseRole(viewer, 'Cy Viewer', 'editor');
  await viewer.getByRole('button', { name: 'Change role' }).click();
  await expect(beas!.getByRole('status')).toHaveText('Role of Cy Viewer changed to Editor.');
  await expect(personRow(beas!, 'Cy Viewer').getByRole('button')).toHaveCount(0);
  for (const context of contexts) await context.close();
});
