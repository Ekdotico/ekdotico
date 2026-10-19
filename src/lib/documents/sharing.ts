// Document invitations (FR-ED-21, FR-ED-37, FR-ED-44 (a)) and the people of a
// document: inviting, sending again, revoking, accepting and declining, and
// the list the sharing settings show. Whether a caller may invite is decided
// before any of this, by ./access.ts; whether an account may answer an
// invitation is decided here, by the address it holds.
//
// THE UNIFORM ANSWER (FR-ED-21). `createInvitations` writes the same rows for
// every address and reads nothing of who holds one, apart from the two
// refusals FR-ED-37 allows, which rest on what the Owner knows already.
// Whether an address belongs to an account is asked only after the response
// has gone, by `deliverInvitations`, so that neither the body nor the time of
// the response shows it (NFR-RE-15).
//
// NFR-SE-19: nothing here logs an address, a name, or a token. The token
// leaves this module once, inside the email.
import { Prisma, type DocumentRole as StoredRole } from '../../generated/prisma/client.ts';
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
import { COLLABORATOR_ROLE, holds, ROLE_NAME, type DocumentRole } from './permissions.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** FR-ED-37: "in the α line a document has at most ten people". Fixed, not an initial value. */
export const PEOPLE_MOST = 10;

/** The roles an invitation may offer in α 0.1.0: the Reviewer is not offered (D56; plan Q7). */
export const OFFERED = { editor: 'EDITOR', viewer: 'VIEWER' } as const satisfies Record<string, StoredRole>;
export type OfferedRole = keyof typeof OFFERED;

/** The kind of the notification of a document invitation (FR-ED-42). */
export const INVITATION_NOTIFICATION = 'document_invitation';

/** The notifications of these invitations: their payload names the invitation and nothing else. */
const notificationsOf = (invitationIds: string[]): Prisma.NotificationWhereInput => ({
  kind: INVITATION_NOTIFICATION,
  OR: invitationIds.map((id) => ({ payload: { path: ['invitationId'], equals: id } })),
});

/** An invitation is open while it is stored pending and its expiry is ahead ("expired" is derived). */
const open = (now: Date) => ({ state: 'PENDING' as const, expiresAt: { gt: now } });

// ── Inviting ────────────────────────────────────────────────────────────────

/** What `deliverInvitations` needs of one new invitation, held in memory only until the response has gone. */
export interface NewInvitation {
  id: string;
  email: string;
  token: string;
  role: OfferedRole;
  expiresAt: Date;
}

export type CreateResult =
  | { outcome: 'created'; invitations: NewInvitation[] }
  /** FR-ED-37: an address of the inviter's own (and, for the Owner, an accepted collaborator's): nothing created. */
  | { outcome: 'own_address'; email: string }
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
 */
