// The limits of NFR-SE-07, counted in Valkey so that a limit holds across
// instances (NFR-SC-04). "N in any M seconds" is a sliding window: each event
// is one member of a sorted set, scored by the time it happened, and leaves
// the count M seconds later.
//
// Nothing here catches an error. Where Valkey cannot be reached the call
// rejects, and the caller refuses the request (NFR-SE-06 A10: fail closed).
import { createHmac, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { settings, type Limit, type LimitName } from './settings.ts';
import { valkey } from './valkey.ts';

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

// One script, so that the check and the count are one step whichever instance
// asks. The clock is Valkey's, so the instances need not agree on the time.
// It returns 0 where the event is admitted, and otherwise the milliseconds
// until one more would be.
const SCRIPT = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < max then
  if ARGV[3] ~= '' then
    redis.call('ZADD', KEYS[1], now, ARGV[3])
    redis.call('PEXPIRE', KEYS[1], window)
  end
  return 0
end
local leaving = redis.call('ZRANGE', KEYS[1], count - max, count - max, 'WITHSCORES')
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
): Promise<LimitResult> {
  // ponytail: EVAL sends the script on each call; defineCommand (EVALSHA) if that ever shows in a profile.
  const reply = await client.eval(
    SCRIPT,
    1,
    storageKey(name, key),
    limit.max,
    limit.windowSeconds * 1000,
    count ? randomUUID() : '',
  );
  // Nothing but the number 0 admits: an empty or absent reply is a refusal.
  if (reply === 0) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(Number(reply) / 1000) || 1) };
}

/** Counts one event against the limit unless it is already reached. A refused event is not counted. */
export function takeLimit(name: LimitName, key: string): Promise<LimitResult> {
  return limitWith(valkey(), settings().limits[name], name, key, true);
}

/** Whether the limit is reached, without counting anything. */
export function checkLimit(name: LimitName, key: string): Promise<LimitResult> {
  return limitWith(valkey(), settings().limits[name], name, key, false);
}

/** Forgets the events counted for this key (a completed password reset clears the failed sign-ins). */
export async function clearLimit(name: LimitName, key: string): Promise<void> {
  await valkey().del(storageKey(name, key));
}
