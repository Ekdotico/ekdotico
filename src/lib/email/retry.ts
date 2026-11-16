// D263, NFR-RE-15: the timer that tries again the emails of a document that the service CERTAINLY did not take
// (src/lib/email/queue.ts writes the rows): the invitation (FR-ED-21), its reminder (FR-ED-48), the offer of
// ownership (FR-ED-47), the one email of a transfer of all documents (FR-AU-92), and the notice of a clearing
// (FR-AU-91).
//
// Each run takes the rows in the order they were written. For each row:
//   1. the row is REMOVED, by one statement that only one of two runs (or two instances) can win: the one that
//      loses sends nothing. A row is never held across the attempt, so that no fault of the application, a crash
//      among them, sends an email twice: what is lost then is one email, and the invitee can be invited again.
//   2. the email is made again from the rows the row names, and only while they still say it is wanted: the
//      invitation or the offer is still pending, the clearing has not run, the address is still the account's
//      verified one, and FR-AU-58 (a) is read again, since a retry is a new attempt (D267).
//   3. it is handed over. Where the service again certainly did not take it, the row is written again, to wait for
//      the next run. Any other outcome ends it: a success, an unknown outcome, or a refusal of the message.
// Nothing is written to the Notification list: it was written once, when the email was first claimed.
//
// NFR-SE-19: a line names the kind and the identifier of the subject, and the class and code of the fault. Never
// an address, a link, or a word of the email.
import { inDeletion } from '../account/in-deletion.ts';
import { CLEARING_NOTICE } from '../clearing/notices.ts';
import { clearingEmail } from '../clearing/email.ts';
import { batchOfferEmail } from '../account/transfer-email.ts';
import { displayNameOf } from '../collab/presence.ts';
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';
import { COLLABORATOR_ROLE, ROLE_NAME } from '../documents/permissions.ts';
import { offerEmail, open as openOffer } from '../documents/ownership.ts';
import { invitationEmail, openInvitation, type OfferedRole } from '../documents/sharing.ts';
import { reminderEmail } from '../documents/invitation-timers.ts';
import { certainlyNotTaken, sendEmail, type EmailMessage } from './index.ts';
import { queueRetry, type RetryRef } from './queue.ts';

/** D263: "every 15 minutes (an initial value)". */
export const EMAIL_RETRY_INTERVAL_MS = 15 * 60 * 1000;

/** The most rows one run takes, so that a long outage is worked through over several runs. */
const PER_RUN = 200;

const INVITATIONS = { INVITATION: 'emailClaimedAt', REMINDER: 'reminderClaimedAt' } as const;

