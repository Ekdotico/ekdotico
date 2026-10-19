// The permission settings screen (FR-ED-44, FR-ED-45, FR-ED-46; NFR-IC-19):
// the table for the Owner, with a checkbox for each cell the Owner may change
// and words for each it may not; a change saved when it is made and said beside
// the control; a refusal that returns the box to its stored state; the reset to
// the defaults after a confirmation; and, to any other role, the role held and
// what it may do, with no control. What a change does to an open page is in
// tests/e2e/editor.spec.ts, the one file that runs the collaboration server.
//
// The words are those of docs/plan/slice-16.md, §7 (for the owner's approval),
// written out here and not taken from the code under test.
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { expectNoSidewaysScroll, newPerson, screens, signUp, type Person } from './account.ts';
import { accept, CONFIRMATION, invite, shareNew } from './sharing.ts';

async function enter(page: Page, person: Person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}

// The first column of FR-ED-44, as the screen words it (register row S16-2), in the order of the table.
const ROWS = [
  ["View the document's content", 'Fixed by role', ['Always', 'Always', 'Always']],
  [
    "Edit the document's content, which includes adding and changing images and footnotes",
    'Fixed by role',
    ['Always', 'Always', 'Never'],
  ],
  ['See the list of collaborators and their roles', 'Adjustable', ['Always', null, null]],
  ['Rename the document', 'Adjustable', ['Always', null, 'Never']],
  ['Draft export', 'Adjustable', ['Always', null, null]],
  [
    'Invite collaborators, send an invitation again, revoke a pending invitation, and see the pending invitations',
    'Adjustable',
    ['Always', null, 'Never'],
  ],
  ["Change a collaborator's role", 'Adjustable', ['Always', null, 'Never']],
  ['Remove a collaborator', 'Adjustable', ['Always', null, 'Never']],
  ['Leave the document', 'Fixed by role', ['Never', 'Always', 'Always']],
  ["Change the document's permission set", 'Fixed to the Owner', ['Always', 'Never', 'Never']],
  ['Transfer ownership of the document', 'Fixed to the Owner', ['Always', 'Never', 'Never']],
  [
    'Delete the document, and restore it within its retention',
    'Fixed to the Owner',
    ['Always', 'Never', 'Never'],
  ],
] as const;

const LIMIT = 'An Editor who is given this permission can act on Viewers and never on another Editor.';

/** The checkbox of a cell, by the name that states its permission and its role (FR-ED-46). */
const box = (page: Page, role: 'Editor' | 'Viewer', permission: string) =>
  page.getByRole('checkbox', { name: `${role}: ${permission}`, exact: true });

/** The cell that holds a checkbox, to read what is said beside it. */
const cellOf = (control: Locator) => control.locator('xpath=ancestor::td[1]');

const table = (page: Page) => page.getByRole('group', { name: 'Permissions of each role' });

