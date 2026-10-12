// The page of a document and its editor (FR-ED-01 to FR-ED-04, FR-ED-06,
// FR-ED-07, FR-ED-09, FR-ED-15, FR-ED-16, FR-ED-18, FR-ED-22 to FR-ED-24,
// FR-ED-41, FR-ED-43, FR-AU-08, NFR-IC-19; NFR-SE-06, A03), against the real
// collaboration server, which this file starts and stops.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import * as Y from 'yjs';
import {
  expectNoSidewaysScroll,
  newPerson,
  screens,
  signIn,
  signUp,
  storeNested,
  watchOrigins,
  type Person,
} from './account.ts';
import { connectAs, startCollab, stopCollab } from './collab.ts';

// One collaboration server for the file, and one test at a time: a test stops it.
test.describe.configure({ mode: 'serial' });
test.beforeAll(startCollab);
test.afterAll(stopCollab);

// The fixed texts, written out here and not taken from the code under test.
const MARK = 'Not recorded'; // FR-ED-43
const IN_SYNC_MESSAGE = 'Document autosaves — working version is in sync.'; // FR-ED-24

const text = (page: Page) => page.getByRole('textbox', { name: 'Document text' });
const status = (page: Page, words: string | RegExp) => page.getByRole('button', { name: words });
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Formatting' });
async function enter(page: Page, person: Person = newPerson()) {
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  return person;
}

