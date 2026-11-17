// The Insert control beside the cursor (audit row F05; ui-dc-insert, the owner's sketch): a second way to
// the block palette that the slash opens (FR-ED-10), against the real collaboration server. WRITTEN, NOT RUN.
import { expect, test, type Page } from './fixtures.ts';
import { newPerson, signUp } from './account.ts';
import { startCollab, stopCollab } from './collab.ts';
import { accept, CONFIRMATION, invite, shareNew } from './sharing.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => startCollab());
test.afterAll(stopCollab);

const NAME = 'Insert a block'; // approved, ui-insert-name
const text = (page: Page) => page.getByRole('textbox', { name: 'Document text' });
const palette = (page: Page) => page.getByRole('listbox', { name: 'Blocks' });

async function enter(page: Page, person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}

test('the control is faint until hovered, solid on hover and on focus, and opens the palette that the slash opens', async ({
  page,
}) => {
  await enter(page);
  await shareNew(page);
  await page.goBack();
  await page.getByRole('link', { name: 'Untitled document' }).click();
  await expect(text(page)).toBeVisible();
  const button = page.getByRole('button', { name: NAME });
  const wrapper = button.locator('..');
  await expect(button).toBeVisible();
  // Faint at rest, solid on hover, solid on keyboard focus.
  await expect(wrapper).toHaveCSS('opacity', '0.6');
  await button.hover();
  await expect(wrapper).toHaveCSS('opacity', '1');
  await text(page).click();
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await expect(wrapper).toHaveCSS('opacity', '1');
  // It sits immediately to the right of the cursor, on its line, and covers no text: nothing follows the
  // cursor there. It is gone (hidden, still in the page) where text follows the cursor.
  await page.keyboard.press('Shift+Tab');
  await expect(text(page)).toBeFocused();
  await text(page).pressSequentially('Some words');
  const end = await text(page)
    .locator('p')
    .last()
    .evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const box = range.getBoundingClientRect();
      return { right: box.right, middle: (box.top + box.bottom) / 2 };
    });
  const own = (await button.boundingBox())!;
  expect(own.x).toBeGreaterThanOrEqual(end.right);
  expect(own.x - end.right).toBeLessThan(24);
  expect(Math.abs(own.y + own.height / 2 - end.middle)).toBeLessThan(4);
  await page.keyboard.press('ArrowLeft');
  await expect(button).toBeHidden();
  await page.keyboard.press('End');
  await expect(button).toBeVisible();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  // Enter opens the palette, with every block, and the text has the focus again for its keys. Closed
  // without a choice it leaves the document as a typed "/" and Escape leave it: the "/".
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeVisible();
  await expect(text(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
  await expect(text(page)).toBeFocused();
  await expect(text(page)).toHaveText('/');
  await page.keyboard.press('Backspace');
  // A click does the same, and a choice places the block as the slash's does.
  await text(page).pressSequentially('Words');
  await button.click();
  await expect(palette(page)).toBeVisible();
  await page.getByRole('option', { name: /Heading 1/ }).click();
  await expect(text(page).locator('h1')).toHaveCount(1);
});

test('the control does not move the layout as the cursor moves, and a Viewer has none', async ({
  page,
  browser,
}) => {
  test.slow();
  await enter(page, { ...newPerson(), name: 'Ada Owner' });
  const id = await shareNew(page);
  const cy = { ...newPerson(), name: 'Cy Viewer' };
  const context = await browser.newContext();
  const his = await context.newPage();
  await enter(his, cy);
  await invite(page, [cy.email], 'Viewer');
  await expect(page.getByRole('status')).toContainText(CONFIRMATION(cy.email));
  await accept(his, cy.email, id);
  await his.goto(`/documents/${id}`);
  await expect(his.getByText('You can read this document.')).toBeVisible();
  await expect(his.getByRole('button', { name: NAME })).toHaveCount(0);

  await page.goto(`/documents/${id}`);
  await text(page).pressSequentially('One\nTwo\nThree');
  const before = await text(page).boundingBox();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  expect(await text(page).boundingBox()).toEqual(before);
});
