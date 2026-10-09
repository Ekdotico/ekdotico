import { beforeAll, describe, expect, it } from 'vitest';

let stopped: (typeof import('../../src/lib/auth/founding-gate.ts'))['stoppedByFoundingGate'];

// Written by their code points (tests/unit/field-text.test.ts).
const of = (points: string) =>
  String.fromCodePoint(...points.split(' ').map((point) => Number.parseInt(point, 16)));
const GREEK = {
  upper: `${of('39f 394 39f 3a3')}@example.gr`,
  finalSigma: `${of('3bf 3b4 3bf 3c2')}@example.gr`,
  sigma: `${of('3bf 3b4 3bf 3c3')}@example.gr`,
};
const MARKED = { composed: `andr${of('e9')}@example.com`, decomposed: `andre${of('301')}@example.com` };

beforeAll(async () => {
  Object.assign(process.env, {
    // Entries are lowered when the list is read (FR-AU-83).
    // The third is Greek in capitals, ending in sigma; the fourth has a
    // letter typed as a base and a mark.
    FOUNDING_TEAM_EMAILS: `Founder@Example.com, second@example.com, ${GREEK.upper}, ${MARKED.decomposed}`,
    APP_ORIGIN: 'https://app.example.test',
    TRUSTED_PROXY_COUNT: '1',
    EMAIL_TRANSPORT: 'sink',
    EMAIL_SINK_DIRECTORY: '/unused',
    AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
    DATABASE_URL: 'postgresql://unused',
    VALKEY_URL: 'redis://unused',
  });
  ({ stoppedByFoundingGate: stopped } = await import('../../src/lib/auth/founding-gate.ts'));
});

const account = (email: string | null, twoFactorEnabled: boolean | null = false, emailVerified = true) => ({
  email,
  emailVerified,
  twoFactorEnabled,
});

// FR-AU-83; register D114, A102.
describe('the founding-team gate', () => {
  it('stops an account whose verified address is on the list, until two-factor authentication is on', () => {
    expect(stopped(account('founder@example.com'))).toBe(true);
    expect(stopped(account('second@example.com'))).toBe(true);
    expect(stopped(account('founder@example.com', true))).toBe(false);
  });

  it('compares without regard to case', () => {
    expect(stopped(account('FOUNDER@example.COM'))).toBe(true);
    expect(stopped(account('Founder@Example.com'))).toBe(true);
  });

  // FR-AU-02; the owner's decision of 9 October 2026: both sides of the
  // comparison are written in the one spelling of an address (field-text.ts).
  it('compares in the one spelling of an address: either sigma, and a letter composed or not', () => {
    // As an account stores it, and as a row from before the rule could.
    for (const email of [GREEK.sigma, GREEK.finalSigma, GREEK.upper]) {
      expect(stopped(account(email)), email).toBe(true);
    }
    for (const email of [MARKED.composed, MARKED.decomposed]) {
      expect(stopped(account(email)), email).toBe(true);
    }
    expect(stopped(account(GREEK.sigma, true))).toBe(false);
  });

  it('takes anything but true for two-factor authentication as off', () => {
    expect(stopped(account('founder@example.com', null))).toBe(true);
    expect(stopped(account('founder@example.com', 'true' as never))).toBe(true);
    expect(stopped(account('founder@example.com', 1 as never))).toBe(true);
  });

  it('does not stop an account whose address is not on the list', () => {
    for (const email of [
      'writer@example.com',
      'founder@example.com.evil.example',
      'xfounder@example.com',
      'founder@example.co',
      ' founder@example.com',
      'founder@example.com,second@example.com',
      '',
    ]) {
      expect(stopped(account(email))).toBe(false);
    }
  });

  it('reads the verified address: an unverified one, and a tombstone, are no account of the team', () => {
    expect(stopped(account('founder@example.com', false, false))).toBe(false);
    expect(stopped(account(null))).toBe(false);
  });
});
