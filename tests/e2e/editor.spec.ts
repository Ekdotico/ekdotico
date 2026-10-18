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
  storeState,
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
 * Where the editor holds the cursor, which is not always where the browser
 * draws it. A press, an arrow key and a range set by a script move the
 * browser's cursor, and the editor reads the move when the browser tells of
 * it, some milliseconds later: sooner than a person can type, and later than
 * a test does. And for 20 ms after the text takes the focus the editor's
 * library may put the browser's cursor back where the editor holds it
 * (prosemirror-view, the handler of `focus`), on a timer that a busy machine
 * runs late: 76 ms was measured. A move made before it is then taken back.
 *
 * So a test that moves the cursor waits for this, and not for a time, and
 * moves it again where the move was taken back.
 */
function held(block: Locator) {
  return block.evaluate((element) => {
    const { editor } = element.closest('.ekd-editor') as unknown as {
      editor: {
        state: { selection: { empty: boolean; anchor: number; head: number } };
        view: {
          dom: HTMLElement;
          domAtPos(pos: number): { node: Node };
          posAtDOM(node: Node, offset: number): number;
        };
      };
    };
    const { selection } = editor.state;
    const drawn = element.ownerDocument.getSelection()!;
    const at = (node: Node | null, offset: number) =>
      node && editor.view.dom.contains(node) ? editor.view.posAtDOM(node, offset) : -1;
    return {
      /** The editor holds the cursor in the block, and where the browser draws it: it has read the move. */
      inside:
        element.contains(editor.view.domAtPos(selection.head).node) &&
        at(drawn.anchorNode, drawn.anchorOffset) === selection.anchor &&
        at(drawn.focusNode, drawn.focusOffset) === selection.head,
      /** It is a cursor, after the last of the block's text. */
      atEnd: selection.empty && selection.head === editor.view.posAtDOM(element, element.childNodes.length),
    };
  });
}

/** Puts the cursor in a block by a press on it, and waits for the editor to hold it there. */
async function place(block: Locator) {
  // One press: a second one soon after it would be the second of two, and select a word.
  await block.click();
  await expect.poll(async () => (await held(block)).inside).toBe(true);
}

/** Puts the cursor at the end of a block's text, whatever the keys of the platform do. */
async function placeAtEnd(block: Locator) {
  await place(block);
  await expect(async () => {
    await block.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    // The browser tells of the range in a task of its own: the first look is often too soon.
    expect((await held(block)).atEnd).toBe(true);
  }).toPass({ intervals: [20, 50] });
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
  const blocks = text(page).locator(':scope > *');
  // Down until the editor holds the cursor at the end of the last block, and
  // not for a count of keys and a time: a key that the editor's library took
  // back is pressed again (`held`).
  await expect(async () => {
    await page.keyboard.press('ArrowDown');
    expect((await held(blocks.last())).atEnd).toBe(true);
  }).toPass({ intervals: [20, 50] });
  const before = await blocks.count();
  await page.keyboard.press('Enter');
  // Enter is the editor's own key, and its paragraph is there when the key has been answered.
  await expect(blocks).toHaveCount(before + 1);
  await expect.poll(async () => (await held(blocks.last())).atEnd).toBe(true);
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
    // The page sends what it types in a batch where the keys come fast
    // (src/lib/collab/client.ts), so the other client lags the page by up to
    // 250 ms, and by more of the page's changes than one. It waits until it
    // holds the page's state up to the command: the heading chosen above,
    // and the command in the last block, and not the one that was chosen.
    const command = () => {
      const fragment = shared.getXmlFragment('default');
      if (!fragment.toString().includes('<heading level="2">Chosen</heading>')) return undefined;
      const last = fragment.toArray().at(-1);
      return last instanceof Y.XmlElement
        ? last.toArray().find((each) => each instanceof Y.XmlText && each.toString() === '/h')
        : undefined;
    };
    await expect.poll(() => command() !== undefined).toBe(true);
    (command() as Y.XmlText).insert(2, 'zz');
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

    // The review of pull request 25. The other client rewrites the command in
    // one change with a block that the editor answers by a change of its own:
    // a rule put last, which the editor follows with a paragraph. The list
    // closes as for any rewrite; it opened again on "/code", and Enter put a
    // code block in place of it and of the writer's "de".
    const fragment = shared.getXmlFragment('default');
    await newLastLine(page);
    await page.keyboard.type('see  de mine');
    for (let press = 0; press < ' de mine'.length; press += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('/co');
    await expect(rows(page)).toHaveText(['Code block/code', 'Table of contents/toc']);
    await expect.poll(() => fragment.toString()).toContain('see /co de mine');
    shared.transact(() => {
      sharedText(shared, 'see /co de mine').delete('see /co'.length, 1);
      fragment.push([element('horizontalRule')]);
    });
    await expect(doc.locator(':scope > p').filter({ hasText: 'see /code mine' })).toHaveCount(1);
    // The editor did answer: the rule is there, and a paragraph after it.
    await expect(doc.locator(':scope > hr + p:last-child')).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(palette(page)).toBeHidden();
    await expect(page.getByText(NO_BLOCK).first()).toBeHidden();
    await expect(doc).not.toHaveAttribute('aria-controls');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(doc.locator('pre')).toHaveCount(0);
    // Enter was the text's key: it broke the line at the cursor, and the writer's words are whole.
    await expect(doc.getByText('see /co', { exact: true })).toHaveCount(1);
    await expect(doc.getByText('de mine', { exact: true })).toHaveCount(1);

    // And an open list stays, at the row the writer moved to, through such a change elsewhere.
    await newLastLine(page);
    await page.keyboard.type('/q');
    await expect(rows(page)).toHaveText(['Quote/quote']);
    await expect.poll(() => fragment.toString()).toContain('/q');
    shared.transact(() => {
      fragment.insert(0, [paragraph('Elsewhere.')]);
      fragment.push([element('pageBreak')]);
    });
    await expect(doc.locator(':scope > p').first()).toHaveText('Elsewhere.');
    await expect(doc.locator(':scope > .ekd-page-break + p:last-child')).toHaveCount(1);
    await expect(rows(page)).toHaveText(['Quote/quote']);
    await expect(doc).toHaveAttribute('aria-controls', LIST_ID);
    await page.keyboard.press('Enter');
    await expect(doc.locator('blockquote')).toHaveCount(1);
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
    // The page listens before the key is pressed: this is awaited, and the
    // time is asked for afterwards. Asked for in one step, a slow page was
    // reached by the key first, and the time never came.
    await page.evaluate(() => {
      (window as unknown as { keyTime: Promise<number> }).keyTime = new Promise<number>((resolve) => {
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
      });
    });
    await page.keyboard.press(key);
    times.push(
      Math.round(await page.evaluate(() => (window as unknown as { keyTime: Promise<number> }).keyTime)),
    );
  }
  await expect(doc.locator(':scope > p')).toHaveText(/^\*{32000}abcde$/);
  test.info().annotations.push({ type: 'milliseconds for each key', description: times.join(', ') });
  console.log(`a key at the end of 32,000 asterisks: ${times.join(', ')} ms`);
  // The middle one of five, so that one slow frame of a busy machine fails nothing.
  expect(times.toSorted((a, b) => a - b)[2]).toBeLessThan(150);
});

// The owner's decision of 12 October 2026, and the owner's sentence, written
// out here and not taken from the code under test.
const SLASH_HINT = 'Type / for a list of blocks.';
// R31: the prompt of an empty document is a sentence other than the description's.
const PROMPT = 'Write here, or type / for a list of blocks.';
const DESCRIPTION = `${SLASH_HINT} Alt+F10 moves from the text to the formatting toolbar when text is selected. When no text is selected, Alt+F10 moves to the controls of the block that holds the cursor. Escape returns to the text.`;

