// What the end-to-end tests share: an invitation made as the team makes one, an
// account made as a person makes one, and the checks every page owes.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { APP_ORIGIN, AUTH_SECRET } from './origin.ts';

// The fixed texts, written out here and not taken from the code under test.
export const NOT_OPEN = 'This invitation is not open. Ask the Ekdotico team for a new one.'; // FR-AU-90
export const SIGN_IN_REFUSED = 'The email address or the password is not correct.'; // FR-AU-81
export const NOTICE_TITLE = 'Closed α'; // FR-AU-55
// FR-AU-55: without the sentence about Send feedback, which a release without
// the Feedback Widget leaves out, and without the contact address, which does
// not exist yet.
export const NOTICE_BODY =
  'Ekdotico is in Closed α. Closed α is an early test release. Only invited people can create an account. This release does not reflect the planned first public version of Ekdotico. It may be unavailable at times, and the Ekdotico team makes no commitment about its availability. The Ekdotico team uses feedback from the people who test this release to design and develop the next steps.';

const unique = () => randomBytes(9).toString('base64url');

export interface Person {
  email: string;
  name: string;
  password: string;
}

/** A person no earlier run has met. The password holds no part of the address (FR-AU-82). */
export function newPerson(): Person {
  return {
    email: `e2e-${unique().toLowerCase()}@example.com`,
    name: 'Test Person',
    password: `Pw ${unique()} ${unique()}`,
  };
}

/**
 * Has an admission invitation created by the command the founding team runs
 * (FR-AU-57), and reads its link where the person would: in the email, which
 * the local sink wrote to a file. The command prints neither.
 */
export async function invite(email: string): Promise<string> {
  const sink = process.env.E2E_EMAIL_SINK!;
  mkdirSync(sink, { recursive: true });
  const before = new Set(readdirSync(sink));
  expect(admission('create', email).status).toBe(201);
  // FR-AU-87: the email is handed over after the response has been returned,
  // so the file may not be there yet when the command has ended.
  const link = () =>
    readdirSync(sink)
      .filter((name) => !before.has(name))
      .map((name) => readFileSync(join(sink, name), 'utf8'))
      .filter((text) => text.includes(`To: ${email}`))
      .map((text) => /\/sign-up\/[A-Za-z0-9_-]{43}/.exec(text)?.[0])
      .find(Boolean);
  await expect.poll(link, { message: 'the link in the invitation email', timeout: 5_000 }).toBeDefined();
  return link()!;
}

/**
 * Runs the command the founding team runs (FR-AU-57, FR-AU-89), against the
 * server of the tests, and returns the status and the JSON it printed.
 */
