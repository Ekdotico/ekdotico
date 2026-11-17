// The image block of the editor (FR-ED-08, FR-ED-12, NFR-SE-18, NFR-SE-06 A01,
// NFR-IC-19; register rows S19-1, S19-4, S19-8), against the real collaboration
// server, which this file starts and stops, and the local object store that the
// run is given (IMAGE_STORAGE_*: compose.yaml, and the step of ci.yml). Every test
// runs under the policy of a page as a deployment serves it (./fixtures.ts), so
// that an image that loaded did so from the origin of the store and from no other.
import { spawnSync } from 'node:child_process';
import { png, pngChunk } from '../unit/image-fixtures.ts';
import { expect, test, type Page } from './fixtures.ts';
import { INVITATION_LINK, invite } from './sharing.ts';
import { expectNoSidewaysScroll, mailFor, newPerson, signUp, type Person } from './account.ts';
import { APP_ORIGIN, AUTH_SECRET } from './origin.ts';
import { startCollab, stopCollab } from './collab.ts';

// Skipped on a machine with no store; under CI the tests run, and fail where no store was given (the review of pull request 52).
test.skip(
  !process.env.IMAGE_STORAGE_ENDPOINT && process.env.CI !== 'true',
  'No object store is given to this run (IMAGE_STORAGE_*): the application stores no image.',
);
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => startCollab());
test.afterAll(stopCollab);

// The fixed texts, written out here and not taken from the code under test.
const NOT_AN_IMAGE =
  'That file is not a PNG, JPEG, GIF, or WebP image, so it was not added. Choose an image in one of those formats.';
const GONE =
  'This image is no longer available. An image that has been out of the document for more than 30 days is deleted from storage.';
const STORE = process.env.IMAGE_STORAGE_ENDPOINT!;

const PNG = png();
const picture = { name: 'plate.png', mimeType: 'image/png', buffer: PNG };

const text = (page: Page) => page.getByRole('textbox', { name: 'Document text' });
const figure = (page: Page) => page.locator('figure.ekd-image');
const handle = (page: Page) => page.getByRole('slider', { name: 'Resize the image' });
const widthSelect = (page: Page) => page.getByRole('combobox', { name: 'Image width' });

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
  await expect(page.getByRole('button', { name: 'In sync' })).toBeVisible();
  return /\/documents\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}
/** The file picker, from the button of the page. */
async function choose(page: Page, ...files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Choose an image' }).click(),
  ]);
  await chooser.setFiles(files);
}
/** A document with one image in it, and the page of its Owner. */
async function withImage(page: Page, person?: Person) {
  const who = await enter(page, person);
  const id = await openNew(page);
  await choose(page, picture);
  await expect(page.getByText('Image added')).toBeVisible();
  await expect(figure(page).locator('img.ekd-image-img')).toBeVisible();
  return { id, who };
}
const inSync = (page: Page) => expect(page.getByRole('button', { name: 'In sync' })).toBeVisible();

test('uploads an image by the picker, shows it from a link of the store under the policy of the page, and keeps it across a reload', async ({
  page,
}) => {
  test.slow();
  const hosts = new Set<string>();
  page.on('request', (request) => hosts.add(new URL(request.url()).origin));
  await enter(page);
  const id = await openNew(page);
  await choose(page, picture);
  await expect(page.getByText('Uploading the image…').or(page.getByText('Image added'))).toBeVisible();
  await expect(page.getByText('Image added')).toBeVisible();

  const img = figure(page).locator('img.ekd-image-img');
  await expect(figure(page)).toHaveCount(1);
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((each: HTMLImageElement) => each.naturalWidth)).toBe(1);
  // A link of the store, valid for 5 minutes, which the page was handed and that nothing else supplied.
  const src = (await img.getAttribute('src'))!;
  expect(src.startsWith(`${new URL(STORE).origin}/`)).toBe(true);
  expect(new URL(src).searchParams.get('X-Amz-Expires')).toBe('300');
  expect(await img.getAttribute('alt')).toBe('');
  expect(await img.getAttribute('referrerpolicy')).toBe('no-referrer');
  // Nothing was asked of any origin but the application's and the store's.
  expect([...hosts].sort()).toEqual([APP_ORIGIN, new URL(STORE).origin].sort());

  // The policy of the page names that one origin beside its own, in img-src alone.
  const response = (await page.goto(`/documents/${id}`))!;
  const policy = response.headers()['content-security-policy']!;
  expect(policy).toContain(`img-src 'self' ${new URL(STORE).origin};`);
  expect(policy.match(new RegExp(new URL(STORE).origin.replace(/[.:/]/g, '\\$&'), 'g'))).toHaveLength(1);
  // Reloaded, the block asks for a new link and shows the image again.
  await expect(figure(page).locator('img.ekd-image-img')).toBeVisible();
  await expect
    .poll(() =>
      figure(page)
        .locator('img.ekd-image-img')
        .evaluate((each: HTMLImageElement) => each.naturalWidth),
    )
    .toBe(1);
});