/** Creates a document from the list and opens its page. Resolves with its identifier. */
async function openNew(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New document' }).click();
  await page.getByRole('link', { name: 'Untitled document' }).click();
  await expect(text(page)).toBeVisible();
  await expect(status(page, 'In sync')).toBeVisible();
  return /\/documents\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

/**
 * What the clipboard holds. A page of the application may write to the
 * clipboard and may not read it (src/lib/csp.ts, `Permissions-Policy`), so it
 * is read from a page of the test's own, on the same origin, that the
 * application did not answer and that carries no policy.
 */
async function clipboardText(page: Page): Promise<string> {
  const reader = await page.context().newPage();
  try {
    await reader.route('**/the-clipboard-of-the-test', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>The clipboard of the test</title>' }),
    );
    await reader.goto('/the-clipboard-of-the-test');
    return await reader.evaluate(() => navigator.clipboard.readText());
  } finally {
    await reader.close();
  }
}

/** What a paste from another page hands the editor: markup, which the schema reads or drops. */
async function paste(page: Page, html: string) {
  await text(page).evaluate((element, markup) => {
    const data = new DataTransfer();
    data.setData('text/html', markup);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, html);
}

/**
 * Puts the cursor in a block by a press on it. The editor reads where a press
 * put the cursor a few milliseconds after it, sooner than a person can type
 * and later than a test does: so the test waits.
 */
async function place(block: Locator) {
  await block.click();
  await block.page().waitForTimeout(100);
}

/** Puts the cursor at the end of a block's text, whatever the keys of the platform do. */
async function placeAtEnd(block: Locator) {
  await place(block);
  await block.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  await block.page().waitForTimeout(100);
}

/** Counts the sockets a page opens from now on. */
function countSockets(page: Page) {
  const opened = { count: 0 };
  page.on('websocket', () => (opened.count += 1));
  return opened;
}

// Every block of the cut that this slice builds, and every mark (FR-ED-01, FR-ED-02).
const EVERYTHING = `
  <h1>Heading one</h1><h2>Heading two</h2><h3>Heading three</h3>
  <p>Plain, <strong>bold</strong>, <em>italic</em>, <u>underline</u>, <s>strike</s>, <code>code</code>,
    x<sup>sup</sup>, y<sub>sub</sub>, <a href="https://example.com/">link</a>, <mark>highlight</mark>.</p>
  <ol><li><p>First</p></li><li><p>Second</p></li></ol>
  <ul><li><p>Bullet</p></li></ul>
  <blockquote><p>Quoted</p></blockquote>
  <table><tbody><tr><th>Head A</th><th>Head B</th></tr><tr><td>One</td><td>Two</td></tr></tbody></table>
  <pre><code class="language-typescript">const answer: number = 42;</code></pre>
  <aside class="callout" data-type="warning"><div class="callout-body"><p>Take care.</p></div></aside>
  <nav class="ekd-toc" data-depth="2"></nav>
  <div class="ekd-page-break">Page break</div>
  <hr>
  <p>Last paragraph.</p>`;

test('a document opens at its address, is edited, and is there after a reload', async ({ page }) => {
  const elsewhere = watchOrigins(page);
  await enter(page);
  const id = await openNew(page);

  // The owner's decision E4: the address. FR-ED-43: the mark beside the title.
  expect(new URL(page.url()).pathname).toBe(`/documents/${id}`);
  await expect(page).toHaveTitle('Untitled document – Ekdotico');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Untitled document');
  await expect(page.getByRole('main').getByRole('button', { name: MARK })).toBeVisible();

  // NFR-IC-19: the region has a role and a name, and says how its controls are reached.
  await expect(text(page)).toHaveAttribute('aria-multiline', 'true');
  await expect(text(page)).toHaveAttribute('aria-readonly', 'false');
  await expect(text(page)).toHaveAccessibleDescription(
    /Alt\+F10 moves from the text to the formatting toolbar/,
  );
  await expectNoSidewaysScroll(page);
  await screens(page, 'editor-empty');

  await text(page).click();
  await page.keyboard.type('What was typed survives a reload.');
  await expect(status(page, 'In sync')).toBeVisible();

  // FR-ED-24: the indicator is pressed, and the fixed message is shown.
  await status(page, 'In sync').click();
  const dialog = page.getByRole('dialog', { name: 'Sync status' });
  await expect(dialog).toContainText(IN_SYNC_MESSAGE);
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.reload();
  await expect(text(page)).toHaveText('What was typed survives a reload.');
  // FR-AU-08, FR-AU-88: the socket is on the application's own origin.
  expect(elsewhere).toEqual([]);
});

test('every block and every mark, the controls inside each block, and the toolbar on the selection', async ({
  page,
  context,
}) => {
  test.slow();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await enter(page);
  await openNew(page);
  await text(page).click();
  await paste(page, EVERYTHING);
  const doc = text(page);

  // FR-ED-01: the blocks.
  for (const tag of ['h1', 'h2', 'h3', 'ol:not(.ekd-toc-list)', 'ul', 'blockquote', 'table', 'pre', 'hr']) {
    await expect(doc.locator(tag), tag).toHaveCount(1);
  }
  await expect(doc.locator('th')).toHaveText(['Head A', 'Head B']);
  await expect(doc.locator('td')).toHaveText(['One', 'Two']);
  await expect(doc.locator('.ekd-page-break')).toHaveText('Page break');
  // FR-ED-02: the nine marks, each as its own element.
  for (const [tag, words] of [
    ['strong', 'bold'],
    ['em', 'italic'],
    ['u', 'underline'],
    ['s', 'strike'],
    ['p code', 'code'],
    ['sup', 'sup'],
    ['sub', 'sub'],
    ['a[href="https://example.com/"]', 'link'],
    ['mark', 'highlight'],
  ] as const) {
    await expect(doc.locator(tag), tag).toHaveText(words);
  }

  // FR-ED-03: the language selector and the copy button are in the block, and the code is highlighted.
  const language = doc.getByRole('combobox', { name: 'Code language' });
  await expect(language).toHaveValue('typescript');
  await expect(doc.locator('pre .hljs-keyword')).toHaveText('const');
  await expect(doc.locator('pre')).toHaveAttribute('spellcheck', 'false');
  await language.selectOption('python');
  await expect(doc.locator('pre code')).toHaveClass(/language-python/);
  await doc.getByRole('button', { name: 'Copy' }).click();
  await expect(doc.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await clipboardText(page)).toBe('const answer: number = 42;');

  // FR-ED-04: three variants, chosen after the callout is there.
  await expect(doc.getByRole('note', { name: 'Warning' })).toContainText('Take care.');
  await doc.getByRole('radio', { name: 'Tip' }).check();
  await expect(doc.getByRole('note', { name: 'Tip' })).toContainText('Take care.');
  await expect(doc.locator('.callout')).toHaveAttribute('data-type', 'tip');

  // FR-ED-06: the entries follow the headings and the depth, and each goes to its heading.
  const contents = doc.getByRole('navigation', { name: 'Table of contents' });
  await expect(contents.getByRole('link')).toHaveText(['Heading one', 'Heading two']);
  await contents.getByRole('radio', { name: 'Levels 1–3' }).check();
  await expect(contents.getByRole('link')).toHaveText(['Heading one', 'Heading two', 'Heading three']);
  await placeAtEnd(doc.locator('h2'));
  await page.keyboard.type(' renamed');
  await expect(contents.getByRole('link')).toHaveText([
    'Heading one',
    'Heading two renamed',
    'Heading three',
  ]);
  await contents.getByRole('link', { name: 'Heading three' }).click();
  await page.keyboard.type('In ');
  await expect(doc.locator('h3')).toHaveText('In Heading three');

  // FR-ED-09: the operations are in the block, and act on the cell the cursor is in; the caption is below.
  await place(doc.locator('td', { hasText: 'One' }));
  await doc.getByRole('button', { name: 'Table' }).click();
  await page.getByRole('menuitem', { name: 'Add row below' }).click();
  await expect(doc.locator('tr')).toHaveCount(3);
  await doc.getByRole('button', { name: 'Table' }).click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'Add row above',
    'Add row below',
    'Add column left',
    'Add column right',
    'Delete row',
    'Delete column',
    'Merge cells',
    'Split cell',
    'Remove header row',
  ]);
  await page.getByRole('menuitem', { name: 'Add column right' }).click();
  await expect(doc.locator('tr').first().locator('th')).toHaveCount(3);
  await place(doc.locator('figcaption'));
  await page.keyboard.type('Table 1: a caption');
  await expect(doc.locator('figcaption')).toHaveText('Table 1: a caption');

  // NFR-IC-19: from a cell, the keyboard reaches the block's controls and returns.
  await place(doc.locator('td', { hasText: 'Two' }));
  await page.keyboard.press('Alt+F10');
  await expect(doc.getByRole('button', { name: 'Table' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(doc).toBeFocused();
  await screens(page, 'editor-content');

  // The owner's decision E3: a toolbar on the selection, for the nine marks.
  await expect(toolbar(page)).toHaveCount(0);
  await doc.getByText('Last paragraph.').click({ clickCount: 3 });
  await expect(toolbar(page)).toBeVisible();
  const names = ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Inline code', 'Superscript', 'Subscript'];
  names.push('Link', 'Highlight');
  await expect(toolbar(page).getByRole('button')).toHaveCount(9);
  for (const [index, name] of names.entries()) {
    await expect(toolbar(page).getByRole('button').nth(index)).toHaveAccessibleName(name);
  }
  // The focus is not taken from the text when the toolbar appears, nor by a press on it.
  await expect(doc).toBeFocused();
  await toolbar(page).getByRole('button', { name: 'Bold' }).click();
  await expect(doc).toBeFocused();
  await expect(toolbar(page).getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  await expect(doc.locator('p strong').last()).toHaveText('Last paragraph.');
  await expectNoSidewaysScroll(page);
  await screens(page, 'editor-toolbar');

  // By the keyboard alone: Alt+F10 reaches the row, the arrows move in it, Escape returns.
  await page.keyboard.press('Alt+F10');
  await expect(toolbar(page).getByRole('button', { name: 'Bold' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(toolbar(page).getByRole('button', { name: 'Italic' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toolbar(page).getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'true');
  await expect(doc.locator('p em').last()).toHaveText('Last paragraph.');

  // The hyperlink: an address that could run as script is refused in words, and one of the web is set.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await expect(toolbar(page).getByRole('button', { name: 'Link' })).toBeFocused();
  await page.keyboard.press('Enter');
  const link = page.getByRole('dialog', { name: 'Link' });
  await link.getByLabel('Link address').fill('javascript:alert(1)');
  await link.getByRole('button', { name: 'Save' }).click();
  await expect(link.getByRole('alert')).toContainText('The link was not saved');
  await expect(link.getByRole('alert')).toContainText(
    'Enter an address that begins with https://, http://, or mailto: — for example, https://example.org.',
  );
  await expect(doc.locator('p a')).toHaveCount(1);
  await link.getByLabel('Link address').fill('https://example.org/page');
  await link.getByRole('button', { name: 'Save' }).click();
  await expect(link).toBeHidden();
  await expect(doc.locator('a[href="https://example.org/page"]')).toHaveCount(1);
  // The dialog returns the focus to the control that opened it, and Escape returns to the text.
  await expect(toolbar(page).getByRole('button', { name: 'Link' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(doc).toBeFocused();

  // "Survives a reload": every block and the choices made in each.
  await expect(status(page, 'In sync')).toBeVisible();
  await page.reload();
  for (const tag of [
    'h1',
    'h2',
    'h3',
    'ol:not(.ekd-toc-list)',
    'ul',
    'blockquote',
    'table',
    'pre',
    'hr',
    '.ekd-page-break',
  ]) {
    await expect(doc.locator(tag), tag).toHaveCount(1);
  }
  await expect(doc.getByRole('note', { name: 'Tip' })).toBeVisible();
  await expect(doc.getByRole('combobox', { name: 'Code language' })).toHaveValue('python');
  await expect(contents.getByRole('link')).toHaveCount(3);
  await expect(doc.locator('figcaption')).toHaveText('Table 1: a caption');
  await expect(doc.locator('tr')).toHaveCount(3);
});

test('two browsers that edit one document converge', async ({ page, browser }) => {
  const person = await enter(page);
  await openNew(page);
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto('/sign-in');
  await signIn(other, person);
  await expect(other.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await other.goto(page.url());
  await expect(status(other, 'In sync')).toBeVisible();

  await text(page).click();
  await page.keyboard.type('From the first browser.');
  await expect(text(other)).toHaveText('From the first browser.');
  await placeAtEnd(text(other).locator('p'));
  await other.keyboard.press('Enter');
  await other.keyboard.type('From the second browser.');
  await expect(text(page).locator('p')).toHaveText(['From the first browser.', 'From the second browser.']);

  // At the same time, each in its own paragraph: FR-ED-16, one state on both.
  await placeAtEnd(text(page).locator('p').first());
  await Promise.all([page.keyboard.type(' AAAAAAAAAA'), other.keyboard.type(' BBBBBBBBBB')]);
  const both = ['From the first browser. AAAAAAAAAA', 'From the second browser. BBBBBBBBBB'];
  await expect(text(page).locator('p')).toHaveText(both);
  await expect(text(other).locator('p')).toHaveText(both);
  // And in one paragraph, at once: whatever the order, it is the same on both.
  await placeAtEnd(text(other).locator('p').first());
  await Promise.all([page.keyboard.type('11111'), other.keyboard.type('22222')]);
  await expect(text(page).locator('p').first()).toContainText('22222');
  await expect(text(other).locator('p').first()).toContainText('11111');
  await expect
    .poll(async () => (await text(page).innerText()) === (await text(other).innerText()))
    .toBe(true);
  await second.close();
});

/** Selects the whole text of a block, as three presses do, and waits for the editor to read it. */
async function selectText(block: Locator) {
  await block.click({ clickCount: 3 });
  await block.page().waitForTimeout(100);
}

// Every element a mark or a block of the editor is drawn as, apart from the paragraph.
const FORMATTED = 'strong, em, u, s, code, sub, sup, mark, a, h1, h2, h3, ol, ul, blockquote, pre, hr';

test('the keyboard shortcuts of the requirement act, and the others the library ships do not', async ({
  page,
}) => {
  await enter(page);
  await openNew(page);
  const doc = text(page);
  const line = doc.locator('p').first();
  const link = page.getByRole('dialog', { name: 'Link' });
  await doc.click();
  await page.keyboard.type('Marked words.');

  // FR-ED-13: bold, italic, underline, strikethrough and inline code, each on and off again.
  await selectText(line);
  for (const [key, tag] of [
    ['b', 'strong'],
    ['i', 'em'],
    ['u', 'u'],
    ['Shift+S', 's'],
    ['Backquote', 'code'],
  ] as const) {
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await expect(line.locator(tag), key).toHaveText('Marked words.');
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await expect(line.locator(tag), key).toHaveCount(0);
  }

  // The library's own, which are not on the list: inline code on its other
  // key, highlight, subscript, superscript, the three headings, the two
  // lists, the blockquote and the code block. None acts.
  for (const key of [
    'e',
    'Shift+H',
    'Comma',
    'Period',
    'Alt+Digit1',
    'Alt+Digit2',
    'Alt+Digit3',
    'Shift+Digit7',
    'Shift+Digit8',
    'Shift+B',
    'Alt+C',
  ]) {
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await expect(doc.locator(FORMATTED), key).toHaveCount(0);
  }
  await expect(doc).toHaveText('Marked words.');
  await expect(doc).toBeFocused();

  // The hyperlink: the key opens the dialog of the toolbar, with its rule for the address.
  await page.keyboard.press('ControlOrMeta+k');
  await link.getByLabel('Link address').fill('javascript:alert(1)');
  await link.getByRole('button', { name: 'Save' }).click();
  await expect(link.getByRole('alert')).toContainText('The link was not saved');
  await expect(doc.locator('a')).toHaveCount(0);
  await link.getByLabel('Link address').fill('https://example.org/key');
  await link.getByRole('button', { name: 'Save' }).click();
  await expect(link).toBeHidden();
  await expect(line.locator('a[href="https://example.org/key"]')).toHaveText('Marked words.');
  // The dialog returns the focus to the text it was opened from.
  await expect(doc).toBeFocused();
  // "Or edit": with the cursor in a link and nothing selected, the dialog holds its address.
  await place(line.locator('a'));
  await page.keyboard.press('ControlOrMeta+k');
  await expect(link.getByLabel('Link address')).toHaveValue('https://example.org/key');
  await link.getByRole('button', { name: 'Remove link' }).click();
  await expect(doc.locator('a')).toHaveCount(0);
  // With nothing selected and no link under the cursor there is nothing to link.
  await place(line);
  await page.keyboard.press('ControlOrMeta+k');
  await page.waitForTimeout(300);
  await expect(link).toBeHidden();
  await expect(doc).toBeFocused();

  // Undo and redo. The editor joins what is typed within half a second into one step.
  await placeAtEnd(line);
  await page.waitForTimeout(700);
  await page.keyboard.type(' More.');
  await expect(doc).toHaveText('Marked words. More.');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(doc).toHaveText('Marked words.');
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect(doc).toHaveText('Marked words. More.');

  // The paragraph of a heading is not a shortcut either: a heading stays one.
  await placeAtEnd(line);
  await page.keyboard.press('Enter');
  await page.keyboard.type('# Heading');
  await page.keyboard.press('ControlOrMeta+Alt+Digit0');
  await expect(doc.locator('h1')).toHaveText('Heading');

  // Tab and Shift+Tab indent and outdent a list item.
  await page.keyboard.press('Enter');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Tab');
  await expect(doc.locator('ul ul > li')).toHaveText('two');
  await page.keyboard.press('Shift+Tab');
  await expect(doc.locator('ul ul')).toHaveCount(0);
  await expect(doc.locator('ul > li')).toHaveText(['one', 'two']);
  // NFR-IC-19: outside a list and a table, Tab is the browser's, and leaves the text.
  await place(line);
  await page.keyboard.press('Tab');
  await expect(doc).not.toBeFocused();
  await expect(doc.locator('ul > li')).toHaveText(['one', 'two']);
});

test('the Markdown input of the requirement converts as it is typed, and nothing else does', async ({
  page,
}) => {
  page.on('dialog', () => {
    throw new Error('a dialog was opened by content');
  });
  await enter(page);
  await openNew(page);
  const doc = text(page);
  const lines = async (...typed: string[]) => {
    for (const each of typed) {
      await page.keyboard.type(each);
      await page.keyboard.press('Enter');
    }
  };
  await doc.click();

  // FR-ED-14, row by row. A second Enter leaves a list or a blockquote.
  await lines('# One', '## Two', '### Three', '- dash', '', '* star', '', '1. first', '', '> quoted', '');
  await lines('---', 'Marks: **bold** *italic* ~~struck~~ `code` and on.');
  const converted = async () => {
    await expect(doc.locator('h1')).toHaveText('One');
    await expect(doc.locator('h2')).toHaveText('Two');
    await expect(doc.locator('h3')).toHaveText('Three');
    await expect(doc.locator('ul > li')).toHaveText(['dash', 'star']);
    await expect(doc.locator('ol > li')).toHaveText('first');
    await expect(doc.locator('blockquote')).toHaveText('quoted');
    await expect(doc.locator('hr')).toHaveCount(1);
    await expect(doc.locator('strong')).toHaveText('bold');
    await expect(doc.locator('em')).toHaveText('italic');
    await expect(doc.locator('s')).toHaveText('struck');
    await expect(doc.locator('p code')).toHaveText('code');
    await expect(doc.locator('u, sub, sup, mark, a')).toHaveCount(0);
  };
  await converted();
  // The signs are gone, and what follows a mark is not marked.
  await expect(doc.locator('p', { hasText: 'Marks:' })).toHaveText('Marks: bold italic struck code and on.');
  await expect(doc.locator('ol')).not.toHaveAttribute('start');

  // What the library's own rules would convert, and the requirement does not
  // list; and what could carry an address. Each stays as it was typed.
  const kept = [
    '#### four',
    '+ plus',
    '2. two',
    '10. ten',
    '__under__ _score_ ==equals==',
    '___ ',
    '*** ',
    '--- dashes',
    // A mark opens at the start of a block or after white space, and holds no white space at its edges.
    'snake*case*name a**b** 1~~2~~ (*x*) x`y` 5 * 3 * 2 a ** b ** c ~~ x ~~ ` y `',
    '~~~',
    '```js',
    '``` ',
    '[x](javascript:alert(1)) <https://example.com/> https://example.net/ <b>markup</b>',
  ];
  await lines(...kept);
  // The paragraphs of the document itself that hold text, in their order.
  const plain = doc.locator(':scope > p').filter({ hasText: /\S/ });
  const typed = ['Marks: bold italic struck code and on.', ...kept.map((each) => each.trim())];
  await expect(plain).toHaveText(typed);
  await converted();
  await expect(doc.locator('pre')).toHaveCount(0);

  // Markdown that is pasted is text: FR-ED-14 is of what is typed.
  const pasted = '# pasted **strong** [y](javascript:alert(2)) https://example.org/ `tick`';
  await doc.evaluate((element, words) => {
    const data = new DataTransfer();
    data.setData('text/plain', words);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, pasted);
  await expect(plain).toHaveText([...typed, pasted]);
  await converted();

  // The code block, last: three backticks and Enter, plain text, and no rule acts inside it.
  await page.keyboard.press('Enter');
  await lines('```');
  await page.keyboard.type('# not **converted** `here`');
  await expect(doc.locator('pre code')).toHaveText('# not **converted** `here`');
  await expect(doc.getByRole('combobox', { name: 'Code language' })).toHaveValue('plaintext');
  await converted();

  // A caption is plain text (FR-ED-09, Build phases): it takes no mark, and keeps its signs.
  await placeAtEnd(plain.last());
  await paste(page, '<table><tbody><tr><td>Cell</td></tr></tbody></table>');
  await place(doc.locator('figcaption'));
  await page.keyboard.type('**kept** *as* ~~it~~ `was`');
  await expect(doc.locator('figcaption')).toHaveText('**kept** *as* ~~it~~ `was`');
  await converted();

  // Each conversion reached the server as the block or the mark it became.
  await expect(status(page, 'In sync')).toBeVisible();
  await page.reload();
  await converted();
  await expect(doc.locator('pre code')).toHaveText('# not **converted** `here`');
  await expect(plain).toHaveText([...typed, pasted]);
});

test('in the read-only state no shortcut changes the document', async ({ page }) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  const link = page.getByRole('dialog', { name: 'Link' });
  await doc.click();
  await page.keyboard.type('Kept as it is.');
  await expect(status(page, 'In sync')).toBeVisible();

  await stopCollab();
  try {
    // FR-ED-18: read-only in the error state.
    await expect(status(page, /^Not connected\./)).toBeVisible({ timeout: 15_000 });
    await selectText(doc.locator('p'));
    // The hyperlink first, while the text carries no mark that would refuse one.
    await page.keyboard.press('ControlOrMeta+k');
    await page.waitForTimeout(300);
    await expect.soft(link).toBeHidden();
    await page.keyboard.press('Escape');
    await selectText(doc.locator('p'));
    // Each is looked at before the next: an undo would take the others back with it.
    for (const key of ['b', 'i', 'u', 'Shift+S', 'Backquote']) {
      await page.keyboard.press(`ControlOrMeta+${key}`);
      await page.waitForTimeout(100);
      await expect.soft(doc.locator(FORMATTED), key).toHaveCount(0);
    }
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(300);
    await expect.soft(doc.locator('p')).toContainText('Kept as it is.');
    await expect.soft(doc.locator(FORMATTED)).toHaveCount(0);
  } finally {
    await startCollab();
  }

  // The connection returns, and so do the keys.
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 60_000 });
  await selectText(doc.locator('p'));
  await page.keyboard.press('ControlOrMeta+b');
  await expect(doc.locator('strong')).toHaveText('Kept as it is.');
});

// ── The slash command palette (FR-ED-10 to FR-ED-12) ────────────────────────

// The texts of the palette, written out here. No requirement gives them.
const LIST_ID = 'slash-commands';
const NO_BLOCK = 'No block matches. Delete a letter to see more.';
const palette = (page: Page) => page.getByRole('listbox', { name: 'Blocks' });
const rows = (page: Page) => palette(page).getByRole('option');

/**
 * The cursor out of the last block of the document, which it is in, down to
 * the paragraph that ends the document, and a new empty paragraph there. By
 * the arrow key alone: from the first cell of a new table that is two rows,
 * the caption, and the paragraph.
 */
async function newLastLine(page: Page) {
  for (let press = 0; press < 6; press += 1) await page.keyboard.press('ArrowDown');
  // The editor reads where a key of the browser's put the cursor a few milliseconds after it (`place`).
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
}

// FR-ED-12, the rows for the blocks of the cut: the command, the name of its
// row, the element its block is drawn as, and what is then typed into it.
const SLASH_ROWS: [command: string, row: string, made: string, words?: string][] = [
  ['text', 'Text', ':scope > p', 'A paragraph.'],
  ['h1', 'Heading 1', 'h1', 'First heading'],
  ['h2', 'Heading 2', 'h2', 'Second heading'],
  ['h3', 'Heading 3', 'h3', 'Third heading'],
  ['bullet', 'Bulleted list', 'ul > li', 'A point'],
  ['numbered', 'Numbered list', 'ol > li', 'A step'],
  ['quote', 'Quote', 'blockquote', 'A quotation'],
  ['table', 'Table', 'figure table tr:first-child > td:first-child', 'A cell'],
  ['code', 'Code block', 'pre code', 'a = 1'],
  ['callout', 'Callout', 'aside.callout[data-type="note"]', 'A note'],
  ['toc', 'Table of contents', 'nav.ekd-toc'],
  ['divider', 'Divider', 'hr'],
  ['page-break', 'Page break', '.ekd-page-break'],
];

/** Every block of the rows above, once, as it was inserted. */
async function inserted(doc: Locator) {
  for (const [command, , made, words] of SLASH_ROWS) {
    const block = words ? doc.locator(made).filter({ hasText: words }) : doc.locator(made);
    await expect(block, command).toHaveCount(1);
  }
  // "3×3 default", and three plain rows: no header row (the owner's decision of 9 October 2026).
  await expect(doc.locator('figure table tr')).toHaveCount(3);
  await expect(doc.locator('figure table td')).toHaveCount(9);
  await expect(doc.locator('figure table th')).toHaveCount(0);
  await expect(doc.locator('figcaption')).toHaveCount(1);
  await expect(doc.getByRole('combobox', { name: 'Code language' })).toHaveValue('plaintext');
  // What was typed to ask for a block is not in the document.
  for (const [command] of SLASH_ROWS)
    await expect(doc.getByText(`/${command}`, { exact: true })).toHaveCount(0);
}

test('every row of the slash palette is inserted by keyboard alone, and a second browser sees each block', async ({
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
  await expect(status(other, 'In sync')).toBeVisible();

  const doc = text(page);
  // No press of a pointer from here on.
  await doc.focus();
  for (const [command, row, made, words] of SLASH_ROWS) {
    await newLastLine(page);
    await page.keyboard.type(`/${command}`);
    // The row Enter chooses is the first, and is the one the command names.
    await expect(rows(page).first(), command).toContainText(row);
    await expect(rows(page).first(), command).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(palette(page), command).toBeHidden();
    // The focus is in the text, and the cursor where the block takes text.
    await expect(doc, command).toBeFocused();
    if (words) await page.keyboard.type(words);
    const block = words ? doc.locator(made).filter({ hasText: words }) : doc.locator(made);
    await expect(block, command).toHaveCount(1);
  }
  await inserted(doc);
  await inserted(text(other));

  // Each block reached the server as the block it is (the plan's criterion: "survives a reload").
  await expect(status(page, 'In sync')).toBeVisible();
  await page.reload();
  await inserted(text(page));
  await second.close();
});

test('the slash palette opens where the requirement says, filters by name and alias, and closes without losing what was typed', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  const list = palette(page);
  const last = doc.locator(':scope > p').last();
  /** Nothing opens within the time a list takes to. */
  const staysClosed = async (why: string) => {
    await page.waitForTimeout(300);
    await expect(list, why).toBeHidden();
    await expect(page.getByText(NO_BLOCK).first(), why).toBeHidden();
    await expect(doc, why).not.toHaveAttribute('aria-controls');
  };
  await doc.focus();
  await expect(doc).not.toHaveAttribute('aria-controls');

  // FR-ED-10: a slash at the beginning of an empty block. FR-ED-12: the thirteen rows of the cut.
  await page.keyboard.type('/');
  await expect(rows(page)).toHaveText(SLASH_ROWS.map(([command, row]) => `${row}/${command}`));
  await expect(rows(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page).and(page.locator('[aria-selected="true"]'))).toHaveCount(1);
  // NFR-IC-19: the focus stays in the text, which names the list, and no row while the query is typed.
  await expect(doc).toBeFocused();
  await expect(doc).toHaveAttribute('aria-controls', LIST_ID);
  await expect(list).toHaveAttribute('id', LIST_ID);
  await expect(doc).not.toHaveAttribute('aria-activedescendant');
  // What a screen reader is told once the count has settled: the count, and the row Enter chooses.
  await expect(page.getByRole('status').filter({ hasText: '13 blocks. Text first.' })).toBeAttached();

  // FR-ED-11: "a maximum of eight results at a time and shall be scrollable".
  const whole = () =>
    list.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll('[role="option"]')].filter((row) => {
        const each = row.getBoundingClientRect();
        return each.top >= box.top - 1 && each.bottom <= box.bottom + 1;
      }).length;
    });
  expect(await whole()).toBe(8);
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(rows(page).nth(12)).not.toBeInViewport();

  // The arrow keys move in the list, and the text then names the row; the cursor does not move.
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page).and(page.locator('[aria-selected="true"]'))).toHaveCount(1);
  await expect(doc).toHaveAttribute('aria-activedescendant', (await rows(page).nth(1).getAttribute('id'))!);
  await page.keyboard.press('ArrowUp');
  await expect(doc).toHaveAttribute('aria-activedescendant', (await rows(page).nth(0).getAttribute('id'))!);
  // To the last row, which is scrolled into view; Down stops there.
  for (let press = 0; press < 14; press += 1) await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(12)).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page).nth(12)).toBeInViewport();
  await expect(doc).toHaveAttribute('aria-activedescendant', (await rows(page).nth(12).getAttribute('id'))!);
  await expect(doc).toBeFocused();
  await expect(doc).toHaveText('/');

  // FR-ED-11: filtered as the query is typed, by name. A letter ends the move in the list.
  await page.keyboard.type('h');
  await expect(rows(page)).toHaveText(['Heading 1/h1', 'Heading 2/h2', 'Heading 3/h3', 'Divider/divider']);
  await expect(rows(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(doc).not.toHaveAttribute('aria-activedescendant');
  await expect(doc).toHaveAttribute('aria-controls', LIST_ID);
  await expect(page.getByRole('status').filter({ hasText: '4 blocks. Heading 1 first.' })).toBeAttached();
  // By alias, and without regard to case (the owner's decision of 9 October 2026): from the start of the word.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('OL');
  await expect(rows(page)).toHaveText(['Numbered list/numbered']);
  await expect(page.getByRole('status').filter({ hasText: '1 block. Numbered list first.' })).toBeAttached();
  // Nothing matches: the empty text, in place of the list, and the text names no list.
  await page.keyboard.type('x');
  await expect(list).toBeHidden();
  await expect(page.getByText(NO_BLOCK).first()).toBeVisible();
  await expect(doc).not.toHaveAttribute('aria-controls');
  // What a screen reader is told of it: the same words, once.
  await expect(page.getByRole('status').filter({ hasText: NO_BLOCK })).toHaveText(NO_BLOCK);
  await page.keyboard.press('Backspace');
  await expect(rows(page)).toHaveText(['Numbered list/numbered']);

  // FR-ED-10: Escape. The text stays as typed, the focus stays, and that slash opens nothing again.
  // The key is the palette's while it is open, and nothing else on the page is to act on it.
  await page.evaluate(() => {
    const seen = window as unknown as { escapes: boolean[] };
    seen.escapes = [];
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') seen.escapes.push(event.defaultPrevented);
    });
  });
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  // The default of the key was prevented, which is what a dialog round the
  // text reads. (The editor prevents it with the list closed as well, which is
  // not the palette's doing: tests/unit/slash-palette.test.ts holds the
  // palette to taking the key only while it is open.)
  expect(await page.evaluate(() => (window as unknown as { escapes: boolean[] }).escapes)).toEqual([true]);
  await expect(doc).toHaveText('/OL');
  await expect(doc).toBeFocused();
  await page.keyboard.type('q');
  await staysClosed('after Escape');
  await expect(doc).toHaveText('/OLq');
  // A slash that follows a space is a new request; one that follows a letter is none.
  await page.keyboard.type(' /');
  await expect(rows(page)).toHaveCount(13);
  // FR-ED-10: "or clicks outside it".
  await page.getByRole('heading', { level: 1 }).click();
  await expect(list).toBeHidden();
  await expect(doc).toHaveText('/OLq /');
  await placeAtEnd(last);
  // A cursor that arrives after a slash is no request.
  await staysClosed('a cursor that arrives');
  await page.keyboard.type('x/');
  await staysClosed('a slash after a letter');
  await expect(doc).toHaveText('/OLq /x/');

  // A row is chosen by a press as well, which leaves the focus in the text.
  await newLastLine(page);
  await page.keyboard.type('/q');
  await rows(page).filter({ hasText: 'Quote' }).click();
  await expect(list).toBeHidden();
  await expect(doc).toBeFocused();
  await page.keyboard.type('Quoted');
  await expect(doc.locator('blockquote')).toHaveText('Quoted');

  // One step of undo (the owner's decision of 9 October 2026): the choice
  // alone is undone, and what was typed to ask for it is back as it was
  // typed. Typed and chosen at once, well inside the half second that undo
  // joins into one step.
  await newLastLine(page);
  await page.keyboard.type('/h2');
  await page.keyboard.press('Enter');
  await expect(doc.locator('h2')).toHaveCount(1);
  await page.waitForTimeout(700);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(doc.locator('h2')).toHaveCount(0);
  await expect(doc.locator(':scope > p').filter({ hasText: '/h2' })).toHaveText('/h2');
  await expect(doc.locator('blockquote')).toHaveText('Quoted');
  // An undo is no request.
  await staysClosed('after undo');
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect(doc.locator('h2')).toHaveCount(1);
  await expect(doc.getByText('/h2', { exact: true })).toHaveCount(0);

  // Not in a code block, which is text as it is typed.
  await newLastLine(page);
  await page.keyboard.type('```');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await staysClosed('in a code block');
  await page.keyboard.type('usr /h');
  await staysClosed('in a code block, after a space');
  await expect(doc.locator('pre code')).toHaveText('/usr /h');
  // Not where no block can stand: the caption of a table.
  await newLastLine(page);
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await place(doc.locator('figcaption'));
  await page.keyboard.type('/');
  await staysClosed('in a caption');
  await page.keyboard.type('h /');
  await staysClosed('in a caption, after a space');
  await expect(doc.locator('figcaption')).toHaveText('/h /');

  // An input method that is composing asks for nothing. Chromium's own
  // protocol stands in for one: no input method was run. What it shows is
  // then withdrawn, and a slash that is typed is a request again.
  const method = await page.context().newCDPSession(page);
  await newLastLine(page);
  await method.send('Input.imeSetComposition', { text: '/', selectionStart: 1, selectionEnd: 1 });
  await expect(doc.locator(':scope > p').last()).toHaveText('/');
  await staysClosed('while an input method composes');
  await method.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await method.detach();
  await page.keyboard.type('/h');
  await expect(rows(page)).toHaveCount(4);
  await page.keyboard.press('Escape');

  // NFR-IC-19: at 320 CSS pixels the list is inside the viewport, wherever the slash is on its line.
  await page.setViewportSize({ width: 320, height: 640 });
  await newLastLine(page);
  await page.keyboard.type('A line that runs on to the far edge of it /');
  await expect(rows(page)).toHaveCount(13);
  await expect(list).toBeInViewport({ ratio: 1 });
  const box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');

  // In a short viewport, at the foot of a long document, the list does not cover the line being typed in.
  await page.setViewportSize({ width: 640, height: 360 });
  await newLastLine(page);
  await page.keyboard.type('/');
  await expect(rows(page)).toHaveCount(13);
  const drawn = (await list.locator('xpath=..').boundingBox())!;
  const line = (await doc.locator('.slash-command').boundingBox())!;
  expect(line.y).toBeGreaterThanOrEqual(0);
  expect(line.y + line.height).toBeLessThanOrEqual(360);
  expect(drawn.y).toBeGreaterThanOrEqual(0);
  expect(drawn.y + drawn.height).toBeLessThanOrEqual(360);
  expect(drawn.y >= line.y + line.height || drawn.y + drawn.height <= line.y).toBe(true);
  await page.keyboard.press('Escape');
});

/** The text of the paragraph of the shared document that holds `written` and nothing else. */
function sharedText(shared: Y.Doc, written: string): Y.XmlText {
  const found = shared
    .getXmlFragment('default')
    .toArray()
    .flatMap((block) => (block instanceof Y.XmlElement ? block.toArray() : []))
    .find((each) => each instanceof Y.XmlText && each.toString() === written);
  if (!(found instanceof Y.XmlText))
    throw new Error('the test found no such paragraph in the shared document');
  return found;
}

test('the slash palette stays open through another client’s change elsewhere, and closes when that client rewrites the command', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  const other = await connectAs(page.context(), id);
  const shared = other.provider.document;
  let sent = 0;
  /** Another client writes a paragraph at the head of the document, and this page shows it. */
  const elsewhere = async () => {
    sent += 1;
    shared.getXmlFragment('default').insert(0, [paragraph(`From another client, ${sent}.`)]);
    await expect(doc.locator(':scope > p').first()).toHaveText(`From another client, ${sent}.`);
  };
  try {
    await doc.focus();
    await page.keyboard.type('Above');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/h');
    await page.keyboard.press('ArrowDown');
    await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    const moved = (await rows(page).nth(1).getAttribute('id'))!;

    // The collaboration binding replaces the whole document for every change of another client.
    await elsewhere();
    await elsewhere();
    await expect(rows(page)).toHaveText(['Heading 1/h1', 'Heading 2/h2', 'Heading 3/h3', 'Divider/divider']);
    await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(doc).toHaveAttribute('aria-activedescendant', moved);
    await expect(doc).toBeFocused();
    // And Enter chooses the row the writer moved to.
    await page.keyboard.press('Enter');
    await expect(doc.locator('h2')).toHaveCount(1);
    await expect(doc.getByText('/h', { exact: true })).toHaveCount(0);
    await page.keyboard.type('Chosen');
    await expect(doc.locator('h2')).toHaveText('Chosen');

    // The other client rewrites the command itself: the list goes, and Enter inserts nothing.
    await newLastLine(page);
    await page.keyboard.type('/h');
    await expect(rows(page)).toHaveCount(4);
    sharedText(shared, '/h').insert(2, 'zz');
    await expect(doc.locator(':scope > p').filter({ hasText: '/hzz' })).toHaveCount(1);
    await expect(palette(page)).toBeHidden();
    await expect(page.getByText(NO_BLOCK).first()).toBeHidden();
    await expect(doc).not.toHaveAttribute('aria-controls');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(doc.locator('h1, h3, hr')).toHaveCount(0);
    await expect(doc.locator('h2')).toHaveCount(1);
    // Enter was the text's key: it broke the line at the cursor, and the command is still text.
    await expect(doc.getByText('/h', { exact: true })).toHaveCount(1);
    await expect(doc.getByText('zz', { exact: true })).toHaveCount(1);

    // Closed with Escape, the list stays closed for that slash through another client's change.
    await newLastLine(page);
    await page.keyboard.type('/t');
    await expect(rows(page)).toHaveCount(3);
    await page.keyboard.press('Escape');
    await elsewhere();
    await page.keyboard.type('o');
    await page.waitForTimeout(300);
    await expect(palette(page)).toBeHidden();
    await expect(doc.locator(':scope > p').last()).toHaveText('/to');
  } finally {
    other.close();
  }
});

// The owner's decision of 12 October 2026: the palette opens only when the
// writer themself typed the slash. Before it, the writer's own change to a
// command opened the list, so another client could put a slash before the
// word a writer was typing: the next letter opened the list on a row, and
// Enter put that row's block in place of the word.
test('the slash palette opens only on a slash the writer typed: not on another client’s, a pasted one, one an undo brought back, or one the cursor left', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  const blocks = doc.locator(':scope > p');
  const other = await connectAs(page.context(), id);
  const shared = other.provider.document;
  /** Nothing opens within the time a list takes to. */
  const staysClosed = async (why: string) => {
    await page.waitForTimeout(300);
    await expect(palette(page), why).toBeHidden();
    await expect(page.getByText(NO_BLOCK).first(), why).toBeHidden();
    await expect(doc, why).not.toHaveAttribute('aria-controls');
  };
  try {
    await doc.focus();

    // The writer has typed "cod" of a word. Another client puts a slash before it.
    await page.keyboard.type('cod');
    await expect.poll(() => shared.getXmlFragment('default').toString()).toContain('cod');
    sharedText(shared, 'cod').insert(0, '/');
    await expect(blocks).toHaveText(['/cod']);
    await staysClosed('after another client’s slash');
    // The writer types on: no list. Enter is the text's key, and the word stays.
    await page.keyboard.type('e');
    await expect(blocks).toHaveText(['/code']);
    await staysClosed('after the writer’s next letter');
    await page.keyboard.press('Enter');
    await staysClosed('after Enter');
    await expect(doc.locator('pre')).toHaveCount(0);
    await expect(blocks).toHaveText(['/code', '']);

    // The writer's own slash, which the cursor left: the list went then, and
    // typing in the word does not bring it back. Not when another client has
    // joined the writer's next words to the command either.
    await page.keyboard.type('see /c');
    await expect(rows(page)).toHaveText(['Code block/code', 'Callout/callout', 'Table of contents/toc']);
    await page.keyboard.type(' de mine');
    await staysClosed('past the command');
    for (let press = 0; press < ' de mine'.length; press += 1) await page.keyboard.press('ArrowLeft');
    await staysClosed('back in the command');
    await expect.poll(() => shared.getXmlFragment('default').toString()).toContain('see /c de mine');
    sharedText(shared, 'see /c de mine').delete('see /c'.length, 1);
    await expect(blocks).toHaveText(['/code', 'see /cde mine']);
    await staysClosed('after another client joined the words');
    await page.keyboard.type('o');
    await expect(blocks).toHaveText(['/code', 'see /code mine']);
    await staysClosed('after a letter typed in the joined word');
    await page.keyboard.press('Enter');
    await staysClosed('after Enter in the joined word');
    await expect(doc.locator('pre')).toHaveCount(0);
    await expect(blocks).toHaveText(['/code', 'see /co', 'de mine']);

    // A pasted slash.
    await newLastLine(page);
    await paste(page, '<p>/h</p>');
    await expect(blocks.last()).toHaveText('/h');
    await staysClosed('after a paste');
    await page.keyboard.type('1');
    await expect(blocks.last()).toHaveText('/h1');
    await staysClosed('after a letter typed in what was pasted');

    // A slash that an undo brought back. Each part is a step of undo of its own.
    await newLastLine(page);
    await page.waitForTimeout(700);
    await page.keyboard.type('/q');
    await expect(rows(page)).toHaveText(['Quote/quote']);
    await page.waitForTimeout(700);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(blocks.last()).toHaveText('');
    await page.waitForTimeout(700);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(blocks.last()).toHaveText('/q');
    await staysClosed('after an undo');
    // The undo leaves the cursor before the slash: to the end of the command, which asks for nothing.
    await placeAtEnd(blocks.last());
    await staysClosed('a cursor that arrives after an undo');
    await page.keyboard.type('u');
    await expect(blocks.last()).toHaveText('/qu');
    await staysClosed('after a letter typed in what the undo brought back');
    await page.keyboard.press('Enter');
    await expect(doc.locator('blockquote')).toHaveCount(0);

    // The writer asks again by typing a slash.
    await page.keyboard.type('/q');
    await expect(rows(page)).toHaveText(['Quote/quote']);
    await page.keyboard.press('Enter');
    await expect(doc.locator('blockquote')).toHaveCount(1);
  } finally {
    other.close();
  }
});

// A long run of one character that no line can break at was laid out again,
// whole, at every key: with kerning on, the cost grew with the square of its
// length, about 430 ms a key at 32,000 characters. The design package turns
// kerning off on the document surface from 0.28.1 (`font-kerning: none` on
// `.ekd-editor`), and a key then costs a few milliseconds. This fails if the
// cost comes back, from the package or from a style of the application's.
test('a key typed at the end of a paragraph of 32,000 asterisks is answered at once', async ({ page }) => {
  test.slow();
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  const other = await connectAs(page.context(), id);
  try {
    other.provider.document.getXmlFragment('default').insert(0, [paragraph('*'.repeat(32_000))]);
    await expect(doc.locator(':scope > p')).toHaveText(/^\*{32000}$/);
  } finally {
    other.close();
  }
  await placeAtEnd(doc.locator(':scope > p'));
  // From the key going down to the second frame after it came up: the key,
  // the change to the document, and the layout and the paint that follow.
  const times: number[] = [];
  for (const key of 'abcde') {
    const timed = page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let down = 0;
          document.addEventListener('keydown', () => (down = performance.now()), {
            once: true,
            capture: true,
          });
          document.addEventListener(
            'keyup',
            () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - down))),
            { once: true, capture: true },
          );
        }),
    );
    await page.keyboard.press(key);
    times.push(Math.round(await timed));
  }
  await expect(doc.locator(':scope > p')).toHaveText(/^\*{32000}abcde$/);
  test.info().annotations.push({ type: 'milliseconds for each key', description: times.join(', ') });
  console.log(`a key at the end of 32,000 asterisks: ${times.join(', ')} ms`);
  // The middle one of five, so that one slow frame of a busy machine fails nothing.
  expect(times.toSorted((a, b) => a - b)[2]).toBeLessThan(150);
});

