// Document invitations (FR-ED-21, FR-ED-37, FR-ED-44 (a)) and the people of a
// document: inviting, sending again, revoking, accepting and declining, and
// the list the sharing settings show. Whether a caller may invite is decided
// before any of this, by ./access.ts; whether an account may answer an
// invitation is decided here, by the address it holds.
//
// THE UNIFORM ANSWER (FR-ED-21). `createInvitations` writes the same rows for
// every address. For an inviter who holds `document.collaborators.view` alone
// it reads the account table before the response, and only to refuse an
// address whose account holds a role on the document now (the Owner's and the
// collaborators'); the query is made whatever the addresses are, so that its
// time shows nothing, and the refusal counts against the hourly limit of
// invitations first, so that it cannot be asked without limit. For any other
// inviter it reads nothing of who holds an address. Whether an address
// belongs to an account, for the delivery, is asked only after the response
// has gone, by `deliverInvitations`, so that neither the body nor the time of
// the response shows it (NFR-RE-15).
//
// NFR-SE-19: nothing here logs an address, a name, or a token. The token
// leaves this module once, inside the email.
import { Prisma, type DocumentRole as StoredRole } from '../../generated/prisma/client.ts';
import { holdOwnableAccount, inDeletion } from '../account/in-deletion.ts';
import { displayNameOf } from '../collab/presence.ts';
import { dateText } from '../date-text.ts';
import { db } from '../db.ts';
import { sendEmail, type EmailMessage } from '../email/index.ts';
import { faultOf } from '../fault.ts';
import { takeLimitReturnable } from '../rate-limit.ts';
import { securityLogIn } from '../security-log.ts';
import { settings } from '../settings.ts';
import { hashToken, newToken } from '../token.ts';
import type { DocumentRow } from './access.ts';
import { listAccessNotifications, type AccessNotificationView } from './access-notifications.ts';
import {
  listOfferEndedNotifications,
  listOfferNotifications,
  type OfferEndedNotificationView,
  type OfferNotificationView,
} from './ownership-notifications.ts';
import { COLLABORATOR_ROLE, holds, ROLE_NAME, type DocumentRole } from './permissions.ts';
import { newPseudonymAvoiding, withoutSenderName } from './pseudonym.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** FR-ED-37: "in the α line a document has at most ten people". Fixed, not an initial value. */
export const PEOPLE_MOST = 10;

/** The roles an invitation may offer in α 0.1.0: the Reviewer is not offered (D56; plan Q7). */
export const OFFERED = { editor: 'EDITOR', viewer: 'VIEWER' } as const satisfies Record<string, StoredRole>;
export type OfferedRole = keyof typeof OFFERED;

/** The kind of the notification of a document invitation (FR-ED-42). */
export const INVITATION_NOTIFICATION = 'document_invitation';

/**
 * The kind of the notification of the one reminder of an invitation (FR-ED-42, FR-ED-48). Written by the timer of
 * ./invitation-timers.ts; it ends as the invitation's own notification does.
 */
export const REMINDER_NOTIFICATION = 'document_invitation_reminder';

/** Both kinds of notification an invitation has: their payload names the invitation and nothing else. */
export const INVITATION_NOTIFICATIONS = [INVITATION_NOTIFICATION, REMINDER_NOTIFICATION];

/** The notifications of these invitations, the invitation's own and its reminder. */
export const notificationsOf = (invitationIds: string[]): Prisma.NotificationWhereInput => ({
  kind: { in: INVITATION_NOTIFICATIONS },
  OR: invitationIds.map((id) => ({ payload: { path: ['invitationId'], equals: id } })),
});

/** An invitation is open while it is stored pending and its expiry is ahead ("expired" is derived). */
const open = (now: Date) => ({ state: 'PENDING' as const, expiresAt: { gt: now } });
export { open as openInvitation };

// ── Inviting ────────────────────────────────────────────────────────────────

/** What `deliverInvitations` needs of one new invitation, held in memory only until the response has gone. */
export interface NewInvitation {
  id: string;
  email: string;
  token: string;
  role: OfferedRole;
  expiresAt: Date;
  /** D202, Q49: the words that stand for the title in the email where it was hidden, and null where it was not. */
  pseudonym: string | null;
}

export type CreateResult =
  | { outcome: 'created'; invitations: NewInvitation[] }
  /** FR-ED-37: an address of the inviter's own: nothing created. */
  | { outcome: 'own_address'; email: string }
  /** An address whose account holds a role on the document now, for an inviter who may see its people: nothing created. */
  | { outcome: 'collaborator_address'; email: string }
  /** FR-ED-37: the Owner, the collaborators and the pending invitations would be more than ten. */
  | { outcome: 'limit' }
  /** NFR-SE-07: past the invitations an inviter may create in an hour. */
  | { outcome: 'rate_limited'; retryAfterSeconds: number }
  /** Deleted by a request beside this one, after the caller was authorised. */
  | { outcome: 'not_found' }
  /** The caller's role no longer holds the permission under the lock (a transfer of ownership in between): a 403. */
  | { outcome: 'no_permission' };

