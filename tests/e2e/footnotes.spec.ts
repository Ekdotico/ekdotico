// Footnotes in the editor (FR-ED-05, FR-ED-02, FR-ED-10 to FR-ED-12, FR-ED-16, FR-ED-19, NFR-IC-19;
// docs/plan/slice-20.md), against the real collaboration server, which this file starts and stops.
// The marker is a link in the text, the entries are a list at the end of the document; every number
// is derived from the order of the markers. No automated accessibility checker is a dependency of
// the repository yet (plan row C5), so what is asked here is the roles, the names, the focus and
// the keys, which the checker would read.
import { expect, test, type Locator, type Page } from './fixtures.ts';
import { mailFor, newPerson, signIn, signUp, type Person } from './account.ts';
import { startCollab, stopCollab } from './collab.ts';
import { INVITATION_LINK, invite, shareNew } from './sharing.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => startCollab());
test.afterAll(stopCollab);

// The fixed texts, written out here and not taken from the code under test.
const FOOTNOTES = 'Footnotes';
/** Lines between a marker and its entry: more than a page, so that the entry is out of view from the marker. */
const LINES = 80;
const marker = (page: Page, number?: number) =>
  number === undefined
    ? text(page).locator('sup a[role="doc-noteref"]')
    : text(page).getByRole('link', { name: `Footnote ${number}`, exact: true });
const entries = (page: Page) => text(page).locator(`section[aria-label="${FOOTNOTES}"] ol > li`);

const text = (page: Page) => page.getByRole('textbox', { name: 'Document text' });
const palette = (page: Page) => page.getByRole('listbox', { name: 'Blocks' });
const rows = (page: Page) => palette(page).getByRole('option');
const inSync = (page: Page) => expect(page.getByRole('button', { name: 'In sync' })).toBeVisible();

async function enter(page: Page, person: Person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}
async function openNew(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New document' }).click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(text(page)).toBeVisible();
  await inSync(page);
  return /\/documents\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

/** The footnote of the palette, chosen by keyboard: the marker where the command was, and the cursor in its entry. */
async function addFootnote(page: Page, command = '/footnote') {
  await page.keyboard.type(command);
  await expect(rows(page).first()).toContainText('Footnote');
  await expect(rows(page).first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toBeHidden();
}

/** The block that holds the cursor in the editor's own state, which is what the next key is answered from. */
const blockWithCursor = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector('[role="textbox"]') as unknown as {
      editor: { state: { selection: { $from: { parent: { type: { name: string } } } } } };
    };
    return view.editor.state.selection.$from.parent.type.name;
  });
/**
 * The cursor at the end (or the start) of a paragraph, put there by the pointer and the End (or Home) key: the
 * keys for the start of a document differ by platform, and a test that used them would have held the cursor
 * where it was. It is looked for in the editor's state and not in the page's: a change the editor applies in the
 * moment between the pointer's press and the editor's reading of it (another client's cursor, which is what
 * the editor draws) writes the old selection over the new, as ProseMirror does everywhere, and the press is
 * made again.
 */
async function toParagraph(page: Page, index: number, edge: 'End' | 'Home' = 'End') {
  const paragraph = text(page).locator('p').nth(index);
  await paragraph.scrollIntoViewIfNeeded();
  await expect(async () => {
    await paragraph.click({ position: { x: 2, y: 2 } });
    await page.keyboard.press(edge);
    expect(await blockWithCursor(page)).toBe('paragraph');
  }).toPass({ intervals: [100, 250, 500] });
}
const toEndOfFirstParagraph = (page: Page, edge: 'End' | 'Home' = 'End') => toParagraph(page, 0, edge);
/** The element that holds the cursor of the page, as the closest list item, or null. */
const entryWithCursor = (page: Page) =>
  page.evaluate(() => {
    const at = document.getSelection()?.anchorNode;
    const element = at instanceof Element ? at : at?.parentElement;
    return element?.closest('section[aria-label="Footnotes"] li')?.textContent ?? null;
  });