test('the slash palette: Tab, the cursor inside the command and out of it, and one undo of a Markdown conversion', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  const list = palette(page);
  const closed = async (why: string) => {
    await expect(list, why).toBeHidden();
    await expect(doc, why).not.toHaveAttribute('aria-controls');
  };
  /** Where the focus is: in the text, in the list, or the element that has it. */
  const focus = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return 'nothing';
      if (active.closest('[role="listbox"]')) return 'the list';
      if (active.closest('[role="textbox"]')) return 'the text';
      // The words of a control may change (the sync status): its place among its kind does not.
      return `${active.tagName} ${[...document.querySelectorAll(active.tagName)].indexOf(active)}`;
    });
  // Every element the focus comes to, from here on.
  await page.evaluate(() => {
    const seen = window as unknown as { inList: boolean };
    seen.inList = false;
    document.addEventListener('focusin', (event) => {
      if ((event.target as Element).closest('[role="listbox"]')) seen.inList = true;
    });
  });
  await doc.focus();

  // Where Tab and Shift+Tab take the focus from the text with no list open.
  await page.keyboard.press('Tab');
  const next = await focus();
  await page.keyboard.press('Shift+Tab');
  expect(await focus()).toBe('the text');
  await page.keyboard.press('Shift+Tab');
  const previous = await focus();
  await page.keyboard.press('Tab');
  expect(await focus()).toBe('the text');
  expect(previous).not.toBe('nothing');

  // Tab, with the whole list open: thirteen rows, so the list scrolls, and a
  // scroller is a stop of Tab in Chromium. The list closes before the browser
  // looks for the next stop: the focus goes where it goes with no list, comes
  // back to the text, and is never in the list.
  await page.keyboard.type('/');
  await expect(rows(page)).toHaveCount(13);
  await page.keyboard.press('Tab');
  await closed('after Tab');
  expect(await focus()).toBe(next);
  await page.keyboard.press('Shift+Tab');
  expect(await focus()).toBe('the text');
  await expect(doc).toBeFocused();
  await expect(doc).toHaveText('/');
  // And Shift+Tab, back and forth.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('/');
  await expect(rows(page)).toHaveCount(13);
  await page.keyboard.press('Shift+Tab');
  await closed('after Shift+Tab');
  expect(await focus()).toBe(previous);
  await page.keyboard.press('Tab');
  await expect(doc).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { inList: boolean }).inList)).toBe(false);
  // In a list item Tab is the text's key and indents: the list closes there too.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two /');
  await expect(rows(page)).toHaveCount(13);
  await page.keyboard.press('Tab');
  await closed('after Tab in a list item');
  await expect(doc).toBeFocused();
  await expect(doc.locator('ul ul > li')).toHaveText('two /');

  // The command is the whole word the slash begins: with the cursor inside
  // it, the filter is still what stands on the page, and a choice replaces all of it.
  await newLastLine(page);
  await page.keyboard.type('a /he');
  await expect(rows(page)).toHaveText(['Heading 1/h1', 'Heading 2/h2', 'Heading 3/h3']);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  await expect(rows(page)).toHaveText(['Heading 1/h1', 'Heading 2/h2', 'Heading 3/h3']);
  await expect(doc).toHaveAttribute('aria-controls', LIST_ID);
  await page.keyboard.press('Enter');
  await expect(doc.locator('h1')).toHaveCount(1);
  await expect(doc.locator(':scope > p').filter({ hasText: /^a $/ })).toHaveCount(1);
  // Nothing of the command is left: no "e" in a paragraph of its own.
  await expect(doc.getByText('e', { exact: true })).toHaveCount(0);
  await expect(doc.getByText('/he')).toHaveCount(0);

  // The cursor leaves the command: before the slash, by Home, or as a range. The list goes.
  for (const [leave, how] of [
    [['ArrowLeft', 'ArrowLeft', 'ArrowLeft'], 'Left, to before the slash'],
    [['Home'], 'Home'],
    [['Shift+ArrowLeft'], 'a range'],
  ] as const) {
    await newLastLine(page);
    await page.keyboard.type('b /q');
    await expect(rows(page), how).toHaveText(['Quote/quote']);
    for (const each of leave) await page.keyboard.press(each);
    await closed(how);
    await expect(doc.locator(':scope > p').last(), how).toHaveText('b /q');
    await expect(doc, how).toBeFocused();
    // Enter is then the text's, and inserts no block.
    await expect(doc.locator('blockquote'), how).toHaveCount(0);
  }

  // FR-ED-14 and FR-ED-16: one undo after a Markdown conversion takes back
  // the conversion alone, and leaves what was typed as it was typed.
  await newLastLine(page);
  await page.waitForTimeout(700);
  await page.keyboard.type('## ');
  await expect(doc.locator('h2')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(doc.locator('h2')).toHaveCount(0);
  expect(
    await doc
      .locator(':scope > p')
      .last()
      .evaluate((element) => element.textContent),
  ).toBe('## ');
});