/** The email to try again, or null where it is no longer wanted. */
async function messageOf({ kind, subjectId, userId }: RetryRef, now: Date): Promise<EmailMessage | null> {
  // FR-AU-58 (a), read again before each attempt (D263, D267).
  if (await inDeletion(userId)) return null;
  const user = await db().user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.email) return null;

  if (kind === 'INVITATION' || kind === 'REMINDER') {
    const invitation = await db().documentInvitation.findFirst({
      where: { id: subjectId, ...openInvitation(now), [INVITATIONS[kind]]: { not: null } },
      select: {
        email: true,
        role: true,
        expiresAt: true,
        titlePseudonym: true,
        documentId: true,
        invitedBy: { select: { name: true, email: true } },
      },
    });
    // Sent to the address entered, which must still be a verified address of the account that was sent it.
    if (!invitation?.email || invitation.email !== user.email || !user.emailVerified) return null;
    const document = await db().document.findUnique({
      where: { id: invitation.documentId },
      select: { ownerId: true, collaborators: { where: { userId }, select: { id: true } } },
    });
    // FR-ED-37, FR-ED-44 (a): the Owner, or a user who holds a role, is sent nothing.
    if (!document || document.ownerId === userId || document.collaborators.length > 0) return null;
    const inviter = { name: displayNameOf(invitation.invitedBy), email: invitation.invitedBy.email };
    const role = COLLABORATOR_ROLE[invitation.role] as OfferedRole;
    // Its own link is stored only as a hash: the link to the notification list, as the reminder has.
    return kind === 'INVITATION'
      ? invitationEmail(
          invitation.email,
          inviter,
          role,
          null,
          invitation.expiresAt,
          invitation.titlePseudonym,
        )
      : reminderEmail(invitation.email, inviter, ROLE_NAME[role], invitation.expiresAt);
  }

  if (kind === 'OFFER') {
    const offer = await db().ownershipOffer.findFirst({
      where: {
        id: subjectId,
        toUserId: userId,
        emailClaimedAt: { not: null },
        batchId: null,
        ...openOffer(now),
      },
      select: { expiresAt: true, from: { select: { name: true, email: true } } },
    });
    return offer ? offerEmail(user.email, displayNameOf(offer.from), offer.expiresAt) : null;
  }

  if (kind === 'OFFER_BATCH') {
    const offers = await db().ownershipOffer.findMany({
      where: { batchId: subjectId, toUserId: userId, emailClaimedAt: { not: null }, ...openOffer(now) },
      select: { expiresAt: true, from: { select: { name: true, email: true } } },
    });
    const first = offers[0];
    if (!first) return null;
    const expiresAt = new Date(Math.min(...offers.map((offer) => offer.expiresAt.getTime())));
    const ownerName = displayNameOf(first.from);
    return offers.length === 1
      ? offerEmail(user.email, ownerName, expiresAt)
      : batchOfferEmail(user.email, ownerName, offers.length, expiresAt);
  }

  // CLEARING: until it has run, and for as long as this person's notice of it stands.
  const clearing = await db().documentClearing.findFirst({
    where: { id: subjectId, deleteSharedAt: { not: null }, completedAt: null },
    select: { deleteSharedAt: true },
  });
  if (!clearing?.deleteSharedAt) return null;
  const documents = await db().notification.count({
    where: {
      recipientId: userId,
      kind: CLEARING_NOTICE,
      payload: { path: ['clearingId'], equals: subjectId },
    },
  });
  return documents > 0 ? clearingEmail(user.email, documents, clearing.deleteSharedAt) : null;
}

/**
 * One run of the timer. Answers 0, since a timer says what it deleted and this deletes nothing that matters to
 * the log. A failure of one row is one line, and the next row is tried.
 */
export async function retryEmails(
  send: (message: EmailMessage) => Promise<void> = sendEmail,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db().emailRetry.findMany({
    orderBy: { createdAt: 'asc' },
    take: PER_RUN,
    select: { id: true, kind: true, subjectId: true, userId: true },
  });
  for (const { id, ...ref } of rows) {
    const which = `${ref.kind.toLowerCase()} ${ref.subjectId}`;
    // 1. The row is removed before the attempt: of two runs, one wins and the other matches nothing.
    const { count } = await db().emailRetry.deleteMany({ where: { id } });
    if (count !== 1) continue;
    let message: EmailMessage | null;
    try {
      // The clock is read again, as the claim of a reminder reads it: a run that is slow does not send for an
      // invitation that has expired since it began (the run's `now` is a parameter for the tests).
      message = await messageOf(ref, new Date(Math.max(now.getTime(), Date.now())));
    } catch (error) {
      // Nothing was handed over: a fault of the database. The row waits again.
      console.error(`email retry ${which}: not made (${faultOf(error)})`);
      await queueRetry(ref).catch(() => {});
      continue;
    }
    if (!message) continue;
    try {
      await send(message);
    } catch (error) {
      if (certainlyNotTaken(error)) {
        console.error(`email retry ${which}: not taken, will try again (${faultOf(error)})`);
        await queueRetry(ref).catch((cause) =>
          console.error(`email retry ${which}: not kept (${faultOf(cause)})`),
        );
      } else {
        // An unknown outcome, or a message the service refuses: not tried again (FR-ED-21).
        console.error(`email retry ${which}: not delivered (${faultOf(error)})`);
      }
    }
  }
  return 0;
}