test('takes the alt text and the caption from fields of the block, and keeps them', async ({ page }) => {
  test.slow();
  const { id } = await withImage(page);
  await page.getByRole('textbox', { name: 'Alt text' }).fill('The north front, seen from the lawn');
  await page.getByRole('textbox', { name: 'Caption (optional)' }).fill('Plate 3');
  await expect(figure(page).locator('figcaption.ekd-image-caption')).toHaveText('Plate 3');
  await expect(figure(page).locator('img')).toHaveAttribute('alt', 'The north front, seen from the lawn');
  await inSync(page);
  await page.goto(`/documents/${id}`);
  await expect(figure(page).locator('img')).toHaveAttribute('alt', 'The north front, seen from the lawn');
  await expect(figure(page).locator('figcaption')).toHaveText('Plate 3');
  await expect(page.getByRole('textbox', { name: 'Alt text' })).toHaveValue(
    'The north front, seen from the lawn',
  );
});

test('takes an image from the slash palette, in place of the command, and from a drop on the text', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  await text(page).click();
  // Listened for before the typing, and not in the same step as the key: Playwright turns on its interception of the
  // picker when the listener is made, which takes a round trip, and a key pressed at once can open the picker before
  // that, which headless Chromium cancels (one run in eight, the run of pull request 52). A click on a button
  // is slow enough not to meet it.
  const asked = page.waitForEvent('filechooser');
  await page.keyboard.type('/image');
  await page.keyboard.press('Enter');
  const chooser = await asked;
  await chooser.setFiles(picture);
  await expect(figure(page)).toHaveCount(1);
  await expect(figure(page).locator('img')).toBeVisible();
  await expect(text(page)).not.toContainText('/image');

  // A drop of a file on the text (FR-ED-08): no picker, and the block follows the upload.
  await text(page).evaluate(
    (element, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
      const box = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
          clientX: box.left + 20,
          clientY: box.top + 20,
        }),
      );
    },
    [...PNG],
  );
  await expect(figure(page)).toHaveCount(2);
  await expect(figure(page).nth(1).locator('img')).toBeVisible();
});

// The review of pull request 52 (S5): a drop is a place in the shared document, which a change above it made
// during the upload does not move. The upload is held at the browser until the text above has been changed.
test('puts the block where the file was dropped, though the text above it changed during the upload', async ({
  page,
}) => {
  test.slow();
  await enter(page);
  await openNew(page);
  await text(page).click();
  await page.keyboard.type('first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await inSync(page);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/documents\/[^/]+\/images$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    return route.fallback();
  });
  await text(page)
    .locator('p', { hasText: 'second' })
    .evaluate(
      (element, bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
        const box = element.getBoundingClientRect();
        element.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer: data,
            bubbles: true,
            cancelable: true,
            clientX: box.left + 2,
            clientY: box.top + box.height / 2,
          }),
        );
      },
      [...PNG],
    );
  // Text above the drop, while the upload waits: the number of the drop would now point into the word below.
  await text(page).locator('p', { hasText: 'first' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Longer text than before, so that every position after it has moved: ');
  release();
  await expect(figure(page)).toHaveCount(1);
  const order = await text(page).evaluate((element) =>
    [...element.children].map(
      (child) =>
        `${child.querySelector('figure') ? 'FIGURE' : child.tagName}:${child.textContent?.slice(0, 6)}`,
    ),
  );
  // After the paragraph that was dropped on, which is where it was; not after the first, where the number points now.
  expect(order.map((entry) => entry.split(':')[0])).toEqual(['P', 'P', 'FIGURE', 'P']);
  expect(order[1]).toBe('P:second');
});

