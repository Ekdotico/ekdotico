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
  const language = doc.getByRole('combobox', { name: 'Language' });
  await expect(language).toHaveValue('typescript');
  await expect(doc.locator('pre .hljs-keyword')).toHaveText('const');
  await expect(doc.locator('pre')).toHaveAttribute('spellcheck', 'false');
  await language.selectOption('python');
  await expect(doc.locator('pre code')).toHaveClass(/language-python/);
  await doc.getByRole('button', { name: 'Copy' }).click();
  await expect(doc.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const answer: number = 42;');

  // FR-ED-04: three variants, chosen after the callout is there.
  await expect(doc.getByRole('note', { name: 'Warning' })).toContainText('Take care.');
  await doc.getByRole('radio', { name: 'Tip' }).check();
  await expect(doc.getByRole('note', { name: 'Tip' })).toContainText('Take care.');
  await expect(doc.locator('.callout')).toHaveAttribute('data-type', 'tip');

  // FR-ED-06: the entries follow the headings and the depth, and each goes to its heading.
  const contents = doc.getByRole('navigation', { name: 'Table of contents' });
  await expect(contents.getByRole('link')).toHaveText(['Heading one', 'Heading two']);
  await contents.getByRole('radio', { name: 'Levels 1 to 3' }).check();
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
    'Enter an address that begins with https://, http://, or mailto:',
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
  await expect(doc.getByRole('combobox', { name: 'Language' })).toHaveValue('python');
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
  const languages = text(page).getByRole('combobox', { name: 'Language' });
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
    const languages = text(page).getByRole('combobox', { name: 'Language' });
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

test('a table past the bound of the schema is not laid out, and the page answers', async ({ page }) => {
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
  hostile.close();
  await expect(text(page)).toContainText('The end.');
  await expect(text(page).locator('table')).toHaveCount(0);
  await placeAtEnd(text(page).getByText('The end.'));
  await page.keyboard.type(' Written after.');
  await expect(text(page)).toContainText('The end. Written after.');
  await page.reload();
  await expect(text(page)).toContainText('The end. Written after.');
  await expect(text(page).locator('table')).toHaveCount(0);
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
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('some code');
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
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'some code\n\nSome words. Not sent.',
    );
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
    'The document is closed in this tab. Changes that were not yet sent were discarded.',
  );
  await expect(statement.getByRole('link', { name: 'Open the list of documents' })).toHaveAttribute(
    'href',
    '/',
  );
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
    const restoring = status(page, /^Restoring the connection\. Changes are kept in this tab/);
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
    const lost = status(page, /^Not connected\. The document is read-only until the connection returns\./);
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