test('an empty document says how the list of blocks is opened: in the description of the text, and as a prompt that is no content', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  const prompt = doc.locator('p > span[data-placeholder]');

  // The description of the text, word for word.
  await expect(doc).toHaveAccessibleDescription(DESCRIPTION);

  // The prompt: the sentence, drawn by the design package's rule, in the one empty paragraph.
  await expect(prompt).toHaveCount(1);
  await expect(prompt).toHaveAttribute('data-placeholder', PROMPT);
  await expect(prompt).toHaveAttribute('aria-hidden', 'true');
  const drawn = () =>
    prompt.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      // The colour as the browser paints it, whatever notation the stylesheet wrote it in.
      const painted = (colour: string) => {
        const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        canvas.fillStyle = colour;
        canvas.fillRect(0, 0, 1, 1);
        return [...canvas.getImageData(0, 0, 1, 1).data];
      };
      let behind: Element | null = element;
      let ground = [0, 0, 0, 0];
      while (behind && ground[3] !== 255) {
        ground = painted(getComputedStyle(behind).backgroundColor);
        behind = behind.parentElement;
      }
      const light = ([red, green, blue]: number[]) => {
        const [r, g, b] = [red!, green!, blue!].map((value) => {
          const part = value / 255;
          return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const ink = painted(style.color);
      const [above, below] = [light(ink), light(ground)].sort((a, b) => b - a);
      return {
        content: style.content,
        inkAlpha: ink[3],
        groundAlpha: ground[3],
        contrast: (above! + 0.05) / (below! + 0.05),
      };
    });
  // WCAG 2.2, 1.4.3: the prompt is text, so 4.5 to 1, in the light theme and in the dark.
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const seen = await drawn();
    // The sentence, with the empty alternative text the package gives it from 0.29.0, which this browser parses.
    expect(seen.content, colorScheme).toBe(`"${PROMPT}" / ""`);
    expect(seen.inkAlpha, colorScheme).toBe(255);
    expect(seen.groundAlpha, colorScheme).toBe(255);
    expect(seen.contrast, colorScheme).toBeGreaterThanOrEqual(4.5);
    console.log(`the prompt of an empty document, ${colorScheme}: ${seen.contrast.toFixed(2)} to 1`);
  }
  await page.emulateMedia({ colorScheme: null });

  // It is no content. Not text of the document, on the page or in what is selected and copied.
  await expect(doc).toHaveText('');
  await doc.focus();
  await page.keyboard.press('ControlOrMeta+a');
  expect(await page.evaluate(() => window.getSelection()!.toString().trim())).toBe('');
  // Not in the shared document: another client holds nothing, or one empty paragraph.
  const other = await connectAs(page.context(), id);
  try {
    expect(['', '<paragraph></paragraph>']).toContain(
      other.provider.document.getXmlFragment('default').toString(),
    );
  } finally {
    other.close();
  }
  // NFR-IC-19: a screen reader is told the sentence once, by the description.
  // In the browser's own accessibility tree nothing under the text holds it.
  const tree = await page.context().newCDPSession(page);
  const { nodes } = (await tree.send('Accessibility.getFullAXTree')) as {
    nodes: { nodeId: string; childIds?: string[]; role?: { value: string }; name?: { value: string } }[];
  };
  await tree.detach();
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const box = nodes.find((node) => node.role?.value === 'textbox' && node.name?.value === 'Document text')!;
  const under = (node: (typeof nodes)[number]): typeof nodes =>
    (node.childIds ?? []).flatMap((child) => {
      const found = byId.get(child);
      return found ? [found, ...under(found)] : [];
    });
  expect(under(box).length).toBeGreaterThan(0);
  expect(
    under(box)
      .map((node) => (node.name?.value ?? '').trim())
      .filter(Boolean),
  ).toEqual([]);
  expect(nodes.filter((node) => node.name?.value === PROMPT || node.name?.value === SLASH_HINT)).toEqual([]);

  // At 320 CSS pixels the prompt is inside the page.
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoSidewaysScroll(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Gone at the first character, and back when the document is empty again.
  await page.keyboard.type('a');
  await expect(doc).toHaveText('a');
  await expect(doc.locator(`[data-placeholder="${PROMPT}"]`)).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await expect(prompt).toHaveCount(1);
  // Not in a document of two empty paragraphs.
  await page.keyboard.press('Enter');
  await expect(doc.locator(':scope > p')).toHaveCount(2);
  await expect(doc.locator(`[data-placeholder="${PROMPT}"]`)).toHaveCount(0);
  await page.keyboard.press('Backspace');
  await expect(prompt).toHaveCount(1);
  await expect(status(page, 'In sync')).toBeVisible();

  // FR-ED-18: not in the read-only state.
  await stopCollab();
  try {
    await expect(status(page, /^Not connected\./)).toBeVisible({ timeout: 15_000 });
    await expect(doc).toHaveAttribute('aria-readonly', 'true');
    await expect(doc.locator(`[data-placeholder="${PROMPT}"]`)).toHaveCount(0);
  } finally {
    await startCollab();
  }
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 60_000 });
  await expect(prompt).toHaveCount(1);
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

test('the closing of the slash palette is said after a dismissal, and nothing is said after a choice', async ({
  page,
}) => {
  // The owner's decision R44 of 12 October 2026 (FR-ED-10; NFR-IC-19). What a
  // screen reader is given is read from the region; none is run here.
  test.slow();
  await enter(page);
  await openNew(page);
  const doc = text(page);
  // The status region of the list (the package, 0.29.0): one element, in the page open and closed.
  const region = page.locator('.ekd-option-list-announce[role="status"]');
  const COUNT = '4 blocks. Heading 1 first.';
  /** The list open and its count said: a list whose opening was not said closes unsaid. */
  const opened = async (typed: string) => {
    await page.keyboard.type(typed);
    // Open, the region is the element that follows the list.
    await expect(page.locator('.ekd-option-list + [role="status"]')).toHaveText(COUNT);
    await expect(region).toHaveCount(1);
  };
  /** What the region holds once the 150 milliseconds of a closing are well over. */
  const afterClosing = async () => {
    await expect(palette(page)).toBeHidden();
    await page.waitForTimeout(600);
    await expect(region).toHaveCount(1);
    return region.textContent();
  };
  await doc.focus();
  await expect(region).toHaveCount(1);
  expect(await region.textContent()).toBe('');

  // Escape: the package's own words.
  await opened('/h');
  await page.keyboard.press('Escape');
  await expect(region).toHaveText('List closed.');
  expect(await afterClosing()).toBe('List closed.');

  // Enter on a row: nothing.
  await opened(' /h');
  await page.keyboard.press('Enter');
  await expect(doc.locator('h1')).toHaveCount(1);
  expect(await afterClosing()).toBe('');

  // A click on a row: nothing.
  await opened('/h');
  await rows(page).nth(1).click();
  await expect(doc.locator('h2')).toHaveCount(1);
  expect(await afterClosing()).toBe('');

  // The choice is not remembered: the cursor leaving the command of the next list is said.
  await opened('/h');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await afterClosing()).toBe('List closed.');

  // Tab, which closes the list and leaves the text.
  await page.keyboard.press('End');
  await opened(' /h');
  await page.keyboard.press('Tab');
  expect(await afterClosing()).toBe('List closed.');
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
  await holds(hostile, 'pasted callout');
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
  await holds(hostile, 'pasted link');
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
test('a table past the bound of the schema is refused by the server, and one stored before is laid out with the bound, and the page answers', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  await expect(status(page, 'In sync')).toBeVisible();
  const past = () => [
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
  ];
  // Sent by another client, it is refused (register D171): the page never receives it.
  const refused = await connectAs(page.context(), id);
  await holds(refused, 'Written before.');
  refused.provider.document.transact(() => refused.provider.document.getXmlFragment('default').push(past()));
  await page.waitForTimeout(2000);
  await expect(text(page)).not.toContainText('The end.');
  refused.close();
  // Stored as a document could hold it before the server held the bounds.
  await storedWith(page, id, (fragment) => fragment.push(past()));
  const hostile = await connectAs(page.context(), id);
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
  await holds(hostile, 'Written before.');
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
  await holds(hostile, 'Written before.');
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

// ── A table in a cell of a table (the owner's decision R32 of 12 October 2026) ──

/** The time of one key, from its going down to the second frame after it came up, for each key of `keys`. */
async function keyTimes(page: Page, keys: string): Promise<number[]> {
  const times: number[] = [];
  for (const key of keys) {
    // The page listens before the key is pressed (the test of 32,000 asterisks says why).
    await page.evaluate(() => {
      (window as unknown as { keyTime: Promise<number> }).keyTime = new Promise<number>((resolve) => {
        let down = 0;
        document.addEventListener('keydown', () => (down = performance.now()), { once: true, capture: true });
        document.addEventListener(
          'keyup',
          () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - down))),
          { once: true, capture: true },
        );
      });
    });
    await page.keyboard.press(key);
    times.push(
      Math.round(await page.evaluate(() => (window as unknown as { keyTime: Promise<number> }).keyTime)),
    );
  }
  return times;
}
/** A table as a client that is no editor writes it: each cell holds what `cell` gives. */
const gridOf = (
  rows: number,
  columns: number,
  cell: (row: number, column: number) => (Y.XmlElement | Y.XmlText)[],
  caption = '',
) =>
  tableOf(
    Array.from({ length: rows }, (_, row) =>
      element(
        'tableRow',
        {},
        Array.from({ length: columns }, (_, column) => element('tableCell', {}, cell(row, column))),
      ),
    ),
    caption,
  );
