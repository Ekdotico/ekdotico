// Deleting a document from the list, with its confirmation; the list of
// deleted documents, with the day each is deleted permanently, in the zone of
// the browser; and restoring one (FR-ED-36, NFR-I18-06, NFR-SE-04).
import { expect, test, type Page } from '@playwright/test';
import { expectNoSidewaysScroll, newPerson, screens, signUp, watchOrigins } from './account.ts';

// The texts, written out here and not taken from the code under test. FR-ED-36
// gives none: they are the application's, for the owner's approval.
const STATEMENT =
  'Deleting this document removes it from the list of documents and closes every open connection to it. Ekdotico keeps the document for 30 days in the list of deleted documents, where it can be restored. After 30 days Ekdotico deletes the document permanently, and it cannot be restored.';
// A title written to read as part of the confirmation, were it set inside the
// statement: it is whatever its Owner typed.
const TITLE = 'x” is kept for ever. “y';
const DELETED = 'Document deleted. Ekdotico keeps it for 30 days in the list of deleted documents.';
const INTRODUCTION =
  'Ekdotico keeps a deleted document for 30 days and then deletes it permanently. Until then it can be restored.';
const RESTORED = 'Document restored. It is in the list of documents again.';

const ZONE = 'Pacific/Auckland';
test.use({ timezoneId: ZONE });

/** A time as the lists show it, in a zone: `2026-10-09 07:52`. */
const shown = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

async function enter(page: Page) {
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
}

async function create(page: Page, title: string) {
  const rows = page.getByRole('listitem');
  const before = await rows.count();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(rows).toHaveCount(before + 1);
  await rows.first().getByRole('button', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename document' });
  await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(rows.first().locator('bdi')).toHaveText(title);
}

test('a document deleted with its confirmation, seen in the list of deleted documents, and restored', async ({
  page,
  browser,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  await enter(page);
  await create(page, 'Stays');
  await create(page, TITLE);
  const rows = page.getByRole('listitem');
  await expect(rows.locator('bdi')).toHaveText([TITLE, 'Stays']);

  // The control names what it deletes, and which document.
  const deleteButton = rows.first().getByRole('button', { name: 'Delete document' });
  await expect(deleteButton).toHaveAccessibleDescription(TITLE);
  await deleteButton.click();
  const dialog = page.getByRole('dialog', { name: 'Delete document' });
  await expect(dialog).toBeVisible();
  // Which document, on a line of its own under its label; then the statement
  // of what happens, before anything does, which holds no word of the title.
  // Both are read with the name.
  await expect(dialog.getByRole('paragraph')).toHaveText(['Document', TITLE, STATEMENT]);
  await expect(dialog).toHaveAccessibleDescription(`${TITLE} ${STATEMENT}`);
  // Focus opens on the way that deletes nothing.
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeFocused();
  await expectNoSidewaysScroll(page);
  await screens(page, 'documents-delete');

  // Cancel, and Escape, delete nothing.
  await cancel.click();
  await expect(dialog).toBeHidden();
  await expect(deleteButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(rows).toHaveCount(2);

  // Confirmed: by keyboard alone.
  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Delete document' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(rows.locator('bdi')).toHaveText(['Stays']);
  // What was done is stated, takes focus, and is announced.
  const status = page.getByRole('status').filter({ hasText: 'Document deleted.' });
  await expect(status).toHaveText(DELETED);
  await expect(status).toBeFocused();
  await screens(page, 'documents-deleted-statement');
  expect((await (await page.request.get('/api/documents')).json()).documents).toHaveLength(1);

  // The list of deleted documents.
  await page.getByRole('link', { name: 'Deleted documents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Deleted documents' })).toBeVisible();
  await expect(page).toHaveTitle('Deleted documents – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('paragraph').first()).toHaveText(INTRODUCTION);
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('bdi')).toHaveText(TITLE);

  // NFR-I18-06: when it was deleted and the day it is deleted permanently, 30
  // days later, in the zone of the browser; UTC for a machine.
  const { documents } = await (await page.request.get('/api/documents/deleted')).json();
  expect(documents).toHaveLength(1);
  const { id, deletedAt, permanentDeletionAt } = documents[0];
  expect(Date.parse(permanentDeletionAt) - Date.parse(deletedAt)).toBe(30 * 24 * 60 * 60 * 1000);
  const times = rows.locator('time');
  await expect(times).toHaveCount(2);
  await expect(times.nth(0)).toHaveAttribute('datetime', deletedAt);
  await expect(times.nth(1)).toHaveAttribute('datetime', permanentDeletionAt);
  await expect(rows).toContainText(
    `Deleted ${shown(deletedAt, ZONE)}. Permanent deletion after ${shown(permanentDeletionAt, ZONE)}.`,
  );
  expect(shown(permanentDeletionAt, ZONE)).not.toBe(shown(permanentDeletionAt, 'UTC'));
  // The server sent no date of its own to be corrected afterwards.
  expect(await (await page.request.get('/deleted')).text()).not.toContain('<time');
  await expectNoSidewaysScroll(page);
  await screens(page, 'deleted-documents');

  // NFR-SE-04: another account sees nothing of it, and cannot restore it.
  const context = await browser.newContext();
  const other = await context.newPage();
  await enter(other);
  await other.goto('/deleted');
  await expect(other.getByRole('listitem')).toHaveCount(0);
  await expect(other.getByRole('main').getByRole('paragraph').last()).toHaveText('No deleted documents.');
  const origin = new URL(other.url()).origin;
  const theirs = await other.request.post(`/api/documents/${id}/restore`, { headers: { origin } });
  const none = await other.request.post('/api/documents/3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b/restore', {
    headers: { origin },
  });
  expect(theirs.status()).toBe(404);
  expect(await theirs.text()).toBe(await none.text());
  const removed = await other.request.delete(`/api/documents/${id}`, { headers: { origin } });
  expect(removed.status()).toBe(404);
  await context.close();

  // Restored: it leaves this list, and what was done is stated.
  const restoreButton = rows.getByRole('button', { name: 'Restore' });
  await expect(restoreButton).toHaveAccessibleDescription(TITLE);
  await restoreButton.focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(0);
  const restored = page.getByRole('status').filter({ hasText: 'Document restored.' });
  await expect(restored).toHaveText(RESTORED);
  await expect(restored).toBeFocused();
  await expect(page.getByRole('main').getByRole('paragraph').last()).toHaveText('No deleted documents.');
  await screens(page, 'deleted-documents-empty');

  // And it is back in the list of documents, as it was.
  await page.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await expect(rows.locator('bdi')).toHaveText([TITLE, 'Stays']);
  expect((await (await page.request.get(`/api/documents/${id}`)).json()).title).toBe(TITLE);

  // FR-AU-88: none of this asked another origin for anything.
  expect(elsewhere).toEqual([]);
});
