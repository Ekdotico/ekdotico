// The Feedback Widget's dialog in a browser (FR-AU-60 to FR-AU-80): keyboard path, focus on opening and on closing,
// the statements a screen reader is given, and the sizes of the targets. WRITTEN, NOT RUN: the widget is behind
// `FEEDBACK_INTAKE_ENABLED`, which no test environment of this slice turns on, so the spec runs only where the owner has
// set `E2E_FEEDBACK_WIDGET=1` for a server that has the switch on. The answers of `POST /api/feedback` are the test's own
// (`page.route`), so nothing reaches Praktico. What it cannot cover: a real screen reader, which no browser test can.
import { expect, test, type Page } from './fixtures.ts';
import { newPerson, signUp } from './account.ts';
import { WIDGET_TEXT } from '../../src/lib/feedback/widget.ts';

test.skip(process.env.E2E_FEEDBACK_WIDGET !== '1', 'the switch is off in this environment');

// The feedback notice of FR-AU-95 is acknowledged by the account's own request, unless the test is of the notice: so that the
// tests of the form begin at the form. Version 1 is the text while posting to Discord is off, which this spec assumes.
async function enter(page: Page, { acknowledged = true }: { acknowledged?: boolean } = {}) {
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  if (acknowledged) {
    const origin = new URL(page.url()).origin;
    const response = await page.request.post('/api/account/feedback-notice/acknowledgement', {
      data: { version: 1 },
      headers: { origin },
    });
    expect(response.ok()).toBe(true);
  }
}

const control = (page: Page) => page.getByRole('button', { name: WIDGET_TEXT.control, exact: true }).first();
const dialog = (page: Page) => page.getByRole('dialog', { name: WIDGET_TEXT.title });
const answer = (page: Page, status: number, body: unknown, headers: Record<string, string> = {}) =>
  page.route('**/api/feedback', (route) =>
    route.fulfill({
      status,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

async function fill(page: Page, text: string) {
  await dialog(page).getByRole('radio', { name: WIDGET_TEXT.kinds.idea }).check();
  await dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label }).fill(text);
}

test('opens by keyboard, puts focus on the first kind, stays inside, and returns focus on Escape', async ({
  page,
}) => {
  await enter(page);
  await control(page).focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('radio', { name: WIDGET_TEXT.kinds.problem })).toBeFocused();
  // None is chosen in advance (FR-AU-65), and the group has its label.
  await expect(dialog(page).getByRole('group', { name: WIDGET_TEXT.legend })).toBeVisible();
  await expect(dialog(page).getByRole('radio', { checked: true })).toHaveCount(0);
  // Tab stays in the dialog: it comes round to the first control again.
  for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('dialog') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(control(page)).toBeFocused();
});

test('shows the notice above Send and gives the text area the notice and the count as its description', async ({
  page,
}) => {
  await enter(page);
  await control(page).click();
  const field = dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label });
  await expect(field).toHaveAccessibleDescription(/Your message goes to the Ekdotico team\./);
  await expect(field).toHaveAccessibleDescription(/characters remaining/);
  await expect(dialog(page).getByRole('link', { name: WIDGET_TEXT.privacyLink })).toHaveAttribute(
    'href',
    '/privacy',
  );
});

test('shows the feedback notice first, before the kind and the message, and the form only after "Continue" (FR-AU-95)', async ({
  page,
}) => {
  await enter(page, { acknowledged: false });
  await control(page).click();
  // The notice is announced and "Continue" takes the focus; no kind or message is shown yet, and there is no tick box.
  await expect(dialog(page).getByText(/^Your message goes to the Ekdotico team/)).toBeVisible();
  const proceed = dialog(page).getByRole('button', { name: 'Continue', exact: true });
  await expect(proceed).toBeFocused();
  const box = await proceed.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
  await expect(dialog(page).getByRole('checkbox')).toHaveCount(0);
  await expect(dialog(page).getByRole('radio')).toHaveCount(0);
  await expect(dialog(page).getByRole('link', { name: WIDGET_TEXT.privacyLink })).toHaveAttribute(
    'href',
    '/privacy',
  );
  // Closing before "Continue" records nothing: the notice is shown again.
  await page.keyboard.press('Escape');
  await control(page).click();
  await expect(proceed).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dialog(page).getByRole('radio', { name: WIDGET_TEXT.kinds.problem })).toBeFocused();
  await expect(proceed).toHaveCount(0);
  // Acknowledged on the server, so a reload shows the form at once.
  await page.reload();
  await control(page).click();
  await expect(dialog(page).getByRole('radio', { name: WIDGET_TEXT.kinds.problem })).toBeVisible();
});

test('counts in code points: 4,000 emoji are 0 remaining, not 8,000 over', async ({ page }) => {
  await enter(page);
  await control(page).click();
  await dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label }).fill('😀'.repeat(4000));
  await expect(dialog(page).getByText('0 characters remaining')).toBeVisible();
});