// FR-ED-08: "The maximum upload size per image shall be 20 MB". The proxy of the application does not see
// the upload (src/proxy.ts, `config`), so Next.js cuts no body of it at `proxyClientMaxBodySize`, which is
// 320 KB (next.config.ts): an image of 15 MB arrives whole, and one of 21 MB is told its size.
test('takes an image of 15 MB whole, and refuses one of 21 MB with its size', async ({ page }) => {
  test.slow();
  await enter(page);
  await openNew(page);
  const big = (size: number) => png({ before: [pngChunk('IDAT', Buffer.alloc(size - png().length - 12))] });
  await choose(page, { name: 'big.png', mimeType: 'image/png', buffer: big(15 * 1024 * 1024) });
  await expect(page.getByText('Image added')).toBeVisible({ timeout: 30_000 });
  await expect(figure(page)).toHaveCount(1);
  await choose(page, { name: 'bigger.png', mimeType: 'image/png', buffer: big(21 * 1024 * 1024) });
  await expect(
    page.getByText(
      'That image is larger than 20 MB, so it was not added. Choose a smaller image, or reduce its size first.',
    ),
  ).toBeVisible();
  await expect(figure(page)).toHaveCount(1);
});

test('refuses a file that is no image with the words of the server, and puts no block in the document', async ({
  page,
}) => {
  await enter(page);
  await openNew(page);
  await choose(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(page.getByText(NOT_AN_IMAGE)).toBeVisible();
  // An SVG file under the name of a picture is refused the same, whatever it says it is.
  await choose(page, {
    name: 'plate.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
  });
  await expect(page.getByText(NOT_AN_IMAGE)).toBeVisible();
  await expect(figure(page)).toHaveCount(0);
});

test('inserts no image from pasted content that refers to one at another address', async ({ page }) => {
  await enter(page);
  await openNew(page);
  await text(page).click();
  // Neither the page nor the policy would load it; the schema does not read it at all (NFR-SE-06 A01).
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.com')) requested.push(request.url());
  });
  await text(page).evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>before</p><img src="https://example.com/pixel.png"><p>after</p>');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(text(page)).toContainText('before');
  await expect(figure(page)).toHaveCount(0);
  await expect(text(page).locator('img')).toHaveCount(0);
  expect(requested).toEqual([]);
});