/**
 * FR-ED-21, FR-ED-37: one invitation for each address, pending, with a new
 * link and a new period. An earlier pending invitation to an address is
 * revoked. `emails` are accepted addresses, distinct. In one transaction that
 * holds the document's row, so that two requests at once cannot together pass
 * the limit of ten people.
 *
 * D202, Q49: with `hideTitle` each invitation is created with a pseudonym of
 * its own, made with the display name of the inviter, and the invitee is not
 * shown the title before accepting. Whoever may invite may hide the title
 * (Q49 point 5): the permission is the one `document.collaborators.invite`
 * that `documentRoute` asked for and `inviterUnderLock` asks again.
 */
export async function createInvitations(
  document: Pick<DocumentRow, 'id' | 'ownerId'>,
  inviterId: string,
  emails: readonly string[],
  role: OfferedRole,
  now: Date = new Date(),
  hideTitle = false,
): Promise<CreateResult> {
  // NFR-SE-07, S13-5: the invitations are counted inside the transaction,
  // after every refusal, and given back where the transaction then fails, so
  // that a request counts all its invitations only where it creates them.
  let giveBack: (() => Promise<void>) | undefined;
  try {
    return await db().$transaction((tx) =>
      creating(tx, document, inviterId, emails, role, now, hideTitle, (back) => (giveBack = back)),
    );
  } catch (error) {
    await giveBack?.().catch((fault: unknown) =>
      console.error(`invitations: count not given back (${faultOf(fault)})`),
    );
    throw error;
  }
}

/**
 * Holds the row of a document that is not deleted until the transaction ends;
 * false where there is none. The one statement Prisma's interface cannot make.
 * A raw query is not given the schema the client names (src/lib/db.ts), so it
 * names its own, the application schema of contract IC-23. Parameterised
 * (NFR-SE-06, A05). Every change to who holds a role on a document holds it
 * (an invitation, an acceptance, and src/lib/documents/collaborators.ts), so
 * that they are one after another.
 */
