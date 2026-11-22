// The timers of the application (NFR-RE-15): scheduled work that is not a queue
// job. Started once when a process starts.
import { carryOutDeletions } from './account/deletion-steps.ts';
import { clearAdmissionAddresses } from './admission/invitations.ts';
import { deleteExpiredRemovedNotifications } from './documents/access-notifications.ts';
import { carryOutClearings } from './clearing/deletion.ts';
import { deliverUnsentClearingEmails } from './clearing/email.ts';
import { deleteExpiredDocuments } from './documents/deletion.ts';
import {
  clearInvitationAddresses,
  deleteEndedInvitationNotifications,
  remindInvitations,
} from './documents/invitation-timers.ts';
import { deliverUnsentBatches } from './account/transfer-email.ts';
import { deliverUnsentOffers, expireOffers } from './documents/ownership.ts';
import { deleteExpiredTokens } from './auth/password.ts';
import { deleteEndedSessions } from './auth/session-list.ts';
import { EMAIL_RETRY_INTERVAL_MS, retryEmails } from './email/retry.ts';
import { faultOf } from './fault.ts';
import { db } from './db.ts';
import { emailHealthy } from './email/health.ts';
import { checkIn } from './healthcheck.ts';
import { settings } from './settings.ts';
import { deleteExpiredImagesNow } from './images/deletion.ts';
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
  // tokens" (FR-AU-84, FR-AU-86), and "the address of an admission invitation
  // 30 days after it is revoked or expires" (FR-AU-89); says how many it cleared.
  'ended-session-removal': () => deleteEndedSessions(),
  'expired-token-removal': () => deleteExpiredTokens(),
  'admission-address-clearing': () => clearAdmissionAddresses(),
  // NFR-RE-15, "the reminder of a document invitation" (FR-ED-48): the one reminder, claimed on the
  // invitation's row before its email is handed over; it deletes nothing and says 0 (S18-7).
  'invitation-reminder': () => remindInvitations(),
  // NFR-RE-15, "the clearing of the invited address 30 days after an invitation is declined,
  // revoked, or expires" (FR-ED-37); says how many addresses it cleared.
  'invitation-address-clearing': () => clearInvitationAddresses(),
  // FR-ED-42 (S13-6): the notifications of invitations that are no longer open, which an expiry
  // leaves behind, since it has no event to delete them on.
  'invitation-notification-removal': () => deleteEndedInvitationNotifications(),
  // NFR-RE-15, "the expiry of the offer" (FR-ED-47): writes the offers past their time expired and
  // deletes their notifications; it says how many offers it expired.
  'ownership-offer-expiry': () => expireOffers(),
  // NFR-RE-15, "the email of an offer of ownership": the backstop of the hand-over after the response (S17-6),
  // and the same for the one email to each person offered by a transfer of all documents (FR-AU-92).
  // Both are run whatever the other does: a failure of one is the timer's failure, after the other has run.
  'ownership-offer-email': async () => {
    const [batches, offers] = await Promise.allSettled([deliverUnsentBatches(), deliverUnsentOffers()]);
    if (offers.status === 'rejected') throw offers.reason;
    if (batches.status === 'rejected') throw batches.reason;
    return offers.value;
  },
  // FR-ED-42 (register row PR-8): the notification of a removal stays 30 days, and so does the Owner's
  // notice of an ended offer (D217), which the same run deletes. The name
  // is kept: a claim row and the logs know it.
  'removed-notification-removal': () => deleteExpiredRemovedNotifications(),
  // NFR-RE-15, "deletion from storage of an image that no longer appears in its document" (NFR-SE-18):
  // the images out of their documents for 30 days, the object and the row; says how many it deleted.
  'image-deletion': () => deleteExpiredImagesNow(),
  // NFR-RE-15, "the steps of an account deletion in Closed α" (FR-AU-58): a step that failed is
  // repeated here until it succeeds, under the claim of the deletion (it needs a claim to be safe
  // on two instances, which the others above do not); says how many steps it carried out.
  // A deletion stuck at a call to the feedback intake for 24 hours (fw-detach-wait) raises the alarm at a check of
  // its own, HEALTHCHECK_DELETION_URL: each run checks in there while none is stuck and calls `/fail` while one is,
  // so the service emails the owner and the timers' own check carries nothing of it. It names no account.
  'account-deletion-steps': async () => {
    const outcome = await carryOutDeletions();
    await checkInDeletion(outcome.stuckAtFeedback);
    return outcome.steps;
  },
  // NFR-RE-15, "the clearing of all of an account's documents" (FR-AU-91): the permanent deletion of each document
  // a clearing confirmed, "idempotent and repeated on a timer ... until every one of them is deleted" (a shared one
  // from its day on), under the document's own claim; says how many documents it deleted.
  'clearing-deletion': async () => (await carryOutClearings()).deleted,
  // NFR-RE-15, the email of the notice of a clearing: the backstop of the hand-over after the response, under the
  // clearing's own claim, so that it is sent once. Deletes nothing and says 0.
  'clearing-email': () => deliverUnsentClearingEmails(),
};

