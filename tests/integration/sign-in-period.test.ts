// The periods of the limits on failed sign-ins (NFR-SE-07), with periods short
// enough for a test to outlast. The counts themselves are in sign-in.test.ts.
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { createAccount, handle, load, ORIGIN, PASSWORD, prepare } from './identity.ts';

const database = prepare('signinperiod', {
  TRUSTED_PROXY_COUNT: '1',
  // Not the initial values: the limits are configuration.
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: '2/3',
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: '4/4',
});
const { auth, db, valkey } = await load();

const WRONG = 'a wrong password, long enough';
const signIn = async (email: string, password: string, n: number) =>
  (
    await handle(
      auth,
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': `198.51.100.${n}` },
        body: JSON.stringify({ email, password }),
      }),
    )
  ).status;

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the period of a limit on failed sign-ins (NFR-SE-07; the owner’s answer to Q10)', () => {
  it('ends 3 seconds after the failures from one network address, whatever was refused meanwhile', async () => {
    await createAccount(auth, 'one@example.com');
    // The period is open from the first failure, which leaves the count 3
    // seconds after it was made: so the time is taken before it, and "still
    // refused" is asked only while that failure cannot have left, with a
    // second to spare for a slow machine.
    const began = Date.now();
    expect(await signIn('one@example.com', WRONG, 1)).toBe(401);
    expect(await signIn('one@example.com', WRONG, 1)).toBe(401);
    const reached = Date.now();

    // Refused attempts, right and wrong, for most of the period: none is
    // counted, and none makes the period longer.
    while (Date.now() < began + 2000) {
      expect(await signIn('one@example.com', PASSWORD, 1)).toBe(401);
      expect(await signIn('one@example.com', WRONG, 1)).toBe(401);
      await pause(100);
    }
    await pause(reached + 3300 - Date.now());
    expect(await signIn('one@example.com', PASSWORD, 1)).toBe(200);
  }, 15_000);

  it('ends 4 seconds after the failures from all network addresses, whatever was refused meanwhile', async () => {
    await createAccount(auth, 'all@example.com');
    const began = Date.now();
    for (const n of [1, 2, 3, 4]) expect(await signIn('all@example.com', WRONG, n)).toBe(401);
    const reached = Date.now();

    while (Date.now() < began + 3000) {
      expect(await signIn('all@example.com', PASSWORD, 5)).toBe(401);
      expect(await signIn('all@example.com', WRONG, 6)).toBe(401);
      await pause(100);
    }
    await pause(reached + 4300 - Date.now());
    expect(await signIn('all@example.com', PASSWORD, 5)).toBe(200);
  }, 15_000);

  it('is "any" period: a failure leaves the count when it is 3 seconds old, and not before', async () => {
    await createAccount(auth, 'any@example.com');
    expect(await signIn('any@example.com', WRONG, 1)).toBe(401);
    await pause(1700);
    expect(await signIn('any@example.com', WRONG, 1)).toBe(401);
    // The first failure is 3 seconds old and the second is not: one more may fail.
    await pause(1600);
    expect(await signIn('any@example.com', WRONG, 1)).toBe(401);
    expect(await signIn('any@example.com', PASSWORD, 1)).toBe(401);
  }, 15_000);
});
