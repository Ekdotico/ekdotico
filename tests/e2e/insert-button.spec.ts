// The Insert control beside the cursor (audit row F05; ui-dc-insert, the owner's sketch): a second way to
// the block palette that the slash opens (FR-ED-10), against the real collaboration server. WRITTEN, NOT RUN.
import { expect, test, type Page } from './fixtures.ts';
import { newPerson, signUp } from './account.ts';
import { startCollab, stopCollab } from './collab.ts';
import { layoutState } from './layout-state.ts';
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

test('the control is not seen at rest, appears under the pointer and on focus, and opens the palette that the slash opens', async ({
  page,
}) => {
  await enter(page);
  await shareNew(page);
  // Back from the sharing settings to the page of the document, which shareNew opened first.
  await page.goBack();
  await expect(text(page)).toBeVisible();
  const button = page.getByRole('button', { name: NAME });
  // The box that fades: the tooltip's own element stands between it and the button.
  const wrapper = page.locator('[data-near]');
  await expect(button).toBeVisible();
  // Not seen at rest (the pointer starts far from it), seen under the pointer and on keyboard focus.
  await expect(wrapper).toHaveCSS('opacity', '0');
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

test('on a very wide screen the box grows with the interface scale, and the plus stays at its middle', async ({
  page,
}) => {
  // 2200px and wider sets --scale: 1.5 (src/app/scale.css), which enlarges the design package's icons.
  await page.setViewportSize({ width: 2400, height: 1000 });
  await enter(page);
  await shareNew(page);
  await page.goBack();
  const button = page.getByRole('button', { name: NAME });
  await expect(button).toBeVisible();
  const { box, plus } = await button.evaluate((element) => {
    const own = element.getBoundingClientRect();
    const icon = element.querySelector('svg')!.getBoundingClientRect();
    return {
      box: { width: own.width, height: own.height },
      plus: {
        width: icon.width,
        height: icon.height,
        dx: icon.left + icon.width / 2 - (own.left + own.width / 2),
        dy: icon.top + icon.height / 2 - (own.top + own.height / 2),
      },
    };
  });
  // 20 by 20 at 1.5 is 30 by 30, and the icon keeps its own 24 by 24 inside it, square and centred.
  expect(box).toEqual({ width: 30, height: 30 });
  expect(plus.width).toBe(plus.height);
  expect(Math.abs(plus.dx)).toBeLessThan(0.5);
  expect(Math.abs(plus.dy)).toBeLessThan(0.5);
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
  // The page is measured once it has settled: the status in the header and the people beside it change as the
  // connection opens (openNew of editor.spec.ts waits for the same two).
  await expect(text(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'In sync' })).toBeVisible();
  await text(page).pressSequentially('One\nTwo\nThree');
  // The page settles after the text is typed: in a failed run the text stood 11.5px lower when first measured
  // than a moment later, with no key pressed in between (run 45086557515). Measure once two reads, 250 ms
  // apart, agree; the arrow keys below are then the only thing that can move it.
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await text(page).boundingBox());
        const same = now === last;
        last = now;
        return same;
      },
      { message: 'the text stands still', intervals: [250], timeout: 10_000 },
    )
    .toBe(true);
  const before = await text(page).boundingBox();
  const stateBefore = await layoutState(text(page));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  // A failure names what moved: the scroll, the tops, and what stands above the text, before and after.
  expect(
    await text(page).boundingBox(),
    `Before: ${stateBefore}. After: ${await layoutState(text(page))}`,
  ).toEqual(before);
});
