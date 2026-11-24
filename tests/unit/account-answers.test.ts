// The owner's answers for the account and sessions pages (23 November 2026). Each text is written out here
// whole, and not taken from the code under test.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NOT_SIGNED_IN,
  NOT_SIGNED_IN_MARKER,
  NOT_SIGNED_IN_PATH,
  NOTICE_PARAMETER,
} from '../../src/lib/auth/sign-in-notice.ts';
import { returnPath } from '../../src/lib/http.ts';

const read = (path: string) => readFileSync(path, 'utf8');

describe('the session list', () => {
  const src = read('src/app/(app)/settings/session-list.tsx');
  it('has the approved statements and the approved name for the session in use', () => {
    expect(src).toContain("export const SESSION_ENDED = 'Session ended.';");
    expect(src).toContain("export const OTHER_SESSIONS_ENDED = 'Other sessions ended.';");
    expect(src).toContain("export const END_OWN_SESSION = 'End this session and sign out';");
    expect(src).toContain("session.current ? END_OWN_SESSION : 'End session'");
  });
  it('holds a status from the first paint that takes focus', () => {
    expect(src).toContain('<p role="status" ref={statement} tabIndex={-1}');
    expect(src).toContain('statement.current?.focus()');
  });
});

describe('the deleted account page', () => {
  it('leads on to the sign-in page', () => {
    const src = read('src/app/(app)/settings/delete-account/delete-account.tsx');
    expect(src).toContain("export const SIGN_IN_LINK = 'Go to the sign-in page';");
    expect(src).toMatch(/<Link href="\/sign-in"[^>]*>\s*\{SIGN_IN_LINK\}/);
    expect(src).toContain(
      'The account is being deleted. Ekdotico has ended your access and completes the deletion without you. You can close this page.',
    );
  });
});

describe('the second step of sign-in', () => {
  it('moves focus to the new field only after the toggle', () => {
    const src = read('src/app/(auth)/sign-in/two-factor/second-step-form.tsx');
    expect(src).toContain("if (toggled.current) document.getElementById('code')?.focus();");
    expect(src).toContain('toggled.current = true;');
  });
});

describe('sign-up without a session', () => {
  it('states the approved text after this case only, by a fixed marker with no data', () => {
    expect(NOT_SIGNED_IN).toBe(
      'Your account was created, but you were not signed in. Sign in with your email address and password.',
    );
    expect(NOT_SIGNED_IN_PATH).toBe(`/sign-in?${NOTICE_PARAMETER}=account-created`);
    expect(NOT_SIGNED_IN_MARKER).toBe('account-created');
    const page = read('src/app/(auth)/sign-in/page.tsx');
    expect(page).toContain('notice === NOT_SIGNED_IN_MARKER');
    expect(read('src/app/(auth)/sign-up/[token]/sign-up-form.tsx')).toContain(
      "signedIn ? '/' : NOT_SIGNED_IN_PATH",
    );
  });
  it('leaves the return handling to the validator', () => {
    expect(returnPath('https://evil.example/')).toBe('/');
    expect(returnPath('/settings')).toBe('/settings');
  });
});