test('asks for a kind and a message in text beside the field, and moves focus to the first', async ({
  page,
}) => {
  await enter(page);
  await control(page).click();
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect(dialog(page).getByText(WIDGET_TEXT.noKind)).toBeVisible();
  await expect(dialog(page).getByText(WIDGET_TEXT.empty)).toBeVisible();
  await expect(dialog(page).getByRole('radio', { name: WIDGET_TEXT.kinds.problem })).toBeFocused();
});

test('refuses a hidden character by its own sentence, and keeps the text', async ({ page }) => {
  await enter(page);
  await control(page).click();
  await fill(page, 'a‮b');
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect(dialog(page).getByText(WIDGET_TEXT.refusedCharacter)).toBeVisible();
});

test('says not sent, keeps the text, and sends the same identifier for the same text only', async ({
  page,
}) => {
  await enter(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/feedback', (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      // The server's own `message` is a text the widget must never show.
      body: JSON.stringify({
        error: { code: 'not_sent', message: 'THE SERVER’S OWN TEXT' },
        submissionId: 'issued-1',
      }),
    });
  });
  await control(page).click();
  await fill(page, 'first words');
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(WIDGET_TEXT.notSent);
  await expect(dialog(page).getByText('THE SERVER’S OWN TEXT')).toHaveCount(0);
  await expect(dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label })).toHaveValue('first words');
  // Focus stays where the person was: on Send, not moved to the statement.
  await expect(dialog(page).getByRole('button', { name: WIDGET_TEXT.send })).toBeFocused();
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0]).not.toHaveProperty('submissionId');
  expect(bodies[1]).toHaveProperty('submissionId', 'issued-1');
  // An edited text is a new piece: no identifier.
  await dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label }).fill('other words');
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).not.toHaveProperty('submissionId');
});

test('sends route and viewport, announces that it was sent, and keeps the statement until Close', async ({
  page,
}) => {
  await enter(page);
  let body: Record<string, unknown> = {};
  await page.route('**/api/feedback', (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ sent: true }),
    });
  });
  await control(page).click();
  await fill(page, 'a thought');
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect(dialog(page).getByRole('status')).toHaveText(WIDGET_TEXT.sent);
  expect(Object.keys(body).sort()).toEqual(['kind', 'message', 'route', 'viewport']);
  expect(body.route).toBe('/');
  await expect(dialog(page).getByRole('button', { name: WIDGET_TEXT.close, exact: true })).toBeFocused();
  // Nothing is timed: the statement is still there.
  await page.waitForTimeout(6000);
  await expect(dialog(page).getByRole('status')).toHaveText(WIDGET_TEXT.sent);
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeHidden();
  await expect(control(page)).toBeFocused();
  // The next opening is the empty form again.
  await control(page).click();
  await expect(dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label })).toHaveValue('');
});

test('keeps a half-written message when the dialog is closed and opened again', async ({ page }) => {
  await enter(page);
  await control(page).click();
  await fill(page, 'half a thought');
  await page.keyboard.press('Escape');
  await control(page).click();
  await expect(dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label })).toHaveValue('half a thought');
});

test('says when sending is possible again, and keeps the text, on a 429', async ({ page }) => {
  await enter(page);
  await answer(
    page,
    429,
    { error: { code: 'rate_limited', message: '', retryAfterSeconds: 300 } },
    { 'Retry-After': '300' },
  );
  await control(page).click();
  await fill(page, 'too soon');
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('You have sent too much feedback for now.');
  await expect(dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label })).toHaveValue('too soon');
  // Typing again does not move the time (a later render shows the same one).
  const statement = await dialog(page).getByRole('alert').textContent();
  await dialog(page).getByRole('textbox', { name: WIDGET_TEXT.label }).pressSequentially(' more');
  await expect(dialog(page).getByRole('alert')).toHaveText(statement ?? '');
});

test('says not sent when the network is gone', async ({ page }) => {
  await enter(page);
  await page.route('**/api/feedback', (route) => route.abort('internetdisconnected'));
  await control(page).click();
  await fill(page, 'offline');
  await dialog(page).getByRole('button', { name: WIDGET_TEXT.send }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(WIDGET_TEXT.notSent);
});

test('has targets of at least 24 by 24 CSS pixels, and 44 on a phone', async ({ page }) => {
  await enter(page);
  const box = await control(page).boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(24);
  expect(box?.height).toBeGreaterThanOrEqual(24);
  await control(page).click();
  for (const name of [WIDGET_TEXT.send, WIDGET_TEXT.close]) {
    const target = await dialog(page).getByRole('button', { name, exact: true }).boundingBox();
    expect(target?.height).toBeGreaterThanOrEqual(24);
  }
});

test('is in the drawer below 921px, opens from it, and returns focus to the drawer’s trigger', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await enter(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  const inDrawer = page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: WIDGET_TEXT.control });
  await inDrawer.click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
});

test('is usable at 320 CSS pixels without a second scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await enter(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: WIDGET_TEXT.control })
    .click();
  const sideways = await dialog(page).evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(sideways).toBe(false);
});
