// NFR-SE-07 against a real Valkey, in real time: periods of 3 and 6 seconds
// stand in for the minutes and hours of the table. Each test uses a key of its
// own, so that runs do not meet.
//
// The waits are long beside the time a call takes, and a result is asserted
// only where a wait guarantees it or leaves more than a second to spare, so
// that a machine that stalls does not flip one.
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Obviously fake values: the settings module refuses to load without them.
process.env.FOUNDING_TEAM_EMAILS ??= '';
process.env.APP_ORIGIN ??= 'http://localhost:3000';
process.env.DATABASE_URL ??= 'postgresql://fake:fake@localhost:5432/fake';
// The limiter keys its counters by this secret, so a secret of its own gives
// this run counters that no other run on the machine can name.
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
process.env.AUTH_SECRET = SECRET;
// A database apart from the one a development machine uses.
const url = new URL(process.env.VALKEY_URL ?? 'redis://localhost:6379');
url.pathname = '/15';
process.env.VALKEY_URL = url.href;
process.env.RATE_LIMIT_RESET_PER_EMAIL = '3/6';
process.env.RATE_LIMIT_RESET_PER_ADDRESS = '3/6';
process.env.RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL = '2/3';

const { checkLimit, clearLimit, limitWith, takeLimit } = await import('../../src/lib/rate-limit.ts');
const { valkey } = await import('../../src/lib/valkey.ts');

const OK = { ok: true };
/** Refused, whenever it says to try again: the seconds are asserted in the first test alone. */
const REFUSED = { ok: false, retryAfterSeconds: expect.any(Number) };
const address = () => `person-${randomUUID()}@example.test`;

// A second connection: another instance of the application.
const other = new Redis(url.href);

afterAll(async () => {
  await other.quit();
  await valkey().quit();
});

describe('the connection (NFR-SE-06 A10)', () => {
  // A Valkey that does not answer fails the request within seconds.
  it('gives up on a connection and on a command after 5 seconds, and retries a command twice', () => {
    expect(valkey().options).toMatchObject({
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      commandTimeout: 5000,
    });
  });

  // NFR-SE-19: the client would print the address of the server itself.
  it('reports a fault of the connection by its class and code, never its message', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fault = Object.assign(new Error('connect ECONNREFUSED 192.0.2.7:6379'), { code: 'ECONNREFUSED' });
    valkey().emit('error', fault);
    expect(errors.mock.calls).toEqual([['valkey: connection fault (Error ECONNREFUSED)']]);
    errors.mockRestore();
  });
});