test('the slash palette does not open in the read-only state, and one that is open closes', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  await doc.focus();
  await page.keyboard.type('/h');
  await expect(rows(page)).toHaveCount(4);
  await expect(status(page, 'In sync')).toBeVisible();

  await stopCollab();
  try {
    // FR-ED-18: read-only in the error state. The list goes with the editing.
    await expect(status(page, /^Not connected\./)).toBeVisible({ timeout: 15_000 });
    await expect.soft(palette(page)).toBeHidden();
    await expect.soft(doc).not.toHaveAttribute('aria-controls');
    await expect.soft(doc).toBeFocused();
    // No key of the palette, and no slash, does anything.
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('1 /');
    await page.waitForTimeout(300);
    await expect.soft(palette(page)).toBeHidden();
    await expect.soft(doc.locator(FORMATTED)).toHaveCount(0);
    await expect.soft(doc).toHaveText('/h');
  } finally {
    await startCollab();
  }

  // The connection returns, and so does the palette, on a new slash.
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 60_000 });
  await placeAtEnd(doc.locator('p'));
  await page.keyboard.type(' /h1');
  await expect(rows(page)).toHaveText(['Heading 1/h1']);
  await page.keyboard.press('Enter');
  await expect(doc.locator('h1')).toHaveCount(1);
  await expect(doc.locator('p').first()).toHaveText('/h ');
});

