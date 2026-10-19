// The timers of the application (NFR-RE-15): scheduled work that is not a queue
// job. Started once when a process starts.
import { deleteExpiredDocuments } from './documents/deletion.ts';
import { expireOffers } from './documents/ownership.ts';
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
  // NFR-RE-15, "the expiry of the offer" (FR-ED-47): writes the offers past their time expired and
  // deletes their notifications; it says how many it deleted.
  'ownership-offer-expiry': () => expireOffers(),
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

// NFR-RE-15, "permanent deletion of a deleted document when its retention
// ends" (FR-ED-36): scheduled, at least once a day. Each hour, for the reason
// above, and so that a document whose deletion was left unfinished is taken
// up again within two. With two instances each document is deleted by one of
// them: src/lib/documents/deletion.ts says how.
function deleteDocuments(): void {
  deleteExpiredDocuments().then(
    ({ deleted, kept }) => {
      // A document that was kept has its own line, from the run.
      if (deleted > 0 || kept > 0)
        console.log(`timer ran: document-deletion (${deleted} deleted, ${kept} kept)`);
    },
    (error) => console.error(`timer failed: document-deletion (${faultOf(error)})`),
  );
}

export function startTimers(): void {
  if (started) return;
  started = true;
  for (const run of [runTimers, deleteDocuments]) {
    run();
    // unref: a timer never keeps a stopping process alive.
    setInterval(run, HOUR_MS).unref();
  }
}