const cellsIn = (fragment: Y.XmlFragment) => fragment.toString().split('<tablecell').length - 1;
/** The rows of a table that are its own, and not those of a table in one of its cells. */
const ownRows = (table: Locator) => table.locator(':scope > tbody > tr');
/** The items of a table's menu, as they stand in the page while the menu is closed: each name, and whether it is off. */
const menuOf = (figure: Locator) =>
  figure
    .locator(':scope > [data-block-controls] [role="menuitem"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('aria-disabled') === 'true'));
/** Chooses an item of the menu that has the focus, by the keyboard alone. */
async function chooseItem(page: Page, name: string) {
  await page.keyboard.press('Enter');
  const item = page.getByRole('menuitem', { name, exact: true });
  await expect(item).toBeVisible();
  await expect(async () => {
    if (!(await item.evaluate((each) => each === document.activeElement)))
      await page.keyboard.press('ArrowDown');
    await expect(item).toBeFocused({ timeout: 100 });
  }).toPass({ intervals: [20, 50] });
  await page.keyboard.press('Enter');
}

test('a table is put in a cell of a table from the palette, by keyboard alone: its keys, its menu, one undo, and what a screen reader is told', async ({
  page,
}) => {
  test.slow();
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  await enter(page);
  await openNew(page);
  const doc = text(page);
  const outer = doc.locator('figure').first();
  const inner = doc.locator('figure figure');
  // No press of a pointer from here on.
  await doc.focus();
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(doc.locator('table')).toHaveCount(1);
  await page.keyboard.type('outer A1');
  await page.keyboard.press('Tab');

  // The row is listed in a cell, and Enter puts the table there.
  await page.keyboard.type('/table');
  await expect(rows(page).filter({ hasText: '/table' })).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(doc.locator('table')).toHaveCount(2);
  await expect(inner.locator('td')).toHaveCount(9);
  await expect(doc).toBeFocused();
  // One undo takes the table away, and leaves what was typed to ask for it; a redo brings it back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(doc.locator('table')).toHaveCount(1);
  await expect(ownRows(doc.locator('table')).first().locator('td').nth(1)).toHaveText('/table');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(doc.locator('table')).toHaveCount(2);
  // The cell holds the table and a paragraph after it: a place of the cell's own.
  const cell = ownRows(doc.locator('table').first()).first().locator(':scope > td').nth(1);
  await expect(cell.locator(':scope > p')).toHaveCount(1);
  await expect(cell.locator(':scope > :last-child')).toHaveJSProperty('tagName', 'P');

  // The cursor is in the first cell of the new table, and Tab moves between its cells.
  await place(inner.locator('td').first());
  await page.keyboard.type('inner A1');
  await expect(inner.locator('td').first()).toHaveText('inner A1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('inner B1');
  await expect(inner.locator('td').nth(1)).toHaveText('inner B1');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  // No table a level deeper: the row is not listed there.
  await page.keyboard.type('/');
  await expect(palette(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(SLASH_ROWS.length - 1);
  await expect(rows(page).filter({ hasText: '/table' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('inner C1');
  await expect(inner.locator('td').nth(2)).toHaveText('inner C1');

  // Alt+F10 reaches the menu of the innermost table, which acts on that table alone.
  // The menu of the table round it offers nothing while the cursor is in the inner one.
  expect(await menuOf(outer)).toEqual(Array(9).fill(true));
  expect(await menuOf(inner)).toEqual([false, false, false, false, false, false, true, true, false]);
  await page.keyboard.press('Alt+F10');
  await expect(inner.getByRole('button', { name: 'Table' })).toBeFocused();
  await chooseItem(page, 'Add row below');
  await expect(inner.locator('tr')).toHaveCount(4);
  await expect(ownRows(doc.locator('table').first())).toHaveCount(3);
  await expect(doc).toBeFocused();

  // Down to the paragraph after the inner table, in the cell of the outer one:
  // from there Alt+F10 reaches the menu of the outer table, which acts on it alone.
  // A key is pressed only once the editor holds the cursor where the last one
  // put it (`held`): a key too many would go on, past the paragraph.
  await expect(async () => {
    if ((await held(inner)).inside) await page.keyboard.press('ArrowDown');
    expect((await held(cell.locator(':scope > p'))).inside).toBe(true);
  }).toPass({ intervals: [20, 50] });
  expect(await menuOf(inner)).toEqual(Array(9).fill(true));
  await page.keyboard.press('Alt+F10');
  await expect(
    outer.locator(':scope > [data-block-controls]').getByRole('button', { name: 'Table' }),
  ).toBeFocused();
  await chooseItem(page, 'Add row below');
  await expect(ownRows(doc.locator('table').first())).toHaveCount(4);
  await expect(inner.locator('tr')).toHaveCount(4);
  // The focus is back in the text before a letter is typed: the menu would take it for a search.
  await expect(doc).toBeFocused();
  await expect.poll(async () => (await held(cell.locator(':scope > p'))).inside).toBe(true);
  await page.keyboard.type('the cell’s own');
  await expect(cell.locator(':scope > p')).toHaveText('the cell’s own');

  // The caption of the inner table is in no cell of it, and in a cell of the
  // outer one. So the inner menu offers nothing there, the outer menu acts on
  // the row and the column of that cell, and Alt+F10 goes to the menu that
  // offers something, and not to the one that offers nothing.
  await place(inner.locator('figcaption'));
  await page.keyboard.type('Inner caption');
  expect(await menuOf(inner)).toEqual(Array(9).fill(true));
  expect(await menuOf(outer)).toEqual([false, false, false, false, false, false, true, true, false]);
  await page.keyboard.press('Alt+F10');
  await expect(
    outer.locator(':scope > [data-block-controls]').getByRole('button', { name: 'Table' }),
  ).toBeFocused();
  await chooseItem(page, 'Add column right');
  await expect(ownRows(doc.locator('table').first()).first().locator(':scope > td')).toHaveCount(4);
  await expect(inner.locator('tr').first().locator('td')).toHaveCount(3);
  await expect(doc).toBeFocused();
  // From the caption of a table that stands in no cell the key goes to that
  // table's own menu, which offers nothing there: as before the decision.
  await place(doc.locator('figcaption').last());
  expect(await menuOf(outer)).toEqual(Array(9).fill(true));
  await page.keyboard.press('Alt+F10');
  await expect(
    outer.locator(':scope > [data-block-controls]').getByRole('button', { name: 'Table' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(doc).toBeFocused();

  // Tab into the cell that holds the table selects nothing: the cursor is in
  // the cell's own text, and a letter replaces nothing (the review of pull
  // request 28: one letter left a table of one cell).
  await place(doc.getByText('outer A1', { exact: true }));
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await held(cell.locator(':scope > p'))).inside).toBe(true);
  await page.keyboard.type('Z');
  await expect(cell.locator(':scope > p')).toHaveText('Zthe cell’s own');
  await expect(inner.locator('td')).toHaveCount(12);
  for (const [at, written] of ['inner A1', 'inner B1', 'inner C1'].entries())
    await expect(inner.locator('td').nth(at)).toHaveText(written);
  await expect(inner.locator('figcaption')).toHaveText('Inner caption');
  await page.keyboard.press('Backspace');
  await expect(cell.locator(':scope > p')).toHaveText('the cell’s own');

  // NFR-IC-19: what is exposed. Each table is a table in a figure with its own
  // button, and the inner one stands in a cell of the outer. A table with a
  // caption is named by it, and so is its button; one without is as before.
  await expect(doc).toMatchAriaSnapshot(`
    - figure:
      - button "Table"
      - table:
        - rowgroup:
          - row:
            - cell "outer A1"
            - cell:
              - figure "Inner caption":
                - 'button "Table: Inner caption"'
                - table:
                  - rowgroup:
                    - row "inner A1 inner B1 inner C1":
                      - cell "inner A1"
                      - cell "inner B1"
                      - cell "inner C1"
                - text: Inner caption
              - paragraph: the cell’s own
  `);
  await expectNoSidewaysScroll(page);
  await screens(page, 'editor-table-in-cell');

  // A pasted table with its caption goes into a cell as a table in it; into a
  // cell of the inner table it would be a level too deep, and nothing is pasted.
  const figure =
    '<figure class="ekd-table"><table><tbody><tr><td><p>PASTED</p></td></tr></tbody></table><figcaption class="ekd-table-caption">pasted caption</figcaption></figure>';
  // What is not pasted is said to be so, once, in words that are seen and
  // heard, and the focus stays in the text. Written out here, and not taken
  // from the code under test.
  const noRoom = page.getByRole('status').filter({
    hasText:
      'We cannot paste this table. A table and the tables in its cell hold 10,000 cells, two levels deep and this surpasses our current limits.',
  });
  await expect(noRoom).toHaveCount(0);
  await place(inner.locator('td').nth(4));
  await paste(page, figure);
  await expect(noRoom).toBeVisible();
  await expect(doc).toBeFocused();
  await expect(doc.locator('table')).toHaveCount(2);
  await paste(page, figure);
  await expect(noRoom).toHaveCount(1);
  // The words go with the next change the writer makes.
  const empty = ownRows(doc.locator('table').first()).nth(1).locator(':scope > td').first();
  await place(empty);
  await expect(noRoom).toBeVisible();
  await paste(page, figure);
  await expect(noRoom).toHaveCount(0);
  await expect(doc.locator('table')).toHaveCount(3);
  await expect(doc.getByText('PASTED', { exact: true })).toHaveCount(1);
  await expect(doc.getByText('pasted caption', { exact: true })).toHaveCount(1);
  await expect(inner.first().locator('table')).toHaveCount(1);
  // The table was pasted into an empty cell, and a paragraph follows it there:
  // the cell has a place of its own, which the keyboard reaches from the
  // caption of the pasted table (the review: WCAG 2.1.1).
  await expect(empty.locator(':scope > *')).toHaveCount(2);
  await expect(empty.locator(':scope > p')).toHaveText('');
  await place(empty.locator('figcaption'));
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await held(empty.locator(':scope > p'))).inside).toBe(true);
  await page.keyboard.type('own place');
  await expect(empty.locator(':scope > p')).toHaveText('own place');
  await expect(status(page, 'In sync')).toBeVisible();
  await page.reload();
  await expect(text(page).locator('table')).toHaveCount(3);
  await expect(text(page)).toContainText('the cell’s own');
  await expect(text(page)).toContainText('own place');
  expect(faults).toEqual([]);
});

test('a table in a cell that another client takes past the bounds is brought inside them, and the writer’s text stays', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  await doc.click();
  await page.keyboard.type('Written before.');
  let hostile = await connectAs(page.context(), id);
  let fragment = hostile.provider.document.getXmlFragment('default');
  // The writer's table, sixty by sixty, and what the writer writes in it.
  fragment.push([
    gridOf(60, 60, (row, column) => [paragraph(`w${row}.${column}`)], 'the writer’s'),
    paragraph('after'),
  ]);
  await expect(doc.locator('td')).toHaveCount(3600);
  await placeAtEnd(doc.getByText('w0.0', { exact: true }));
  await page.keyboard.type(' KEEP-THIS');
  await expect(doc).toContainText('w0.0 KEEP-THIS');
  await expect.poll(() => fragment.toString()).toContain('KEEP-THIS');

  // Another client puts four by four in every cell, 57,600 cells more, and in
  // one of them a table a level too deep.
  const cellAt = (row: number, column: number, within = fragment) =>
    (((within.get(1) as Y.XmlElement).get(0) as Y.XmlElement).get(row) as Y.XmlElement).get(
      column,
    ) as Y.XmlElement;
  const putIn = (within: Y.XmlFragment) => {
    for (let row = 0; row < 60; row += 1)
      for (let column = 0; column < 60; column += 1)
        cellAt(row, column, within).push([
          gridOf(4, 4, (inner, across) =>
            row + column + inner + across === 0
              ? [paragraph('two'), gridOf(1, 1, () => [paragraph('THREE-DEEP')])]
              : [paragraph('')],
          ),
        ]);
  };
  // Sent, it is refused by the server (register D171): the page never receives it.
  hostile.provider.document.transact(() => putIn(fragment));
  await page.waitForTimeout(3000);
  await expect(doc.locator('table')).toHaveCount(1);
  hostile.close();
  // Stored as a document could hold it before the server held the bounds.
  await storedWith(page, id, (stored) => {
    putIn(stored);
    expect(cellsIn(stored)).toBe(61_201);
  });
  hostile = await connectAs(page.context(), id);
  fragment = hostile.provider.document.getXmlFragment('default');

  // The page holds the bound: the writer's 3,600 cells, and the first four
  // hundred of the tables put in them, in the order of the document.
  const held = async () => {
    await expect(doc.locator('table')).toHaveCount(401, { timeout: 60_000 });
    await expect(doc.locator('td')).toHaveCount(10_000);
    await expect(doc.locator('table table table')).toHaveCount(0);
    await expect(doc).not.toContainText('THREE-DEEP');
    for (const written of ['Written before.', 'w0.0 KEEP-THIS', 'two', 'w6.39', 'w6.40', 'w59.59', 'after'])
      await expect(doc.getByText(written, { exact: true })).toHaveCount(1);
  };
  await held();
  // The shared document holds what the page does: what was past the bounds is gone from it, and nothing else.
  await expect.poll(() => cellsIn(fragment), { timeout: 60_000 }).toBe(10_000);
  expect(fragment.toString()).toContain('KEEP-THIS');
  expect(fragment.toString()).not.toContain('THREE-DEEP');
  for (let row = 0; row < 60; row += 1)
    for (let column = 0; column < 60; column += 1)
      expect(cellAt(row, column).toString()).toContain(`w${row}.${column}`);

  // It holds 401 tables, more than a document holds (D184): it says so, and
  // takes deletions alone until it is back under.
  await expect(page.getByText(/^This document holds 401 tables, more than our current limit/)).toHaveCount(1);
  await placeAtEnd(doc.getByText('after', { exact: true }));
  await page.keyboard.type(' typed');
  await expect(doc).not.toContainText('after typed');
  await held();
  expect(cellsIn(fragment)).toBe(10_000);
  hostile.close();
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await held();
  expect(faults).toEqual([]);
});

// The largest there may be: ten by ten, and ten by ten in each cell but the
// last, ten thousand cells in a hundred tables, the most a document holds
// (D184). Measured on 12 October 2026, with nine by eleven in every cell: 31
// ms a key, which is what one table of a hundred by a hundred takes.
test('a key typed in a table whose cells hold tables, ten thousand cells in all, is answered at once', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  const other = await connectAs(page.context(), id);
  try {
    other.provider.document
      .getXmlFragment('default')
      .insert(0, [
        gridOf(10, 10, (row, column) =>
          row === 9 && column === 9
            ? [paragraph('')]
            : [
                gridOf(10, 10, (inner, across) => [
                  paragraph(row === 9 && column === 8 && inner === 9 && across === 9 ? 'last cell' : ''),
                ]),
              ],
        ),
      ]);
    await expect(doc.locator('td')).toHaveCount(10_000, { timeout: 60_000 });
    await expect(doc.locator('table')).toHaveCount(100);
  } finally {
    other.close();
  }
  await placeAtEnd(doc.getByText('last cell'));
  const times = await keyTimes(page, 'abcde');
  await expect(doc.locator('td', { hasText: 'last cellabcde' }).last()).toBeVisible();
  test.info().annotations.push({ type: 'milliseconds for each key', description: times.join(', ') });
  console.log(`a key in a table of tables, 10,000 cells: ${times.join(', ')} ms`);
  // The middle one of five, as for the 32,000 asterisks.
  expect(times.toSorted((a, b) => a - b)[2]).toBeLessThan(150);

  // At the bound the menu offers no row and no column (the review of pull
  // request 28, S2), and what would take one away is still offered.
  expect(await menuOf(doc.locator('figure figure').last())).toEqual([
    true,
    true,
    true,
    true,
    false,
    false,
    true,
    true,
    false,
  ]);
  // Tab in the last cell would add a row: it adds none, and the page says so.
  const noRoom = page.getByRole('status').filter({ hasText: 'The table has no room for this.' });
  await expect(noRoom).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(noRoom).toBeVisible();
  await expect(doc.locator('td')).toHaveCount(10_000);
  await expect(doc).toBeFocused();
  await page.keyboard.type('f');
  await expect(noRoom).toHaveCount(0);
});

// Register D170, D171 and D180: the collaboration server refuses an update
// that creates a block without the content it must hold, or takes a table past
// a bound (src/lib/collab/shape.ts). Nothing a writer does in the editor is such
// an update, and a refusal would hold the tab read-only with "A change in this
// tab…", so each step is taken, sent and stored.
test('the server refuses nothing a writer does: writing, a list, pasting, a table at its bounds, a table in a cell, undo and redo', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await enter(page);
  await openNew(page);
  const doc = text(page);
  const held = page.getByText(/A change in this tab|We cannot apply this change/);
  const figure = (rows: string, caption: string) =>
    `<figure class="ekd-table"><table><tbody>${rows}</tbody></table><figcaption class="ekd-table-caption">${caption}</figcaption></figure>`;
  const full = figure(
    Array.from(
      { length: 100 },
      (_, row) =>
        `<tr>${Array.from({ length: 100 }, (__, column) => `<td><p>${row}.${column}</p></td>`).join('')}</tr>`,
    ).join(''),
    'full table',
  );
  const nested = figure(
    `<tr><td><p>outer</p>${figure('<tr><td><p>inner</p></td><td><p>inner two</p></td></tr>', 'inner table')}</td><td><p>beside</p></td></tr>`,
    'outer table',
  );

  await doc.click();
  await page.keyboard.type('Written first.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(doc.locator('table')).toHaveCount(1);
  await page.keyboard.type('in the palette table');
  await expect(status(page, 'In sync')).toBeVisible();

  await placeAtEnd(doc.getByText('Written first.'));
  await paste(
    page,
    `<ul><li><p>pasted item</p></li></ul><blockquote><p>pasted quote</p></blockquote>${nested}<p>After the tables.</p>`,
  );
  await expect(doc.locator('td')).toHaveCount(9 + 4);
  await expect(status(page, 'In sync')).toBeVisible();

  // Undo until no table is left, and redo until both are back, each step sent as it is made.
  const cells = () => doc.locator('td').count();
  for (let presses = 0; presses < 40 && (await cells()) > 0; presses += 1) {
    await page.keyboard.press('ControlOrMeta+z');
  }
  await expect(doc.locator('td')).toHaveCount(0);
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  for (let presses = 0; presses < 40 && (await cells()) < 9 + 4; presses += 1) {
    await page.keyboard.press('ControlOrMeta+Shift+z');
  }
  await expect(doc.locator('td')).toHaveCount(9 + 4);
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  await expect(held).toHaveCount(0);

  // A table at its bounds, pasted, and a key in its last cell, undone and done again.
  await placeAtEnd(doc.getByText('After the tables.'));
  await paste(page, full);
  await expect(doc.locator('td')).toHaveCount(9 + 4 + 10_000, { timeout: 60_000 });
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  await placeAtEnd(doc.getByText('99.99', { exact: true }));
  await page.waitForTimeout(600);
  await page.keyboard.type(' typed at the bound');
  await expect(doc.getByText('99.99 typed at the bound')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(doc.getByText('99.99', { exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(doc.getByText('99.99 typed at the bound')).toBeVisible();
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  await expect(held).toHaveCount(0);

  // The server took and stored every step.
  await page.reload();
  await expect(doc.locator('td')).toHaveCount(9 + 4 + 10_000, { timeout: 60_000 });
  for (const written of [
    '99.99 typed at the bound',
    'pasted item',
    'pasted quote',
    'inner two',
    'in the palette table',
  ])
    await expect(doc.getByText(written)).toBeVisible();
  await expect(held).toHaveCount(0);
});

// The owner's decisions R58 of 13 October 2026, "refuse only, never delete, at 100", and
// D184 of 18 October 2026: one number, and no second against a flood. A document
// stored with more is the test 'a document stored with more than 100 tables'.
test('a writer brings a document to a hundred tables and no further, and is told so in the owner’s words', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  // Written out here, and not taken from the code under test.
  const WORDS =
    'We could not paste this. It would bring the document to 101 tables, more than our current limit for tables (100).';
  const figure =
    '<figure class="ekd-table"><table><tbody><tr><td><p>PASTED</p></td></tr></tbody></table><figcaption class="ekd-table-caption">pasted</figcaption></figure>';
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  await doc.click();
  await page.keyboard.type('Written before.');
  await expect(status(page, 'In sync')).toBeVisible();
  const other = await connectAs(page.context(), id);
  await holds(other, 'Written before.');
  const tablesIn = (client: typeof other) =>
    client.provider.document.getXmlFragment('default').toString().split('<tableblock').length - 1;
  // Ninety-nine tables, of five rows by four with text.
  other.provider.document.transact(() =>
    other.provider.document
      .getXmlFragment('default')
      .push([
        ...Array.from({ length: 99 }, (_, at) => gridOf(5, 4, () => [paragraph('some text')], `table ${at}`)),
        paragraph('after'),
      ]),
  );
  await expect(doc.locator('table')).toHaveCount(99, { timeout: 60_000 });
  const said = page.getByText(WORDS, { exact: true });

  // The hundredth is the writer's to add, from the palette, and is listed.
  await placeAtEnd(doc.getByText('after', { exact: true }));
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await expect(rows(page).filter({ hasText: '/table' })).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(doc.locator('table')).toHaveCount(100);
  await expect.poll(() => tablesIn(other)).toBe(100);
  // At a hundred: not listed, in the text or in a cell, and a pasted one is not put in, which the page says.
  await page.keyboard.type('/');
  await expect(palette(page)).toBeVisible();
  await expect(rows(page).filter({ hasText: '/table' })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(SLASH_ROWS.length - 1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await expect(said).toHaveCount(0);
  await paste(page, figure);
  await expect(said).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: WORDS })).toHaveCount(1);
  await expect(doc.locator('table')).toHaveCount(100);
  await expect(doc).not.toContainText('PASTED');
  // What adds no table is applied, and takes the words away.
  await page.keyboard.type('typed');
  await expect(said).toHaveCount(0);
  other.close();
  expect(faults).toEqual([]);
});

// The re-review of pull request 28, finding d: the words of a refusal stayed
// through another client's change and the writer's own undo, and a second
// refusal in the same words was not heard.
test('the words of a refusal are heard at each refusal, and go when the document next changes, whoever changes it', async ({
  page,
}) => {
  test.slow();
  // Written out here, and not taken from the code under test.
  const WORDS =
    'We cannot paste this table. A table and the tables in its cell hold 10,000 cells, two levels deep and this surpasses our current limits.';
  const figure =
    '<figure class="ekd-table"><table><tbody><tr><td><p>PASTED</p></td></tr></tbody></table><figcaption class="ekd-table-caption">pasted caption</figcaption></figure>';
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  await doc.focus();
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await expect(doc.locator('table')).toHaveCount(2);
  await place(doc.locator('figure figure td').first());
  // Everything the region a screen reader hears is given, from here on.
  await page.evaluate(() => {
    const region = [...document.querySelectorAll('[role="status"]')].find(
      (each) => !each.closest('[role="textbox"]') && each.classList.contains('sr-only'),
    )!;
    const heard = ((window as unknown as { heard: string[] }).heard = [] as string[]);
    new MutationObserver(() => heard.push(region.textContent ?? '')).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  const heard = () => page.evaluate(() => (window as unknown as { heard: string[] }).heard);
  // Seen, in the page, and heard, in the region: the same words in both.
  const said = page.getByText(WORDS, { exact: true });
  await expect(said).toHaveCount(0);

  // A table a level too deep is not pasted, twice: the words are given to the
  // region twice, with the region empty between, so that the second is heard.
  await paste(page, figure);
  await expect(said).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: WORDS })).toHaveCount(1);
  await expect(doc).toBeFocused();
  await paste(page, figure);
  await expect.poll(heard).toEqual([WORDS, '', WORDS]);
  await expect(said).toHaveCount(2);
  await expect(doc.locator('table')).toHaveCount(2);

  // A move of the cursor is no change to the document: the words stay.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(said).toHaveCount(2);
  // Another client's change takes them away.
  const other = await connectAs(page.context(), id);
  other.provider.document.getXmlFragment('default').push([paragraph('theirs')]);
  await expect(doc).toContainText('theirs');
  await expect(said).toHaveCount(0);
  other.close();
  // And so does the writer's own undo, which arrives as the binding's change.
  await paste(page, figure);
  await expect(said).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(doc.locator('table')).toHaveCount(1);
  await expect(said).toHaveCount(0);
  expect((await heard()).filter(Boolean)).toEqual([WORDS, WORDS, WORDS]);
});

// The re-review of pull request 28 (WCAG 2.1.1): a cell that holds a table and
// nothing else, as another client or a stored document makes one, had no place
// the keyboard reached beside the table.
test('from a table that is all a cell holds, the arrow keys reach the place beside it, where a letter makes the paragraph', async ({
  page,
}) => {
  test.slow();
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  await enter(page);
  const id = await openNew(page);
  const doc = text(page);
  const other = await connectAs(page.context(), id);
  const fragment = other.provider.document.getXmlFragment('default');
  fragment.insert(0, [
    gridOf(
      2,
      3,
      (row, column) =>
        row === 0 && column === 1
          ? [gridOf(2, 2, () => [paragraph('in')], 'inner caption')]
          : [paragraph(`o${row}.${column}`)],
      'outer caption',
    ),
  ]);
  await expect(doc.locator('table')).toHaveCount(2);
  // With a cell of text on each side of it and a row below: where the table library's own arrows would go.
  const cell = doc.locator('table').first().locator(':scope > tbody > tr > td').nth(1);
  const shared = () =>
    ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement)
      .get(0)
      .toString()
      .replace(/ (col|row)span="1"/g, '');
  const before = shared();
  /** Where the editor holds the cursor: the kind of selection, and the blocks round it. */
  const cursor = () =>
    doc.evaluate((element) => {
      const { editor } = element as unknown as {
        editor: {
          state: {
            selection: {
              toJSON(): { type: string };
              $from: {
                depth: number;
                node(depth: number): { type: { name: string } };
                index(depth: number): number;
              };
            };
          };
        };
      };
      const { $from } = editor.state.selection;
      const round = Array.from({ length: $from.depth + 1 }, (_, depth) => $from.node(depth).type.name);
      return `${editor.state.selection.toJSON().type} in ${round.at(-1)} at ${$from.index($from.depth)}, ${round.filter((name) => name === 'table').length} deep`;
    });

  // Down from the caption of the inner table: the cursor between blocks, after the table, in the cell.
  await place(cell.locator('figcaption'));
  await page.keyboard.press('ArrowDown');
  await expect.poll(cursor).toBe('gapcursor in tableCell at 1, 1 deep');
  // A selection and no content: the shared document holds what it held.
  expect(shared()).toBe(before);
  // From there the menu of the table round the cell is reached, and acts on it.
  await page.keyboard.press('Alt+F10');
  await expect(
    doc
      .locator('figure')
      .first()
      .locator(':scope > [data-block-controls]')
      .getByRole('button', { name: 'Table' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(doc).toBeFocused();
  await expect.poll(cursor).toBe('gapcursor in tableCell at 1, 1 deep');
  // The first letter makes the paragraph, as the writer's own change.
  await page.keyboard.type('beside');
  await expect(cell.locator(':scope > p')).toHaveText('beside');
  await expect(cell.locator(':scope > :last-child')).toHaveJSProperty('tagName', 'P');
  await expect.poll(shared).toContain('<paragraph>beside</paragraph></tablecell>');
  await expect(cell.locator('table td')).toHaveCount(4);
  await expect(cell.locator('figcaption')).toHaveText('inner caption');
  // One undo takes the paragraph away, and the cell is as the other client made it.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cell.locator(':scope > p')).toHaveCount(0);
  await expect.poll(shared).toBe(before);

  // Right at the end of the caption does the same.
  await placeAtEnd(cell.locator('figcaption'));
  await page.keyboard.press('ArrowRight');
  await expect.poll(cursor).toBe('gapcursor in tableCell at 1, 1 deep');
  // Up from the first row of the inner table, and Left at the start of its
  // first cell: the cursor before the table, in the cell.
  await place(cell.locator('table td').nth(1));
  await page.keyboard.press('ArrowUp');
  await expect.poll(cursor).toBe('gapcursor in tableCell at 0, 1 deep');
  await place(cell.locator('table td').first());
  // Left through the two letters of the cell, and once more at its start: a
  // key is pressed only once the editor holds the cursor where the last put it.
  await expect(async () => {
    if ((await held(cell.locator('table td').first())).inside) await page.keyboard.press('ArrowLeft');
    expect(await cursor()).toBe('gapcursor in tableCell at 0, 1 deep');
  }).toPass({ intervals: [20, 50] });
  await page.keyboard.type('before');
  await expect(cell.locator(':scope > :first-child')).toHaveText('before');
  // With text of its own before the table, the keys are the library's again:
  // Up from the first row goes to that text.
  await place(cell.locator('table td').first());
  await page.keyboard.press('ArrowUp');
  await expect.poll(cursor).toMatch(/^text in paragraph at \d, 1 deep$/);
  // And in the second row of the inner table, Up stays in that table.
  await place(cell.locator('table td').nth(2));
  await page.keyboard.press('ArrowUp');
  await expect.poll(cursor).toMatch(/^text in paragraph at \d, 2 deep$/);
  await screens(page, 'editor-beside-table');
  other.close();
  expect(faults).toEqual([]);
});

// The third review: the library makes the document itself without asking the
// schema. Text directly in it closed the document in every tab, and a row was
// shown as a table that the next keystroke wrote over it as the member's own.
test('what another client puts directly in the document where it cannot stand is taken out alone, and is not the member’s to undo', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(String(error)));
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  await expect(status(page, 'In sync')).toBeVisible();
  const hostile = await connectAs(page.context(), id);
  await holds(hostile, 'Written before.');
  const fragment = hostile.provider.document.getXmlFragment('default');
  const held = () => fragment.toArray().map((each) => (each as Y.XmlElement).nodeName ?? 'text');
  await expect.poll(held).toEqual(['paragraph']);
  hostile.provider.document.transact(() => {
    fragment.push([paragraph('KEEP-THIS')]);
    fragment.insert(1, [
      element('tableRow', {}, [cellWith({}, 'stray-row')]),
      words('stray-text'),
      cellWith({}, 'stray-cell'),
    ]);
  });
  // The three are gone from the shared document, and their neighbours stand.
  await expect.poll(held).toEqual(['paragraph', 'paragraph']);
  await expect(text(page)).toContainText('Written before.');
  await expect(text(page)).toContainText('KEEP-THIS');
  await expect(text(page)).not.toContainText('stray');
  await expect(text(page).locator('table')).toHaveCount(0);
  await expect(page.getByText('This document could not be shown')).toHaveCount(0);

  // Undo is the member's own: it takes back what the member typed, and brings no stray back.
  await placeAtEnd(text(page).getByText('KEEP-THIS'));
  await page.keyboard.type(' typed');
  await expect(text(page)).toContainText('KEEP-THIS typed');
  for (let presses = 0; presses < 4; presses += 1) await page.keyboard.press('ControlOrMeta+z');
  await expect(text(page)).not.toContainText('typed');
  await expect(text(page)).toContainText('KEEP-THIS');
  await expect(text(page)).not.toContainText('stray');
  await expect(status(page, 'In sync')).toBeVisible();
  // Four presses took back everything the member wrote, the first paragraph
  // among it: what is left is the other client's paragraph, and nothing else.
  await expect.poll(held).toEqual(['paragraph']);
  expect(fragment.toString()).not.toContain('stray');
  expect(fragment.toString()).toContain('KEEP-THIS');
  expect(faults).toEqual([]);
  hostile.close();
  await page.reload();
  await expect(text(page)).toContainText('KEEP-THIS');
  await expect(text(page)).not.toContainText('stray');
});

// The third review: a megabyte of code was a second and a half at each keystroke.
test('a code block past the bound is shown without the colours of its language, and is the same block otherwise', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await enter(page);
  const id = await openNew(page);
  const peer = await connectAs(page.context(), id);
  const line = 'const a = "b" + 1; // c\n';
  const long = line.repeat(Math.ceil(50_001 / line.length));
  peer.provider.document
    .getXmlFragment('default')
    .push([
      element('codeBlock', { language: 'javascript' }, [words(line.repeat(3))]),
      element('codeBlock', { language: 'javascript' }, [words(long)]),
      paragraph('END-OF-DOCUMENT'),
    ]);
  await expect(text(page)).toContainText('END-OF-DOCUMENT', { timeout: 30_000 });
  const blocks = text(page).locator('pre code');
  await expect(blocks).toHaveCount(2);
  // The short one has its colours, and the long one none; both say their language.
  await expect.poll(() => blocks.nth(0).locator('span').count()).toBeGreaterThan(5);
  expect(await blocks.nth(1).locator('span').count()).toBe(0);
  await expect(page.getByLabel('Language')).toHaveCount(2);
  for (const at of [0, 1]) await expect(page.getByLabel('Language').nth(at)).toHaveValue('javascript');
  // Every character of it is there, and it is written in as any block is.
  expect(await blocks.nth(1).evaluate((element) => element.textContent!.length)).toBe(long.length);
  await blocks.nth(1).click({ position: { x: 5, y: 5 } });
  await page.keyboard.type('typed-in ');
  await expect(blocks.nth(1)).toContainText('typed-in ');
  await expect(status(page, 'In sync')).toBeVisible();
  const stored = peer.provider.document
    .getXmlFragment('default')
    .toArray()
    .filter((each) => (each as Y.XmlElement).nodeName === 'codeBlock')[1] as Y.XmlElement;
  await expect.poll(() => stored.toString().length).toBeGreaterThan(long.length + 'typed-in '.length);
  expect(stored.getAttribute('language')).toBe('javascript');
  peer.close();
});

// The owner's decision R23 of 12 October 2026 (specification row D133):
// "50,000, and say so in the block's header". The block was shown without its
// colours, and nothing said so.
test('the header of a code block says that the block is shown without colours while it is past 50,000 characters, to every reader, and stops when it is not', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  // Written out here, and not taken from the code under test. The owner approved the words on 13 October 2026.
  const WORDS = 'Syntax colours are not shown in a code block longer than 50,000 characters.';
  const person = await enter(page);
  const id = await openNew(page);
  const peer = await connectAs(page.context(), id);
  const fragment = peer.provider.document.getXmlFragment('default');
  // Two blocks of code as it is written: one of 50,000 characters to the letter, and one of 50,001.
  const code = 'const a = "b" + 1; // c\n'.repeat(3000).slice(0, 50_000);
  expect(code).toHaveLength(50_000);
  fragment.push([
    element('codeBlock', { language: 'javascript' }, [words(code)]),
    element('codeBlock', { language: 'javascript' }, [words(`${code}Z`)]),
    paragraph('END-OF-DOCUMENT'),
  ]);
  const doc = text(page);
  await expect(doc).toContainText('END-OF-DOCUMENT', { timeout: 30_000 });
  const blocks = doc.locator('.ekd-code');
  await expect(blocks).toHaveCount(2);
  const said = (within: Locator) => within.locator('.ekd-code-header').getByText(WORDS, { exact: true });
  await expect(said(blocks.nth(0))).toHaveCount(0);
  await expect(said(blocks.nth(1))).toBeVisible();
  // A statement that stands, in the header with the block's controls, and no
  // announcement: it is in no live region, and the one live region of the
  // header, which says that the code was copied, is empty.
  await expect(blocks.nth(1)).toMatchAriaSnapshot(`
    - combobox "Code language"
    - button "Copy"
    - status
    - text: ${WORDS}
  `);
  expect(
    await said(blocks.nth(1)).evaluate((element) => element.closest('[role="status"], [aria-live]')),
  ).toBeNull();
  await expectNoSidewaysScroll(page);
  await screens(page, 'editor-code-uncoloured');

  // A second reader of the document is told the same.
  const second = await browser.newContext();
  const other = await second.newPage();
  await other.goto('/sign-in');
  await signIn(other, person);
  await expect(other.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await other.goto(page.url());
  const theirs = text(other).locator('.ekd-code');
  await expect(theirs).toHaveCount(2, { timeout: 30_000 });
  await expect(said(theirs.nth(0))).toHaveCount(0);
  await expect(said(theirs.nth(1))).toBeVisible();

  // A letter more in the block that was at the length, and it says so too; the
  // letter taken away again, and it stops. The same in the other reader's page.
  const first = fragment
    .toArray()
    .filter((each) => (each as Y.XmlElement).nodeName === 'codeBlock')[0] as Y.XmlElement;
  (first.get(0) as Y.XmlText).insert(50_000, 'Z');
  await expect(said(blocks.nth(0))).toBeVisible();
  await expect(said(theirs.nth(0))).toBeVisible();
  (first.get(0) as Y.XmlText).delete(50_000, 1);
  await expect(said(blocks.nth(0))).toHaveCount(0);
  await expect(said(theirs.nth(0))).toHaveCount(0);
  // And by the writer's own key: the last letter of the longer block deleted, in the page.
  await placeAtEnd(blocks.nth(1).locator('code'));
  await page.keyboard.press('Backspace');
  await expect(said(blocks.nth(1))).toHaveCount(0);
  await expect(said(theirs.nth(1))).toHaveCount(0);
  await page.keyboard.type('Y');
  await expect(said(blocks.nth(1))).toBeVisible();
  await expect(said(theirs.nth(1))).toBeVisible();
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  await second.close();
  peer.close();

  // In a view that cannot be edited the statement is there as well: the
  // connection is lost, and the document is read-only until it returns.
  await stopCollab();
  try {
    await expect(status(page, /^Not connected\./)).toBeVisible({ timeout: 15_000 });
    await expect(doc).toHaveAttribute('aria-readonly', 'true');
    await expect(said(blocks.nth(1))).toBeVisible();
    await expect(said(blocks.nth(0))).toHaveCount(0);
  } finally {
    await startCollab();
  }
});

// Register row D183: "A colouring of a code block that fails, or that takes
// too long, shows the block without syntax colours." The review of pull
// request 34 found content whose colouring threw, so that the document could
// not be shown, and content whose colouring took seconds at each key. Here the
// faults are put into the page instead: the regular expressions of the
// colouring (global and multiline) throw on code that holds COLOURING-THROWS,
// and take 400 ms on each new code that holds COLOURING-SLOW.
test('a code block whose colouring throws or takes too long is shown without colours, its header says so, and the document stays open and editable; an honest block keeps its colours', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Written out here, and not taken from the code under test. The words are the owner's to approve.
  const WORDS =
    'Syntax colours are not shown in this code block. Colouring its code took too long or could not complete.';
  await page.addInitScript(() => {
    const exec = RegExp.prototype.exec;
    const fault = { slow: 0, last: '' };
    (window as unknown as { __colouring: typeof fault }).__colouring = fault;
    RegExp.prototype.exec = function (this: RegExp, given: string) {
      if (this.global && this.multiline && typeof given === 'string') {
        if (given.includes('COLOURING-THROWS')) throw new Error('A fault put in by the test.');
        if (given.includes('COLOURING-SLOW') && given !== fault.last) {
          fault.last = given;
          fault.slow += 1;
          const until = performance.now() + 400;
          while (performance.now() < until);
        }
      }
      return exec.call(this, given);
    };
  });
  const slowCount = () =>
    page.evaluate(() => (window as unknown as { __colouring: { slow: number } }).__colouring.slow);
  await enter(page);
  const id = await openNew(page);
  const peer = await connectAs(page.context(), id);
  const fragment = peer.provider.document.getXmlFragment('default');
  // The honest block first: a pass that has spent its budget, as the slow
  // block spends it, tries no block after it (CODE_COLOURS_PASS_LONGEST).
  fragment.push([
    element('codeBlock', { language: 'javascript' }, [words('const honest = "kept";')]),
    element('codeBlock', { language: 'javascript' }, [
      words('function f(g) {\n  return "COLOURING-THROWS";\n}'),
    ]),
    element('codeBlock', { language: 'javascript' }, [words('const slow = "COLOURING-SLOW";')]),
    paragraph('END-OF-DOCUMENT'),
  ]);
  const doc = text(page);
  await expect(doc).toContainText('END-OF-DOCUMENT', { timeout: 30_000 });
  const blocks = doc.locator('.ekd-code');
  await expect(blocks).toHaveCount(3);
  const [kept, thrown, slow] = [blocks.nth(0), blocks.nth(1), blocks.nth(2)];
  const said = (within: Locator) => within.locator('.ekd-code-header').getByText(WORDS, { exact: true });
  const colours = (within: Locator) => within.locator('code [class*="hljs-"]');
  await expect(doc).toContainText('COLOURING-THROWS');
  await expect(said(thrown)).toBeVisible();
  await expect(colours(thrown)).toHaveCount(0);
  await expect(said(slow)).toBeVisible();
  await expect(colours(slow)).toHaveCount(0);
  await expect(said(kept)).toHaveCount(0);
  await expect(colours(kept).first()).toBeVisible();
  expect(await colours(kept).count()).toBeGreaterThan(1);
  // A statement that stands, with the controls of the header, in no live region.
  await expect(thrown).toMatchAriaSnapshot(`
    - combobox "Code language"
    - button "Copy"
    - status
    - text: ${WORDS}
  `);
  expect(
    await said(thrown).evaluate((element) => element.closest('[role="status"], [aria-live]')),
  ).toBeNull();
  expect(await slowCount()).toBe(1);

  // Editable: keys typed in the slow block are not coloured again, so none of
  // them waits for the 400 ms; and they reach the other client.
  await placeAtEnd(slow.locator('code'));
  const times = await keyTimes(page, 'abc');
  console.log(`a key in a block whose colouring took too long: ${times.join(', ')} ms`);
  expect(Math.max(...times)).toBeLessThan(400);
  expect(await slowCount()).toBe(1);
  await expect(slow).toContainText('"COLOURING-SLOW";abc');
  await expect(said(slow)).toBeVisible();
  await expect(colours(slow)).toHaveCount(0);
  await expect.poll(() => fragment.toString()).toContain('COLOURING-SLOW";abc');
  // And in the honest block, which keeps its colours, and the others still have none.
  await placeAtEnd(kept.locator('code'));
  await page.keyboard.type(' // more');
  await expect(kept).toContainText('"kept"; // more');
  await expect(kept.locator('code .hljs-comment')).toHaveText('// more');
  await expect(said(kept)).toHaveCount(0);
  await expect(colours(thrown)).toHaveCount(0);
  await expect(colours(slow)).toHaveCount(0);
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => fragment.toString()).toContain('// more');
  await expectNoSidewaysScroll(page);
  await screens(page, 'editor-code-not-coloured');
  peer.close();
});

// The owner's decision of 12 October 2026. Before it the member was told
// nothing: the connection closed, the page asked again and was refused again,
// and the change was lost at the next load.
test('a change that would take the document past a limit is said in words that name the limit; the text can be copied, nothing of it is stored, and no one else sees it', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Written before.');
  await expect(status(page, 'In sync')).toBeVisible();
  const other = await connectAs(page.context(), id);
  await holds(other, 'Written before.');
  const seen = () => other.provider.document.getXmlFragment('default').toString();
  await expect.poll(seen).toContain('Written before.');
  const BODY =
    'The server did not take the change, and the document is read-only in this tab. The changes that were not sent are shown here and nowhere else. Copy the text to keep it, then reload the document from the server. Reloading discards the changes that were not sent.';

  // An honest paste: quotations from another page, 50 deep (a list is held to
  // 10 levels by the browser, D192, and is refused before it is sent).
  const nested = (levels: number): string =>
    levels === 0 ? '' : `<blockquote><p>level ${levels}</p>${nested(levels - 1)}</blockquote>`;
  await placeAtEnd(text(page).getByText('Written before.'));
  await page.keyboard.press('Enter');
  await paste(page, nested(50));
  const deep = page.getByRole('alert').filter({ hasText: 'A change in this tab would nest the content' });
  await expect(deep).toBeVisible({ timeout: 30_000 });
  await expect(deep.getByRole('heading')).toHaveText(
    'A change in this tab would nest the content more than 50 levels deep',
  );
  await expect(deep).toContainText(BODY);
  await expect(deep.getByRole('button')).toHaveText(['Copy text', 'Reload document']);
  // The text is still there to read and to select, and is not written in.
  await expect(text(page)).toContainText('level 1');
  await expect(text(page)).toHaveAttribute('aria-readonly', 'true');
  // The statement stands where the indicator stood: no state of the connection is shown.
  await expect(status(page, /In sync|Syncing|Restoring|Not connected|Opening/)).toHaveCount(0);
  // It is copied whole.
  await deep.getByRole('button', { name: 'Copy text' }).click();
  await expect(deep.getByRole('status')).toHaveText('Text copied.');
  const copied = await clipboardText(page);
  expect(copied).toContain('Written before.');
  expect(copied).toContain('level 50');
  expect(copied).toContain('level 1');
  // At 320 CSS pixels the statement and its two buttons are inside the page.
  // Asked of the statement and not of the page: 50 levels of quotation are wider
  // than that by themselves.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: size.height });
  for (const part of [deep, ...(await deep.getByRole('button').all())]) {
    const box = (await part.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await page.setViewportSize(size);
  // No further try: the page opens no socket and asks for nothing again.
  const sockets = countSockets(page);
  await page.waitForTimeout(5000);
  expect(sockets.count).toBe(0);
  await expect(deep).toBeVisible();
  // No one else saw any of it, and the document is as it was, for them and after a load.
  expect(seen()).not.toContain('level');
  other.provider.document.getXmlFragment('default').push([paragraph('Written by another.')]);
  await deep.getByRole('button', { name: 'Reload document' }).click();
  await expect(text(page)).toContainText('Written by another.');
  await expect(text(page)).toContainText('Written before.');
  await expect(text(page)).not.toContainText('level');
  await expect(status(page, 'In sync')).toBeVisible();

  // And by its size: a paste of five megabytes and a little.
  await placeAtEnd(text(page).getByText('Written by another.'));
  await paste(page, `<p>${'lorem ipsum '.repeat(Math.ceil((5 * 1024 * 1024 + 4096) / 12))}</p>`);
  const large = page.getByRole('alert').filter({ hasText: 'A change in this tab would make the document' });
  await expect(large).toBeVisible({ timeout: 120_000 });
  await expect(large.getByRole('heading')).toHaveText(
    'A change in this tab would make the document larger than 5 MB',
  );
  await expect(large).toContainText(BODY);
  expect(seen()).not.toContain('lorem');
  await large.getByRole('button', { name: 'Reload document' }).click();
  await expect(text(page)).toContainText('Written by another.');
  await expect(text(page)).not.toContainText('lorem');
  // The document is written in as before.
  await placeAtEnd(text(page).getByText('Written by another.'));
  await page.keyboard.type(' And after.');
  await expect(status(page, 'In sync')).toBeVisible();
  await expect.poll(seen).toContain('And after.');
  other.close();
});

// The third review of pull request 24 (S1') and the fourth: a change that
// refers to more content than the document holds, and than may wait, is
// refused with a reason and a statement of its own. The page cannot make
// such a change by itself, so the socket of the test loses the first change
// it sends, and the paste after it holds more than 2,000 structs that wait
// for it.
test('a change that refers to content the document does not hold is said so, in words of its own and not the 5 MB of another limit; the text stays, and the page does not try again', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  let lose = false;
  let lost = 0;
  await page.routeWebSocket('**/collab', (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      // The name of the document behind its length (36), a synchronisation (0), and an update (2).
      if (lose && typeof message !== 'string' && message[37] === 0 && message[38] === 2 && lost === 0) {
        lost += 1;
        return;
      }
      server.send(message);
    });
  });
  await enter(page);
  const id = await openNew(page);
  const other = await connectAs(page.context(), id);
  await text(page).click();
  lose = true;
  await page.keyboard.type('A');
  await expect.poll(() => lost).toBe(1);
  await paste(page, '<p>from a paste</p>'.repeat(1100));
  const held = page.getByRole('alert').filter({ hasText: 'A change in this tab refers to content' });
  await expect(held).toBeVisible({ timeout: 30_000 });
  await expect(held.getByRole('heading')).toHaveText(
    'A change in this tab refers to content that this document does not hold, so it cannot be applied',
  );
  // The words of the other two limits are not said.
  await expect(page.getByText('larger than 5 MB')).toHaveCount(0);
  await expect(page.getByText('levels deep')).toHaveCount(0);
  await expect(held).toContainText(
    'The server did not take the change, and the document is read-only in this tab. The changes that were not sent are shown here and nowhere else. Copy the text to keep it, then reload the document from the server. Reloading discards the changes that were not sent.',
  );
  await expect(held.getByRole('button')).toHaveText(['Copy text', 'Reload document']);
  // The text is still there, read-only, and no one else saw any of it.
  await expect(text(page)).toContainText('from a paste');
  await expect(text(page)).toHaveAttribute('aria-readonly', 'true');
  expect(fragment(other.provider)).not.toContain('from a paste');
  await held.getByRole('button', { name: 'Copy text' }).click();
  await expect(held.getByRole('status')).toHaveText('Text copied.');
  expect(await clipboardText(page)).toContain('from a paste');
  // No further try.
  const sockets = countSockets(page);
  await page.waitForTimeout(5500);
  expect(sockets.count).toBe(0);
  await expect(held).toBeVisible();
  other.close();
});

