// Two-factor authentication by authenticator application, in the browser
// (FR-AU-83, FR-AU-81, FR-AU-87 (f), (g), FR-AU-88, FR-AU-90): turning it on
// in the account settings, the second step of a sign-in, a recovery code,
// replacing the codes, turning it off; and an account of the founding team,
// which meets the enrolment before anything else.
import { randomUUID } from 'node:crypto';
import { QrCode } from '@ekdotico/domico/components';
import type { Request } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, type Locator, type Page } from './fixtures.ts';
import {
  NOTICE_TITLE,
  alertOn,
  expectNoSidewaysScroll,
  invite,
  mailFor,
  newPerson,
  ownDocument,
  screens,
  signIn,
  signUp,
  watchOrigins,
  type Person,
} from './account.ts';
import { freshCode, wrongCode } from './totp.ts';

// The fixed texts, written out here and not taken from the code under test.
// FR-AU-87 (f) and (g).
const ON_EMAIL =
  /Subject: Two-factor authentication was turned on for your Ekdotico account\n[^]*\n\nTwo-factor authentication was turned on for your Ekdotico account\. If you did not do this, set a new password from the sign-in page\.$/;
const OFF_EMAIL =
  /Subject: Two-factor authentication was turned off for your Ekdotico account\n[^]*\n\nTwo-factor authentication was turned off for your Ekdotico account\. If you did not do this, set a new password from the sign-in page\.$/;
const CODES_EMAIL =
  /Subject: The recovery codes of your Ekdotico account were replaced\n[^]*\n\nThe recovery codes of your Ekdotico account were replaced, and the earlier codes no longer work\. If you did not do this, set a new password from the sign-in page\.$/;
// The application's own words (the owner's answer to Q6 of the plan).
const CODE_REFUSED = 'The code is not correct. Enter the code that the authenticator application shows now.';
const RECOVERY_REFUSED =
  'The recovery code is not correct, or it has been used. Enter a recovery code that has not been used.';
const ENROLMENT_TITLE = 'Two-factor authentication';

const firstScreen = { level: 1, name: 'Documents' } as const;
const secondStep = { level: 1, name: 'Enter code' } as const;

/** The part of the account settings that holds two-factor authentication. */
const part = (page: Page) => page.getByRole('region', { name: 'Two-factor authentication' });

/**
 * A button whose label is two words for the eye and names its object for a
 * screen reader (Expression Guidelines, functional, rule 1; WCAG 2.5.3): the
 * words that are seen begin the name, and the rest is in the page and takes
 * no room on it.
 */
async function expectShortLabel(button: Locator, seen: string, rest: string) {
  await expect(button).toHaveAccessibleName(`${seen} ${rest}`);
  expect(await button.evaluate((element) => element.firstChild?.textContent)).toBe(seen);
  const hidden = button.locator('span');
  await expect(hidden).toHaveText(rest);
  const box = await hidden.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(1);
  expect(box!.height).toBeLessThanOrEqual(1);
}

/**
 * The enrolment, from the password to the recovery codes, as a person makes
 * it with an authenticator application: on the settings page, and on the
 * screen an account of the founding team is shown. Returns the secret and the codes.
 */
