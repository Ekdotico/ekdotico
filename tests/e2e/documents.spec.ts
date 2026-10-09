// The first screen of a signed-in account: the list of its documents, the
// creation of one, its renaming, the mark "Not recorded" with its explanation,
// and the date in the zone of the browser (FR-ED-35, FR-ED-43, NFR-I18-06,
// NFR-SE-08, NFR-SE-04).
import { expect, test, type Page } from '@playwright/test';
import { alertOn, expectNoSidewaysScroll, newPerson, screens, signUp, watchOrigins } from './account.ts';
import { shown } from './shown.ts';

// The fixed texts, written out here and not taken from the code under test.
const MARK = 'Not recorded'; // FR-ED-43
const EXPLANATION =
  'This document was created while writing was not being recorded. It has no provenance record, and it can never be sealed.'; // FR-ED-43
const DEFAULT_TITLE = 'Untitled document'; // FR-ED-35

// NFR-I18-06: a zone that is never the server's day and hour, so that a date
// rendered on the server, or in UTC, cannot pass for the browser's.
const ZONE = 'Pacific/Auckland';
// And a locale that is not English: the words of a date are fixed, and are not
// the browser's (src/lib/date-text.ts).
test.use({ timezoneId: ZONE, locale: 'el-GR' });

async function enter(page: Page) {
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
}

