// The one email that each person who holds a role on a shared document is sent when a clearing is confirmed
// (FR-AU-91; NFR-RE-15: "its email handed over at most once, when the user confirms"). It names no document and no
// title, so no title reaches the email provider; "Your notifications in Ekdotico name them".
//
// The clearing's row is claimed (`emailsClaimedAt`) before any message is handed over, and a claimed row is never
// handed over again, as the row of an invitation and of an offer are (docs/plan/slice-23.md, S23-3): a process
// that stops in the middle loses the rest, which keep their notification, and no one is sent two. A timer hands
// over what a process that stopped before the claim left (`deliverUnsentClearingEmails`).
import { inDeletion } from '../account/in-deletion.ts';
import { dateText } from '../date-text.ts';
import { db } from '../db.ts';
import { sendEmail, type EmailMessage } from '../email/index.ts';
import { sendOrQueue } from '../email/queue.ts';
import { faultOf } from '../fault.ts';
import { settings } from '../settings.ts';
import { CLEARING_NOTICE } from './notices.ts';

/**
 * FR-AU-91, verbatim: the subject, and the fixed text with its three places filled: the number of documents of
 * this clearing that the person holds a role on, the day (the one form of a date, in UTC and said so, since an
 * email does not know the reader's zone), and the link to the notifications.
 */
export function clearingEmail(to: string, documents: number, day: Date): EmailMessage {
  const link = `${settings().appOrigin}/notifications`;
  const when = dateText(day, 'utc');
  return {
    to,
    subject: 'Documents you have access to in Ekdotico will be deleted',
    // The requirement's text has no singular. For one document the same sentences are written for one (S23-9).
    text:
      documents === 1
        ? `The Owner of 1 document that you have access to in Ekdotico will delete it on ${when}. Until then you can open it and take a draft export of it. Your notifications in Ekdotico name it:\n${link}`
        : `The Owner of ${documents} documents that you have access to in Ekdotico will delete them on ${when}. Until then you can open each one and take a draft export of it. Your notifications in Ekdotico name them:\n${link}`,
  };
}

/**
 * After the response: claims the clearing's emails and hands over one to each person whose notice of this
 * clearing still stands, counting the documents. It never rejects; a failure is one line naming the clearing.
 */
export async function deliverClearingEmails(
  clearingId: string,
  send: (message: EmailMessage) => Promise<void> = sendEmail,
): Promise<void> {
  try {
    const now = new Date();
    const { count } = await db().documentClearing.updateMany({
      where: { id: clearingId, emailsClaimedAt: null, deleteSharedAt: { not: null }, completedAt: null },
      data: { emailsClaimedAt: now },
    });
    if (count !== 1) return;
    const clearing = await db().documentClearing.findUnique({
      where: { id: clearingId },
      select: { deleteSharedAt: true },
    });
    if (!clearing?.deleteSharedAt) return;
    // The people told are those whose notice of this clearing stands: a document cancelled before this ran has
    // none, and so is not counted; a person with none is sent nothing.
    const notices = await db().notification.findMany({
      where: { kind: CLEARING_NOTICE, payload: { path: ['clearingId'], equals: clearingId } },
      select: { recipientId: true },
    });
    const counts = new Map<string, number>();
    for (const { recipientId } of notices) counts.set(recipientId, (counts.get(recipientId) ?? 0) + 1);
    for (const [recipientId, documents] of counts) {
      try {
        const user = await db().user.findUnique({ where: { id: recipientId }, select: { email: true } });
        // FR-AU-58 (a): no email reaches an account whose deletion is confirmed, or a tombstone.
        if (!user?.email || (await inDeletion(recipientId))) continue;
        await sendOrQueue(send, clearingEmail(user.email, documents, clearing.deleteSharedAt), {
          kind: 'CLEARING',
          subjectId: clearingId,
          userId: recipientId,
        });
      } catch (error) {
        console.error(`clearing ${clearingId}: an email was not delivered (${faultOf(error)})`);
      }
    }
  } catch (error) {
    console.error(`clearing ${clearingId}: emails not delivered (${faultOf(error)})`);
  }
}

/**
 * NFR-RE-15: the backstop of the hand-over after the response. A process that stopped between the commit and
 * `after` left its clearing with no claim, and the timer hands it over; the claim keeps it to one whichever of
 * the two comes first, and on two instances. Answers 0, since a timer says what it deleted and this deletes nothing.
 */
export async function deliverUnsentClearingEmails(
  send: (message: EmailMessage) => Promise<void> = sendEmail,
): Promise<number> {
  const unsent = await db().documentClearing.findMany({
    where: { emailsClaimedAt: null, deleteSharedAt: { not: null }, completedAt: null },
    select: { id: true },
  });
  for (const { id } of unsent) await deliverClearingEmails(id, send);
  return 0;
}