test('the palette puts a footnote in: the marker where the command stood, and the cursor in its entry, which takes marks', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  await doc.focus();
  await page.keyboard.type('A claim that needs a source ');
  await addFootnote(page);

  // The row, its name and its command.
  await expect(doc.getByText('/footnote', { exact: true })).toHaveCount(0);
  // The marker is a superscript link named by its number, which is its visible text.
  await expect(marker(page)).toHaveCount(1);
  await expect(marker(page)).toHaveText('1');
  await expect(marker(page, 1)).toBeVisible();
  await expect(marker(page).locator('xpath=ancestor::sup')).toHaveCount(1);
  // The entry is a list item of a list in a region that is named, read with its number.
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).first()).toHaveAttribute('value', '1');
  // The role of an entry is the list item's own: doc-endnote is deprecated in the module, and a list item in a
  // region named Footnotes is read as one entry of a list.
  await expect(entries(page).first()).not.toHaveAttribute('role', /.+/);
  await expect(doc.locator(`section[aria-label="${FOOTNOTES}"]`)).toHaveAttribute('role', 'doc-endnotes');
  // The package's classes (domico 0.38.0, "The document surface"): sup > a.ekd-footnote-ref, section.ekd-footnotes > ol, li.ekd-footnote.
  await expect(marker(page)).toHaveClass('ekd-footnote-ref');
  await expect(
    doc.locator(`section.ekd-footnotes[aria-label="${FOOTNOTES}"] > ol > li.ekd-footnote`),
  ).toHaveCount(1);
  await expect(entries(page).first()).not.toHaveAttribute('data-footnote-target');
  // The marker leads to the entry by its address.
  const target = await entries(page).first().getAttribute('id');
  expect(target).toMatch(/^footnote-[0-9a-f]{24}$/);
  await expect(marker(page)).toHaveAttribute('href', `#${target}`);
  // The cursor is in the entry, and the focus is in the text.
  await expect(doc).toBeFocused();
  expect(await entryWithCursor(page)).toBe('');

  // The marks of FR-ED-02 apply in an entry as they do in a paragraph.
  await page.keyboard.type('See ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('Smith');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+i');
  await page.keyboard.type(' 2024');
  await expect(entries(page).first()).toHaveText('See Smith 2024');
  await expect(entries(page).first().locator('strong')).toHaveText('Smith');
  await expect(entries(page).first().locator('em')).toHaveText(' 2024');
  // Enter makes a line break and no second entry, which would hold the same identifier.
  await page.keyboard.press('Enter');
  await page.keyboard.type('next line');
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).first().locator('br')).toHaveCount(1);

  // It is there after the document has been loaded again, with the same number.
  await inSync(page);
  await page.reload();
  await expect(marker(page, 1)).toBeVisible();
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).first()).toHaveAttribute('value', '1');
  await expect(entries(page).first().locator('strong')).toHaveText('Smith');
});

test('the alias /fn, and nowhere that a marker cannot stand: a code block, a caption, an entry', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  await doc.focus();
  // In a code block the palette does not open.
  await page.keyboard.type('Intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/code');
  await page.keyboard.press('Enter');
  await expect(doc.locator('pre')).toHaveCount(1);
  await page.keyboard.type('a /');
  await expect(palette(page)).toBeHidden();
  // Out of it, by the arrow key, to the paragraph that ends the body: the alias is listed, alone.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('/fn');
  await expect(rows(page)).toHaveText(['Footnote/footnote']);
  await page.keyboard.press('Enter');
  await expect(marker(page)).toHaveCount(1);
  await expect(entries(page)).toHaveCount(1);
  // In the entry, where the cursor now is, the palette does not open, and the words go in the entry.
  await expect(doc).toBeFocused();
  await page.keyboard.type('words /fn');
  await expect(palette(page)).toBeHidden();
  await expect(entries(page).first()).toHaveText('words /fn');
  await expect(entries(page)).toHaveCount(1);
  await expect(marker(page)).toHaveCount(1);
});