test('an account without a role on a document reaches neither its page nor its connection', async ({
  page,
  browser,
}) => {
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Nothing of this is for another account.');
  await expect(status(page, 'In sync')).toBeVisible();

  const second = await browser.newContext();
  const other = await second.newPage();
  await enter(other);
  // The page: the answer for a document of another account is the answer for
  // one that does not exist (the owner's answer to Q8 of the plan).
  for (const address of [`/documents/${id}`, `/documents/${randomUUID()}`, '/documents/not-an-identifier']) {
    const response = await other.goto(address);
    expect(response!.status(), address).toBe(404);
    await expect(other.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await expect(other).toHaveTitle('Page not found – Ekdotico');
    await expect(text(other)).toHaveCount(0);
    expect(await other.content()).not.toContain('Nothing of this is for another account.');
  }
  // The connection (FR-AU-08, FR-ED-39): refused, and nothing of the document sent.
  await expect(connectAs(second, id)).rejects.toThrow('no-access');
  const own = await connectAs(page.context(), id);
  expect(own.provider.document.getXmlFragment('default').toString()).toContain(
    'Nothing of this is for another',
  );
  own.close();
  await second.close();

  // Without a session the address is the sign-in page (FR-AU-07).
  const third = await browser.newContext();
  const visitor = await third.newPage();
  await visitor.goto(`/documents/${id}`);
  await expect(visitor).toHaveURL(/\/sign-in\?/);
  await expect(connectAs(third, id)).rejects.toThrow('handshake refused');
  await third.close();
});

test('hostile content, pasted or sent by another client, stays inert', async ({ page }) => {
  page.on('dialog', () => {
    throw new Error('a dialog was opened by content');
  });
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await paste(
    page,
    `<p>pasted <script>window.__pwned = 1</script><img src="x" onerror="window.__pwned = 2">
       <a href="javascript:window.__pwned = 3">script link</a>
       <a href="data:text/html,<script>window.__pwned = 4</script>">data link</a>
       <a href=" JaVaScRiPt:window.__pwned = 5">cased link</a>
       <iframe src="javascript:window.__pwned = 6"></iframe>
       <span onclick="window.__pwned = 7" style="position: fixed; inset: 0">span</span>
       <svg onload="window.__pwned = 8"></svg><object data="x"></object></p>
     <aside class="callout" data-type='"><img src=x onerror="window.__pwned = 9">'><p>pasted callout</p></aside>
     <pre><code class='language-"><img src=x onerror="window.__pwned = 10">'>pasted code</code></pre>`,
  );
  await expect(text(page)).toContainText('pasted callout');

  // Another client, which is no editor and writes what it likes into the document.
  const hostile = await connectAs(page.context(), id);
  hostile.provider.document.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    const words = new Y.XmlText();
    words.insert(0, 'sent link', {
      link: {
        href: 'javascript:window.__pwned = 11',
        target: '_self',
        rel: 'opener',
        class: 'sent',
        onclick: 'window.__pwned = 12',
      },
    });
    words.insert('sent link'.length, ' <img src=x onerror="window.__pwned = 13">', { link: null });
    paragraph.insert(0, [words]);
    const script = new Y.XmlElement('script');
    script.insert(0, [new Y.XmlText('window.__pwned = 14')]);
    const image = new Y.XmlElement('image');
    image.setAttribute('src', 'x');
    image.setAttribute('onerror', 'window.__pwned = 15');
    const callout = new Y.XmlElement('callout');
    callout.setAttribute('type', '"><img src=x onerror="window.__pwned = 16">');
    callout.setAttribute('onmouseover', 'window.__pwned = 17');
    const inside = new Y.XmlElement('paragraph');
    inside.insert(0, [new Y.XmlText('sent callout')]);
    callout.insert(0, [inside]);
    const code = new Y.XmlElement('codeBlock');
    code.setAttribute('language', '"><script>window.__pwned = 18</script>');
    code.insert(0, [new Y.XmlText('sent code')]);
    const contents = new Y.XmlElement('tableOfContents');
    contents.setAttribute('depth', '<img src=x onerror="window.__pwned = 19">');
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', '1"><script>window.__pwned = 20</script>');
    heading.insert(0, [new Y.XmlText('<img src=x onerror="window.__pwned = 21"> sent heading')]);
    hostile.provider.document
      .getXmlFragment('default')
      .push([paragraph, script, image, callout, code, contents, heading]);
  });
  await expect(text(page)).toContainText('sent callout');
  await expect(text(page)).toContainText('sent heading');
  hostile.close();

  // Markup that arrived as text is shown as text.
  await expect(text(page)).toContainText('<img src=x onerror="window.__pwned = 13">');
  await text(page).getByText('sent link').click();
  await text(page).getByText('script link').click();

  const found = await text(page).evaluate((root) => {
    const elements = [...root.querySelectorAll('*')];
    return {
      pwned: (window as unknown as { __pwned?: number }).__pwned ?? null,
      // No element that loads or runs anything.
      active: elements.filter((each) => /^(script|img|iframe|object|embed|style|link)$/i.test(each.tagName))
        .length,
      // No handler, on any element.
      handlers: elements.flatMap((each) => each.getAttributeNames().filter((name) => name.startsWith('on'))),
      // The links of the text. The table of contents lists the heading that was sent, which is a level 1 now.
      links: [...root.querySelectorAll('a:not(.ekd-toc a)')].map((each) => ({
        words: each.textContent,
        href: each.getAttribute('href'),
        target: each.getAttribute('target'),
        rel: each.getAttribute('rel'),
        class: each.getAttribute('class'),
      })),
      callouts: [...root.querySelectorAll('.callout')].map((each) => each.getAttribute('data-type')),
    };
  });
  expect(found.pwned).toBeNull();
  expect(found.active).toBe(0);
  expect(found.handlers).toEqual([]);
  // The pasted addresses made no link at all; the one that was sent is drawn with no address.
  expect(found.links).toEqual([
    { words: 'sent link', href: '', target: '_blank', rel: 'noopener noreferrer nofollow', class: null },
  ]);
  expect(found.callouts).toEqual(['note', 'note']);
  const languages = text(page).getByRole('combobox', { name: 'Code language' });
  await expect(languages).toHaveCount(2);
  await expect(languages.first()).toHaveValue('plaintext');
  await expect(languages.last()).toHaveValue('plaintext');
});

