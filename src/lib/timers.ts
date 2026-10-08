// The timers of the application (NFR-RE-15): scheduled work that is not a queue
// job. Started once when a process starts.
import { deleteExpiredSecurityLog } from './security-log.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let started = false;

// NFR-RE-15, "deletion of log entries after their retention": scheduled, at
// least once a day, and idempotent. It needs no claim to be safe on two
// instances: both delete the rows older than the same moment, the second finds
// what the first left, which is nothing, and neither fails.
function deleteSecurityLog(): void {
  // Only the name of the timer is reported: an error's message can quote a row.
  deleteExpiredSecurityLog().catch(() => console.error('timer failed: security-log-deletion'));
}

export function startTimers(): void {
  if (started) return;
  started = true;
  deleteSecurityLog();
  // unref: a timer never keeps a stopping process alive.
  setInterval(deleteSecurityLog, DAY_MS).unref();
}