// The owner's decision of 12 October 2026: 600 messages that carry an update
// in any minute for each user, past which the collaboration server closes the
// connection (src/collab/server.ts). The server of this file keeps the number
// as it is first set. What the editor sends is counted on the socket itself.
test('fast typing and a large paste stay inside the limit of messages: a few for 300 keys, and a few for a paste of 4 MB', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // The frames of the socket (@hocuspocus/server, types.ts): the name of the
  // document, a UUID, behind its length; the type; and for a synchronisation
  // its step. An update travels in the second step and in an update.
  const type = (payload: string | Buffer) => (typeof payload === 'string' ? -1 : payload[37]!);
  const sent = { updates: 0, closed: 0 };
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      if ([0, 4].includes(type(payload)) && [1, 2].includes((payload as Buffer)[38]!)) sent.updates += 1;
    });
    // The close of the document's connection, whatever its reason.
    socket.on('framereceived', ({ payload }) => {
      if (type(payload) === 7) sent.closed += 1;
    });
  });
  await enter(page);
  const id = await openNew(page);
  const other = await connectAs(page.context(), id);
  const bytes = () => Y.encodeStateAsUpdate(other.provider.document).byteLength;
  await text(page).click();
  // The second step that answered the server when the document opened.
  expect(sent.updates).toBe(1);

  // 300 characters at 100 a second, where the fastest typists reach some 15.
  // Until 12 October 2026 this was one message for each key (300). The editor
  // now sends at once only what a bucket of 8 messages, refilled at 4 a second,
  // allows, and merges the rest into one message for each 250 ms
  // (src/lib/collab/client.ts): so 300 keys in some 3 seconds are about 8 + 4
  // a second, and every character still arrives.
  const words = 'the quick brown fox jumps over the lazy dog. '.repeat(7).slice(0, 300);
  await page.keyboard.type(words, { delay: 10 });
  await expect(status(page, 'In sync')).toBeVisible();
  await expect.poll(() => other.provider.document.getXmlFragment('default').toString()).toContain(words);
  expect(sent.updates - 1).toBeGreaterThanOrEqual(8);
  expect(sent.updates - 1).toBeLessThanOrEqual(words.length / 4);

  // A paste of 4 MB is a few messages, and not one for each of its words.
  const before = sent.updates;
  await paste(page, `<p>${'lorem ipsum '.repeat((4 * 1024 * 1024) / 12)}</p>`);
  await expect.poll(bytes, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(4 * 1024 * 1024);
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 60_000 });
  console.log(`e2e measure: ${sent.updates - before} message(s) for the paste`);
  expect(sent.updates - before).toBeLessThanOrEqual(3);

  // Never closed for the limit, or for anything else, and still written in.
  expect(sent.closed).toBe(0);
  await page.keyboard.type(' And after.');
  await expect
    .poll(() => other.provider.document.getXmlFragment('default').toString())
    .toContain('And after.');
  await expect(status(page, 'In sync')).toBeVisible();
  other.close();
});