// What a client that is no editor puts into a document: an element, with attributes of any type.
const element = (
  name: string,
  attributes: Record<string, unknown> = {},
  children: (Y.XmlElement | Y.XmlText)[] = [],
) => {
  const made = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) made.setAttribute(key, value as string);
  if (children.length > 0) made.insert(0, children);
  return made;
};
const words = (written: string, marks?: Record<string, unknown>) => {
  const made = new Y.XmlText();
  made.insert(0, written, marks);
  return made;
};
const paragraph = (written: string, marks?: Record<string, unknown>) =>
  element('paragraph', {}, [words(written, marks)]);
const tableOf = (rows: Y.XmlElement[], caption: string) =>
  element('tableBlock', {}, [element('table', {}, rows), element('tableCaption', {}, [words(caption)])]);
const cellWith = (attributes: Record<string, unknown>, written: string) =>
  element('tableCell', attributes, [paragraph(written)]);

test('an attribute outside its rule, sent by another client or pasted, becomes the default, and the document still opens', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(message.text());
  });
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  await paste(
    page,
    `<table><tbody><tr><td colspan="300000" rowspan="70000" colwidth="50,x,9999999" align="middle">pasted cell</td></tr></tbody></table>
     <ol start="4000000" type="z"><li><p>pasted item</p></li></ol>
     <pre><code class="language-html">pasted code</code></pre>
     <p><a href="&#xfeff;https://a/../../../../api/health?x">pasted address</a> and <a href="https://example.com/ok">pasted link</a></p>`,
  );
  await expect(text(page)).toContainText('pasted link');
  await expect(status(page, 'In sync')).toBeVisible();

  const hostile = await connectAs(page.context(), id);
  hostile.provider.document.transact(() => {
    hostile.provider.document.getXmlFragment('default').push([
      // Finding 1 of the review of pull request 20: a language that is no text.
      element('codeBlock', { language: 5 }, [words('code five')]),
      element('codeBlock', { language: { toLowerCase: 1 } }, [words('code object')]),
      element('codeBlock', { language: ['typescript'] }, [words('code list')]),
      // An alias of the highlighter, and a name it would guess a grammar for.
      element('codeBlock', { language: 'html' }, [words('<b>code alias</b>')]),
      element('codeBlock', { language: 'no-such-language' }, [words('code unknown')]),
      // Finding 2: a cell that spans more columns than a page can make.
      tableOf([element('tableRow', {}, [cellWith({ colspan: 20000000 }, 'wide cell')])], 'wide'),
      tableOf(
        [
          element('tableRow', {}, [
            cellWith({ rowspan: 300000, colwidth: [1e9] }, 'tall cell'),
            cellWith(
              { colspan: -3, rowspan: 1.5, colwidth: 'x', align: 'left;background:url(/api/health)' },
              'odd',
            ),
            element('tableHeader', { colspan: '2" onx="1', rowspan: { a: 1 }, colwidth: { a: 1 } }, [
              paragraph('head'),
            ]),
          ]),
        ],
        'tall',
      ),
      // The largest table the schema takes: it is laid out, and the page answers.
      tableOf(
        Array.from({ length: 100 }, (_, row) =>
          element(
            'tableRow',
            {},
            Array.from({ length: 100 }, (_, column) => cellWith({}, row + column === 198 ? 'last cell' : '')),
          ),
        ),
        'large',
      ),
      element('orderedList', { start: 1e9, type: 'z" style="position:fixed' }, [
        element('listItem', {}, [paragraph('sent item')]),
      ]),
      element('orderedList', { start: '7" onmouseover="x', type: { a: 1 } }, [
        element('listItem', {}, [paragraph('sent item two')]),
      ]),
      element('heading', { level: 9 }, [words('level nine')]),
      element('heading', { level: { a: 1 } }, [words('level object')]),
      element('tableOfContents', { depth: { a: 1 } }),
      element('tableOfContents', { depth: 99 }),
      // Finding 3: white space that the language trims and a browser does not.
      paragraph('space address', { link: { href: '﻿https://a/../../../../api/health?x' } }),
      paragraph('line address', { link: { href: ' https://a/../../../../?x' } }),
      paragraph('list address', { link: { href: ['https://example.com/list'] } }),
      paragraph('object address', { link: { href: { a: 1 } } }),
      paragraph('The end.'),
    ]);
  });
  hostile.close();

  // What the page holds: every attribute a default or a value of its rule.
  const held = async () => {
    await expect(text(page)).toContainText('The end.', { timeout: 30_000 });
    await expect(text(page)).toContainText('last cell');
    for (const written of [
      'Written before.',
      'code five',
      'code object',
      'code list',
      'wide cell',
      'tall cell',
    ]) {
      await expect(text(page), written).toContainText(written);
    }
    // Finding 1: the selector and the highlighter read one value, and no grammar is guessed.
    const languages = text(page).getByRole('combobox', { name: 'Code language' });
    await expect(languages).toHaveCount(6);
    for (const each of await languages.all()) await expect(each).toHaveValue('plaintext');
    await expect(text(page).locator('pre code:not(.language-plaintext)')).toHaveCount(0);
    await expect(text(page).locator('pre [class*="hljs-"]')).toHaveCount(0);
    await expect(text(page).locator('pre', { hasText: 'code alias' })).toHaveText(/<b>code alias<\/b>/);

    const found = await text(page).evaluate((root) => {
      const cells = [...root.querySelectorAll<HTMLTableCellElement>('td, th')];
      return {
        spans: Math.max(...cells.flatMap((cell) => [cell.colSpan, cell.rowSpan])),
        spanAttributes: [
          ...new Set(
            cells
              .flatMap((cell) => [cell.getAttribute('colspan'), cell.getAttribute('rowspan')])
              .filter(Boolean),
          ),
        ],
        columns: root.querySelectorAll('col').length,
        // Finding 2 and the policy of the page: the only inline styles are the widths of a table.
        styles: [
          ...new Set(
            [...root.querySelectorAll('[style]')].map(
              (each) => `${each.tagName.toLowerCase()} ${each.getAttribute('style')}`,
            ),
          ),
        ],
        lists: [...root.querySelectorAll('ol:not(.ekd-toc-list)')].map((list) => ({
          start: list.getAttribute('start'),
          type: list.getAttribute('type'),
        })),
        headings: [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(
          (heading) => `${heading.tagName.toLowerCase()} ${heading.textContent}`,
        ),
        depths: [...root.querySelectorAll('.ekd-toc input:checked')].map(
          (input) => (input as HTMLInputElement).value,
        ),
        links: [...root.querySelectorAll('a:not(.ekd-toc a)')].map((link) => ({
          words: link.textContent,
          href: link.getAttribute('href'),
          // Where a press would go: never an address of this application.
          goes: new URL((link as HTMLAnchorElement).href).pathname.startsWith('/api'),
        })),
        handlers: [...root.querySelectorAll('*')].flatMap((each) =>
          each.getAttributeNames().filter((name) => name.startsWith('on')),
        ),
      };
    });
    expect(found.spans).toBe(1);
    expect(found.spanAttributes).toEqual([]);
    // One for each column of each table: 1 pasted, 1 wide, 3 tall, 100 large.
    expect(found.columns).toBe(105);
    // …and what the library writes on the element of a block that has controls.
    const written = /^((col|table) (min-)?width: \d{1,4}px;|[a-z]+ white-space: [a-z-]+;)$/;
    for (const style of found.styles) expect(style).toMatch(written);
    expect(found.lists).toEqual([
      { start: null, type: null },
      { start: null, type: null },
      { start: null, type: null },
    ]);
    expect(found.headings).toEqual(['h1 level nine', 'h1 level object']);
    expect(found.depths).toEqual(['3', '3']);
    expect(found.links).toEqual([
      { words: 'pasted link', href: 'https://example.com/ok', goes: false },
      { words: 'space address', href: '', goes: false },
      { words: 'line address', href: '', goes: false },
      { words: 'list address', href: '', goes: false },
      { words: 'object address', href: '', goes: false },
    ]);
    expect(found.handlers).toEqual([]);
  };
  await held();

  // The document is still one that can be written in…
  await placeAtEnd(text(page).getByText('The end.'));
  await page.keyboard.type(' Written after.');
  await expect(text(page)).toContainText('The end. Written after.');
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  // …and one that opens: for this member, and for every other.
  await page.reload();
  await held();
  await expect(text(page)).toContainText('The end. Written after.');
  await expect(status(page, 'In sync')).toBeVisible();
  expect(faults).toEqual([]);
});

