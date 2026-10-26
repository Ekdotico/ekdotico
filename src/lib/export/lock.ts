// One draft export at a time for a user (FR-EX-36: "a second request made meanwhile is refused with a 429
// response"). A key in Valkey, so that it holds across instances (NFR-SC-04), set only where it is absent and with
// an expiry, so that a process that dies holding it does not hold it for ever.
//
// THE LOCK CANNOT LEAK. It has an owner (a random token that only the holder knows), so that a release or a renewal
// by a holder whose lock has expired and been taken by another never touches the other's; it expires by itself,
// at twice the idle period of a response, and is renewed as long as the response moves
// (src/lib/export/draft.ts); and it is released by the one function that ends a response (./stream.ts).
//
// Nothing here catches an error. Where Valkey cannot be reached the call rejects and the request is refused
// (NFR-SE-06 A10: fail closed); a release that fails leaves the key to expire.
import { randomUUID } from 'node:crypto';
import { valkey } from '../valkey.ts';

const key = (userId: string) => `export-lock:${userId}`;

// Deletes the key only if it still holds this token; and extends it only if it does.
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;

export interface ExportLock {
  /** Extends the lock by its period from now; false where it is no longer this holder's. */
  renew(): Promise<boolean>;
  /** Gives the lock up. Safe to call more than once. */
  release(): Promise<void>;
}

/** The lock of this user for `ttlMs`, or null where an export of the user's is under way. */
export async function takeExportLock(userId: string, ttlMs: number): Promise<ExportLock | null> {
  const token = randomUUID();
  const taken = await valkey().set(key(userId), token, 'PX', ttlMs, 'NX');
  if (taken !== 'OK') return null;
  return {
    renew: async () => (await valkey().eval(RENEW, 1, key(userId), token, ttlMs)) === 1,
    release: async () => {
      await valkey().eval(RELEASE, 1, key(userId), token);
    },
  };
}
