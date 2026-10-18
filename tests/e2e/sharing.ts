// What the end-to-end tests of sharing share (FR-ED-21, FR-ED-37): the texts,
// written out here and not taken from the code under test, and the steps of
// the sharing settings. The tests that need the collaboration server are in
// tests/e2e/editor.spec.ts, the one file that runs it: its port is fixed, so
// two files cannot each run one.
import { spawnSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
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

export const pendingRow = (page: Page, address: string) =>
  page.getByRole('group', { name: 'Pending invitations' }).getByRole('row').filter({ hasText: address });

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