export async function createInvitations(
  document: Pick<DocumentRow, 'id' | 'ownerId'>,
  inviterId: string,
  emails: readonly string[],
  role: OfferedRole,
  now: Date = new Date(),
): Promise<CreateResult> {
  // NFR-SE-07, S13-5: the invitations are counted inside the transaction,
  // after every refusal, and given back where the transaction then fails, so
  // that a request counts all its invitations only where it creates them.
  let giveBack: (() => Promise<void>) | undefined;
  try {
    return await db().$transaction((tx) =>
      creating(tx, document, inviterId, emails, role, now, (back) => (giveBack = back)),
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
  };
}

async function creating(
  tx: Prisma.TransactionClient,
  document: Pick<DocumentRow, 'id' | 'ownerId'>,
  inviterId: string,
  emails: readonly string[],
  role: OfferedRole,
  now: Date,
  counted: (giveBack: () => Promise<void>) => void,
): Promise<CreateResult> {
  if (!(await lockDocument(tx, document.id))) return { outcome: 'not_found' };
  const under = await inviterUnderLock(tx, document.id, inviterId);
  if (!under) return { outcome: 'not_found' };
  if (!under.may) return { outcome: 'no_permission' };

  // The two refusals of FR-ED-37 rest on what the Owner knows. A holder of
  // the permission who is not the Owner may not know them, so only the
  // holder's own address is refused (FR-ED-44 (a)).
  const inviter = await tx.user.findUnique({ where: { id: inviterId }, select: { email: true } });
  const own = emails.find((email) => email === inviter?.email);
  if (own) return { outcome: 'own_address', email: own };
  const collaborators = await tx.documentCollaborator.findMany({
    where: { documentId: document.id },
    select: { userId: true },
  });
  if (inviterId === under.ownerId) {
    const accepted = await tx.documentInvitation.findFirst({
      where: {
        documentId: document.id,
        state: 'ACCEPTED',
        email: { in: [...emails] },
        acceptedById: { in: collaborators.map(({ userId }) => userId) },
      },
      select: { email: true },
    });
    if (accepted?.email) return { outcome: 'collaborator_address', email: accepted.email };
    // FR-ED-47, register row S17-12: a former Owner holds a role through an accepted transfer, not through an
    // invitation, and is as well known to the Owner as the people above.
    const transferred = await tx.ownershipOffer.findMany({
      where: {
        documentId: document.id,
        state: 'ACCEPTED',
        fromUserId: { in: collaborators.map(({ userId }) => userId) },
      },
      select: { from: { select: { email: true } } },
    });
    const former = transferred.map(({ from }) => from.email).find((email) => email && emails.includes(email));
    if (former) return { outcome: 'collaborator_address', email: former };
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
  if (people > PEOPLE_MOST) return { outcome: 'limit' };

  // NFR-SE-07: each invitation created counts; all of them, or none (S13-5).
  const limit = await takeLimitReturnable('INVITATIONS_PER_USER', inviterId, emails.length);
  if (!limit.ok) return { outcome: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  counted(limit.giveBack);

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
    const { id } = await tx.documentInvitation.create({
      data: {
        documentId: document.id,
        email,
        role: OFFERED[role],
        invitedById: inviterId,
        tokenHash: hashToken(token),
        createdAt: now,
        expiresAt,
      },
      select: { id: true },
    });
    invitations.push({ id, email, token, role, expiresAt });
  }
  return { outcome: 'created', invitations };
}

/**
 * FR-ED-37: send again. A new invitation to the same address with the same
 * role, which revokes the earlier one where it is still pending. Null where
 * there is nothing to send again: an invitation of another document, one that
 * was accepted, or one whose address has been cleared.
 */
export async function resendInvitation(
  document: Pick<DocumentRow, 'id' | 'ownerId'>,
  inviterId: string,
  invitationId: string,
  now: Date = new Date(),
): Promise<CreateResult | null> {
  const earlier = await db().documentInvitation.findFirst({
    where: { id: invitationId, documentId: document.id, state: { not: 'ACCEPTED' }, email: { not: null } },
    select: { email: true, role: true },
  });
  if (!earlier?.email || earlier.role === 'REVIEWER') return null;
  const role = COLLABORATOR_ROLE[earlier.role] as OfferedRole;
  return createInvitations(document, inviterId, [earlier.email], role, now);
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

// ── Delivering, after the response ──────────────────────────────────────────

/** FR-ED-21, verbatim: the subject and the fixed text of the email. */
export function invitationEmail(
  to: string,
  inviterName: string,
  role: OfferedRole,
  token: string,
  expiresAt: Date,
): EmailMessage {
  const link = `${settings().appOrigin}/invitations/${token}`;
  return {
    to,
    subject: 'An invitation to a document in Ekdotico',
    text: `${inviterName} invited you to a document in Ekdotico as ${ROLE_NAME[role]}. To accept or decline, open this link: ${link}. The link works once, and the invitation is open until ${dateText(expiresAt, 'utc')}. If you did not expect this invitation, you can ignore this email.`,
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
  const inviter = await db().user.findUnique({ where: { id: inviterId }, select: { name: true } });
  await send(
    invitationEmail(
      invitation.email,
      inviter?.name ?? '',
      invitation.role,
      invitation.token,
      invitation.expiresAt,
    ),
  );
}

// ── Answering ───────────────────────────────────────────────────────────────

/** How a page or a request names an invitation: by the token of its link, or by its identifier (plan Q2). */
export type InvitationRef = { token: string } | { id: string };

export type InvitationView =
  /** Pending, and this account may answer it. */
  | { outcome: 'open'; inviterName: string; role: DocumentRole; expiresAt: Date }
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
      invitedBy: { select: { name: true } },
      document: {
        select: {
          ownerId: true,
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
  return {
    view: {
      outcome: 'open',
      inviterName: invitation.invitedBy.name ?? '',
      role: COLLABORATOR_ROLE[invitation.role],
      expiresAt: invitation.expiresAt,
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
  invitations?: { id: string; email: string; role: DocumentRole; expiresAt: Date }[];
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
      select: { id: true, email: true, role: true, expiresAt: true },
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
    sharing.invitations = pending.flatMap(({ id, email, role: offered, expiresAt }) =>
      email ? [{ id, email, role: COLLABORATOR_ROLE[offered], expiresAt }] : [],
    );
  }
  return sharing;
}

// ── The notification list (FR-ED-42) ───────────────────────────────────────

export interface NotificationView {
  id: string;
  createdAt: Date;
  read: boolean;
  inviterName: string;
  role: DocumentRole;
  invitationId: string;
}

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
): Promise<{ unread: number; notifications: NotificationView[] }> {
  const rows = await db().notification.findMany({
    where: { recipientId: userId, kind: INVITATION_NOTIFICATION },
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
        select: { id: true, role: true, invitedBy: { select: { name: true } } },
      })
    ).map((invitation) => [invitation.id, invitation]),
  );
  const notifications = rows.flatMap((row) => {
    const invitationId = (row.payload as { invitationId?: string }).invitationId ?? '';
    const invitation = invitations.get(invitationId);
    if (!invitation) return [];
    return [
      {
        id: row.id,
        createdAt: row.createdAt,
        read: row.readAt !== null,
        inviterName: invitation.invitedBy.name ?? '',
        role: COLLABORATOR_ROLE[invitation.role],
        invitationId,
      },
    ];
  });
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