/**
 * Counts the messages a page sends that carry an update (the second step of a
 * synchronisation and an update), and the closes it is sent, on its sockets.
 */
function countUpdates(page: Page) {
  const counted = { updates: 0, closed: 0 };
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      // The name of the document, a UUID, behind its length; the type; and the step.
      if (typeof payload !== 'string' && payload[37] === 0 && [1, 2].includes(payload[38]!))
        counted.updates += 1;
    });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' && payload[37] === 7) counted.closed += 1;
    });
  });
  return counted;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fragment = (provider: { document: Y.Doc }) => provider.document.getXmlFragment('default').toString();
/**
 * Waits for a client of the test to hold `words`. The page sends what is typed
 * in a batch where keys come fast (src/lib/collab/client.ts), up to 250 ms
 * after it, and "In sync" does not wait for the batch, so it is not yet a
 * sign that the server holds the text.
 */
const holds = (client: { provider: { document: Y.Doc } }, words: string) =>
  expect.poll(() => fragment(client.provider), { message: `the client holds ${words}` }).toContain(words);

/**
 * Stores the document as it is with `change` made to it, as a document could
 * be stored before the collaboration server held the shape of a document
 * (src/lib/collab/shape.ts), and opens it again. The page leaves it first, so
 * that the server stores what it holds and lets go of it.
 */
