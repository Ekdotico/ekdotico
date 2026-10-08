// The timers of the application (NFR-RE-15): scheduled work that is not a queue
// job. Started once when a process starts.
import { deleteExpiredTokens } from './auth/password.ts';
import { deleteEndedSessions } from './auth/session-list.ts';
import { faultOf } from './fault.ts';
import { deleteExpiredSecurityLog } from './security-log.ts';

const HOUR_MS = 60 * 60 * 1000;

let started = false;

// Each is scheduled, at least once a day, and idempotent, and answers with
// the number of rows it deleted. They run each hour, so that a run that
// failed, the one at start among them, is repeated within the hour. None needs
// a claim to be safe on two instances: both delete the rows older than the
// same moment, the second finds what the first left, which is nothing, and
// neither fails.
export const TIMERS: Readonly<Record<string, () => Promise<number>>> = {
  // NFR-RE-15, "deletion of log entries after their retention" (NFR-SE-19).
  'security-log-deletion': () => deleteExpiredSecurityLog(),
  // NFR-RE-15, "removal of ended sessions, of expired reset and confirmation
  // tokens" (FR-AU-84, FR-AU-86). The third part of that row, the address of an
  // admission invitation 30 days on, is not built yet.
  'ended-session-removal': () => deleteEndedSessions(),
  'expired-token-removal': () => deleteExpiredTokens(),
};

function runTimers(): void {
  for (const [name, run] of Object.entries(TIMERS)) {
    run().then(
      // A run that found nothing to delete says nothing, or the log would hold a line an hour.
      (count) => {
        if (count > 0) console.log(`timer ran: ${name} (${count} deleted)`);
      },
      // The name of the timer, and the class and code of the fault: an error's
      // message can quote a row (NFR-SE-19).
      (error) => console.error(`timer failed: ${name} (${faultOf(error)})`),
    );
  }
}

export function startTimers(): void {
  if (started) return;
  started = true;
  runTimers();
  // unref: a timer never keeps a stopping process alive.
  setInterval(runTimers, HOUR_MS).unref();
}