test('the Owner sees the table of the set, in words and checkboxes, and every control is named by its permission and its role', async ({
  page,
}) => {
  test.slow();
  await enter(page, { ...newPerson(), name: 'Ada Owner' });
  await shareNew(page);

  await expect(page.getByRole('heading', { level: 2, name: 'Permissions' })).toBeVisible();
  const grid = table(page);
  // The headers of both axes, which a screen reader announces: the columns, and each permission as a row header.
  await expect(grid.getByRole('columnheader')).toHaveText([
    'Permission',
    'Kind',
    'Owner',
    'Editor',
    'Viewer',
  ]);
  await expect(grid.getByRole('row')).toHaveCount(ROWS.length + 1);
  // `scope` on every header, for WebKit with VoiceOver (register row S16-8 (b)).
  await expect(grid.locator('thead th')).toHaveCount(5);
  for (const header of await grid.locator('thead th').all())
    await expect(header).toHaveAttribute('scope', 'col');
  await expect(grid.locator('tbody th')).toHaveCount(ROWS.length);
  for (const header of await grid.locator('tbody th').all())
    await expect(header).toHaveAttribute('scope', 'row');
  for (const [text, kind, words] of ROWS) {
    const row = grid
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: text, exact: false }) });
    await expect(row.getByRole('rowheader')).toContainText(text);
    // "Each row states its kind in words."
    await expect(row.getByRole('cell').first()).toHaveText(kind);
    // A cell the Owner cannot change shows "Always" or "Never", as text and not as a disabled control.
    const cells = row.getByRole('cell');
    for (const [n, word] of words.entries()) {
      if (word) await expect(cells.nth(n + 1)).toHaveText(word);
      else await expect(cells.nth(n + 1).getByRole('checkbox')).toBeVisible();
    }
  }
  // No disabled control stands for a fixed cell: the checkboxes are those of the 8 cells that can change.
  await expect(grid.getByRole('checkbox')).toHaveCount(8);
  await expect(grid.locator('input:disabled')).toHaveCount(0);

  // The defaults of FR-ED-44, which are the stored set of a new document.
  await expect(box(page, 'Editor', 'See the list of collaborators')).toBeChecked();
  await expect(box(page, 'Viewer', 'See the list of collaborators')).toBeChecked();
  await expect(box(page, 'Editor', 'Draft export')).toBeChecked();
  await expect(box(page, 'Viewer', 'Draft export')).not.toBeChecked();
  for (const name of [
    'Rename the document',
    'Invite collaborators',
    "Change a collaborator's role",
    'Remove a collaborator',
  ]) {
    await expect(box(page, 'Editor', name)).not.toBeChecked();
  }

  // The two rows of FR-ED-44 (b) say what an Editor who is given the permission can and cannot do.
  await expect(grid.getByText(LIMIT)).toHaveCount(2);
  await expect(
    grid.getByRole('rowheader', { name: "Change a collaborator's role" }).getByText(LIMIT),
  ).toBeVisible();
  await expect(grid.getByRole('rowheader', { name: 'Remove a collaborator' }).getByText(LIMIT)).toBeVisible();
  await expectNoSidewaysScroll(page);
  await screens(page, 'permissions-owner');
});

test('a change is saved when it is made, said beside the control with the focus where it was, and the table is as stored after a reload', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await shareNew(page);
  const rename = box(page, 'Editor', 'Rename the document');
  await expect(rename).not.toBeChecked();
  await rename.click();
  await expect(rename).toBeChecked();
  await expect(cellOf(rename)).toContainText('Saved.');
  // "announced without moving focus"
  await expect(rename).toBeFocused();
  // No other cell said anything.
  await expect(table(page).getByText('Saved.')).toHaveCount(1);
  await page.reload();
  await expect(box(page, 'Editor', 'Rename the document')).toBeChecked();
  // Taken away again.
  await box(page, 'Editor', 'Rename the document').click();
  await expect(box(page, 'Editor', 'Rename the document')).not.toBeChecked();
  await expect(cellOf(box(page, 'Editor', 'Rename the document'))).toContainText('Saved.');
  await page.reload();
  await expect(box(page, 'Editor', 'Rename the document')).not.toBeChecked();

  // Two boxes pressed one straight after the other are both saved, one after the other.
  await box(page, 'Editor', 'Rename the document').click();
  await box(page, 'Editor', 'Invite collaborators').click();
  await expect(box(page, 'Editor', 'Rename the document')).toBeChecked();
  await expect(box(page, 'Editor', 'Invite collaborators')).toBeChecked();
  await page.reload();
  await expect(box(page, 'Editor', 'Rename the document')).toBeChecked();
  await expect(box(page, 'Editor', 'Invite collaborators')).toBeChecked();
});

test('a change that could not be saved is said beside the control, and the box returns to what is stored', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await shareNew(page);
  const message = 'The permissions were not changed. A statement the server gave.';
  await page.route('**/api/documents/*/permissions', (route) =>
    route.fulfill({ status: 422, json: { error: { code: 'cell_fixed', message } } }),
  );
  const rename = box(page, 'Editor', 'Rename the document');
  await rename.click();
  await expect(cellOf(rename)).toContainText(message);
  await expect(rename).not.toBeChecked();
  await expect(rename).toBeFocused();
  // The words are tied to the control, so that they are read when it is.
  await expect(rename).toHaveAccessibleDescription(message);
  await page.unroute('**/api/documents/*/permissions');
  // And the page works again: the same box, now answered by the server.
  await rename.click();
  await expect(rename).toBeChecked();
  await expect(cellOf(rename)).toContainText('Saved.');
  // A connection that does not reach the application is said in the application's own words.
  await page.route('**/api/documents/*/permissions', (route) => route.abort());
  await rename.click();
  await expect(cellOf(rename)).toContainText(
    'The request did not reach Ekdotico. Check the connection and try again.',
  );
  await expect(rename).toBeChecked();
  await page.unroute('**/api/documents/*/permissions');
});

