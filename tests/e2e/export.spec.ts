// The Markdown draft export (FR-EX-01 (a), FR-EX-02, FR-EX-36, FR-ED-40 (g), FR-ED-44, NFR-PE-01, NFR-I18-03,
// NFR-I18-04, NFR-IC-19; docs/plan/slice-21.md), against the production build, the real collaboration server,
// which this file starts and stops, and the local object store that the run is given (IMAGE_STORAGE_*). What a
// person writes in the editor is reloaded, exported with the button, and unzipped; what a download that fails
// looks like to a browser is asked of the browser.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { deflateSync } from 'node:zlib';
import { png, pngChunk } from '../unit/image-fixtures.ts';
import { readZip } from '../unit/zip-reader.ts';
import { expect, test, type Page } from './fixtures.ts';
import { expectNoSidewaysScroll, mailFor, newPerson, screens, signUp, type Person } from './account.ts';
import { startCollab, stopCollab } from './collab.ts';
import { APP_ORIGIN, APP_PORT, AUTH_SECRET } from './origin.ts';
import { INVITATION_LINK, invite, shareNew } from './sharing.ts';

// Skipped on a machine with no store; under CI the tests run, and fail where no store was given.
test.skip(
  !process.env.IMAGE_STORAGE_ENDPOINT && process.env.CI !== 'true',
  'No object store is given to this run (IMAGE_STORAGE_*): the application stores no image.',
);
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => startCollab());
test.afterAll(stopCollab);

// The fixed texts, written out here and not taken from the code under test.
const EXPORT = 'Export as Markdown';
const WORKING = 'Preparing the export…';
const READY = 'The export is ready. Your browser is saving the file.';
const BUSY = 'An export of yours is already under way. Wait until it has finished, then try again.';
const FAILED = 'The export did not complete, and no file was saved. Try again.';
const NOTE = 'Draft export — not a provenance-sealed document.';