test('a footnote put before the first renumbers both, the list follows the markers, and a marker taken out takes its entry', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  await doc.focus();
  await page.keyboard.type('First paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph ');
  await addFootnote(page);
  await page.keyboard.type('Note on the second');
  await expect(marker(page, 1)).toBeVisible();

  // A footnote in the first paragraph, which comes before: it is the first, and the other the second.
  await toEndOfFirstParagraph(page);
  await page.keyboard.type(' ');
  await addFootnote(page, '/fn');
  await page.keyboard.type('Note on the first');
  await expect(marker(page)).toHaveCount(2);
  await expect(doc.locator('p').first().locator('sup a')).toHaveText('1');
  await expect(doc.locator('p').nth(1).locator('sup a')).toHaveText('2');
  await expect(marker(page).first()).toHaveAccessibleName('Footnote 1');
  await expect(marker(page).last()).toHaveAccessibleName('Footnote 2');
  // The list is in the order of the numbers, each entry with its own.
  await expect(entries(page)).toHaveText(['Note on the first', 'Note on the second']);
  expect(await entries(page).evaluateAll((items) => items.map((item) => item.getAttribute('value')))).toEqual(
    ['1', '2'],
  );

  // The first footnote taken out by its marker: the second is the first, and its entry stays the only one.
  await doc.locator('p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await expect(marker(page)).toHaveCount(1);
  await expect(marker(page, 1)).toBeVisible();
  await expect(entries(page)).toHaveText(['Note on the second']);
  expect(await entries(page).evaluateAll((items) => items.map((item) => item.getAttribute('value')))).toEqual(
    ['1'],
  );

  // And the last: the list goes with it.
  await doc.locator('p').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await expect(marker(page)).toHaveCount(0);
  // The list stays, empty (no list is ever deleted), and is not drawn: no region named Footnotes is on the page.
  await expect(doc.locator(`section[aria-label="${FOOTNOTES}"]`)).toBeHidden();
  await expect(entries(page)).toHaveCount(0);

  // One step of undo brings the marker and the entry back together.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(marker(page, 1)).toBeVisible();
  await expect(entries(page)).toHaveText(['Note on the second']);
});