// The second review of pull request 20, finding C. Before it, each of these
// tables was deleted whole, for everyone, by the first client that opened it.
test('a table past the bound of the schema is laid out with the bound, and the page answers', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  await expect(status(page, 'In sync')).toBeVisible();
  const hostile = await connectAs(page.context(), id);
  hostile.provider.document.transact(() => {
    hostile.provider.document.getXmlFragment('default').push([
      tableOf(
        Array.from({ length: 101 }, () => element('tableRow', {}, [cellWith({}, 'row')])),
        'too many rows',
      ),
      tableOf(
        [
          element(
            'tableRow',
            {},
            Array.from({ length: 101 }, () => cellWith({}, 'cell')),
          ),
        ],
        'too many cells',
      ),
      paragraph('The end.'),
    ]);
  });
  const held = async () => {
    await expect(text(page)).toContainText('The end.');
    await expect(text(page).locator('table')).toHaveCount(2);
    await expect(text(page).locator('table').first().locator('tr')).toHaveCount(100);
    await expect(text(page).locator('table').last().locator('td')).toHaveCount(100);
    await expect(text(page)).toContainText('too many rows');
    await expect(text(page)).toContainText('too many cells');
  };
  await held();
  // The shared document holds what the page does: the row and the cell past the bound, and nothing else, are gone.
  const tables = () =>
    hostile.provider.document
      .getXmlFragment('default')
      .toArray()
      .filter((each) => (each as Y.XmlElement).nodeName === 'tableBlock')
      .map((each) => (each as Y.XmlElement).get(0) as Y.XmlElement);
  await expect.poll(() => tables().map((table) => table.length)).toEqual([100, 1]);
  expect((tables()[1]!.get(0) as Y.XmlElement).length).toBe(100);
  hostile.close();
  await placeAtEnd(text(page).getByText('The end.'));
  await page.keyboard.type(' Written after.');
  await expect(text(page)).toContainText('The end. Written after.');
  await expect(status(page, 'In sync')).toBeVisible();
  await page.reload();
  await expect(text(page)).toContainText('The end. Written after.');
  await held();
});

// Finding A of the second review: every rule of a cell held, and the grid the
// cells made together was ten thousand columns wide. The tab that opened the
// document stopped answering.
test('a table whose cells together span more than the bound opens at once, each cell one square', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  await expect(status(page, 'In sync')).toBeVisible();
  const hostile = await connectAs(page.context(), id);
  hostile.provider.document.transact(() => {
    hostile.provider.document.getXmlFragment('default').push([
      tableOf(
        Array.from({ length: 100 }, (_, row) =>
          element(
            'tableRow',
            {},
            Array.from({ length: 100 }, (_, column) =>
              cellWith({ colspan: 100, rowspan: 100 }, row + column === 198 ? 'last cell' : ''),
            ),
          ),
        ),
        'every cell a hundred each way',
      ),
      // A cell that reaches below the last row, in a table that is otherwise as a member made it.
      tableOf(
        [
          element('tableRow', {}, [cellWith({ colspan: 2 }, 'merged'), cellWith({ rowspan: 9 }, 'too tall')]),
          element('tableRow', {}, [cellWith({}, 'a'), cellWith({}, 'b'), cellWith({}, 'c')]),
        ],
        'one cell too tall',
      ),
      paragraph('The end.'),
    ]);
  });
  hostile.close();

  const opened = async () => {
    const started = Date.now();
    await expect(text(page)).toContainText('The end.', { timeout: 20_000 });
    await expect(text(page)).toContainText('last cell');
    const spans = await text(page).evaluate((root) =>
      [...root.querySelectorAll('table')].map((table) => [
        ...new Set(
          [...table.querySelectorAll<HTMLTableCellElement>('td, th')].map(
            (cell) => `${cell.colSpan}x${cell.rowSpan}`,
          ),
        ),
      ]),
    );
    expect(spans).toEqual([['1x1'], ['2x1', '1x1']]);
    await expect(text(page).locator('table').first().locator('td')).toHaveCount(10_000);
    // The page answers: a key is taken and shown.
    await placeAtEnd(text(page).getByText('The end.'));
    await page.keyboard.type('Z');
    await expect(text(page)).toContainText('The end.Z');
    await page.keyboard.press('Backspace');
    await expect(text(page)).not.toContainText('The end.Z');
    return Date.now() - started;
  };
  // The reviewer's page did not answer in two minutes.
  expect(await opened()).toBeLessThan(20_000);
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  expect(await opened()).toBeLessThan(20_000);
  expect(faults).toEqual([]);
});

// Finding C: one paragraph under a member's table, sent by another client,
// and the table was deleted for everyone, past any undo.
test('what another client puts where it cannot stand is taken out alone: the table it was put in stays, through undo too', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  const hostile = await connectAs(page.context(), id);
  const fragment = hostile.provider.document.getXmlFragment('default');
  fragment.push([
    tableOf(
      [
        element('tableRow', {}, [cellWith({}, 'one'), cellWith({}, 'two')]),
        element('tableRow', {}, [cellWith({}, 'three'), cellWith({}, 'four')]),
      ],
      'theirs',
    ),
    paragraph('after'),
  ]);
  await expect(text(page).locator('table')).toHaveCount(1);
  // The member writes in the table.
  await placeAtEnd(text(page).getByText('four'));
  await page.keyboard.type(' KEEP-THIS');
  await expect(text(page)).toContainText('four KEEP-THIS');
  await expect(status(page, 'In sync')).toBeVisible();
  const block = () =>
    fragment.toArray().find((each) => (each as Y.XmlElement).nodeName === 'tableBlock') as Y.XmlElement;
  await expect.poll(() => fragment.toString()).toContain('KEEP-THIS');

  const table = block().get(0) as Y.XmlElement;
  hostile.provider.document.transact(() => {
    table.insert(table.length, [paragraph('not a row')]);
    table.insert(0, [element('noSuchNode', {}, [words('nothing')])]);
  });
  // What could not stand there is gone from the shared document, and nothing else is.
  await expect
    .poll(() => table.toArray().map((each) => (each as Y.XmlElement).nodeName))
    .toEqual(['tableRow', 'tableRow']);
  await expect(text(page).locator('table')).toHaveCount(1);
  await expect(text(page)).toContainText('four KEEP-THIS');
  await expect(text(page)).not.toContainText('not a row');
  expect(fragment.toString()).toContain('KEEP-THIS');

  // Undo is the member's own: it takes back what the member typed, and never the table.
  await placeAtEnd(text(page).getByText('after'));
  await page.keyboard.type(' typed');
  await expect(text(page)).toContainText('after typed');
  for (let presses = 0; presses < 4; presses += 1) await page.keyboard.press('ControlOrMeta+z');
  await expect(text(page)).not.toContainText('typed');
  await expect(text(page).locator('table')).toHaveCount(1);
  await expect(text(page)).toContainText('three');
  expect(block()).toBeDefined();
  expect((block().get(0) as Y.XmlElement).length).toBe(2);
  hostile.close();
  await page.reload();
  await expect(text(page).locator('table')).toHaveCount(1);
  await expect(text(page)).toContainText('three');
});

// Finding B, in the browser's half. The collaboration server refuses such a
// document now (src/lib/collab/state.ts), so this one is as a document stored
// before there was a limit: written into its row.
test('a document the browser cannot build is said to be so, and the page stays', async ({ page }) => {
  test.setTimeout(90_000);
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  await expect(status(page, 'In sync')).toBeVisible();
  // Left, so that the collaboration server stores it and lets go of it.
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await page.waitForTimeout(3500);
  storeNested(id, 10_000);

  await page.goto(`/documents/${id}`);
  const statement = page.getByRole('alert').filter({ hasText: 'This document could not be shown' });
  await expect(statement).toBeVisible({ timeout: 30_000 });
  await expect(statement).toHaveText(
    'This document could not be shownEkdotico could not build the content of the document in this browser, so the document is closed in this tab. Nothing in the document was changed. Open the list of documents.',
  );
  await expect(statement).toBeFocused();
  // The page is the document's own still, and not the page of a fault on the server.
  await expect(page.getByRole('heading', { level: 1, name: 'Untitled document' })).toBeVisible();
  await expect(page.getByText(MARK)).toBeVisible();
  await expect(page.getByText('fault on the server')).toHaveCount(0);
  await expect(text(page)).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  expect(faults).toEqual([]);
  // Nothing was written to it: another client still receives all ten thousand levels.
  const other = await connectAs(page.context(), id);
  let depth = 0;
  for (
    let each = other.provider.document.getXmlFragment('default').get(0);
    each instanceof Y.XmlElement;
    each = each.get(0)
  ) {
    depth += 1;
  }
  expect(depth).toBe(10_000);
  other.close();
  await statement.getByRole('link', { name: 'Open the list of documents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
});

test('“in sync” is said only after the server has acknowledged, and a check whose dialog was closed does not open it again', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Between the page and the collaboration server: from a moment the test
  // chooses, nothing the server sends arrives, its acknowledgements among it.
  let withheld = false;
  await page.routeWebSocket(/\/collab$/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!withheld) socket.send(message);
    });
  });
  await enter(page);
  await openNew(page);
  await text(page).click();
  await page.keyboard.type('Acknowledged.');
  await expect(status(page, 'In sync')).toBeVisible();

  withheld = true;
  await page.keyboard.type(' Not acknowledged.');
  // FR-ED-18, FR-ED-23: not "In sync" while the server has not said so.
  const syncing = status(page, /^Syncing\. Changes that are not yet sent are lost if this tab is closed\.$/);
  await expect(syncing).toBeVisible();
  await expect(status(page, 'In sync')).toHaveCount(0);

  // The check is asked for, and its dialog closed before the answer.
  await syncing.click();
  const dialog = page.getByRole('dialog', { name: 'Sync status' });
  await expect(dialog).toContainText('Checking the working version against the server');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(syncing).toBeFocused();
  // The answer comes after 5 seconds: it opens nothing, and takes no focus.
  await page.waitForTimeout(7000);
  await expect(dialog).toBeHidden();
  await expect(syncing).toBeFocused();

  // FR-ED-24: asked again and waited for, the check does not confirm, and never says "in sync".
  await syncing.click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Ekdotico could not confirm that the working version matches the server',
    { timeout: 10_000 },
  );
  await expect(dialog).not.toContainText(IN_SYNC_MESSAGE);
  await expect(status(page, 'In sync')).toHaveCount(0);
});

