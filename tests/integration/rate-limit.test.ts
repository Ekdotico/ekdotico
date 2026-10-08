// NFR-SE-07 against a real Valkey, in real time: periods of 1 and 2 seconds
// stand in for the minutes and hours of the table. Each test uses a key of its
// own, so that runs do not meet.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

// Obviously fake values: the settings module refuses to load without them.
process.env.FOUNDING_TEAM_EMAILS ??= '';
process.env.APP_ORIGIN ??= 'http://localhost:3000';
process.env.DATABASE_URL ??= 'postgresql://fake:fake@localhost:5432/fake';
process.env.AUTH_SECRET ??= 'a-test-secret-of-at-least-thirty-two-characters';
// A database of this file's own, so that the tests on what Valkey holds see
// these keys and no other test's.
const url = new URL(process.env.VALKEY_URL ?? 'redis://localhost:6379');
url.pathname = '/15';
process.env.VALKEY_URL = url.href;
process.env.RATE_LIMIT_RESET_PER_EMAIL = '3/2';
process.env.RATE_LIMIT_RESET_PER_ADDRESS = '3/2';
process.env.RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL = '2/1';

const { checkLimit, clearLimit, limitWith, takeLimit } = await import('../../src/lib/rate-limit.ts');
const { valkey } = await import('../../src/lib/valkey.ts');

const OK = { ok: true };
const refused = (retryAfterSeconds: number) => ({ ok: false, retryAfterSeconds });
const address = () => `person-${randomUUID()}@example.test`;

// A second connection: another instance of the application.
const other = new Redis(url.href);

afterAll(async () => {
  await other.quit();
  await valkey().quit();
});

describe('takeLimit', () => {
  it('admits exactly the maximum, then refuses and says when to try again', async () => {
    const key = address();
    for (let n = 0; n < 3; n += 1) expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(refused(2));
    await sleep(1100);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(refused(1));
  });

  // The owner's answer to Q10: an attempt refused because the limit was
  // already reached counts toward nothing.
  it('does not count a refused event, which does not extend the period', async () => {
    const key = address();
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    await sleep(300);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(refused(1));
    await sleep(300);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(refused(1));
    await sleep(550);
    // The period of the two counted events has passed: the full maximum again.
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(refused(1));
  });

  it('counts in any period: each event leaves the count one period after it happened', async () => {
    const key = address();
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK); // at 0 ms
    await sleep(600);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK); // at 600 ms
    await sleep(550);
    // At 1150 ms the first has left and the second has not.
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(refused(1));
    await sleep(550);
    // At 1700 ms the second has left.
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('FAILED_SIGN_IN_PER_EMAIL', key)).toEqual(refused(1));
  });

  it('keeps a count of its own for each key and for each limit', async () => {
    const key = address();
    for (let n = 0; n < 3; n += 1) await takeLimit('RESET_PER_EMAIL', key);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(refused(2));
    expect(await takeLimit('RESET_PER_EMAIL', address())).toEqual(OK);
    expect(await takeLimit('RESET_PER_ADDRESS', key)).toEqual(OK);
  });
});

describe('a limit across instances (NFR-SC-04)', () => {
  const limit = { max: 3, windowSeconds: 2 };

  it('is one count for two connections', async () => {
    const key = address();
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await limitWith(other, limit, 'RESET_PER_EMAIL', key, true)).toEqual(OK);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await limitWith(other, limit, 'RESET_PER_EMAIL', key, true)).toEqual(refused(2));
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(refused(2));
  });

  it('admits exactly the maximum of events that arrive at once', async () => {
    const key = address();
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, n) =>
        limitWith(n % 2 ? other : valkey(), limit, 'RESET_PER_EMAIL', key, true),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok)).toEqual(Array(6).fill(refused(2)));
  });
});

describe('checkLimit', () => {
  it('counts nothing, and reports a limit that is reached', async () => {
    const key = address();
    for (let n = 0; n < 10; n += 1) expect(await checkLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    for (let n = 0; n < 3; n += 1) expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await checkLimit('RESET_PER_EMAIL', key)).toEqual(refused(2));
  });
});

describe('clearLimit', () => {
  it('forgets the events of its key and of no other', async () => {
    const [key, another] = [address(), address()];
    for (let n = 0; n < 3; n += 1) {
      await takeLimit('RESET_PER_EMAIL', key);
      await takeLimit('RESET_PER_EMAIL', another);
    }
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(refused(2));
    await clearLimit('RESET_PER_EMAIL', key);
    expect(await takeLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect(await takeLimit('RESET_PER_EMAIL', another)).toEqual(refused(2));
  });
});

describe('what Valkey holds', () => {
  // FR-AU-05, NFR-SE-01: no identity data outside the database.
  it('is a digest of the key, never the key, and nothing that stays', async () => {
    const local = `person-${randomUUID()}`;
    const key = `${local}@example.test`;
    const before = new Set(await other.keys('*'));

    expect(await checkLimit('RESET_PER_EMAIL', key)).toEqual(OK);
    expect((await other.keys('*')).filter((name) => !before.has(name))).toEqual([]);

    for (let n = 0; n < 4; n += 1) await takeLimit('RESET_PER_EMAIL', key);
    const all = await other.keys('*');
    const added = all.filter((name) => !before.has(name));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatch(/^limit:RESET_PER_EMAIL:[0-9a-f]{64}$/);
    for (const name of all) expect(name).not.toContain(local);
    for (const member of await other.zrange(added[0]!, 0, '-1')) expect(member).not.toContain(local);

    // The counter expires by itself, with its last event.
    const remaining = await other.pttl(added[0]!);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(2000);
    await sleep(2200);
    expect(await other.exists(added[0]!)).toBe(0);
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
    const limit = { max: 3, windowSeconds: 2 };
    await expect(limitWith(unreachable, limit, 'RESET_PER_EMAIL', address(), true)).rejects.toThrow();
    await expect(limitWith(unreachable, limit, 'RESET_PER_EMAIL', address(), false)).rejects.toThrow();
    unreachable.disconnect();
  });

  it.each([null, '', [], false, undefined, 'OK'])(
    'refuses on the reply %j, which is not a number',
    async (reply) => {
      const odd = { eval: async () => reply } as unknown as Redis;
      const result = await limitWith(odd, { max: 3, windowSeconds: 2 }, 'RESET_PER_EMAIL', address(), true);
      expect(result).toEqual(refused(1));
    },
  );
});