async function enrol(page: Page, person: Person, within = page.locator('body'), shot?: string) {
  // All that the browser sends from here on: the secret is in none of it.
  const sent: string[] = [];
  const record = (request: Request) => sent.push(`${request.url()}\n${request.postData() ?? ''}`);
  page.on('request', record);
  await within.getByLabel('Current password', { exact: true }).fill(person.password);
  await within.getByRole('button', { name: 'Continue' }).click();

  // FR-AU-83: "the secret the application shows", as text, and as a link that holds it.
  const heading = page.getByRole('heading', { name: 'Authenticator application' });
  await expect(heading).toBeFocused();
  const shown = within.getByLabel('Secret', { exact: true });
  await expect(shown).not.toBeEditable();
  const secret = await shown.inputValue();
  expect(secret).toMatch(/^[A-Z2-7]{52}$/);
  const link = within.getByRole('link', { name: 'Open authenticator application' });
  const address = new URL((await link.getAttribute('href'))!);
  expect(address.protocol).toBe('otpauth:');
  expect(address.host).toBe('totp');
  expect(decodeURIComponent(address.pathname)).toBe(`/Ekdotico:${person.email}`);
  expect(address.searchParams.get('secret')).toBe(secret);
  expect(address.searchParams.get('issuer')).toBe('Ekdotico');

  // "As a QR code": an image with a name, which is the code of the address
  // the link holds and of no other value. The package's control is asked here
  // for the code of that address, and the page's is the same, module for
  // module. It is drawn at its size and is not made smaller to fit.
  const image = within.getByRole('img', { name: 'Secret QR code' });
  await expect(image).toBeVisible();
  const own = renderToStaticMarkup(createElement(QrCode, { value: address.href, label: 'The same' }));
  expect(await image.getAttribute('viewBox')).toBe(/ viewBox="([^"]+)"/.exec(own)![1]);
  expect(await image.locator('path').getAttribute('d')).toBe(/ d="([^"]+)"/.exec(own)![1]);
  expect((await image.boundingBox())!.width).toBe(256);
  // The words beside it name it first (FR-AU-83: "as a QR code and as text").
  await expect(
    within.getByText('To add this account to one, scan the QR code with the application.'),
  ).toBeVisible();

  // FR-AU-88: the field for a one-time code, with a visible label.
  const code = within.getByLabel('Six-digit code');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(code).toHaveAttribute('inputmode', 'numeric');
  await expectNoSidewaysScroll(page);
  // At 320 CSS pixels the code is still whole, and as wide.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 640 });
  const box = (await image.boundingBox())!;
  expect(box.width).toBe(256);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await page.setViewportSize(size);
  if (shot) await screens(page, shot);

  // "Confirms with one code from it; only then is it on": a wrong code turns
  // nothing on, and is stated at the head of the form and beside the field.
  await code.fill(wrongCode(secret));
  const turnOn = within.getByRole('button', { name: 'Turn on two-factor authentication' });
  await expectShortLabel(turnOn, 'Turn on', 'two-factor authentication');
  await turnOn.click();
  await expect(alertOn(page)).toBeFocused();
  await expect(alertOn(page)).toContainText(CODE_REFUSED);
  await expect(code).toHaveAttribute('aria-invalid', 'true');

  await code.fill(await freshCode(secret));
  await within.getByRole('button', { name: 'Turn on two-factor authentication' }).click();

  // "Ten single-use recovery codes, once", and the statement to keep them.
  await expect(page.getByRole('heading', { name: 'Keep recovery codes' })).toBeFocused();
  const codes = within.getByLabel('Recovery codes');
  await expect(codes).not.toBeEditable();
  await expect(within.getByText('Keep the codes where only you can read them.')).toBeVisible();
  const recoveryCodes = (await codes.inputValue()).split('\n');
  expect(recoveryCodes).toHaveLength(10);
  for (const each of recoveryCodes) expect(each).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
  await expectNoSidewaysScroll(page);
  // The code was drawn in the browser: the secret went into no request, as
  // an address or as a body (NFR-SE-19).
  page.off('request', record);
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.filter((each) => each.includes(secret))).toEqual([]);
  return { secret, recoveryCodes };
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
}

