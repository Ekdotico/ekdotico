import { beforeAll, describe, expect, it } from 'vitest';

let stopped: (typeof import('../../src/lib/auth/founding-gate.ts'))['stoppedByFoundingGate'];

beforeAll(async () => {
  Object.assign(process.env, {
    // Entries are lowered when the list is read (FR-AU-83).
    FOUNDING_TEAM_EMAILS: 'Founder@Example.com, second@example.com',
    APP_ORIGIN: 'https://app.example.test',
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