const text = (page: Page) => page.getByRole('textbox', { name: 'Document text' });
const inSync = (page: Page) => expect(page.getByRole('button', { name: 'In sync' })).toBeVisible();
const exportButton = (page: Page) => page.getByRole('button', { name: EXPORT });

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
async function choose(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Choose an image' }).click(),
  ]);
  await chooser.setFiles([file]);
}
const exportUrl = (id: string) => `/api/documents/${id}/export/draft`;
/** The export asked for with the page's own session, as the button asks; the archive read to its end. */
async function archiveBy(page: Page, id: string) {
  const response = await page.request.post(exportUrl(id), { headers: { origin: APP_ORIGIN } });
  return { status: response.status(), body: await response.body() };
}
function run(script: string, ...args: string[]) {
  const ran = spawnSync('node', [`tests/e2e/${script}`, ...args], {
    env: {
      ...process.env,
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN,
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(ran.status, ran.stderr).toBe(0);
}

// NFR-I18-03, NFR-I18-04: the scripts of the criterion.
const EVERYTHING = 'Café naïve Ångström — Εκδοτικό Ελληνικά — 論文 日本語 한국어 — مرحبا بالعالم — 📚 🙂 👩‍💻';

test('exports what was written, reloaded: an archive named from the title, with the text, the image, the footnote and every code point', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  const id = await openNew(page);
  // No colon in it: the browser renames a download with one, on its platform's rules (register row S21-2).
  const title = `Thesis ${EVERYTHING.slice(0, 20)} 論文`;
  const renamed = await page.request.patch(`/api/documents/${id}`, {
    data: { title },
    headers: { origin: APP_ORIGIN },
  });
  expect(renamed.status()).toBe(200);

  await text(page).click();
  await page.keyboard.type(`${EVERYTHING} `);
  await page.keyboard.type('/footnote');
  await expect(page.getByRole('listbox', { name: 'Blocks' }).getByRole('option').first()).toContainText(
    'Footnote',
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type(`Note: ${EVERYTHING}`);
  const picture = png();
  await choose(page, { name: 'plate.png', mimeType: 'image/png', buffer: picture });
  await expect(page.getByText('Image added')).toBeVisible();
  await page.getByRole('textbox', { name: 'Alt text' }).fill(`Alt: ${EVERYTHING}`);
  await page.getByRole('textbox', { name: 'Caption (optional)' }).fill(`Caption: ${EVERYTHING}`);
  await inSync(page);

  // The export reads the stored state, which is stored within a few seconds of the last change (NFR-RE-07).
  await expect
    .poll(async () => (await archiveBy(page, id)).body.includes(Buffer.from('Caption: ')), {
      timeout: 20_000,
      intervals: [1500, 2000, 3000],
    })
    .toBe(true);

  // Reloaded.
  await page.goto(`/documents/${id}`);
  await expect(text(page)).toContainText(EVERYTHING);
  await expect(exportButton(page)).toBeVisible();
  await expect(exportButton(page)).toBeEnabled();

  // The page states that the export is under way within 500 ms of the press (NFR-PE-01), the response being held back.
  await page.route('**/export/draft', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const downloading = page.waitForEvent('download');
  await exportButton(page).click();
  await expect(page.getByRole('button', { name: WORKING })).toBeVisible({ timeout: 500 });
  const download = await downloading;
  await page.unroute('**/export/draft');
  await expect(page.getByText(READY)).toBeVisible();
  // FR-AU-88, WCAG 2.2 AA (1.4.10): the control and its statement fit a width of 320 pixels.
  await expectNoSidewaysScroll(page);
  await screens(page, 'export-draft');

  // Named from the title by the rule: nothing in it is to be removed.
  expect(download.suggestedFilename()).toBe(`${title}.zip`);
  const entries = readZip(readFileSync((await download.path())!));
  expect(entries.map((each) => each.name)).toEqual([`${title}.md`, 'images/001.png']);
  expect(entries[1]!.bytes.equals(picture)).toBe(true);

  const file = entries[0]!.bytes.toString('utf8');
  expect(file.startsWith('---\n')).toBe(true);
  expect(file).toContain('draft: true\n---\n');
  expect(file).toContain(`> ${NOTE}`);
  expect(file).toContain(`id: ${id}`);
  expect(file).toContain('![Alt: ');
  expect(file).toContain('](images/001.png)');
  expect(file).toContain('[^1]');
  expect(file).toContain('[^1]: Note: ');
  // Every code point of the sample, in the paragraph, the footnote, the alt text and the caption (four times).
  for (const codePoint of new Set(Array.from(EVERYTHING))) {
    if (/[\s—]/u.test(codePoint)) continue;
    const found = Array.from(file).filter((each) => each === codePoint).length;
    expect(found, `U+${codePoint.codePointAt(0)!.toString(16)} ${codePoint}`).toBeGreaterThanOrEqual(4);
  }
  // The title, in the front matter, is the title.
  expect(file).toContain(`title: "${title}"`);
});

test('a role that holds the permission has the button, and one that does not has none: it comes and goes with the Owner`s change, with no reload', async ({
  page,
  browser,
}) => {
  test.slow();
  await enter(page);
  const id = await shareNew(page);
  const viewer = newPerson();
  const other = await browser.newContext({ acceptDownloads: true });
  const theirs = await other.newPage();
  await enter(theirs, viewer);
  await invite(page, [viewer.email], 'Viewer');
  const { found: link } = await mailFor(viewer.email, INVITATION_LINK);
  await theirs.goto(new URL(link).pathname);
  await theirs.getByRole('button', { name: 'Accept' }).click();
  await theirs.waitForURL(`**/documents/${id}`);
  await inSync(theirs);

  await page.goto(`/documents/${id}`);
  await expect(exportButton(page)).toBeVisible();
  // A Viewer has no draft export by default (FR-ED-44), and the route says so.
  await expect(exportButton(theirs)).toHaveCount(0);
  expect((await theirs.request.post(exportUrl(id), { headers: { origin: APP_ORIGIN } })).status()).toBe(403);

  const change = (allowed: boolean) =>
    page.request.put(`/api/documents/${id}/permissions`, {
      data: { changes: { 'document.export.draft': { viewer: allowed } } },
      headers: { origin: APP_ORIGIN },
    });
  expect((await change(true)).status()).toBe(200);
  // The Viewer's open page is told, and has the button without a reload.
  await expect(exportButton(theirs)).toBeVisible({ timeout: 15_000 });
  const downloading = theirs.waitForEvent('download');
  await exportButton(theirs).click();
  expect((await downloading).suggestedFilename()).toBe('Untitled document.zip');

  expect((await change(false)).status()).toBe(200);
  await expect(exportButton(theirs)).toHaveCount(0, { timeout: 15_000 });
  await other.close();
});

test('a download that fails midway is a failed download, and the next export is admitted at once', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  const id = await openNew(page);
  await text(page).click();
  await page.keyboard.type('Before the image. ');
  await choose(page, { name: 'plate.png', mimeType: 'image/png', buffer: png() });
  await expect(page.getByText('Image added')).toBeVisible();
  await inSync(page);
  await expect
    .poll(async () => (await archiveBy(page, id)).body.includes(Buffer.from('images/001.png')), {
      timeout: 20_000,
      intervals: [1500, 2000, 3000],
    })
    .toBe(true);

  // The object is gone from the store and the row is not: the Markdown is sent, and then the image cannot be read.
  run('delete-objects.ts', id);
  // The server aborted the connection: what the client gets is an error and not a file that looks whole.
  await expect(page.request.post(exportUrl(id), { headers: { origin: APP_ORIGIN } })).rejects.toThrow(
    /aborted|socket|reset/iu,
  );

  // In the page: a statement, and no file.
  await page.goto(`/documents/${id}`);
  let saved = false;
  page.on('download', () => (saved = true));
  await exportButton(page).click();
  await expect(page.getByText(FAILED)).toBeVisible({ timeout: 15_000 });
  // The statement takes the focus, as every refusal of a page does (WCAG 3.3.1), and the page does not scroll sideways.
  await expect(page.getByRole('alert').filter({ hasText: FAILED })).toBeFocused();
  await expectNoSidewaysScroll(page);
  await screens(page, 'export-draft-failed');
  expect(saved).toBe(false);
  // And nothing is held: the button works again, and the lock is not.
  await expect(exportButton(page)).toBeEnabled();
});

// ── A client that stops reading, on the real server ─────────────────────────

/** A valid PNG of about `bytes`, of data that does not shrink. */
function bigPng(bytes: number): Buffer {
  const width = 2000;
  const height = Math.ceil(bytes / (width * 3));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 0 })),
    pngChunk('IEND'),
  ]);
}