test('the list of documents: empty, a document created, renamed, and still there after a reload', async ({
  page,
}) => {
  test.slow();
  const elsewhere = watchOrigins(page);
  await enter(page);
  await expect(page).toHaveTitle('Documents – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  // An account without a document: what the list is for, and how to start.
  await expect(page.getByRole('main').getByRole('paragraph')).toHaveText(
    'No documents yet. Choose New document to create the first one.',
  );
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'documents-empty');

  // FR-ED-35, FR-AU-12: one control creates a document, with the default
  // title and without a choice of workspace.
  await page.getByRole('button', { name: 'New document' }).click();
  const row = page.getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(DEFAULT_TITLE);
  await expect(page.getByText('No documents yet.')).toHaveCount(0);

  // FR-ED-43: the mark beside the title, in words that are always shown.
  const mark = row.getByRole('button', { name: MARK });
  await expect(mark).toBeVisible();
  await expect(mark).toHaveText(MARK);

  // NFR-I18-06: the date of creation, in the zone of the browser. The stored
  // value is UTC, and is what the element carries for a machine.
  const { documents } = await (await page.request.get('/api/documents')).json();
  expect(documents).toHaveLength(1);
  const { id, createdAt } = documents[0];
  expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const time = row.locator('time');
  await expect(time).toHaveAttribute('datetime', createdAt);
  await expect(time).toHaveText(shown(createdAt, ZONE));
  expect(shown(createdAt, ZONE)).not.toBe(shown(createdAt, 'UTC'));
  await expect(row).toContainText(`Created ${shown(createdAt, ZONE)}`);
  // The server sent no date of its own to be corrected afterwards.
  const sent = await (await page.request.get('/')).text();
  expect(sent).not.toContain('<time');

  // Renaming, in a dialog named by its heading, with the title in a labelled field.
  const renameButton = row.getByRole('button', { name: 'Rename' });
  await expect(renameButton).toHaveAccessibleDescription(DEFAULT_TITLE);
  await renameButton.click();
  const dialog = page.getByRole('dialog', { name: 'Rename document' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole('textbox', { name: 'Title' });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(DEFAULT_TITLE);
  await expect(field).toHaveAccessibleDescription(/A title has at most 200 characters\./);
  await screens(page, 'documents-rename');

  // FR-ED-35: a title longer than 200 characters is refused, in text that a
  // screen reader announces and beside the field.
  await field.fill('a'.repeat(201));
  await dialog.getByRole('button', { name: 'Save' }).click();
  const fault = alertOn(page);
  await expect(fault).toContainText('The title was not changed, because it does not meet its rule.');
  await expect(fault).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/A title has at most 200 characters\./);
  await expect(dialog).toBeVisible();
  await screens(page, 'documents-rename-fault');

  // NFR-SE-08: markup in a title is text, on the way in and on the way out.
  const markup =
    '<b>Bold</b> & "quoted" <script>window.marked = 1</script> <img src=x onerror="window.marked = 1">';
  await field.fill(markup);
  await field.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(row.locator('bdi')).toHaveText(markup);
  await expect(row.locator('b, script, img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { marked?: number }).marked)).toBeUndefined();
  // Focus returns to the control that opened the dialog.
  await expect(renameButton).toBeFocused();
  await expect(renameButton).toHaveAccessibleDescription(markup);

  // Reloaded: the document, its title, its date, and its mark, from the server.
  await page.reload();
  await expect(row).toHaveCount(1);
  await expect(row.locator('bdi')).toHaveText(markup);
  await expect(row.locator('b, script, img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { marked?: number }).marked)).toBeUndefined();
  await expect(row.locator('time')).toHaveText(shown(createdAt, ZONE));
  await expect(row.getByRole('button', { name: MARK })).toBeVisible();
  expect((await (await page.request.get(`/api/documents/${id}`)).json()).title).toBe(markup);

  // Cancel leaves the title as it was; an empty title becomes the default.
  await renameButton.click();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Not kept');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(row.locator('bdi')).toHaveText(markup);
  await renameButton.click();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.locator('bdi')).toHaveText(DEFAULT_TITLE);

  // A second document goes above the first: the newest first.
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(row).toHaveCount(2);
  await row.first().getByRole('button', { name: 'Rename' }).click();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('The second document');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.locator('bdi')).toHaveText(['The second document', DEFAULT_TITLE]);
  await expect(page.getByRole('button', { name: MARK })).toHaveCount(2);
  await screens(page, 'documents');

  // FR-AU-88: none of this asked another origin for anything.
  expect(elsewhere).toEqual([]);
});

test('the explanation of "Not recorded": by keyboard, by pointer, and to a screen reader (FR-ED-43)', async ({
  page,
}) => {
  await enter(page);
  await page.getByRole('button', { name: 'New document' }).click();
  const mark = page.getByRole('button', { name: MARK });
  const explanation = page.getByRole('tooltip');
  await expect(mark).toBeVisible();

  // "It is given to a screen reader as the description of the mark", shown or not.
  await expect(explanation).toBeHidden();
  await expect(mark).toHaveAccessibleDescription(EXPLANATION);

  // "Shown … when the mark receives keyboard focus, so the mark can be reached
  // by keyboard": the next stop after the control that creates a document.
  await page.getByRole('button', { name: 'New document' }).focus();
  await page.keyboard.press('Tab');
  await expect(mark).toBeFocused();
  await expect(explanation).toBeVisible();
  await expect(explanation).toHaveText(EXPLANATION);
  await screens(page, 'documents-not-recorded');

  // WCAG 2.2, 1.4.13: dismissed with Escape, without moving the focus…
  await page.keyboard.press('Escape');
  await expect(explanation).toBeHidden();
  await expect(mark).toBeFocused();
  // …"the mark does not depend on it: the words are always shown"…
  await expect(mark).toHaveText(MARK);
  // …and it stays until the focus leaves, and returns with it.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Rename' })).toBeFocused();
  await expect(explanation).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await expect(explanation).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(explanation).toBeHidden();

  // "Shown when the pointer rests on the mark", and the pointer can be moved
  // onto it without its disappearing.
  await mark.hover();
  await expect(explanation).toBeVisible();
  await explanation.hover();
  await expect(explanation).toBeVisible();
  // Dismissed without moving the pointer.
  await page.keyboard.press('Escape');
  await expect(explanation).toBeHidden();
  await page.getByRole('heading', { level: 1 }).hover();
  await mark.hover();
  await expect(explanation).toBeVisible();
  await page.getByRole('heading', { level: 1 }).hover();
  await expect(explanation).toBeHidden();
});

test('the list at a width of 320 CSS pixels, with the longest title and the explanation open', async ({
  page,
}) => {
  await enter(page);
  await page.getByRole('button', { name: 'New document' }).click();
  await page.getByRole('button', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename document' });
  // 200 characters without a place to break.
  await dialog.getByRole('textbox', { name: 'Title' }).fill('W'.repeat(200));
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoSidewaysScroll(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('listitem').locator('bdi')).toHaveText('W'.repeat(200));
  await expectNoSidewaysScroll(page);

  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole('button', { name: MARK }).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const explanation = page.getByRole('tooltip');
  await expect(explanation).toBeVisible();
  // The explanation is inside the screen, and widens nothing.
  const box = (await explanation.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  const [content, viewport] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(content).toBeLessThanOrEqual(viewport!);
  await screens(page, 'documents-320');
});

test('a second account sees nothing of the first’s documents (NFR-SE-04)', async ({ page, browser }) => {
  await enter(page);
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  const { documents } = await (await page.request.get('/api/documents')).json();
  const id = documents[0].id as string;

  const context = await browser.newContext();
  const other = await context.newPage();
  await enter(other);
  await expect(other.getByRole('listitem')).toHaveCount(0);
  expect(await (await other.request.get('/api/documents')).json()).toEqual({ documents: [] });

  // The first's document, and one that does not exist: one answer.
  const theirs = await other.request.get(`/api/documents/${id}`);
  const none = await other.request.get('/api/documents/3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b');
  expect(theirs.status()).toBe(404);
  expect(none.status()).toBe(404);
  expect(await theirs.text()).toBe(await none.text());
  const renamed = await other.request.patch(`/api/documents/${id}`, {
    data: { title: 'Taken' },
    headers: { origin: new URL(other.url()).origin },
  });
  expect(renamed.status()).toBe(404);
  expect(await renamed.text()).toBe(await none.text());
  await context.close();

  await page.reload();
  await expect(page.getByRole('listitem').locator('bdi')).toHaveText(DEFAULT_TITLE);
});