test('a marker leads to its entry: by a click, and by Tab and Enter from the text', async ({ page }) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  await doc.focus();
  await page.keyboard.type('A claim ');
  await addFootnote(page);
  await page.keyboard.type('The source');
  // Between the claim and the entry, enough text to scroll the page.
  await toEndOfFirstParagraph(page);
  for (let line = 0; line < LINES; line += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Line ${line}`);
  }
  await text(page).locator('p').first().scrollIntoViewIfNeeded();
  await expect(entries(page).first()).not.toBeInViewport({ ratio: 1 });

  // A click on the marker: the cursor is in the entry, and the entry is in view.
  await text(page).locator('p').first().scrollIntoViewIfNeeded();
  await expect(entries(page).first()).not.toBeInViewport({ ratio: 1 });
  await marker(page, 1).click();
  // The entry reached carries the package's mark for a moment, and the mark is taken off after it.
  await expect(entries(page).first()).toHaveAttribute('data-footnote-target', '');
  await expect(entries(page).first()).not.toHaveAttribute('data-footnote-target');
  await expect(entries(page).first()).toBeInViewport({ ratio: 1 });
  await expect.poll(() => entryWithCursor(page)).toBe('The source');
  await page.keyboard.type('!');
  await expect(entries(page).first()).toHaveText('The source!');

  // By keyboard alone: Tab from the text reaches a marker (the first of the document; S20-12), and Enter follows it.
  await toEndOfFirstParagraph(page, 'Home');
  await expect(entries(page).first()).not.toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Tab');
  await expect(marker(page, 1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(entries(page).first()).toBeInViewport({ ratio: 1 });
  await expect.poll(() => entryWithCursor(page)).toBe('The source!');
  // Nothing was added to the document by Enter: no second entry, no new paragraph.
  await expect(entries(page)).toHaveCount(1);
  await expect(doc.locator('p')).toHaveCount(LINES + 1);
});

// The package gives the marker a target of 24 by 24 CSS pixels, drawn as an out-of-flow ::after centred on the
// number (WCAG 2.5.8). In a document that can be edited that square lay over the words on either side, so what
// is asked is that a click aimed at those words, a few pixels from the number, still puts the caret in the text
// and follows nothing. domico 0.41.0 removed the square (it had taken all four clicks on 0.40.1); the
// measurements are kept in the report of the run.
test('the target of a marker does not take a click aimed at the words beside it, in a document that can be edited', async ({
  page,
}, testInfo) => {
  test.slow();
  await enter(page);
  await openNew(page);
  await text(page).focus();
  await page.keyboard.type('The claim goes ');
  await addFootnote(page);
  await page.keyboard.type('The source');
  await toEndOfFirstParagraph(page);
  await page.keyboard.type(' on after the marker, and then some more words');
  await expect(marker(page, 1)).toBeVisible();

  const box = (await marker(page, 1).boundingBox())!;
  const y = box.y + box.height / 2;
  const measured: string[] = [];
  const stolen: string[] = [];
  for (const [side, edge, sign] of [
    ['left', box.x, -1],
    ['right', box.x + box.width, 1],
  ] as const) {
    for (const distance of [4, 8]) {
      const x = edge + sign * distance;
      // Wait for the mark of an earlier follow to go, so that one click is not read as the one before it.
      await expect(entries(page).first()).not.toHaveAttribute('data-footnote-target');
      const hit = await page.evaluate(
        ([px, py]) => {
          const element = document.elementFromPoint(px!, py!);
          return element
            ? `${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ''}`
            : 'none';
        },
        [x, y],
      );
      await page.mouse.click(x, y);
      const where = await blockWithCursor(page);
      const marked = await entries(page)
        .first()
        .evaluate((entry) => entry.hasAttribute('data-footnote-target'));
      measured.push(
        `${distance}px ${side} of the number (marker box x ${box.x.toFixed(1)}, width ${box.width.toFixed(1)}): ` +
          `element under the pointer ${hit}; caret in ${where}; entry marked ${marked}`,
      );
      testInfo.annotations.push({ type: `${side} ${distance}px`, description: measured.at(-1)! });
      if (where !== 'paragraph' || marked) stolen.push(measured.at(-1)!);
    }
  }
  // Every point is asked before the test fails, so that the report holds all four measurements.
  expect(stolen, measured.join('\n')).toEqual([]);
});

/** The `content` of the ::after of each element: `""` where the package draws the arrow of a link, else `none`. */
const arrows = (links: Locator) =>
  links.evaluateAll((all) => all.map((each) => getComputedStyle(each, '::after').content));

/** What holds the focus of the page: its name where it has one, else its role or its tag. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element?.getAttribute('aria-label') ?? element?.getAttribute('role') ?? element?.tagName ?? null;
  });

// S20-12 (register row; the review of pull request 55). Tab from the text starts at the first focusable element
// in the editor in the order of the document, whatever the place of the caret: what is asked here is that every
// marker is reached by Tab alone, in the order of the document, and the behaviour the owner is to decide on is
// recorded by the second test and not claimed to be "the next marker".
test('Tab reaches every marker in the order of the document, wherever it stands: a paragraph, a list item, a table cell, and Enter follows each', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  await doc.focus();
  await page.keyboard.type('Lead');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/bullet');
  await page.keyboard.press('Enter');
  await page.keyboard.type('item');
  // Two Enters leave the list.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await page.keyboard.type('cell');
  await expect(doc.locator('td')).toHaveCount(9);

  // One marker in each: they are numbered in the order of the document, which is the order they are made here.
  await toEndOfFirstParagraph(page);
  await page.keyboard.type(' ');
  await addFootnote(page);
  await doc.locator('li', { hasText: 'item' }).first().locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await addFootnote(page);
  await doc.locator('td').first().locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await addFootnote(page);
  await expect(marker(page)).toHaveCount(3);
  await expect(entries(page)).toHaveCount(3);
  await expect(doc.locator('td').first().locator('sup a')).toHaveText('3');
  await expect(doc.locator('li', { hasText: 'item' }).first().locator('sup a')).toHaveText('2');

  // From the first paragraph: every press of Tab moves on, and the three markers are met in order.
  await toEndOfFirstParagraph(page, 'Home');
  const met: string[] = [];
  for (let press = 0; press < 12 && !met.includes('Footnote 3'); press += 1) {
    await page.keyboard.press('Tab');
    const now = await focused(page);
    if (now?.startsWith('Footnote ')) met.push(now);
  }
  expect(met).toEqual(['Footnote 1', 'Footnote 2', 'Footnote 3']);

  // Enter on the last, which is in a cell, follows it: the cursor is in its entry, and nothing was added.
  await expect(marker(page, 3)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => entryWithCursor(page)).toBe('');
  await page.keyboard.type('x');
  await expect(entries(page).nth(2)).toHaveText('x');
  await expect(entries(page)).toHaveCount(3);
  await expect(doc.locator('td').first().locator('p')).toHaveCount(1);
});

test('Tab from a caret after the first of two markers reaches the first, not the next (S20-12, recorded and to be decided)', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  await doc.focus();
  await page.keyboard.type('First ');
  await addFootnote(page);
  await page.keyboard.type('Note one');
  await toEndOfFirstParagraph(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second ');
  await addFootnote(page);
  await page.keyboard.type('Note two');
  await expect(marker(page)).toHaveCount(2);
  // The caret is in the second paragraph, after the first marker and before the second.
  await toParagraph(page, 1, 'Home');
  await page.keyboard.press('Tab');
  // What the browser does and the page does not change: the first focusable element of the editor. A key of
  // the editor's own that follows the marker after the caret is the owner's to choose (S20-12).
  await expect(marker(page, 1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(marker(page, 2)).toBeFocused();
});

test('a second browser sees the same numbers and entries, in the order of the markers; two writers add footnotes at once', async ({
  page,
  browser,
}) => {
  test.slow();
  const person = await enter(page);
  await openNew(page);
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto('/sign-in');
  await signIn(other, person);
  await expect(other.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await other.goto(page.url());
  await inSync(other);

  await text(page).focus();
  await page.keyboard.type('Top paragraph');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Middle paragraph ');
  await addFootnote(page);
  await page.keyboard.type('Middle note');
  // The list exists before two writers add to it at once: the first footnote of a document put in by two
  // writers in one moment is another case (docs/plan/slice-20.md, S20-9; tests/unit/footnote-collab.test.ts).
  await expect(text(other).locator('section[aria-label="Footnotes"] li')).toHaveText(['Middle note']);
  await toParagraph(page, 1);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Bottom paragraph ');
  await expect(text(other)).toContainText('Bottom paragraph');
  await expect(marker(other)).toHaveCount(1);

  // At once, each in a paragraph of its own: both footnotes, with the numbers of their places.
  await toParagraph(page, 0);
  await page.keyboard.type(' ');
  await toParagraph(other, 2);
  await other.keyboard.type(' ');
  await Promise.all([addFootnote(page), addFootnote(other)]);
  await Promise.all([page.keyboard.type('Top note'), other.keyboard.type('Bottom note')]);
  for (const view of [page, other]) {
    await expect(marker(view)).toHaveCount(3);
    await expect(marker(view)).toHaveText(['1', '2', '3']);
    await expect(entries(view)).toHaveText(['Top note', 'Middle note', 'Bottom note']);
  }
  // Each entry is drawn with the number of its own marker, on both pages alike.
  const numbersOf = (view: Page) =>
    entries(view).evaluateAll((items) =>
      items.map((item) => `${item.getAttribute('value')}:${item.textContent}`),
    );
  await expect
    .poll(async () => JSON.stringify(await numbersOf(page)))
    .toBe(JSON.stringify(await numbersOf(other)));
  expect(await numbersOf(page)).toEqual(['1:Top note', '2:Middle note', '3:Bottom note']);

  // One writer takes the first footnote out: the other sees its entry go, and the rest renumbered.
  await toEndOfFirstParagraph(other);
  await other.keyboard.press('Backspace');
  await expect(marker(page)).toHaveCount(2);
  await expect(marker(page)).toHaveText(['1', '2']);
  await expect(entries(page)).toHaveText(['Middle note', 'Bottom note']);
  expect(await numbersOf(page)).toEqual(['1:Middle note', '2:Bottom note']);
  await second.close();
});

test('a Viewer reads the footnotes, follows a marker to its entry, and changes nothing', async ({
  page,
  browser,
}) => {
  test.slow();
  await enter(page);
  const id = await shareNew(page);
  const viewer = newPerson();
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await enter(theirs, viewer);
  await invite(page, [viewer.email], 'Viewer');
  const { found: link } = await mailFor(viewer.email, INVITATION_LINK);
  await theirs.goto(new URL(link).pathname);
  await theirs.getByRole('button', { name: 'Accept' }).click();
  await theirs.waitForURL(`**/documents/${id}`);
  await inSync(theirs);

  await page.goto(`/documents/${id}`);
  await text(page).click();
  await page.keyboard.type('Claim ');
  await addFootnote(page);
  await page.keyboard.type('Source');
  await toEndOfFirstParagraph(page);
  for (let line = 0; line < LINES; line += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Line ${line}`);
  }

  // A link in a paragraph, put in by the writer: the arrow of the package is drawn in a document that cannot be
  // edited and not in one that can (0.41.0: [contenteditable="true"] and what is in it have none).
  await page.evaluate(() => {
    const view = document.querySelector('[role="textbox"]') as unknown as {
      editor: { chain(): { insertContent(html: string): { run(): boolean } } };
    };
    view.editor.chain().insertContent('<a href="https://example.org/x">linked words</a>').run();
  });
  const written = text(page).locator('p a[href="https://example.org/x"]');
  await expect(written).toHaveCount(1);
  expect(await arrows(written)).toEqual(['none']);
  const read = text(theirs).locator('p a[href="https://example.org/x"]');
  await expect(read).toHaveCount(1);
  await expect(text(theirs)).toHaveAttribute('contenteditable', 'false');
  expect(await arrows(read)).toEqual(['""']);
  // The links of the header carry none.
  const header = await arrows(page.getByRole('banner').getByRole('link'));
  expect(header.length).toBeGreaterThan(0);
  expect(header.every((each) => each === 'none')).toBe(true);

  // The Viewer is shown the marker, with its number, and the entry, with its words.
  await expect(text(theirs)).toHaveAttribute('aria-readonly', 'true');
  await expect(marker(theirs, 1)).toBeVisible();
  await expect(entries(theirs)).toHaveText(['Source']);
  await expect(entries(theirs).first()).toHaveAttribute('value', '1');
  // The marker is a link, which Tab reaches in a document that cannot be edited, and its entry takes the focus.
  await expect(marker(theirs, 1)).not.toHaveAttribute('tabindex', '-1');
  await expect(entries(theirs).first()).toHaveAttribute('tabindex', '-1');
  await expect(entries(theirs).first()).not.toBeInViewport({ ratio: 1 });
  await marker(theirs, 1).click();
  await expect(entries(theirs).first()).toBeInViewport({ ratio: 1 });
  await expect(entries(theirs).first()).toBeFocused();
  // The entry carries the package's mark for a moment in a document that cannot be edited too, and the
  // focus is still on it once the mark has gone.
  await expect(entries(theirs).first()).toHaveAttribute('data-footnote-target', '');
  await expect(entries(theirs).first()).not.toHaveAttribute('data-footnote-target');
  await expect(entries(theirs).first()).toBeFocused();
  // What the Viewer types goes nowhere, in the entry or in the text.
  await theirs.keyboard.type('written by the Viewer');
  await expect(entries(theirs)).toHaveText(['Source']);
  await expect(text(theirs)).not.toContainText('written by the Viewer');
  // And what the Owner writes in the entry is seen at once.
  await expect(entries(page).first()).toBeVisible();
  await entries(page).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await expect(entries(theirs)).toHaveText(['Source and more']);
  await other.close();
  // The titles of the list of documents carry no arrow either.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  const titles = await arrows(page.getByRole('main').getByRole('link'));
  expect(titles.length).toBeGreaterThan(0);
  expect(titles.every((each) => each === 'none')).toBe(true);
});