export function admission(...args: string[]): { status: number; answer: unknown } {
  const ran = spawnSync('node', ['scripts/admission.ts', ...args], {
    env: { ...process.env, APP_ORIGIN, ADMISSION_SECRET: process.env.E2E_ADMISSION_SECRET },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(ran.status, ran.stderr + ran.stdout).toBe(0);
  const [status, ...answer] = ran.stdout.split('\n');
  return { status: Number(status), answer: JSON.parse(answer.join('\n')) };
}

/**
 * A document of the account with this address, under this title, written into
 * the database of the run for an account that reaches no route
 * (tests/e2e/own-document.ts). Returns its identifier.
 */
export function ownDocument(email: string, title: string): string {
  const ran = spawnSync('node', ['tests/e2e/own-document.ts', email, title], {
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
  return ran.stdout.trim();
}

/**
 * Stores, as the state of a document, quotes nested `depth` deep: what no
 * client can send now, and a document stored before there was a limit could
 * hold (tests/e2e/stored-state.ts).
 */
export function storeNested(documentId: string, depth: number): void {
  storeWith(documentId, [String(depth)]);
}

/**
 * Stores `state` as the state of a document: what a client could send before
 * the collaboration server held the shape of a document (tests/e2e/stored-state.ts).
 */
export function storeState(documentId: string, state: Uint8Array): void {
  const path = join(mkdtempSync(join(tmpdir(), 'ekdotico-e2e-state-')), 'state');
  writeFileSync(path, state);
  storeWith(documentId, ['--file', path]);
}

function storeWith(documentId: string, args: string[]): void {
  const ran = spawnSync('node', ['tests/e2e/stored-state.ts', documentId, ...args], {
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

/**
 * What `pattern` finds in the newest message the local sink holds for an
 * address, once the message is there: the email of the account is handed over
 * after the response has been returned (FR-AU-87). `text` is the whole message.
 */
export async function mailFor(email: string, pattern: RegExp): Promise<{ found: string; text: string }> {
  const sink = process.env.E2E_EMAIL_SINK!;
  let result: { found: string; text: string } | undefined;
  await expect
    .poll(
      () => {
        for (const name of readdirSync(sink).sort().reverse()) {
          const text = readFileSync(join(sink, name), 'utf8');
          const found = text.includes(`To: ${email}\n`) ? pattern.exec(text) : null;
          if (found) return ((result = { found: found[0], text }), true);
        }
        return false;
      },
      { message: `an email to the address that holds ${pattern}`, timeout: 15_000 },
    )
    .toBe(true);
  return result!;
}

/** Opens the invitation and creates the account. The person ends on the Closed α notice. */
export async function signUp(
  page: Page,
  person: Person,
  link?: string,
  /** `paper: true` leaves the account to be given its Onboarding paper at its first list, as a person's is. */
  options: { paper?: boolean } = {},
): Promise<void> {
  await page.goto(link ?? (await invite(person.email)));
  await page.getByLabel('Name').fill(person.name);
  await page.getByLabel('Password', { exact: true }).fill(person.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: NOTICE_TITLE })).toBeVisible();
  // The list is not read until the notice is acknowledged, so the mark is in time. Every test but
  // the ones of the paper is about a list of the documents it makes.
  if (!options.paper) {
    const ran = spawnSync('node', ['tests/e2e/mark-paper-given.ts', person.email], {
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
}

export async function signIn(page: Page, person: Person, password = person.password): Promise<void> {
  await page.getByRole('textbox', { name: 'Email address' }).fill(person.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * FR-AU-88: a fault "is announced by a screen reader". What the accessibility
 * tree holds as an alert, other than the element in which Next.js announces a
 * change of page, which is one too and is empty until a navigation.
 */
export function alertOn(page: Page) {
  return page.getByRole('alert').and(page.locator(':not(#__next-route-announcer__)'));
}

/** FR-AU-88: the browser makes no request to any origin other than the application's own. */
export function watchOrigins(page: Page): string[] {
  const elsewhere: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== APP_ORIGIN) {
      elsewhere.push(url.origin);
    }
  });
  return elsewhere;
}

/** FR-AU-88: usable at a width of 320 CSS pixels, so nothing scrolls sideways. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 640 });
  const [content, viewport, past] = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    // What reaches past the viewport, so that a failure names it: the innermost such elements first.
    const past = [...document.querySelectorAll('body *')]
      .filter((element) => element.getBoundingClientRect().right > width + 0.5)
      .reverse()
      .slice(0, 8)
      .map((element) => {
        const box = element.getBoundingClientRect();
        const name = `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') ?? '')}`;
        return `${name.slice(0, 80)} ${Math.round(box.left)} to ${Math.round(box.right)}, ${getComputedStyle(element).position}`;
      });
    return [document.documentElement.scrollWidth, width, past] as const;
  });
  expect(content, `Past the viewport of ${viewport}: ${past.join('; ') || 'no element'}`).toBeLessThanOrEqual(
    viewport,
  );
  await page.setViewportSize(size);
}

/**
 * Saves what a page looks like, in both modes and at two widths, where
 * E2E_SCREENS names a directory. For a person to look at; it asserts nothing.
 */
export async function screens(page: Page, name: string): Promise<void> {
  const directory = process.env.E2E_SCREENS;
  if (!directory) return;
  const size = page.viewportSize()!;
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const [label, width, height] of [
      ['320', 320, 640],
      ['desktop', 1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: join(directory, `${name}-${colorScheme}-${label}.png`),
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ colorScheme: null });
  await page.setViewportSize(size);
}
