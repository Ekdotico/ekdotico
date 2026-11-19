// What the end-to-end tests of sharing share (FR-ED-21, FR-ED-37): the texts,
// written out here and not taken from the code under test, and the steps of
// the sharing settings. The tests that need the collaboration server are in
// tests/e2e/editor.spec.ts, the one file that runs it: its port is fixed, so
// two files cannot each run one.
import { spawnSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';
import { mailFor } from './account.ts';
import { APP_ORIGIN, AUTH_SECRET } from './origin.ts';

// The fixed texts of FR-ED-21 and FR-ED-37.
export const CONFIRMATION = (address: string) =>
  `Invitation created for ${address}. Ekdotico sends an invitation only to an address that belongs to an account. If this address does, the person receives an email and a notification.`;
export const LIMIT =
  'This document has reached its limit of ten people. Remove a collaborator or revoke an invitation to invite another.';
// The texts for the owner's approval (docs/plan/slice-13.md, §5).
export const NO_LONGER_OPEN =
  'This invitation is no longer open. It was accepted, declined, or revoked, or it expired.';
export const NOT_OPEN_TO_ACCOUNT =
  'This invitation is not open to this account. An invitation can be accepted only by the account that holds the address it was sent to.';

/** The link of an invitation in its email. */
export const INVITATION_LINK = /https?:\/\/[^\s]+\/invitations\/[A-Za-z0-9_-]{43}/;

/** From the list of documents: a new document, and its sharing settings open. Resolves with its identifier. */
export async function shareNew(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New document' }).click();
  await page.getByRole('link', { name: 'Untitled document' }).first().click();
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  const id = /\/documents\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await page.getByRole('link', { name: 'Sharing' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sharing' })).toBeVisible();
  return id;
}

export async function invite(page: Page, addresses: string[], role: 'Editor' | 'Viewer' = 'Editor') {
  await page.getByRole('textbox', { name: 'Email addresses' }).fill(addresses.join('\n'));
  await page.getByRole('radio', { name: role }).check();
  await page.getByRole('button', { name: 'Invite' }).click();
}

/**
 * The person invited at this address opens the link of the email, and accepts: the document is theirs to
 * open. `except` is the link of an earlier invitation to the address, for a person who is invited again:
 * the email of the new one is handed over after the response, and the newest message may still be the old.
 */
export async function accept(page: Page, address: string, documentId: string, except?: string) {
  let link = '';
  await expect
    .poll(async () => (link = (await mailFor(address, INVITATION_LINK)).found), { timeout: 15_000 })
    .not.toBe(except ?? '');
  await page.goto(new URL(link).pathname);
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.waitForURL(`**/documents/${documentId}`);
}

/**
 * Chooses a role for a person, and returns once the page has heard the choice: its "Change role" button is then
 * enabled. A choice made before the page's script has taken over reaches no handler, and the script then puts the
 * old role back, so it is made again until the button is enabled. It fails, in 20 s, if the select never takes it.
 * `scope` is the page or the row that holds the person's controls.
 */
export async function chooseRole(scope: Page | Locator, name: string, role: string) {
  await expect(async () => {
    await scope.getByRole('combobox', { name: `Role of ${name}` }).selectOption(role);
    await expect(scope.getByRole('button', { name: `Change role of ${name}` })).toBeEnabled({
      timeout: 1_000,
    });
  }).toPass({ timeout: 20_000 });
}

/** The row of a person in the list of people of the sharing settings (FR-ED-38). */
export const personRow = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.locator('bdi', { hasText: name }) });

export const pendingRow = (page: Page, address: string) =>
  page.getByRole('group', { name: 'Pending invitations' }).getByRole('row').filter({ hasText: address });

/** Changes a collaborator's role in the database of the run (tests/e2e/set-role.ts); the server learns of it by its re-check. */
export function setRole(documentId: string, address: string, role: 'editor' | 'reviewer' | 'viewer') {
  const ran = spawnSync('node', ['tests/e2e/set-role.ts', documentId, address, role], {
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

/** Brings the expiry of the pending invitations to an address to 2 days ahead and runs the reminder timer once (tests/e2e/remind-invitation.ts). */
export function remind(address: string) {
  const ran = spawnSync('node', ['tests/e2e/remind-invitation.ts', address], {
    env: {
      ...process.env,
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN,
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET,
      // The sink, whatever a .env.local or the shell says: a run of the tests sends no real email (register D262).
      EMAIL_TRANSPORT: 'sink',
      EMAIL_SINK_DIRECTORY: process.env.E2E_EMAIL_SINK,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(ran.status, ran.stderr).toBe(0);
}

/** Gives the Editor role these permissions on a document, in the database of the run (tests/e2e/set-permissions.ts). */
export function setPermissions(documentId: string, permissions: string[]) {
  const ran = spawnSync('node', ['tests/e2e/set-permissions.ts', documentId, permissions.join(',')], {
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

/** Runs the timer of the clearings of one Owner once, their days brought this many days nearer (tests/e2e/run-clearing.ts). */
export function runClearing(ownerAddress: string, daysAhead: number) {
  const ran = spawnSync('node', ['tests/e2e/run-clearing.ts', ownerAddress, String(daysAhead)], {
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

/** Moves the expiry of the pending invitations to an address into the past (tests/e2e/expire-invitation.ts). */
export function expire(address: string) {
  const ran = spawnSync('node', ['tests/e2e/expire-invitation.ts', address], {
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
