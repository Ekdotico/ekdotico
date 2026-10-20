// The scheduled work of document invitations (NFR-RE-15; FR-ED-48, FR-ED-37,
// FR-ED-42): the one reminder before an invitation expires, the clearing of
// its address after it ended, and the deletion of the notifications of
// invitations that are no longer open. Each is run by a timer of the
// application (src/lib/timers.ts) at start and each hour, is idempotent, and
// is safe on two instances: what could be done twice is claimed by one
// conditional statement, and the rest matches nothing the second time.
//
// NFR-SE-19: nothing here logs an address, a name, or a token. A failure is
// one line naming the invitation.
import { displayNameOf } from '../collab/presence.ts';
import { dateText } from '../date-text.ts';
import { db } from '../db.ts';
import { sendEmail, type EmailMessage } from '../email/index.ts';
import { faultOf } from '../fault.ts';
import { settings } from '../settings.ts';
import { COLLABORATOR_ROLE, ROLE_NAME } from './permissions.ts';
import { INVITATION_NOTIFICATIONS, openInvitation, REMINDER_NOTIFICATION } from './sharing.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── The one reminder (FR-ED-48) ─────────────────────────────────────────────

/**
 * FR-ED-48, verbatim: the subject and the fixed text of the email. It states
 * who sent the invitation, the role, and the day it expires, and "carries
 * neither the title nor any content of the document": the function is handed
 * none. The link of an invitation is stored only as a hash and cannot be sent
 * again, so the email links to the notification list.
 */
export function reminderEmail(to: string, inviterName: string, role: string, expiresAt: Date): EmailMessage {
  const link = `${settings().appOrigin}/notifications`;
  return {
    to,
    subject: 'Your invitation to a document in Ekdotico expires soon',
    text: `${inviterName} invited you to a document in Ekdotico as ${role}. The invitation expires on ${dateText(expiresAt, 'utc')}. To accept or decline it, open your notifications in Ekdotico: ${link}.`,
  };
}

/**
 * FR-ED-48, NFR-RE-15: reminds, once, each invitation that was sent and is
 * still pending, from 3 days before its expiry (`INVITATION_REMINDER_DAYS`).
 * A run at or after the expiry reminds no one: the invitation is not pending.
 * A process that was down catches up at its first run, while the invitation is
 * still open. Answers 0, since a timer says what it deleted and this deletes
 * nothing; a failure is one line naming the invitation, and an email is never
 * tried again (S18-7).
 */
export async function remindInvitations(
  send: (message: EmailMessage) => Promise<void> = sendEmail,
  now: Date = new Date(),
): Promise<number> {
  const period = settings().invitationReminderDays * DAY_MS;
  const due = await db().documentInvitation.findMany({
    where: {
      ...openInvitation(now),
      // FR-ED-48: "only for an invitation that was itself sent".
      emailClaimedAt: { not: null },
      reminderClaimedAt: null,
      email: { not: null },
      expiresAt: { lte: new Date(now.getTime() + period) },
    },
    select: { id: true, createdAt: true, expiresAt: true },
  });
  for (const { id, createdAt, expiresAt } of due) {
    // S18-3: one created after the moment of its reminder was told of its expiry when it was sent.
    if (createdAt.getTime() > expiresAt.getTime() - period) continue;
    try {
      await remind(id, send, now);
    } catch (error) {
      console.error(`invitation ${id}: reminder not delivered (${faultOf(error)})`);
    }
  }
  return 0;
}