test('sets the width by the select, by the keys of the handle, and by dragging it, writing the one that is done and nothing before', async ({
  page,
}) => {
  test.slow();
  const { id } = await withImage(page);
  const frame = figure(page).locator('.ekd-image-frame');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '100');
  await expect(handle(page)).toHaveAttribute('aria-valuemin', '10');
  await expect(handle(page)).toHaveAttribute('aria-valuemax', '100');

  // The select, which is the way that needs no dragging (WCAG 2.2, 2.5.7).
  await widthSelect(page).selectOption('50');
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '50');
  await expect(frame).toHaveAttribute('style', /--ekd-image-width: 50%/);

  // The keys of the handle: 5 for an arrow, 25 for a page, 10 and 100 for Home and End.
  await handle(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(widthSelect(page)).toHaveValue('55');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(widthSelect(page)).toHaveValue('45');
  await page.keyboard.press('PageUp');
  // A key lands on a multiple of its step (the package's README): a page from 45 is 50, and the next is 75.
  await expect(widthSelect(page)).toHaveValue('50');
  await page.keyboard.press('PageUp');
  await expect(widthSelect(page)).toHaveValue('75');
  await page.keyboard.press('Home');
  await expect(widthSelect(page)).toHaveValue('10');
  await page.keyboard.press('End');
  await expect(widthSelect(page)).toHaveValue('100');
  // A key on the handle moves no caret and types nothing.
  await expect(text(page)).not.toContainText('Arrow');

  // A drag: the width follows the pointer and is written when the pointer is let go, and not before.
  await widthSelect(page).selectOption('100');
  const parent = (await figure(page).boundingBox())!;
  const grip = (await handle(page).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(parent.x + parent.width * 0.3, grip.y + grip.height / 2, { steps: 8 });
  await expect(handle(page)).not.toHaveAttribute('aria-valuenow', '100');
  // Shown, and not yet decided: the select, which reads the node, still says 100.
  await expect(widthSelect(page)).toHaveValue('100');
  await page.mouse.up();
  const dragged = Number(await handle(page).getAttribute('aria-valuenow'));
  expect(dragged).toBeGreaterThanOrEqual(20);
  expect(dragged).toBeLessThanOrEqual(40);
  await expect(widthSelect(page)).toHaveValue(String(dragged));

  // Escape in the middle of a drag puts the width back, and writes nothing.
  const again = (await handle(page).boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(parent.x + parent.width * 0.8, again.y + again.height / 2, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(dragged));
  await expect(widthSelect(page)).toHaveValue(String(dragged));

  // Kept, and the same for the page that is opened again.
  await inSync(page);
  await page.goto(`/documents/${id}`);
  await expect(handle(page)).toHaveAttribute('aria-valuenow', String(dragged));
});

test('shows a Viewer the image as a picture and a caption, with no field, no handle and no picker', async ({
  page,
  browser,
}) => {
  test.slow();
  const { id } = await withImage(page);
  await page.getByRole('textbox', { name: 'Caption (optional)' }).fill('Plate 3');
  await page.getByRole('link', { name: 'Sharing' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sharing' })).toBeVisible();
  const viewer = newPerson();
  const context = await browser.newContext();
  const theirs = await context.newPage();
  await enter(theirs, viewer);
  await invite(page, [viewer.email], 'Viewer');
  const { found: link } = await mailFor(viewer.email, INVITATION_LINK);
  await theirs.goto(new URL(link).pathname);
  await theirs.getByRole('button', { name: 'Accept' }).click();
  await theirs.waitForURL(`**/documents/${id}`);

  await expect(theirs.locator('figure.ekd-image img.ekd-image-img')).toBeVisible();
  await expect(theirs.locator('figure.ekd-image figcaption')).toHaveText('Plate 3');
  await expect(theirs.getByRole('slider')).toHaveCount(0);
  await expect(theirs.getByRole('textbox', { name: 'Alt text' })).toHaveCount(0);
  await expect(theirs.getByRole('button', { name: 'Choose an image' })).toHaveCount(0);
  await expect(widthSelect(theirs)).toHaveCount(0);
  // A drop on the text of a Viewer uploads nothing.
  await text(theirs).evaluate(
    (element, bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    [...PNG],
  );
  await theirs.waitForTimeout(1500);
  await expect(theirs.locator('figure.ekd-image')).toHaveCount(1);
  await context.close();
});

test('says that an image is no longer available where its row is gone, and holds at 320 pixels wide', async ({
  page,
}) => {
  test.slow();
  const { id } = await withImage(page);
  await inSync(page);
  const ran = spawnSync('node', ['tests/e2e/delete-images.ts', id], {
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
  await page.goto(`/documents/${id}`);
  await expect(page.getByText(GONE)).toBeVisible();
  await expect(figure(page).locator('img')).toHaveCount(0);
  await expect(figure(page)).toHaveAttribute('data-state', 'unavailable');
  await page.setViewportSize({ width: 320, height: 700 });
  await expectNoSidewaysScroll(page);
});
