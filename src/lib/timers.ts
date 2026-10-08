// The timers of the application (NFR-RE-15): scheduled work that is not a queue
// job. Started once when a process starts.
import { faultOf } from './fault.ts';
import { deleteExpiredSecurityLog } from './security-log.ts';

const HOUR_MS = 60 * 60 * 1000;

let started = false;

// NFR-RE-15, "deletion of log entries after their retention": scheduled, at
// least once a day, and idempotent. It runs each hour, so that a run that
// failed, the one at start among them, is repeated within the hour. It needs
// no claim to be safe on two instances: both delete the rows older than the
// same moment, the second finds what the first left, which is nothing, and
// neither fails.
function deleteSecurityLog(): void {
  deleteExpiredSecurityLog().then(
    // A run that found nothing to delete says nothing, or the log would hold a line an hour.
    (count) => {
      if (count > 0) console.log(`timer ran: security-log-deletion (${count} deleted)`);
    },
    // The name of the timer, and the class and code of the fault: an error's
    // message can quote a row (NFR-SE-19).
    (error) => console.error(`timer failed: security-log-deletion (${faultOf(error)})`),
  );
}

export function startTimers(): void {
  if (started) return;
  started = true;
  deleteSecurityLog();
  // unref: a timer never keeps a stopping process alive.
  setInterval(deleteSecurityLog, HOUR_MS).unref();
}