async function remind(
  invitationId: string,
  send: (message: EmailMessage) => Promise<void>,
  now: Date,
): Promise<void> {
  // The row is marked first, by one conditional statement: of two runs, or of a run and a revocation, an
  // acceptance or an expiry, one wins and the other matches nothing. The notification is written in the
  // same transaction, so that no reminder is marked and left without it.
  const message = await db().$transaction(async (tx) => {
    const { count } = await tx.documentInvitation.updateMany({
      where: {
        id: invitationId,
        ...openInvitation(now),
        emailClaimedAt: { not: null },
        reminderClaimedAt: null,
      },
      data: { reminderClaimedAt: now },
    });
    if (count !== 1) return null;
    const invitation = await tx.documentInvitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: {
        email: true,
        role: true,
        expiresAt: true,
        documentId: true,
        invitedBy: { select: { name: true, email: true } },
      },
    });
    if (!invitation.email) return null;
    // The account that holds the address now, as the invitation's own delivery asks (FR-ED-21): none, and nothing is sent.
    const account = await tx.user.findFirst({
      where: { email: invitation.email, emailVerified: true },
      select: { id: true },
    });
    if (!account) return null;
    // FR-ED-37, FR-ED-44 (a): a user who holds a role is sent nothing.
    const document = await tx.document.findUnique({
      where: { id: invitation.documentId },
      select: { ownerId: true, collaborators: { where: { userId: account.id }, select: { id: true } } },
    });
    if (!document || document.ownerId === account.id || document.collaborators.length > 0) return null;
    await tx.notification.create({
      data: { recipientId: account.id, kind: REMINDER_NOTIFICATION, payload: { invitationId } },
    });
    return reminderEmail(
      invitation.email,
      displayNameOf(invitation.invitedBy),
      ROLE_NAME[COLLABORATOR_ROLE[invitation.role]],
      invitation.expiresAt,
    );
  });
  if (message) await send(message);
}

// ── The clearing of the invited address (FR-ED-37, §2.7) ────────────────────

/**
 * FR-ED-37: "the invited address is cleared from an invitation 30 days after
 * the invitation is declined, revoked, or expires (an initial value); the row
 * stays, without the address, and an accepted invitation keeps its address".
 * The days are counted from `respondedAt` for a declined or revoked invitation
 * and from `expiresAt` for an expired one; a row still stored pending that
 * long after its expiry is written expired, as it has been since the moment
 * of its expiry. At exactly the period, and not before. Idempotent: it matches
 * the rows that still hold an address. Answers with the number cleared.
 */
export async function clearInvitationAddresses(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - settings().documentInvitationAddressDays * DAY_MS);
  const stale = await db().documentInvitation.updateMany({
    where: { email: { not: null }, state: 'PENDING', expiresAt: { lte: before } },
    data: { email: null, state: 'EXPIRED' },
  });
  const ended = await db().documentInvitation.updateMany({
    where: {
      email: { not: null },
      OR: [
        { state: { in: ['DECLINED', 'REVOKED'] }, respondedAt: { lte: before } },
        { state: 'EXPIRED', expiresAt: { lte: before } },
      ],
    },
    data: { email: null },
  });
  return stale.count + ended.count;
}

// ── The notifications of invitations that are no longer open (S13-6) ────────

/**
 * FR-ED-42: a notification of an invitation stays until its subject no longer
 * exists, which for an invitation is when it leaves pending by any route
 * other than acceptance. A decline, a revocation and the deletion of the
 * document delete it at once; an expiry has no event, so this does, with any
 * notification whose invitation is gone. The list leaves these out already:
 * this keeps the table from holding what no one can see. Answers with the
 * number deleted.
 */
export async function deleteEndedInvitationNotifications(now: Date = new Date()): Promise<number> {
  // ponytail: reads every invitation notification, a few for each person in a closed α; a join in SQL if that grows.
  const rows = await db().notification.findMany({
    where: { kind: { in: INVITATION_NOTIFICATIONS } },
    select: { id: true, payload: true },
  });
  const named = rows.map(({ id, payload }) => ({
    id,
    invitationId: (payload as { invitationId?: unknown } | null)?.invitationId,
  }));
  const ids = named.flatMap(({ invitationId }) => (typeof invitationId === 'string' ? [invitationId] : []));
  const live = new Set(
    (
      await db().documentInvitation.findMany({
        where: { id: { in: ids }, OR: [openInvitation(now), { state: 'ACCEPTED' }] },
        select: { id: true },
      })
    ).map(({ id }) => id),
  );
  const ended = named
    .filter(({ invitationId }) => typeof invitationId !== 'string' || !live.has(invitationId))
    .map(({ id }) => id);
  if (ended.length === 0) return 0;
  const { count } = await db().notification.deleteMany({ where: { id: { in: ended } } });
  return count;
}