test('the set is returned to its defaults after a confirmation that opens on Cancel, and Cancel changes nothing', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await shareNew(page);
  await box(page, 'Editor', 'Rename the document').click();
  await expect(cellOf(box(page, 'Editor', 'Rename the document'))).toContainText('Saved.');
  await box(page, 'Viewer', 'See the list of collaborators').click();
  await expect(cellOf(box(page, 'Viewer', 'See the list of collaborators'))).toContainText('Saved.');

  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reset permissions' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toContainText(
    'Resetting returns every permission of every role on this document to its default. Any change you made to the permissions is lost.',
  );
  await screens(page, 'permissions-reset-confirmation');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(box(page, 'Editor', 'Rename the document')).toBeChecked();

  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await dialog.getByRole('button', { name: 'Reset permissions' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Permissions reset to the defaults.')).toBeVisible();
  await expect(box(page, 'Editor', 'Rename the document')).not.toBeChecked();
  await expect(box(page, 'Viewer', 'See the list of collaborators')).toBeChecked();
  // Any save of a cell clears the statement of the reset, so that the next reset is said again.
  await box(page, 'Editor', 'Rename the document').click();
  await expect(cellOf(box(page, 'Editor', 'Rename the document'))).toContainText('Saved.');
  await expect(page.getByText('Permissions reset to the defaults.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await dialog.getByRole('button', { name: 'Reset permissions' }).click();
  await expect(page.getByText('Permissions reset to the defaults.')).toBeVisible();
  await page.reload();
  await expect(box(page, 'Editor', 'Rename the document')).not.toBeChecked();
  await expect(box(page, 'Viewer', 'See the list of collaborators')).toBeChecked();
});

test('an Editor and a Viewer are told in words the role they hold and what it may do, and have no control over the set; what the Owner gives is there at the next load', async ({
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

  await theirs.goto(`/documents/${id}/sharing`);
  await expect(theirs.getByRole('heading', { level: 2, name: 'Your role' })).toBeVisible();
  await expect(theirs.getByText('Your role on this document is Editor.')).toBeVisible();
  await expect(theirs.getByText('This role may do the following on this document.')).toBeVisible();
  const held = theirs.getByRole('listitem');
  await expect(held.filter({ hasText: "View the document's content" })).toHaveCount(1);
  await expect(held.filter({ hasText: 'Draft export' })).toHaveCount(1);
  await expect(held.filter({ hasText: 'Leave the document' })).toHaveCount(1);
  await expect(held.filter({ hasText: 'Rename the document' })).toHaveCount(0);
  await expect(theirs.getByRole('checkbox')).toHaveCount(0);
  await expect(theirs.getByRole('button', { name: 'Reset to defaults' })).toHaveCount(0);
  await expect(theirs.getByRole('heading', { level: 2, name: 'Permissions' })).toHaveCount(0);
  await screens(theirs, 'permissions-editor');

  await his.goto(`/documents/${id}/sharing`);
  await expect(his.getByText('Your role on this document is Viewer.')).toBeVisible();
  await expect(his.getByRole('listitem').filter({ hasText: 'Draft export' })).toHaveCount(0);
  await expect(his.getByRole('listitem').filter({ hasText: "Edit the document's content" })).toHaveCount(0);
  await expect(his.getByRole('checkbox')).toHaveCount(0);

  // The Owner gives the Editor the permission to rename, and takes the list of people from the Viewer.
  await box(page, 'Editor', 'Rename the document').click();
  await expect(cellOf(box(page, 'Editor', 'Rename the document'))).toContainText('Saved.');
  await box(page, 'Viewer', 'See the list of collaborators').click();
  await expect(cellOf(box(page, 'Viewer', 'See the list of collaborators'))).toContainText('Saved.');
  await theirs.reload();
  await expect(theirs.getByRole('listitem').filter({ hasText: 'Rename the document' })).toHaveCount(1);
  // A role whose set hides the people is still told its role, and may still leave.
  await his.reload();
  await expect(
    his.getByText(
      'The role of this account on the document does not show its people. The Owner of the document can change that.',
    ),
  ).toBeVisible();
  await expect(his.getByText('Your role on this document is Viewer.')).toBeVisible();
  await expect(his.getByRole('heading', { level: 2, name: 'Leave document' })).toBeVisible();
  await screens(his, 'permissions-viewer-no-people');
  await beaContext.close();
  await cyContext.close();
});