async function storedWith(page: Page, id: string, change: (fragment: Y.XmlFragment) => void) {
  const reader = await connectAs(page.context(), id);
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(reader.provider.document));
  reader.close();
  copy.transact(() => change(copy.getXmlFragment('default')));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await page.waitForTimeout(3500);
  storeState(id, Y.encodeStateAsUpdate(copy));
  await page.goto(`/documents/${id}`);
}

// The owner's decision of 12 October 2026: a key held down is never limited.
// The editor sends at once what a bucket of 8 messages, refilled at 4 a
// second, allows, and merges the rest into one message for each 250 ms
// (src/lib/collab/client.ts), which is 8 + 4 a second for a key that repeats
// 30 times a second, and not the 20 to 60 seconds to the 600 of the server.
test('a key held down for 30 seconds is never limited: the page does not say it is restoring, far fewer than 600 messages are sent, and another client sees every character', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const sent = countUpdates(page);
  await enter(page);
  const id = await openNew(page);
  const other = await connectAs(page.context(), id);
  await text(page).click();
  // Any look of the page at the words of the two states that a limit would show.
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { __states: string[] }).__states = []);
    const words = /Restoring the connection|Not connected/;
    setInterval(() => {
      const all =
        document.body.textContent +
        [...document.querySelectorAll('[aria-label]')]
          .map((each) => each.getAttribute('aria-label'))
          .join(' ');
      const found = words.exec(all);
      if (found) seen.push(found[0]);
    }, 20);
  });
  const before = sent.updates;

  // A key that repeats the way a keyboard does: down, and down again, 30 a second.
  const SECONDS = 30;
  const began = Date.now();
  let presses = 0;
  while (Date.now() - began < SECONDS * 1000) {
    await page.keyboard.down('x');
    presses += 1;
    await sleep(1000 / 30 - 3);
  }
  await page.keyboard.up('x');
  const elapsed = (Date.now() - began) / 1000;
  await expect(status(page, 'In sync')).toBeVisible({ timeout: 15_000 });
  console.log(
    `e2e measure: ${presses} presses in ${elapsed.toFixed(1)} s (${(presses / elapsed).toFixed(1)} a second), ${sent.updates - before} update messages`,
  );
  expect(presses).toBeGreaterThan(SECONDS * 20);
  // 8 at once, then 4 a second (the bound of src/lib/collab/client.ts), and a little over for the last batch.
  expect(sent.updates - before).toBeLessThanOrEqual(8 + 4 * Math.ceil(elapsed) + 2);
  expect(sent.updates - before).toBeLessThan(600 / 2);
  expect(sent.closed).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __states: string[] }).__states)).toEqual([]);
  // Every character arrived: the other client holds as many as the key made.
  await expect.poll(() => (fragment(other.provider).match(/x/g) ?? []).length).toBe(presses);
  other.close();
});