// The owner's decision of 9 October 2026. The words, written out here and not taken from the code under test.
const TEXT_NOT_COPIED =
  'The text could not be copied. The browser may have refused access to the clipboard. Close this dialog, select the text in the document, and copy it with the keyboard before reloading.';
const CODE_NOT_COPIED =
  'The code could not be copied. The browser may have refused access to the clipboard. Select the code and copy it with the keyboard.';

test('a clipboard that the browser refuses, or does not offer, is said in words, and never as a copy', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The clipboard as the test says it is: the browser's own, one that refuses, or none.
  await page.addInitScript(() => {
    const own = navigator.clipboard;
    const write = own.writeText.bind(own);
    const state = { is: 'allowed' };
    (window as unknown as { __clipboard: typeof state }).__clipboard = state;
    own.writeText = (written) =>
      state.is === 'refused'
        ? Promise.reject(new DOMException('Denied.', 'NotAllowedError'))
        : write(written);
    Object.defineProperty(navigator, 'clipboard', { get: () => (state.is === 'absent' ? undefined : own) });
  });
  const clipboard = (is: 'allowed' | 'refused' | 'absent') =>
    page.evaluate((now) => {
      (window as unknown as { __clipboard: { is: string } }).__clipboard.is = now;
    }, is);
  let withheld = false;
  await page.routeWebSocket(/\/collab$/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (!withheld) socket.send(message);
    });
  });
  await enter(page);
  await openNew(page);
  await text(page).click();
  await paste(page, '<pre><code>some code</code></pre><p>Some words.</p>');
  await expect(status(page, 'In sync')).toBeVisible();

  // The code block (FR-ED-03).
  const block = text(page).locator('.ekd-code');
  const said = block.getByRole('status');
  for (const is of ['refused', 'absent'] as const) {
    await clipboard(is);
    await block.getByRole('button', { name: 'Copy' }).click();
    await expect(said, is).toHaveText(CODE_NOT_COPIED);
    // Seen as well as heard, and the button does not say what did not happen.
    await expect(said, is).toBeVisible();
    await expect(said, is).not.toHaveClass(/sr-only/);
    await expect(block.getByRole('button', { name: 'Copied' }), is).toHaveCount(0);
    await clipboard('allowed');
    await block.getByRole('button', { name: 'Copy' }).click();
    // A copy that worked replaces the statement.
    await expect(block.getByRole('button', { name: 'Copied' }), is).toBeVisible();
    await expect(said, is).toHaveText('Code copied');
    await expect(said, is).toHaveClass(/sr-only/);
    expect(await clipboardText(page)).toBe('some code');
    await expect(block.getByRole('button', { name: 'Copy', exact: true }), is).toBeVisible();
  }

  // The dialog that has just said "Copy the text to keep it, then reload the document from the server" (FR-ED-24).
  withheld = true;
  await placeAtEnd(text(page).getByText('Some words.'));
  await page.keyboard.type(' Not sent.');
  await status(page, /^Syncing\./).click();
  const dialog = page.getByRole('dialog', { name: 'Sync status' });
  await expect(dialog.getByRole('alert')).toContainText('Copy the text to keep it', { timeout: 10_000 });
  const copy = dialog.getByRole('button', { name: 'Copy text' });
  const line = dialog.getByRole('status');
  await expect(line).toHaveText('');
  for (const is of ['refused', 'absent'] as const) {
    await clipboard(is);
    await copy.click();
    await expect(line, is).toHaveText(TEXT_NOT_COPIED);
    await expect(line, is).toBeVisible();
    await expect(dialog, is).not.toContainText('Text copied.');
    // Said politely: the focus is where the press left it.
    await expect(copy, is).toBeFocused();
    await clipboard('allowed');
    await copy.click();
    await expect(line, is).toHaveText('Text copied.');
    await expect(dialog, is).not.toContainText('could not be copied');
    expect(await clipboardText(page)).toBe('some code\n\nSome words. Not sent.');
  }
  expect(faults).toEqual([]);
});

test('the dialog of a link that is open when the connection is lost changes nothing, and the text keeps the focus', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  await text(page).click();
  await page.keyboard.type('Link me.');
  await expect(status(page, 'In sync')).toBeVisible();
  await text(page).getByText('Link me.').click({ clickCount: 3 });
  await toolbar(page).getByRole('button', { name: 'Link' }).click();
  const link = page.getByRole('dialog', { name: 'Link' });
  await link.getByLabel('Link address').fill('https://example.org/late');

  await stopCollab();
  try {
    // FR-ED-18: read-only in the error state. The dialog goes with the editing…
    await expect(status(page, /^Not connected\./)).toBeVisible({ timeout: 15_000 });
    await expect(text(page)).toHaveAttribute('aria-readonly', 'true');
    await expect(link).toBeHidden();
    await expect(toolbar(page)).toHaveCount(0);
    // …the focus is in the text, and not nowhere…
    await expect(text(page)).toBeFocused();
    // …and the document is as it was.
    await expect(text(page).locator('a')).toHaveCount(0);
    await expect(text(page)).toHaveText('Link me.');
  } finally {
    await startCollab();
  }
  // The connection returns, and the dialog does not.
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 60_000 });
  await expect(link).toBeHidden();
  await expect(text(page).locator('a')).toHaveCount(0);
  await page.reload();
  await expect(text(page)).toHaveText('Link me.');
  await expect(text(page).locator('a')).toHaveCount(0);
});

test('a page that is left while its connection is being restored opens no socket afterwards', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  await text(page).click();
  await page.keyboard.type('Left while away.');
  await expect(status(page, 'In sync')).toBeVisible();

  await stopCollab();
  try {
    // The library is trying again: after 1 second, then 2, then 4.
    await expect(status(page, /^Restoring the connection/)).toBeVisible();
    // Left without a load of a page: the editor is taken down, and its connection stopped.
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
    await expect(text(page)).toHaveCount(0);
    const sockets = countSockets(page);
    const asked: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/documents/')) asked.push(request.url());
    });
    // FR-ED-15: the connection is the open document's, and goes with it.
    await page.waitForTimeout(12_000);
    expect(sockets.count).toBe(0);
    expect(asked).toEqual([]);
  } finally {
    await startCollab();
  }
});

test('a document deleted while it is open closes with its words, and the page does not connect again', async ({
  page,
  context,
}) => {
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Open when it is deleted.');
  await expect(status(page, 'In sync')).toBeVisible();
  const sockets = countSockets(page);

  const list = await context.newPage();
  await list.goto('/');
  // FR-ED-36: the Owner deletes it, from another tab. The page sends the `Origin` the proxy checks.
  expect(
    await list.evaluate(
      (address) => fetch(address, { method: 'DELETE' }).then((r) => r.status),
      `/api/documents/${id}`,
    ),
  ).toBe(204);

  // FR-ED-41: a neutral statement, not the error state, and the document is left.
  const statement = page.getByRole('status').filter({ hasText: 'Access to this document has ended' });
  await expect(statement).toBeVisible();
  await expect(statement).toContainText(
    'Ekdotico closed the document in this tab. Ekdotico discarded the changes that it had not yet sent.',
  );
  await expect(statement.getByRole('link', { name: 'Documents', exact: true })).toHaveAttribute('href', '/');
  await expect(text(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Not connected|Restoring|In sync/ })).toHaveCount(0);
  await expect(page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'))).toHaveCount(0);
  // The text that had the focus is gone: the statement has it.
  await expect(statement).toBeFocused();
  await screens(page, 'editor-refused');

  // "The client shall not attempt to reconnect": no socket is opened in the next seconds.
  await page.waitForTimeout(8000);
  expect(sockets.count).toBe(0);
  await expect(statement).toBeVisible();
});

test('a lost connection is restored: the words say so, the error state follows, and nothing typed is lost', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  await text(page).click();
  await page.keyboard.type('Before.');
  await expect(status(page, 'In sync')).toBeVisible();

  await stopCollab();
  try {
    // FR-ED-18, E3: the syncing state, with words that say the connection is being restored.
    const restoring = status(page, /^Restoring the connection\. Ekdotico keeps changes in this tab/);
    await expect(restoring).toBeVisible();
    await expect(page.locator('.ekd-sync')).toHaveAttribute('data-state', 'syncing');
    // The editor still takes input, and the focus is where it was.
    await expect(text(page)).toBeFocused();
    await expect(text(page)).toHaveAttribute('aria-readonly', 'false');
    await page.keyboard.type(' Typed while away.');
    await expect(text(page)).toHaveText('Before. Typed while away.');
    // FR-ED-18: the indicator says that such changes are lost if the tab is closed.
    await expect(
      status(page, /Changes that are not yet sent are lost if this tab is closed\.$/),
    ).toBeVisible();
    await screens(page, 'editor-reconnecting');

    // FR-ED-23: the error state after the period (6 seconds in these tests), and read-only (FR-ED-18).
    const lost = status(
      page,
      /^Not connected\. The document is read-only until the connection returns\. Check the connection\. Ekdotico tries again automatically\./,
    );
    await expect(lost).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ekd-sync')).toHaveAttribute('data-state', 'error');
    await expect(text(page)).toHaveAttribute('aria-readonly', 'true');
    await expect(text(page)).toHaveAttribute('contenteditable', 'false');
    await expect(text(page)).toBeFocused();
    await page.keyboard.type(' Not taken.');
    await expect(text(page)).toHaveText('Before. Typed while away.');
    await screens(page, 'editor-error');

    // FR-ED-24: pressed now, the check does not confirm, and offers the copy before the reload.
    await lost.click();
    const dialog = page.getByRole('dialog', { name: 'Sync status' });
    await expect(dialog.getByRole('alert')).toContainText(
      'Ekdotico could not confirm that the working version matches the server',
    );
    await expect(dialog.getByRole('button')).toHaveText(['Copy text', 'Reload document', 'Close']);
    await screens(page, 'editor-check');
    await dialog.getByRole('button', { name: 'Close' }).click();
  } finally {
    await startCollab();
  }

  // The connection returns: in sync, editable, and what was typed while away is the server's too.
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 60_000 });
  await expect(text(page)).toHaveAttribute('aria-readonly', 'false');
  await placeAtEnd(text(page).locator('p'));
  await page.keyboard.type(' After.');
  await expect(text(page)).toHaveText('Before. Typed while away. After.');
  await expect(status(page, 'In sync')).toBeVisible();
  await page.reload();
  await expect(text(page)).toHaveText('Before. Typed while away. After.');
});

test('a session that has ended is stated once, and the page does not connect again', async ({
  page,
  context,
}) => {
  await enter(page);
  await openNew(page);
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('button', { name: 'Sign out' }).click();
  await expect(other).toHaveURL(/\/sign-in/);

  // The server does not yet end a connection for the end of its session
  // (NFR-SE-03 (b) is a later slice), so the connection is lost here: every
  // new handshake is then refused, and the page must not go on asking.
  await stopCollab();
  await startCollab();
  const statement = page.getByRole('status').filter({ hasText: 'The session has ended' });
  await expect(statement).toBeVisible({ timeout: 30_000 });
  await expect(statement.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/sign-in');
  await expect(text(page)).toHaveCount(0);
  const sockets = countSockets(page);
  await page.waitForTimeout(8000);
  expect(sockets.count).toBe(0);
});
