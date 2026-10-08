// FR-AU-87 (h), in the form the owner gave the email of an invitation on
// 8 October 2026: the link on a line of its own, and each number its setting.
// And the one predicate of a lock in force (FR-AU-81; NFR-SE-06 A10).
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.example.test';
const TOKEN = 'A'.repeat(43);
// 37 seconds past 14:05: the text says 14:05, never a minute the link does not reach.
const UNTIL = new Date('2026-10-08T14:05:37.900Z');

async function load(signInLockSeconds = 3600, max = 20, windowSeconds = 3600) {
  vi.resetModules();
  vi.doMock('../../src/lib/settings.ts', () => ({
    settings: () => ({
      appOrigin: ORIGIN,
      signInLockSeconds,
      limits: { FAILED_SIGN_IN_PER_EMAIL: { max, windowSeconds } },
    }),
  }));
  return import('../../src/lib/auth/sign-in-lock.ts');
}
const email = async (...settings: number[]) =>
  (await load(...settings)).lockEmail('person@example.com', TOKEN, UNTIL);
afterEach(() => vi.doUnmock('../../src/lib/settings.ts'));

describe('the email of a lock', () => {
  it('has the fixed text where the settings have their initial values, with the link on a line of its own', async () => {
    const { to, subject, text } = await email();
    expect(to).toBe('person@example.com');
    expect(subject).toBe('Sign-in to your Ekdotico account is locked for 1 hour');
    expect(text.split('\n')).toEqual([
      'Sign-in to your Ekdotico account is locked for 1 hour, because sign-in to it failed 20 times within an hour. To sign in now, open this link:',
      `${ORIGIN}/sign-in/link/${TOKEN}`,
      'It works once, until 14:05 UTC on 2026-10-08, and it lifts the lock. If the failed attempts were not yours, set a new password from the sign-in page.',
    ]);
    // The requirement's own sentence, but for the line of the link and "[time]".
    expect(
      text
        .replace(`\n${ORIGIN}/sign-in/link/${TOKEN}\n`, ' [link]. ')
        .replace('14:05 UTC on 2026-10-08', '[time]'),
    ).toBe(
      'Sign-in to your Ekdotico account is locked for 1 hour, because sign-in to it failed 20 times within an hour. To sign in now, open this link: [link]. It works once, until [time], and it lifts the lock. If the failed attempts were not yours, set a new password from the sign-in page.',
    );
  });

  it('says the numbers of the settings, never a literal', async () => {
    const two = await email(7200, 12, 1800);
    expect(two.subject).toBe('Sign-in to your Ekdotico account is locked for 2 hours');
    expect(two.text).toContain(
      'is locked for 2 hours, because sign-in to it failed 12 times within 30 minutes. To',
    );
    const odd = await email(90, 1, 60);
    expect(odd.subject).toContain('locked for 90 seconds');
    expect(odd.text).toContain('failed 1 time within 1 minute.');
    expect((await email(900)).text).toContain('locked for 15 minutes,');
  });

  it('holds nothing of a person but the address it is sent to', async () => {
    const message = await email();
    expect(Object.keys(message).sort()).toEqual(['subject', 'text', 'to']);
    expect(message.subject + message.text).not.toContain('person@example.com');
  });
});

describe('a lock in force', () => {
  it('is a time that has not passed, and any time that cannot be read', async () => {
    const { lockInForce } = await load();
    const now = Date.now();
    expect(lockInForce(null, now)).toBe(false);
    expect(lockInForce(undefined, now)).toBe(false);
    expect(lockInForce(new Date(now - 1), now)).toBe(false);
    expect(lockInForce(new Date(now), now)).toBe(false);
    expect(lockInForce(new Date(now + 1), now)).toBe(true);
    // Never to a permissive default.
    expect(lockInForce(new Date(Number.NaN), now)).toBe(true);
  });
});