// The waits of these tests add up to more than the 5 seconds a test is given.
describe('takeLimit', { timeout: 30_000 }, () => {
  it('admits exactly the maximum, then refuses and says when to try again', async () => {
    const key = address();
    for (let n = 0; n < 3; n += 1) expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    const atOnce = await takeLimit('RESET_PER_EMAIL', key);
    // The whole period, 6 seconds, less whatever the calls took.
    expect(atOnce).toEqual(REFUSED);
    expect((atOnce as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(3);
    expect((atOnce as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(6);
    await sleep(3300);
    // At least 3.3 seconds on, no more than 2.7 are left: 3 at the most.
    const later = await takeLimit('RESET_PER_EMAIL', key);
    expect(later).toEqual(REFUSED);
    expect((later as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((later as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(3);
  });

  // The owner's answer to Q10: an attempt refused because the limit was
  // already reached counts toward nothing.
  it('does not count a refused event, which does not extend the period', async () => {
    const key = address();
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    await sleep(900);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(REFUSED);
    await sleep(900);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(REFUSED);
    await sleep(1650);
    // 3.45 seconds on, the period of the two counted events has passed: the
    // full maximum again. Had a refusal counted, it would still be held.
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(REFUSED);
  });

  it('counts in any period: each event leaves the count one period after it happened', async () => {
    const key = address();
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK); // at 0 s
    await sleep(1800);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK); // at 1.8 s
    await sleep(1650);
    // At 3.45 s the first has left and the second has not.
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(REFUSED);
    await sleep(1650);
    // At 5.1 s the second has left.
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(REFUSED);
  });

  it('keeps a count of its own for each key and for each limit', async () => {
    const key = address();
    for (let n = 0; n < 3; n += 1) await takeLimit('RESET_PER_EMAIL', key);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(REFUSED);
    expect(await takeLimit('RESET_PER_EMAIL', address())).toEqual(OK);
    expect(await takeLimit('RESET_PER_ADDRESS', key)).toEqual(OK);
  });

  // NFR-SE-07, "invitations created": one request may create several (S13-5).
  it('counts several events at once, all of them or none', async () => {
    const limit = { max: 5, windowSeconds: 60 };
    const key = address();
    expect(await limitWith(valkey(), limit, 'INVITATIONS_PER_USER', key, true, 3)).toEqual(OK);
    // Three more would pass five: refused whole, and none of them counted.
    expect(await limitWith(valkey(), limit, 'INVITATIONS_PER_USER', key, true, 3)).toEqual(REFUSED);
    expect(await limitWith(valkey(), limit, 'INVITATIONS_PER_USER', key, true, 2)).toEqual(OK);
    expect(await limitWith(valkey(), limit, 'INVITATIONS_PER_USER', key, true, 1)).toEqual(REFUSED);
    // More at once than the limit ever allows is refused for its window.
    expect(await limitWith(valkey(), limit, 'INVITATIONS_PER_USER', address(), true, 6)).toEqual({
      ok: false,
      retryAfterSeconds: 60,
    });
  });
});

describe('a limit across instances (NFR-SC-04)', () => {
  const limit = { max: 3, windowSeconds: 6 };

  it('is one count for two connections', async () => {
    const key = address();
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await limitWith(other, limit, 'RESET_PER_EMAIL', key, true)).toEqual(OK);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await limitWith(other, limit, 'RESET_PER_EMAIL', key, true)).toEqual(REFUSED);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(REFUSED);
  });

  it('admits exactly the maximum of events that arrive at once', async () => {
    const key = address();
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, n) =>
        limitWith(n % 2 ? other : valkey(), limit, 'RESET_PER_EMAIL', key, true),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok)).toEqual(Array(6).fill(REFUSED));
  });
});

describe('checkLimit', () => {
  it('counts nothing, and reports a limit that is reached', async () => {
    const key = address();
    for (let n = 0; n < 10; n += 1) expect(await checkLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    for (let n = 0; n < 3; n += 1) expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await checkLimit('RESET_PER_EMAIL', key)).toEqual(REFUSED);
  });
});

describe('clearLimit', () => {
  it('forgets the events of its key and of no other', async () => {
    const [key, another] = [address(), address()];
    for (let n = 0; n < 3; n += 1) {
      await takeLimit('RESET_PER_EMAIL', key);
      await takeLimit('RESET_PER_EMAIL', another);
    }
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(REFUSED);
    await clearLimit('RESET_PER_EMAIL', key);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('RESET_PER_EMAIL', another)).toEqual(REFUSED);
  });
});

describe('what Valkey holds', { timeout: 30_000 }, () => {
  // FR-AU-05, NFR-SE-01: no identity data outside the database.
  it('is a digest of the key, never the key, and nothing that stays', async () => {
    const local = `person-${randomUUID()}`;
    const key = `${local}@example.test`;
    // The one name the counter of this key can have: a digest under this
    // run's secret. Other runs on the machine write to the same database, so
    // nothing here counts the names it holds.
    const digest = createHmac('sha256', SECRET)
      .update(`rate-limit:FAILED_SIGN_IN_PER_EMAIL:${key}`)
      .digest('hex');
    const name = `limit:FAILED_SIGN_IN_PER_EMAIL:${digest}`;

    expect(await checkLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await other.exists(name)).toBe(0);

    for (let n = 0; n < 3; n += 1) await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key);
    expect(await other.exists(name)).toBe(1);
    // Under no other name either, and in no member of the counter.
    for (const held of await other.keys('*')) expect(held).not.toContain(local);
    const members = await other.zrange(name, 0, '-1');
    expect(members).toHaveLength(2);
    for (const member of members) expect(member).not.toContain(local);

    // The counter expires by itself, with its last event.
    const remaining = await other.pttl(name);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(3000);
    await sleep(3200);
    expect(await other.exists(name)).toBe(0);
  });

  it('holds no counter without an expiry', async () => {
    await takeLimit('RESET_PER_ADDRESS', address());
    const names = await other.keys('limit:*');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(await other.pttl(name)).not.toBe(-1);
  });
});

describe('where Valkey cannot be reached (NFR-SE-06 A10)', () => {
  it('rejects, and never admits', async () => {
    const unreachable = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    unreachable.on('error', () => {});
    const limit = { max: 3, windowSeconds: 6 };
    await expect(limitWith(unreachable, limit, 'RESET_PER_EMAIL', address(), true)).rejects.toThrow();
    await expect(limitWith(unreachable, limit, 'RESET_PER_EMAIL', address(), false)).rejects.toThrow();
    unreachable.disconnect();
  });

  it.each([null, '', [], false, undefined, 'OK'])(
    'refuses on the reply %j, which is not a number',
    async (reply) => {
      const odd = { eval: async () => reply } as unknown as Redis;
      const result = await limitWith(odd, { max: 3, windowSeconds: 6 }, 'RESET_PER_EMAIL', address(), true);
      expect(result).toEqual({ ok: false, retryAfterSeconds: 1 });
    },
  );
});