export async function lockDocument(tx: Prisma.TransactionClient, documentId: string): Promise<boolean> {
  const held = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ekdotico"."Document"
    WHERE "id" = ${documentId}::uuid AND "deletedAt" IS NULL
    FOR UPDATE`;
  return held.length > 0;
}

/**
 * The Owner of the document and whether the caller holds `document.collaborators.invite` NOW, read under
 * the row the caller holds: ownership may have passed since `documentRoute` authorised the request
 * (FR-ED-47), so the permission and the Owner are read again, as slice 15 and 16 do.
 */
async function inviterUnderLock(tx: Prisma.TransactionClient, documentId: string, callerId: string) {
  const document = await tx.document.findUnique({
    where: { id: documentId },
    select: {
      ownerId: true,
      permissionSet: true,
      collaborators: { where: { userId: callerId }, select: { role: true } },
    },
  });
  if (!document) return null;
  const held = document.collaborators[0]?.role;
  const role = document.ownerId === callerId ? 'owner' : held ? COLLABORATOR_ROLE[held] : null;
  return {
    ownerId: document.ownerId,
    may: role !== null && holds(document.permissionSet, role, 'document.collaborators.invite'),
    // D220, Q55: the people list is what an inviter may already see.
    mayView: role !== null && holds(document.permissionSet, role, 'document.collaborators.view'),
  };
}

async function creating(
  tx: Prisma.TransactionClient,
  document: Pick<DocumentRow, 'id' | 'ownerId'>,
  inviterId: string,
  emails: readonly string[],
  role: OfferedRole,
  now: Date,
  hideTitle: boolean,
  counted: (giveBack: () => Promise<void>) => void,
): Promise<CreateResult> {
  if (!(await lockDocument(tx, document.id))) return { outcome: 'not_found' };
  const under = await inviterUnderLock(tx, document.id, inviterId);
  if (!under) return { outcome: 'not_found' };
  if (!under.may) return { outcome: 'no_permission' };

  // The inviter's own address is refused whoever the inviter is: they know it.
  const inviter = await tx.user.findUnique({ where: { id: inviterId }, select: { email: true, name: true } });
  const own = emails.find((email) => email === inviter?.email);
  if (own) return { outcome: 'own_address', email: own };
  const collaborators = await tx.documentCollaborator.findMany({
    where: { documentId: document.id },
    select: { userId: true },
  });
  // D220 (closing Q51; Q57, Q58 for what it leaves): one rule for every address whose
  // account holds a role on the document now, the Owner's and a former Owner's among them (who holds a role
  // through an accepted transfer): "already has access". It follows the account that holds the address, not
  // the invitation it once accepted: an address a collaborator has left is invited as any other.
  // It is made only for an inviter who may see the people of the document (`document.collaborators.view`):
  // the people list shows names and never addresses, so the refusal tells the inviter which address is a
  // collaborator's, and not to an inviter who is shown no collaborators at all. For that inviter the
  // answer stays the uniform one of FR-ED-21 (the invitation is created, and nothing is sent).
  // The request is counted against the hourly limit of invitations before the refusal, and the count is kept
  // where it refuses (D220; Q55): a refusal that tells which address is a collaborator's must not
  // be askable without limit. The other refusals below give the count back, as they did.
  let counting: Awaited<ReturnType<typeof takeLimitReturnable>> | null = null;
  if (under.mayView) {
    counting = await takeLimitReturnable('INVITATIONS_PER_USER', inviterId, emails.length);
    if (!counting.ok) return { outcome: 'rate_limited', retryAfterSeconds: counting.retryAfterSeconds };
    counted(counting.giveBack);
    const accounts = await tx.user.findMany({
      where: { email: { in: [...emails] }, emailVerified: true },
      select: { id: true, email: true },
    });
    const holding = new Set([under.ownerId, ...collaborators.map(({ userId }) => userId)]);
    const present = emails.find((email) => accounts.some((a) => a.email === email && holding.has(a.id)));
    if (present) return { outcome: 'collaborator_address', email: present };
  }

  // A row still stored pending past its expiry is written as expired, so
  // that the index of one pending invitation for an address holds for open ones.
  await tx.documentInvitation.updateMany({
    where: { documentId: document.id, state: 'PENDING', expiresAt: { lte: now } },
    data: { state: 'EXPIRED' },
  });
  const pending = await tx.documentInvitation.findMany({
    where: { documentId: document.id, state: 'PENDING' },
    select: { id: true, email: true },
  });
  const replaced = pending.filter(({ email }) => email !== null && emails.includes(email));
  const people = 1 + collaborators.length + pending.length - replaced.length + emails.length;
  if (people > PEOPLE_MOST) {
    await counting?.giveBack();
    return { outcome: 'limit' };
  }

  // NFR-SE-07: each invitation created counts; all of them, or none (S13-5). Already counted, above, for an
  // inviter who may see the people.
  if (!counting) {
    const limit = await takeLimitReturnable('INVITATIONS_PER_USER', inviterId, emails.length);
    if (!limit.ok) return { outcome: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
    counted(limit.giveBack);
  }

  if (replaced.length > 0) {
    const ids = replaced.map(({ id }) => id);
    await tx.documentInvitation.updateMany({
      where: { id: { in: ids } },
      data: { state: 'REVOKED', respondedAt: now },
    });
    await tx.notification.deleteMany({ where: notificationsOf(ids) });
  }
  const expiresAt = new Date(now.getTime() + settings().documentInvitationDays * DAY_MS);
  const invitations: NewInvitation[] = [];
  for (const email of emails) {
    const token = newToken();
    // D202, Q49 (1): made here, when the invitation is created, and kept in its row.
    // Where the inviter's row is somehow not found the title is still hidden: the name is empty, never the rule.
    // Not the words of an invitation of this sender to this address that is open, in any document.
    const taken = hideTitle
      ? new Set(
          (
            await tx.documentInvitation.findMany({
              where: { invitedById: inviterId, email, titlePseudonym: { not: null }, ...open(now) },
              select: { titlePseudonym: true },
            })
          ).flatMap(({ titlePseudonym }) => (titlePseudonym === null ? [] : [titlePseudonym])),
        )
      : new Set<string>();
    const pseudonym = hideTitle
      ? newPseudonymAvoiding(displayNameOf(inviter ?? { name: null, email: null }), taken)
      : null;
    const { id } = await tx.documentInvitation.create({
      data: {
        documentId: document.id,
        email,
        role: OFFERED[role],
        invitedById: inviterId,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt,
        titlePseudonym: pseudonym,
      },
      select: { id: true },
    });
    invitations.push({ id, email, token, role, expiresAt, pseudonym });
  }
  return { outcome: 'created', invitations };
}

/**
 * FR-ED-37: send again. A new invitation to the same address with the same
 * role, which revokes the earlier one where it is still pending. Null where
 * there is nothing to send again: an invitation of another document, one that
 * was accepted, or one whose address has been cleared. A title that was hidden
 * stays hidden, with a new pseudonym (the invitation is a new one; register row
 * built as the recommendation, for the owner to confirm: the spec says nothing of sending again).
 */
export async function resendInvitation(
  document: Pick<DocumentRow, 'id' | 'ownerId'>,
  inviterId: string,
  invitationId: string,
  now: Date = new Date(),
): Promise<CreateResult | null> {
  const earlier = await db().documentInvitation.findFirst({
    where: { id: invitationId, documentId: document.id, state: { not: 'ACCEPTED' }, email: { not: null } },
    select: { email: true, role: true, titlePseudonym: true },
  });
  if (!earlier?.email || earlier.role === 'REVIEWER') return null;
  const role = COLLABORATOR_ROLE[earlier.role] as OfferedRole;
  return createInvitations(document, inviterId, [earlier.email], role, now, earlier.titlePseudonym !== null);
}

/**
 * FR-ED-37: revokes a pending invitation of this document. Null where there is none; `'forbidden'` where
 * the caller's role does not hold the permission now, read under the document's row.
 */
export async function revokeInvitation(
  documentId: string,
  invitationId: string,
  callerId: string,
  now: Date = new Date(),
): Promise<{ email: string } | null | 'forbidden'> {
  return db().$transaction(async (tx) => {
    if (!(await lockDocument(tx, documentId))) return null;
    const under = await inviterUnderLock(tx, documentId, callerId);
    if (!under) return null;
    if (!under.may) return 'forbidden';
    const [revoked] = await tx.documentInvitation.updateManyAndReturn({
      where: { id: invitationId, documentId, ...open(now) },
      data: { state: 'REVOKED', respondedAt: now },
      select: { email: true },
    });
    if (!revoked?.email) return null;
    await tx.notification.deleteMany({ where: notificationsOf([invitationId]) });
    return { email: revoked.email };
  });
}

/**
 * FR-ED-36, FR-ED-37, FR-ED-42: the deletion of a document revokes its pending
 * invitations, and the notifications of all its invitations go. Called in the
 * transaction of the deletion.
 */
export async function endInvitationsOf(
  tx: Prisma.TransactionClient,
  documentId: string,
  now: Date,
): Promise<void> {
  await tx.documentInvitation.updateMany({
    where: { documentId, state: 'PENDING' },
    data: { state: 'REVOKED', respondedAt: now },
  });
  const all = await tx.documentInvitation.findMany({ where: { documentId }, select: { id: true } });
  if (all.length > 0) await tx.notification.deleteMany({ where: notificationsOf(all.map(({ id }) => id)) });
}

/**
 * FR-AU-58 (f): what the deletion of an account does to the invitations it sent and was sent, in the
 * transaction of the step that ends its roles. Found by the account's identifier and by its address,
 * which is why this runs before the address is cleared from the row of the account.
 *
 * - "every pending invitation the user sent or was sent is revoked (FR-ED-37)", and, as a revocation
 *   does, the notifications of those invitations go (FR-ED-42);
 * - "the invited address is cleared from every document invitation that was addressed to the user",
 *   an accepted one included, which keeps its address otherwise (FR-ED-37): those addressed to the
 *   account's address, and those the account accepted;
 * - the pseudonym of every invitation the account sent that holds one: it carries a copy of the
 *   sender's display name, which nothing else clears (docs/plan/invitation-title.md).
 *
 * The rows themselves stay, and refer to the tombstone (FR-AU-58). An invitation that was pending
 * and past its time is revoked too: it was never anything but pending in the row.
 */
export async function endInvitationsOfAccount(
  tx: Prisma.TransactionClient,
  account: { id: string; email: string | null },
  now: Date,
): Promise<void> {
  const addressed = account.email ? [{ email: account.email }] : [];
  const revoked = await tx.documentInvitation.updateManyAndReturn({
    where: { state: 'PENDING', OR: [{ invitedById: account.id }, ...addressed] },
    data: { state: 'REVOKED', respondedAt: now },
    select: { id: true },
  });
  if (revoked.length > 0) {
    await tx.notification.deleteMany({ where: notificationsOf(revoked.map(({ id }) => id)) });
  }
  await tx.documentInvitation.updateMany({
    where: { email: { not: null }, OR: [{ acceptedById: account.id }, ...addressed] },
    data: { email: null },
  });
  const hidden = await tx.documentInvitation.findMany({
    where: { invitedById: account.id, titlePseudonym: { not: null } },
    select: { id: true, titlePseudonym: true },
  });
  for (const { id, titlePseudonym } of hidden) {
    await tx.documentInvitation.update({
      where: { id },
      data: { titlePseudonym: withoutSenderName(titlePseudonym!) },
    });
  }
}

// ── Delivering, after the response ──────────────────────────────────────────

/**
 * The email of an invitation (FR-ED-21, amended by D202; the subject and the text are owed the owner's final
 * approval). It names the sender by name and by email address, and carries no title and no content of the
 * document: no title reaches the email service. Where the title was hidden it carries the pseudonym, which
 * is not the title (Q49 (1)). It is never given the title, so that it cannot send it.
 */
export function invitationEmail(
  to: string,
  inviter: { name: string; email: string | null },
  role: OfferedRole,
  token: string,
  expiresAt: Date,
  pseudonym: string | null = null,
): EmailMessage {
  const link = `${settings().appOrigin}/invitations/${token}`;
  const sender = inviter.email ? `${inviter.name} (${inviter.email})` : inviter.name;
  const hidden =
    pseudonym === null
      ? ''
      : ` The title of the document is hidden. In Ekdotico it is shown as ${pseudonym}.`;
  return {
    to,
    subject: 'You have been invited to a document | Ekdotico',
    text: `${sender} invited you to a document in Ekdotico as ${ROLE_NAME[role]}.${hidden} To accept or decline, open this link: ${link}. The link works once, and the invitation is open until ${dateText(expiresAt, 'utc')}. If you did not expect this invitation, you can ignore this email.`,
  };
}

/**
 * For each new invitation, after the response has been returned: where the
 * address is a verified address of an account that holds no role on the
 * document, the notification and the one email (FR-ED-21, FR-ED-42); for any
 * other address nothing. The row is marked before the email is handed over,
 * and a marked row is never handed over again, nor tried again: "where the
 * outcome of a send is unknown the email is not sent a second time". It never
 * rejects; a failure is one line naming the invitation (NFR-SE-19).
 */
export async function deliverInvitations(
  documentId: string,
  inviterId: string,
  invitations: readonly NewInvitation[],
  send: (message: EmailMessage) => Promise<void> = sendEmail,
): Promise<void> {
  for (const invitation of invitations) {
    try {
      await deliver(documentId, inviterId, invitation, send);
    } catch (error) {
      console.error(`invitation ${invitation.id}: not delivered (${faultOf(error)})`);
    }
  }
}

async function deliver(
  documentId: string,
  inviterId: string,
  invitation: NewInvitation,
  send: (message: EmailMessage) => Promise<void>,
): Promise<void> {
  // FR-ED-21: "a verified email address of an existing account", in the
  // application's own table. Addresses are stored in lower case.
  const account = await db().user.findFirst({
    where: { email: invitation.email, emailVerified: true },
    select: { id: true },
  });
  if (!account) return;
  // FR-AU-58 (a): nothing reaches an account whose deletion is confirmed, neither the notification nor the email.
  if (await inDeletion(account.id)) return;
  // FR-ED-37, FR-ED-44 (a): to the Owner, or to a user who holds a role, nothing is sent.
  const document = await db().document.findUnique({
    where: { id: documentId },
    select: { ownerId: true, collaborators: { where: { userId: account.id }, select: { id: true } } },
  });
  if (!document || document.ownerId === account.id || document.collaborators.length > 0) return;

  const now = new Date();
  const claimed = await db().$transaction(async (tx) => {
    const { count } = await tx.documentInvitation.updateMany({
      where: { id: invitation.id, emailClaimedAt: null, ...open(now) },
      data: { emailClaimedAt: now },
    });
    if (count !== 1) return false;
    await tx.notification.create({
      data: {
        recipientId: account.id,
        kind: INVITATION_NOTIFICATION,
        payload: { invitationId: invitation.id },
      },
    });
    return true;
  });
  if (!claimed) return;
  const inviter = await db().user.findUnique({
    where: { id: inviterId },
    select: { name: true, email: true },
  });
  await send(
    invitationEmail(
      invitation.email,
      { name: inviter ? displayNameOf(inviter) : '', email: inviter?.email ?? null },
      invitation.role,
      invitation.token,
      invitation.expiresAt,
      invitation.pseudonym,
    ),
  );
}

// ── Answering ───────────────────────────────────────────────────────────────

/** How a page or a request names an invitation: by the token of its link, or by its identifier (plan Q2). */
export type InvitationRef = { token: string } | { id: string };

/**
 * What an invitee is told of the document's title (D202, Q49): the title itself, or the pseudonym that stands
 * for it where the inviter hid it, or neither where the account may no longer be told. Never both: a
 * pseudonym is shown instead of the title, not beside it.
 */
export type TitleShown =
  { title: string; pseudonym: null } | { title: null; pseudonym: string } | { title: null; pseudonym: null };

export type InvitationView =
  /** Pending, and this account may answer it. Its title is shown, or its pseudonym, one of the two. */
  | {
      outcome: 'open';
      inviterName: string;
      /** D202: the sender is named by name and by email address. Null for a sender whose account is deleted. */
      inviterEmail: string | null;
      role: DocumentRole;
      expiresAt: Date;
      titleShown: Exclude<TitleShown, { title: null; pseudonym: null }>;
    }
  /** Accepted by this account, which still holds its role: the document is where it leads. */
  | { outcome: 'accepted'; documentId: string }
  /** FR-ED-37's statement, to the account that holds the address alone (S13-3). */
  | { outcome: 'no_longer_open' }
  /** FR-ED-21's statement: an account that does not hold the address, or an invitation that does not exist. */
  | { outcome: 'not_open_to_account' };

const whereRef = (ref: InvitationRef) =>
  'token' in ref ? { tokenHash: hashToken(ref.token) } : { id: ref.id };

type Client = Pick<Prisma.TransactionClient, 'documentInvitation' | 'user'>;

async function judge(client: Client, userId: string, ref: InvitationRef, now: Date) {
  const invitation = await client.documentInvitation.findUnique({
    where: whereRef(ref),
    include: {
      invitedBy: { select: { name: true, email: true } },
      document: {
        select: {
          ownerId: true,
          title: true,
          deletedAt: true,
          collaborators: { where: { userId }, select: { id: true } },
        },
      },
    },
  });
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  // FR-ED-21: only an account that holds the invited address as verified.
  if (!invitation?.email || !user?.emailVerified || user.email !== invitation.email) {
    return { view: { outcome: 'not_open_to_account' } as InvitationView };
  }
  // FR-ED-37: an invitation that was sent to no one "cannot be accepted,
  // because its link reached nobody", nor declined, even where its address
  // has come to belong to an account; and FR-ED-44 (a): one created for the
  // Owner or a collaborator is sent nothing. Sent means claimed for its email.
  if (!invitation.emailClaimedAt) return { view: { outcome: 'not_open_to_account' } as InvitationView };
  const holdsRole = invitation.document.ownerId === userId || invitation.document.collaborators.length > 0;
  if (invitation.state === 'ACCEPTED' && invitation.acceptedById === userId && holdsRole) {
    return { view: { outcome: 'accepted', documentId: invitation.documentId } as InvitationView };
  }
  const isOpen =
    invitation.state === 'PENDING' && invitation.expiresAt > now && !invitation.document.deletedAt;
  if (!isOpen) return { view: { outcome: 'no_longer_open' } as InvitationView };
  // FR-ED-44 (a): created for a user who holds a role already, and never accepted.
  if (holdsRole) return { view: { outcome: 'not_open_to_account' } as InvitationView };
  // D202, FR-ED-21: the title is shown here, to the account that holds the invited address, behind the
  // session, and nowhere above this line; where the inviter hid it, the view holds the pseudonym and the
  // title is not in it.
  const { titlePseudonym } = invitation;
  return {
    view: {
      outcome: 'open',
      inviterName: displayNameOf(invitation.invitedBy),
      inviterEmail: invitation.invitedBy.email,
      role: COLLABORATOR_ROLE[invitation.role],
      expiresAt: invitation.expiresAt,
      titleShown:
        titlePseudonym === null
          ? { title: invitation.document.title, pseudonym: null }
          : { title: null, pseudonym: titlePseudonym },
    } as InvitationView,
    invitation,
  };
}

/** What the page of an invitation shows this account (FR-ED-21, FR-ED-37). */
export async function viewInvitation(
  userId: string,
  ref: InvitationRef,
  now: Date = new Date(),
): Promise<InvitationView> {
  return (await judge(db(), userId, ref, now)).view;
}

export type AnswerResult =
  | { outcome: 'accepted'; documentId: string }
  | { outcome: 'declined' }
  | { outcome: 'no_longer_open' }
  | { outcome: 'not_open_to_account' };

/**
 * FR-ED-21, FR-ED-37: accepts or declines, for the account that holds the
 * invited address as verified, an invitation that is pending. Accepting, in
 * one transaction: the invitation accepted, the role, and the entry of the
 * security log (NFR-SE-19, D163). Declining: the invitation declined, and its
 * notification gone (FR-ED-42). The acceptance keeps its notification: its
 * subject still exists.
 */
export async function answerInvitation(
  userId: string,
  ref: InvitationRef,
  answer: 'accept' | 'decline',
  now: Date = new Date(),
): Promise<AnswerResult> {
  return db().$transaction(async (tx): Promise<AnswerResult> => {
    const judged = await judge(tx, userId, ref, now);
    if (!judged.invitation) {
      const { outcome } = judged.view;
      return outcome === 'accepted' ? { outcome: 'no_longer_open' } : (judged.view as AnswerResult);
    }
    const { invitation } = judged;
    // The document's row, as `createInvitations` holds it, so that an
    // acceptance never falls between the two counts of a creation that would
    // then see one person fewer (FR-ED-37: ten people).
    if (!(await lockDocument(tx, invitation.documentId))) return { outcome: 'no_longer_open' };
    // FR-AU-58 (f): "a deleted account holds no role". An acceptance gives the account one, so it holds the
    // account's row against the confirmation of its deletion, as the acceptance of an offer does
    // (src/lib/account/in-deletion.ts): an acceptance that began before the record is committed before it,
    // and the deletion's own step ends the role; one that comes after it is refused here.
    if (answer === 'accept' && !(await holdOwnableAccount(tx, userId))) return { outcome: 'no_longer_open' };
    const { count } = await tx.documentInvitation.updateMany({
      where: { id: invitation.id, emailClaimedAt: { not: null }, ...open(now) },
      data:
        answer === 'accept'
          ? { state: 'ACCEPTED', respondedAt: now, acceptedById: userId }
          : { state: 'DECLINED', respondedAt: now },
    });
    if (count !== 1) return { outcome: 'no_longer_open' };
    if (answer === 'decline') {
      await tx.notification.deleteMany({ where: notificationsOf([invitation.id]) });
      return { outcome: 'declined' };
    }
    await tx.documentCollaborator.create({
      data: {
        documentId: invitation.documentId,
        userId,
        role: invitation.role,
        addedAt: now,
        roleSince: now,
      },
    });
    await securityLogIn(tx, { kind: 'collaborators_changed', userId, documentId: invitation.documentId });
    return { outcome: 'accepted', documentId: invitation.documentId };
  });
}

// ── The people of a document ────────────────────────────────────────────────

export interface Sharing {
  people: number;
  limit: number;
  owner: { name: string };
  /** `self` is true for the caller's own entry alone: a page withdraws the controls on it and offers to leave (FR-ED-38). */
  collaborators: { id: string; name: string; role: DocumentRole; self: boolean }[];
  /** For a caller who holds `document.collaborators.invite` alone (API design). */
  invitations?: {
    id: string;
    email: string;
    role: DocumentRole;
    expiresAt: Date;
    /** Q49: the pseudonym of an invitation whose title is hidden, so that the inviter can tell the invitee what to look for; null where it is shown. */
    titlePseudonym: string | null;
  }[];
}

/** The people of a document as the sharing settings show them to a caller with this role (FR-ED-37). */
export async function sharingOf(
  document: Pick<DocumentRow, 'id' | 'ownerId' | 'permissionSet'>,
  role: DocumentRole,
  callerId: string,
  now: Date = new Date(),
): Promise<Sharing> {
  const [owner, collaborators, pending] = await Promise.all([
    db().user.findUnique({ where: { id: document.ownerId }, select: { name: true, email: true } }),
    db().documentCollaborator.findMany({
      where: { documentId: document.id },
      select: { id: true, role: true, userId: true, user: { select: { name: true, email: true } } },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    }),
    db().documentInvitation.findMany({
      where: { documentId: document.id, ...open(now) },
      select: { id: true, email: true, role: true, expiresAt: true, titlePseudonym: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const sharing: Sharing = {
    people: 1 + collaborators.length + pending.length,
    limit: PEOPLE_MOST,
    owner: { name: owner ? displayNameOf(owner) : '' },
    collaborators: collaborators.map((row) => ({
      id: row.id,
      name: displayNameOf(row.user),
      role: COLLABORATOR_ROLE[row.role],
      // The account's identifier is read to say this, and goes no further.
      self: row.userId === callerId,
    })),
  };
  if (holds(document.permissionSet, role, 'document.collaborators.invite')) {
    sharing.invitations = pending.flatMap(({ id, email, role: offered, expiresAt, titlePseudonym }) =>
      email ? [{ id, email, role: COLLABORATOR_ROLE[offered], expiresAt, titlePseudonym }] : [],
    );
  }
  return sharing;
}

// ── The notification list (FR-ED-42) ───────────────────────────────────────

export interface NotificationView {
  kind: typeof INVITATION_NOTIFICATION;
  id: string;
  createdAt: Date;
  read: boolean;
  inviterName: string;
  /** D202: the sender is named by name and by email address. Null for a sender whose account is deleted. */
  inviterEmail: string | null;
  role: DocumentRole;
  invitationId: string;
  /** D202, Q49: the title, the pseudonym that stands for it, or neither (see `listNotifications`). */
  title: string | null;
  pseudonym: string | null;
}

/**
 * FR-ED-42, FR-ED-48: the one reminder of an invitation, with the day it expires. It names the sender by name and by
 * email address (D218) and no title (S18-4), and no pseudonym.
 */
export interface ReminderNotificationView extends Omit<NotificationView, 'kind' | 'title' | 'pseudonym'> {
  kind: typeof REMINDER_NOTIFICATION;
  /** Null once the invitation was accepted (S18-2). */
  expiresAt: Date | null;
}

/** Every kind the list holds: an invitation and its reminder, a change of role, a removal (./access-notifications.ts). Kinds are added here. */
export type ListedNotification =
  | NotificationView
  | ReminderNotificationView
  | AccessNotificationView
  | OfferNotificationView
  | OfferEndedNotificationView;

/**
 * The account's notifications whose subject still exists, newest first, with
 * the count of those unread. For an invitation the subject is gone once it
 * leaves pending other than by acceptance, or its document is deleted; an
 * expired invitation's notification is left out from the moment of expiry
 * (S13-6).
 */
export async function listNotifications(
  userId: string,
  now: Date = new Date(),
): Promise<{ unread: number; notifications: ListedNotification[] }> {
  const rows = await db().notification.findMany({
    where: { recipientId: userId, kind: { in: INVITATION_NOTIFICATIONS } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const ids = rows.flatMap(({ payload }) => {
    const id = (payload as { invitationId?: unknown } | null)?.invitationId;
    return typeof id === 'string' ? [id] : [];
  });
  const invitations = new Map(
    (
      await db().documentInvitation.findMany({
        where: {
          id: { in: ids },
          document: { deletedAt: null },
          OR: [open(now), { state: 'ACCEPTED' }],
        },
        select: {
          id: true,
          role: true,
          email: true,
          expiresAt: true,
          state: true,
          titlePseudonym: true,
          invitedBy: { select: { name: true, email: true } },
          document: {
            select: {
              title: true,
              ownerId: true,
              collaborators: { where: { userId }, select: { id: true } },
            },
          },
        },
      })
    ).map((invitation) => [invitation.id, invitation]),
  );
  // D202: the account that reads is the one that holds the invited address, or it is not told the title.
  const reader = await db().user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  const invited = rows.flatMap((row): (NotificationView | ReminderNotificationView)[] => {
    const invitationId = (row.payload as { invitationId?: string }).invitationId ?? '';
    const invitation = invitations.get(invitationId);
    if (!invitation) return [];
    const shown = {
      id: row.id,
      createdAt: row.createdAt,
      read: row.readAt !== null,
      inviterName: displayNameOf(invitation.invitedBy),
      role: COLLABORATOR_ROLE[invitation.role],
      invitationId,
    };
    if (row.kind === REMINDER_NOTIFICATION) {
      return [
        {
          ...shown,
          kind: REMINDER_NOTIFICATION,
          inviterEmail: invitation.invitedBy.email,
          // S18-2: once accepted the invitation no longer expires, so the reminder states no expiry.
          expiresAt: invitation.state === 'ACCEPTED' ? null : invitation.expiresAt,
        },
      ];
    }
    // D202, Q49 (2): once the invitation is accepted and the account holds a role on the document, it is
    // shown the real title. While it is pending, an account that holds the invited address is shown the
    // title, or the pseudonym where the inviter hid it (as the page of the invitation judges it). In any
    // other case, an address that has gone, or a role lost after accepting, neither is shown: the title
    // is read live and the pseudonym's "until you accept" would be false.
    const holdsRole =
      invitation.state === 'ACCEPTED' &&
      (invitation.document.ownerId === userId || invitation.document.collaborators.length > 0);
    const holdsAddress = reader?.emailVerified === true && reader.email === invitation.email;
    const titleShown: TitleShown = holdsRole
      ? { title: invitation.document.title, pseudonym: null }
      : holdsAddress && invitation.state === 'PENDING'
        ? invitation.titlePseudonym === null
          ? { title: invitation.document.title, pseudonym: null }
          : { title: null, pseudonym: invitation.titlePseudonym }
        : { title: null, pseudonym: null };
    return [
      {
        ...shown,
        kind: INVITATION_NOTIFICATION,
        inviterEmail: invitation.invitedBy.email,
        ...titleShown,
      },
    ];
  });
  // FR-ED-42, S15-2: one list, newest first, whatever the kind.
  const notifications = [
    ...invited,
    ...(await listAccessNotifications(userId, now)),
    // FR-ED-47: the offer of ownership, beside the others.
    ...(await listOfferNotifications(userId, now)),
    // S17-5: the Owner's notice that an offer ended without the Owner's own action.
    ...(await listOfferEndedNotifications(userId, now)),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { unread: notifications.filter(({ read }) => !read).length, notifications };
}

/** Marks a notification of this account read. False where the account has no such notification. */
export async function markNotificationRead(
  userId: string,
  id: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof id !== 'string') return false;
  // Only a notification the list shows: one whose subject is gone is not there (FR-ED-42).
  // ponytail: reads the whole list, which holds a few invitations; a query of one if it grows.
  const { notifications } = await listNotifications(userId, now);
  if (!notifications.some((shown) => shown.id === id)) return false;
  await db().notification.updateMany({
    where: { id, recipientId: userId, readAt: null },
    data: { readAt: now },
  });
  return true;
}