test('two-factor authentication is turned on in the settings, asked for at each sign-in, and turned off', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const elsewhere = watchOrigins(page);
  const person = newPerson();
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();

  // FR-AU-88: the part of the account settings that turns it on.
  await page.goto('/settings');
  await expect(part(page).getByText('Two-factor authentication is turned off.')).toBeVisible();
  await screens(page, 'two-factor-off');
  const { secret, recoveryCodes } = await enrol(page, person, part(page), 'two-factor-secret');
  await screens(page, 'two-factor-recovery-codes');
  // FR-AU-87 (f): the notice, with its fixed text.
  await mailFor(person.email, ON_EMAIL);
  await part(page).getByRole('button', { name: 'Continue' }).click();
  await expect(part(page).getByText('Two-factor authentication is turned on.')).toBeVisible();
  // "Once": the codes are not on the page any more, nor is the secret.
  await expect(page.getByText(recoveryCodes[0]!)).toHaveCount(0);
  await expect(page.getByLabel('Recovery codes')).toHaveCount(0);
  await screens(page, 'two-factor-on');

  // FR-AU-81, FR-AU-83: the password is followed by the second step, and the
  // session begins only after it.
  await signOut(page);
  await signIn(page, person);
  await expect(page).toHaveURL('/sign-in/two-factor?return=%2F');
  await expect(page).toHaveTitle('Enter code – Ekdotico');
  await expect(page.getByRole('heading', secondStep)).toBeVisible();
  expect((await page.request.get('/api/account/closed-alpha-notice')).status()).toBe(401);
  const code = page.getByLabel('Six-digit code');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expectNoSidewaysScroll(page);
  await screens(page, 'second-step');

  // A wrong code is stated at the head of the form, announced, and begins no session.
  await code.fill(wrongCode(secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(alertOn(page)).toHaveText(CODE_REFUSED);
  await expect(alertOn(page)).toBeFocused();
  expect((await page.request.get('/api/account/closed-alpha-notice')).status()).toBe(401);
  await screens(page, 'second-step-fault');
  // The right one, by keyboard alone (FR-AU-88).
  await code.fill(await freshCode(secret));
  await code.press('Enter');
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();

  // "A recovery code is accepted in its place and is then spent."
  await signOut(page);
  await signIn(page, person);
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  const recovery = page.getByLabel('Recovery code');
  await recovery.fill(recoveryCodes[0]!);
  await screens(page, 'second-step-recovery-code');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  await signOut(page);
  await signIn(page, person);
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  await page.getByLabel('Recovery code').fill(recoveryCodes[0]!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(alertOn(page)).toHaveText(RECOVERY_REFUSED);
  // "No device is remembered": back to the code of the authenticator, which is asked for again.
  await page.getByRole('button', { name: 'Use six-digit code' }).click();
  await page.getByLabel('Six-digit code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();

  // FR-AU-83: the recovery codes are replaced after the password.
  await page.goto('/settings');
  const replace = part(page).locator('form', {
    has: page.getByRole('button', { name: 'Replace recovery codes' }),
  });
  await replace.getByLabel('Current password', { exact: true }).fill(person.password);
  await replace.getByRole('button', { name: 'Replace recovery codes' }).click();
  await expect(page.getByRole('heading', { name: 'Keep recovery codes' })).toBeFocused();
  const replaced = (await part(page).getByLabel('Recovery codes').inputValue()).split('\n');
  expect(replaced).toHaveLength(10);
  for (const each of replaced) expect(recoveryCodes).not.toContain(each);
  // FR-AU-87 (g).
  await mailFor(person.email, CODES_EMAIL);
  await part(page).getByRole('button', { name: 'Done' }).click();
  await expect(part(page).getByLabel('Recovery codes')).toHaveCount(0);

  // "Turning two-factor authentication off requires the password and either
  // a current code or a recovery code."
  const turnOff = part(page).locator('form', {
    has: page.getByRole('button', { name: 'Turn off two-factor authentication' }),
  });
  await expectShortLabel(
    turnOff.getByRole('button', { name: 'Turn off two-factor authentication' }),
    'Turn off',
    'two-factor authentication',
  );
  await turnOff.getByLabel('Current password', { exact: true }).fill(person.password);
  await turnOff.getByLabel('Code', { exact: true }).fill(recoveryCodes[1]!);
  await turnOff.getByRole('button', { name: 'Turn off two-factor authentication' }).click();
  // A code that the replacement made void turns nothing off.
  await expect(alertOn(page)).toBeFocused();
  await expect(alertOn(page)).toContainText('The code is not correct.');
  await screens(page, 'two-factor-turn-off-fault');
  await turnOff.getByLabel('Current password', { exact: true }).fill(person.password);
  await turnOff.getByLabel('Code', { exact: true }).fill(await freshCode(secret));
  await turnOff.getByRole('button', { name: 'Turn off two-factor authentication' }).click();
  await expect(part(page).getByText('Two-factor authentication is turned off.')).toBeVisible();
  // FR-AU-87 (f): "turned off" in place of "turned on".
  await mailFor(person.email, OFF_EMAIL);

  // A sign-in is no longer asked for a code.
  await signOut(page);
  await signIn(page, person);
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  // FR-AU-88: no request went to any other origin.
  expect(elsewhere).toEqual([]);
});

test('a sign-in whose second step is abandoned begins again with the password', async ({ page }) => {
  test.setTimeout(120_000);
  const person = newPerson();
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  await page.goto('/settings');
  const { secret } = await enrol(page, person, part(page));
  await part(page).getByRole('button', { name: 'Continue' }).click();
  await signOut(page);

  await signIn(page, person);
  await expect(page.getByRole('heading', secondStep)).toBeVisible();
  // NFR-SE-07: five wrong codes, and the sign-in is abandoned.
  for (let n = 0; n < 5; n++) {
    await page.getByLabel('Six-digit code').fill(wrongCode(secret));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(alertOn(page)).toBeFocused();
    if (n < 4) await expect(alertOn(page)).toHaveText(CODE_REFUSED);
  }
  // No field is left: the statement, announced, and the way back to the password.
  await expect(alertOn(page)).toContainText('This sign-in can no longer complete');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await screens(page, 'second-step-abandoned');
  await page.getByRole('link', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL('/sign-in');
  await signIn(page, person);
  await page.getByLabel('Six-digit code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
});

test('an enrolment whose first code is wrong five times begins again with the password', async ({ page }) => {
  test.setTimeout(120_000);
  const person = newPerson();
  await signUp(page, person);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();
  await page.goto('/settings');
  const within = part(page);
  await within.getByLabel('Current password', { exact: true }).fill(person.password);
  await within.getByRole('button', { name: 'Continue' }).click();
  const secret = await within.getByLabel('Secret', { exact: true }).inputValue();
  // NFR-SE-07, as at a sign-in: five wrong codes, and the secret is gone.
  for (let n = 0; n < 5; n++) {
    await within.getByLabel('Six-digit code').fill(wrongCode(secret));
    await within.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
    await expect(alertOn(page)).toBeFocused();
    if (n < 4) await expect(alertOn(page)).toContainText(CODE_REFUSED);
  }
  // The statement, announced, with the field it asks for and no field for a code.
  await expect(alertOn(page)).toContainText(
    'There is no secret to confirm. Enter the password to begin again.',
  );
  await expect(alertOn(page)).toBeFocused();
  await expect(within.getByLabel('Six-digit code')).toHaveCount(0);
  await expect(within.getByLabel('Current password', { exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
  // With the password it begins again, with another secret.
  const again = await enrol(page, person, within);
  expect(again.secret).not.toBe(secret);
});

test('an account of the founding team meets the enrolment first, then the notice, and cannot turn it off', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const elsewhere = watchOrigins(page);
  // The one address on the list of this run (playwright.config.ts), as it is stored.
  const person = { ...newPerson(), email: process.env.E2E_FOUNDER!.toLowerCase() };
  await page.goto(await invite(person.email));
  await page.getByLabel('Name').fill(person.name);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // FR-AU-90: "for an account of the founding team, the screen that turns
  // two-factor authentication on, with the notice after it".
  const enrolment = page.getByRole('heading', { level: 1, name: ENROLMENT_TITLE });
  await expect(enrolment).toBeVisible();
  await expect(enrolment).toBeFocused();
  await expect(page).toHaveTitle(`${ENROLMENT_TITLE} – Ekdotico`);
  await expect(page.getByRole('heading', { name: NOTICE_TITLE })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await screens(page, 'enrolment-gate');

  // The page of a document (E4), for a document that is the account's own: the
  // answer holds nothing of it, its title in `<title>` included, and is the
  // answer for an address that holds no document, to the last character.
  const title = 'A title the gate withholds';
  const answers: string[] = [];
  for (const id of [ownDocument(person.email, title), randomUUID()]) {
    const response = await page.goto(`/documents/${id}`);
    expect(response!.status()).toBe(200);
    await expect(enrolment).toBeVisible();
    await expect(page).toHaveTitle(`${ENROLMENT_TITLE} – Ekdotico`);
    const sent = await response!.text();
    expect(sent).not.toContain(title);
    expect(sent).not.toContain('Page not found');
    // But for the address itself, and the nonce of the request (src/lib/csp.ts).
    const nonce = /'nonce-([^']+)'/.exec(response!.headers()['content-security-policy']!)![1]!;
    answers.push(sent.replaceAll(id, 'ID').replaceAll(nonce, 'NONCE'));
  }
  expect(answers[0]).toBe(answers[1]);
  // FR-AU-83: every page shows it in place of its content, with only the means to sign out beside it…
  for (const path of ['/settings', '/no-such-page', '/']) {
    await page.goto(path);
    await expect(enrolment).toBeVisible();
    await expect(page.getByRole('link')).toHaveCount(0);
    await expect(
      page.getByRole('button').filter({ hasNotText: /^(Continue|Show current password)$/ }),
    ).toHaveText(['Sign out']);
    // Nothing of the page it stands in place of was sent to the browser.
    expect(await page.content()).not.toContain('Account settings');
  }
  // …and every API route refuses the account.
  const refused = await page.request.get('/api/account/closed-alpha-notice');
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('two_factor_required');
  const acknowledged = await page.request.post('/api/account/closed-alpha-notice/acknowledgement', {
    data: { version: 1 },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(acknowledged.status()).toBe(403);

  await enrol(page, person, undefined, 'enrolment-gate-secret');
  await mailFor(person.email, ON_EMAIL);
  await page.getByRole('button', { name: 'Continue' }).click();
  // The notice, after it.
  await expect(page.getByRole('heading', { level: 1, name: NOTICE_TITLE })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', firstScreen)).toBeVisible();

  // "Such an account cannot turn two-factor authentication off": the control is not offered.
  await page.goto('/settings');
  await expect(
    part(page).getByText(
      'This account belongs to the Ekdotico team, so two-factor authentication cannot be turned off for it.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off two-factor authentication' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replace recovery codes' })).toBeVisible();
  // FR-AU-03: nor can its address be changed. The form is not offered, and the
  // request, made without it, is answered as any other and sends nothing
  // (tests/integration/name-and-address.test.ts).
  const address = page.getByRole('region', { name: 'Email address' });
  await expect(
    address.getByText('This account belongs to the Ekdotico team, so its email address cannot be changed.'),
  ).toBeVisible();
  await expect(address.getByRole('button')).toHaveCount(0);
  await expect(address.getByRole('textbox')).toHaveCount(0);
  await screens(page, 'two-factor-founding-team');
  expect(elsewhere).toEqual([]);
});