test('a client that stops reading does not hold the export: its resources go at the idle period, and the next export is admitted', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await enter(page);
  const id = await openNew(page);
  await choose(page, { name: 'big.png', mimeType: 'image/png', buffer: bigPng(14 * 1024 * 1024) });
  await expect(page.getByText('Image added')).toBeVisible({ timeout: 60_000 });
  await inSync(page);
  await expect
    .poll(async () => (await archiveBy(page, id)).body.length > 10_000_000, {
      timeout: 60_000,
      intervals: [2000, 3000],
    })
    .toBe(true);

  const cookie = (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
  const events: string[] = [];
  const request = httpRequest({
    host: '127.0.0.1',
    port: Number(APP_PORT),
    method: 'POST',
    path: exportUrl(id),
    headers: { origin: APP_ORIGIN, cookie },
  });
  let status = 0;
  let received = 0;
  let stalled: IncomingMessage | undefined;
  request.on('response', (response) => {
    status = response.statusCode ?? 0;
    stalled = response;
    // Takes the headers and nothing more.
    response.pause();
    response.on('data', (chunk: Buffer) => (received += chunk.length));
    response.on('aborted', () => events.push('aborted'));
    response.on('close', () => events.push('close'));
    response.on('error', () => events.push('error'));
  });
  request.on('error', () => events.push('request error'));
  request.end();
  await expect.poll(() => status, { timeout: 15_000 }).toBe(200);
  const began = Date.now();

  // While it is under way, a second export of the same user is refused.
  const second = await page.request.post(exportUrl(id), { headers: { origin: APP_ORIGIN } });
  expect(second.status()).toBe(429);
  expect((await second.json()).error.message).toBe(BUSY);

  // The idle period of the run is 3 seconds (playwright.config.ts): after it, the export holds nothing.
  await expect
    .poll(
      async () => (await page.request.post(exportUrl(id), { headers: { origin: APP_ORIGIN } })).status(),
      {
        timeout: 30_000,
        intervals: [1000],
      },
    )
    .toBe(200);
  const freeAt = Date.now() - began;
  expect(freeAt).toBeLessThan(15_000);
  test.info().annotations.push({ type: 'lock free after', description: `${freeAt} ms` });

  // The client that stopped reading does not get a file that looks whole when it reads on: the response was ended
  // as a failure, and it meets an aborted connection before the 14 MB are in. (The socket itself is the server's
  // framework's to close, and is closed when the client reads or goes: docs/plan/slice-21.md, row S21-9.)
  stalled!.resume();
  await expect.poll(() => events.join('+'), { timeout: 30_000 }).toMatch(/aborted|error/u);
  expect(received).toBeLessThan(14 * 1024 * 1024);
  request.destroy();
});