function runTimers(): void {
  for (const [name, run] of Object.entries(TIMERS)) {
    run().then(
      // A run that found nothing to delete says nothing, or the log would hold a line an hour.
      (count) => {
        // A clearing empties an address from a row that stays: it says "cleared", not "deleted". The
        // steps of an account deletion delete nothing they count: "carried out".
        if (count > 0) {
          const what = name.endsWith('-clearing')
            ? 'cleared'
            : name.endsWith('-steps')
              ? 'carried out'
              : 'deleted';
          console.log(`timer ran: ${name} (${count} ${what})`);
        }
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

// NFR-RE-15, D263: the emails of a document that the service certainly did not take are tried again every 15
// minutes, not each hour, so it has its own interval. Each attempt removes its row first (src/lib/email/retry.ts),
// so two instances do not send one twice.
/**
 * The settings, read when a timer runs and not when the module loads, and undefined where they cannot be
 * loaded. A process that runs the timers has loaded them at start and refused to start otherwise
 * (src/instrumentation.ts), so undefined here is a process that never loaded them, such as a test of another
 * timer; monitoring must not fail a run or write a line for it.
 */
function checkInSettings(): ReturnType<typeof settings> | undefined {
  try {
    return settings();
  } catch {
    return undefined;
  }
}

/**
 * D274, D320: while email is healthy (src/lib/email/health.ts) this run checks in at HEALTHCHECK_EMAIL_URL, and
 * while it is not it stays silent, so that the service emails the owner. Never rejects; it counts nothing and
 * calls nothing where the address is not set.
 */
export async function checkInEmail(): Promise<void> {
  const url = checkInSettings()?.healthcheckEmailUrl;
  if (!url) return;
  try {
    if (emailHealthy(await db().emailRetry.count())) await checkIn(url);
  } catch (error) {
    // Without a count nothing is known, so nothing checks in.
    console.error(`timer failed: email-health (${faultOf(error)})`);
  }
}

/**
 * The check of the deletions: `/fail` where a confirmed deletion has been stuck at a call to the feedback intake
 * for 24 hours, a check-in otherwise. Never rejects; calls nothing where HEALTHCHECK_DELETION_URL is not set.
 */
export async function checkInDeletion(stuck: number): Promise<void> {
  await checkIn(checkInSettings()?.healthcheckDeletionUrl, stuck > 0 ? 'fail' : 'ok');
}

function retryDocumentEmails(): void {
  retryEmails().then(
    // D275, "the application's timers": a run of this timer that reached the database and ended without
    // a fault checks in. Nothing is called where HEALTHCHECK_TIMERS_URL is not set, and a check-in never
    // fails the run. It is this timer's run because it is the shortest, so the grace of the check is short.
    () => {
      void checkIn(checkInSettings()?.healthcheckTimersUrl);
      void checkInEmail();
    },
    (error) => console.error(`timer failed: email-retry (${faultOf(error)})`),
  );
}

export function startTimers(): void {
  if (started) return;
  started = true;
  for (const [run, every] of [
    [runTimers, HOUR_MS],
    [deleteDocuments, HOUR_MS],
    [retryDocumentEmails, EMAIL_RETRY_INTERVAL_MS],
  ] as const) {
    run();
    // unref: a timer never keeps a stopping process alive.
    setInterval(run, every).unref();
  }
}