test('the last keys before the tab is closed are sent, although they wait for their batch', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await enter(page);
  const id = await openNew(page);
  const other = await connectAs(page.context(), id);
  await text(page).click();
  // The timer of a batch (250 ms) never fires in this page, as in a tab that is
  // closed before it does: only the page's leaving can send what waits.
  await page.evaluate(() => {
    const set = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) =>
      ms === 250 ? 0 : set(handler, ms, ...rest)) as typeof window.setTimeout;
  });
  // 60 keys with no pause empty the bucket of 8; the rest wait for a batch.
  const keys = 'abcdefghijklmnopqrstuvwxyz'.repeat(2).slice(0, 60);
  await page.keyboard.type(keys);
  await sleep(500);
  expect(fragment(other.provider)).not.toContain(keys);
  // What a browser does when a tab is closed: the page is hidden, then left.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => fragment(other.provider)).toContain(keys);
  other.close();
});

// The first measurement of the row "Yjs sync propagation to collaborator" of
// SRS section 2.4 (P50 under 150 ms, P99 under 400 ms; NFR-PE-01). One page
// types and a client of the test, on the same machine, receives. It is the
// browser's keydown to the arrival of the change, on the loopback: no network.
test('a single keystroke reaches another client in well under the 150 ms of the budget', async ({ page }) => {
  test.setTimeout(90_000);
  await enter(page);
  const id = await openNew(page);
  const other = await connectAs(page.context(), id);
  await text(page).click();
  await page.evaluate(() => {
    const keydowns: number[] = ((window as unknown as { __keydowns: number[] }).__keydowns = []);
    document.addEventListener('keydown', () => keydowns.push(Date.now()), true);
  });
  const arrived: number[] = [];
  other.provider.document.on('update', () => arrived.push(Date.now()));
  const delays: number[] = [];
  for (let n = 0; n < 20; n += 1) {
    const heard = arrived.length;
    await page.keyboard.press('x');
    await expect.poll(() => arrived.length).toBeGreaterThan(heard);
    const keydowns = await page.evaluate(() => (window as unknown as { __keydowns: number[] }).__keydowns);
    delays.push(arrived[heard]! - keydowns.at(-1)!);
    // A pause that fills the bucket again, and is longer than a person's between two keys.
    await sleep(700);
  }
  delays.sort((a, b) => a - b);
  const median = (delays[9]! + delays[10]!) / 2;
  console.log(`e2e measure: single keystroke to another client, ms: ${delays.join(' ')}; median ${median}`);
  expect(median).toBeLessThan(150);
  expect(delays.at(-1)!).toBeLessThan(400);
  other.close();
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
    'This document could not be shownEkdotico could not build the content of the document in this browser, so the document is closed in this tab. Nothing in the document was changed.Documents',
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
  await statement.getByRole('link', { name: 'Documents', exact: true }).click();
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

// Register D182, D184, D192, D193 and Q45: the limits of a document refuse a
// change at the moment it is made, and never honest editing.
const REFUSED = /We cannot|We could not|This document holds|could not be shown/;

test('honest editing is never refused: typing, a paste of ordinary content, and undo and redo', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await enter(page);
  const id = await openNew(page);
  const other = await connectAs(page.context(), id);
  await text(page).click();
  await page.keyboard.type('First line, typed.');
  await page.keyboard.press('Enter');
  await paste(page, EVERYTHING);
  await paste(
    page,
    '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><blockquote><p>quoted</p></blockquote><pre><code>let x = 1;</code></pre><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
  );
  await page.keyboard.type(' typed after.');
  for (let times = 0; times < 3; times += 1) await page.keyboard.press('ControlOrMeta+z');
  for (let times = 0; times < 3; times += 1) await page.keyboard.press('ControlOrMeta+Shift+Z');
  await page.keyboard.type(' The end.');
  await holds(other, 'The end.');
  await expect(status(page, 'In sync')).toBeVisible();
  await expect(text(page)).toHaveAttribute('aria-readonly', 'false');
  await expect(text(page)).toContainText('nested');
  await expect(page.getByText(REFUSED)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: /We cannot apply this change|A change in this tab/ }),
  ).toHaveCount(0);
  other.close();
});

test('a document stored with more than 100 tables opens to deletions alone, says so, and is written in once it is back under', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await enter(page);
  const id = await openNew(page);
  await storedWith(page, id, (fragment) => {
    const tables = Array.from({ length: 101 }, () => {
      const block = new Y.XmlElement('tableBlock');
      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');
      const cell = new Y.XmlElement('tableCell');
      cell.insert(0, [new Y.XmlElement('paragraph')]);
      row.insert(0, [cell]);
      table.insert(0, [row]);
      block.insert(0, [table, new Y.XmlElement('tableCaption')]);
      return block;
    });
    fragment.push(tables);
  });
  const statement =
    'This document holds 101 tables, more than our current limit per document (100). It is read-only until it is back under the limit. You can still delete tables.';
  await expect(page.getByText(statement)).toHaveCount(1);
  await text(page).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('refused');
  await expect(text(page)).not.toContainText('refused');
  // Said again, where a refusal is seen and where it is heard.
  await expect(page.getByText(statement)).toHaveCount(3);
  // Every table deleted: the document is back under, and written in.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(page.getByText(statement)).toHaveCount(0);
  await page.keyboard.type('written again');
  await expect(text(page)).toContainText('written again');
  await expect(status(page, 'In sync')).toBeVisible();
});
