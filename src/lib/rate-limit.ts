// The limits of NFR-SE-07, counted in Valkey so that a limit holds across
// instances (NFR-SC-04). "N in any M seconds" is a sliding window: each event
// is one member of a sorted set, scored by the time it happened, and leaves
// the count M seconds later.
//
// Nothing here catches an error. Where Valkey cannot be reached the call
// rejects, and the caller refuses the request (NFR-SE-06 A10: fail closed).
// Nothing here is of Next.js: the collaboration server limits its handshakes
// through this module.
import { createHmac, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { securityLog } from './security-log.ts';
import { settings, type Limit, type LimitName } from './settings.ts';
import { valkey } from './valkey.ts';

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

// One script, so that the check and the count are one step whichever instance
// asks. The clock is Valkey's, so the instances need not agree on the time.
// It returns 0 where the events are admitted, all of them, and otherwise the
// milliseconds until they would be. ARGV[4] is how many events at once (one
// request that creates several invitations, NFR-SE-07): all are counted, or
// none. More at once than the limit allows ever is refused for its window.
const SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local amount = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if amount > max then return window end
if count + amount <= max then
  if ARGV[3] ~= '' then
    for i = 1, amount do redis.call('ZADD', KEYS[1], now, ARGV[3] .. ':' .. i) end
    redis.call('PEXPIRE', KEYS[1], window)
  end
  return 0
end
local leaving = redis.call('ZRANGE', KEYS[1], count + amount - max - 1, count + amount - max - 1, 'WITHSCORES')
return leaving[2] + window - now
`;

// FR-AU-05, NFR-SE-01: no identity data is held outside the database, and a
// key may be an email address. Valkey holds a keyed digest of it.
function storageKey(name: LimitName, key: string): string {
  const digest = createHmac('sha256', settings().authSecret)
    .update(`rate-limit:${name}:${key}`)
    .digest('hex');
  return `limit:${name}:${digest}`;
}

/**
 * The one implementation, on a given connection and with a given limit. With
 * `count` false nothing is counted. Exported for the tests, which need short
 * periods and a second connection.
 */
export async function limitWith(
  client: Redis,
  limit: Limit,
  name: LimitName,
  key: string,
  count: boolean,
  amount = 1,
): Promise<LimitResult> {
  // ponytail: EVAL sends the script on each call; defineCommand (EVALSHA) if that ever shows in a profile.
  const reply = await client.eval(
    SCRIPT,
    1,
    storageKey(name, key),
    limit.max,
    limit.windowSeconds * 1000,
    count ? randomUUID() : '',
    Math.max(1, Math.trunc(amount)),
  );
  // Nothing but the number 0 admits: an empty or absent reply is a refusal.
  if (reply === 0) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(Number(reply) / 1000) || 1) };
}

/**
 * Counts `amount` events (one by default) against the limit unless they would
 * pass it. Refused events are not counted, and are refused together.
 */
export function takeLimit(name: LimitName, key: string, amount = 1): Promise<LimitResult> {
  return limitWith(valkey(), settings().limits[name], name, key, true, amount);
}

/** Whether the limit is reached, without counting anything. */
export function checkLimit(name: LimitName, key: string): Promise<LimitResult> {
  return limitWith(valkey(), settings().limits[name], name, key, false);
}

/**
 * A limit counted in the memory of this process: "`max` in any
 * `windowSeconds`", exactly, for each key. The one limit that is not in Valkey:
 * the messages of the collaboration server (the number is the owner's
 * decision of 12 October 2026; where it is counted is reported for the
 * amendment of NFR-SE-07, which says "never in the memory of one instance").
 * For two reasons. What it protects is the one thread
 * of the instance that counts, which no other instance shares; and it is asked
 * for every message a writer sends, where an answer from Valkey would be
 * awaited before each keystroke is applied and a Valkey that does not answer
 * would refuse them all (measured: docs/operations/deployment.md).
 *
 * For each key it holds the times of the last `max` events it admitted, in a
 * ring: one more is admitted where the oldest of them has left the period. A
 * refused event is not counted. A key is forgotten once its last event has
 * left, looked for when a new key arrives. `held` is given by a test, which
 * counts the keys in it.
 */
export function limitHere(
  { max, windowSeconds }: Limit,
  held = new Map<string, { times: number[]; next: number }>(),
): (key: string, now?: number) => LimitResult {
  const period = windowSeconds * 1000;
  return (key, now = performance.now()) => {
    let ring = held.get(key);
    if (!ring) {
      // `at(next - 1)` is the latest: every ring holds one event at least.
      for (const [each, { times, next }] of held) if (now - times.at(next - 1)! >= period) held.delete(each);
      held.set(key, (ring = { times: [], next: 0 }));
    }
    // The slot that is written next holds the `max`-th last event, once there have been that many.
    const oldest = ring.times.length === max ? ring.times[ring.next]! : -Infinity;
    if (now - oldest < period) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + period - now) / 1000)) };
    }
    ring.times[ring.next] = now;
    ring.next = (ring.next + 1) % max;
    return { ok: true };
  };
}

/** The Valkey key of a mark (see `oncePer`). Exported for the tests, which clear one. */
export function markKey(mark: string): string {
  return `limit-logged:${createHmac('sha256', settings().authSecret).update(mark).digest('hex')}`;
}

/**
 * Whether this is the first call for `mark` in `seconds`, across instances:
 * the one mark behind every "one entry for each period". It is in Valkey,
 * under a keyed digest, so that two environments on one Valkey do not share a
 * mark and Valkey holds nothing a mark names, an address among them.
 */
export async function oncePer(mark: string, seconds: number): Promise<boolean> {
  return (await valkey().set(markKey(mark), '1', 'EX', seconds, 'NX')) === 'OK';
}

/**
 * NFR-SE-19: an entry when a limit is reached, with the user where there is
 * one and never the key, which may be an address. One entry for each period of
 * a limit and not one for each request refused in it, or a flood over the
 * limit would write to the database at the rate the limit exists to keep from
 * it. The proxy, a route with a limit of its own, and the sign-in all log
 * here, and so does the collaboration server, which cannot load anything of
 * Next.js. `seconds` is what is left of the period.
 */
export async function logLimitReached(
  name: LimitName,
  key: string,
  seconds: number,
  userId?: string,
): Promise<void> {
  if (await oncePer(`${name}:${key}`, seconds)) await securityLog({ kind: 'rate_limit_reached', userId });
}

/** Forgets the events counted for this key (a completed password reset clears the failed sign-ins). */
export async function clearLimit(name: LimitName, key: string): Promise<void> {
  await valkey().del(storageKey(name, key));
}
