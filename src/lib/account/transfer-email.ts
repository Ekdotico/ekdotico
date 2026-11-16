// The email of the transfer of all documents (FR-AU-92): "Offers made to one person in one action are announced by
// one email, which states how many documents are offered". The subject and the fixed text are the requirement's,
// verbatim. It names no document and carries no title (the owner's decision of 19 October 2026: no title reaches
// the email provider). A person offered one document is sent the email of FR-ED-47 for one document (S24-4).
//
// NFR-RE-15, as the email of a single offer (src/lib/documents/ownership.ts): the offers of a person in one action
// are claimed in one write before the email is handed over, a claimed offer is never handed over again, and a timer
// hands over what a process that stopped after the commit left. It never rejects; a failure is one line naming the
// batch, and the class of the fault, and nothing of the message (NFR-SE-19).
import { displayNameOf } from '../collab/presence.ts';
import { dateText } from '../date-text.ts';
import { db } from '../db.ts';
import { sendEmail, type EmailMessage } from '../email/index.ts';
import { faultOf } from '../fault.ts';
import { offerEmail, open } from '../documents/ownership.ts';
import { settings } from '../settings.ts';
import { inDeletion } from './in-deletion.ts';

/**
 * FR-AU-92, verbatim: the subject and the fixed text. `[link]` is the notification list; `[date]` the expiry in the
 * one form of a date with " UTC", as the email of a single offer.
 */
export function batchOfferEmail(
  to: string,
  ownerName: string,
  documents: number,
  expiresAt: Date,
): EmailMessage {
  const link = `${settings().appOrigin}/notifications`;
  return {
    to,
    subject: `An offer of ownership of ${documents} documents in Ekdotico`,
    text: `${ownerName} has offered you ownership of ${documents} documents that you edit in Ekdotico. To accept or decline each one, open your notifications in Ekdotico:\n${link}\nThe offers are open until ${dateText(expiresAt, 'utc')}. For each one you accept, you become the Owner of the document and ${ownerName} becomes an Editor.`,
  };
}

/**
 * After the response: the one email to one person for the offers of one action. Claims their open, unclaimed offers
 * of the batch in one statement and sends the number it claimed, so that two instances, and the timer, send it once.
 * An offer that ended before the email is not counted; an account whose deletion is confirmed is sent nothing.
 */
export async function deliverBatch(
  batchId: string,
  toUserId: string,
  send: (message: EmailMessage) => Promise<void> = sendEmail,
): Promise<void> {
  try {
    const now = new Date();
    const claimed = await db().ownershipOffer.updateManyAndReturn({
      where: { batchId, toUserId, emailClaimedAt: null, ...open(now) },
      data: { emailClaimedAt: now },
      select: { fromUserId: true, expiresAt: true },
    });
    const first = claimed[0];
    if (!first) return;
    const [to, from] = await Promise.all([
      db().user.findUnique({ where: { id: toUserId }, select: { email: true } }),
      db().user.findUnique({ where: { id: first.fromUserId }, select: { name: true, email: true } }),
    ]);
    if (!to?.email || !from) return;
    // FR-AU-58 (a): the email of an offer reaches no account whose deletion is confirmed.
    if (await inDeletion(toUserId)) return;
    const expiresAt = new Date(Math.min(...claimed.map(({ expiresAt: at }) => at.getTime())));
    const ownerName = displayNameOf(from);
    await send(
      claimed.length === 1
        ? offerEmail(to.email, ownerName, expiresAt)
        : batchOfferEmail(to.email, ownerName, claimed.length, expiresAt),
    );
  } catch (error) {
    console.error(`ownership offers ${batchId}: email not delivered (${faultOf(error)})`);
  }
}

/**
 * NFR-RE-15: the backstop of the hand-over after the response, on the timer of the email of an offer. Answers 0,
 * since a timer says what it deleted and this deletes nothing.
 */
export async function deliverUnsentBatches(
  send: (message: EmailMessage) => Promise<void> = sendEmail,
  now: Date = new Date(),
): Promise<number> {
  const unsent = await db().ownershipOffer.findMany({
    where: { batchId: { not: null }, emailClaimedAt: null, ...open(now) },
    select: { batchId: true, toUserId: true },
    distinct: ['batchId', 'toUserId'],
  });
  for (const { batchId, toUserId } of unsent) await deliverBatch(batchId!, toUserId, send);
  return 0;
}
