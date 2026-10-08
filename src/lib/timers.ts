// The timers of the application (NFR-RE-15): scheduled work that is not a queue
// job. Started once when a process starts.
import { deleteExpiredTokens } from './auth/password.ts';
import { deleteEndedSessions } from './auth/session-list.ts';
import { deleteExpiredSecurityLog } from './security-log.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let started = false;

// Each is scheduled, at least once a day, and idempotent. None needs a claim
// to be safe on two instances: both delete the rows older than the same
// moment, the second finds what the first left, which is nothing, and neither
// fails.
export const DAILY: Readonly<Record<string, () => Promise<unknown>>> = {
  // NFR-RE-15, "deletion of log entries after their retention" (NFR-SE-19).
  'security-log-deletion': () => deleteExpiredSecurityLog(),
  // NFR-RE-15, "removal of ended sessions, of expired reset and confirmation
  // tokens" (FR-AU-84, FR-AU-86). The third part of that row, the address of an
  // admission invitation 30 days on, is not built yet.
  'ended-session-removal': () => deleteEndedSessions(),
  'expired-token-removal': () => deleteExpiredTokens(),
};

function runDaily(): void {
  for (const [name, run] of Object.entries(DAILY)) {
    // Only the name of the timer is reported: an error's message can quote a row.
    run().catch(() => console.error(`timer failed: ${name}`));
  }
}

export function startTimers(): void {
  if (started) return;
  started = true;
  runDaily();
  // unref: a timer never keeps a stopping process alive.
  setInterval(runDaily, DAY_MS).unref();
}
