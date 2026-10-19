// The transfer of ownership of a document (FR-ED-47, FR-ED-40 (h), FR-ED-42,
// FR-AU-13): the Owner offers it to one Editor, who accepts or declines; the
// Owner withdraws; it expires; and on acceptance the Editor becomes the Owner,
// the former Owner an Editor, and the document moves to the new Owner's
// personal workspace, in one transaction.
//
// THE ONE OWNER. `Document.ownerId` is one column, and this module is the only
// place that writes it after the creation of a document (a test reads every
// file for it). Every change holds the document's row (`lockDocument`, as an
// invitation, its acceptance, slice 15 and slice 16 do) and reads again under
// it what authorised the request, so that two offers, two accepts, and an
// accept against a withdrawal, an expiry, a removal, a change of role or a
// deletion are one after the other and the loser reads what the winner left.
//
// WHAT AUTHORISES A REQUEST IS READ AGAIN UNDER THE LOCK. `documentRoute`
// authorised the Owner a moment ago; ownership may have passed since.
//
// NFR-SE-19: the entry of the change, `owner_changed`, is written in the
// transaction of the acceptance by `securityLogIn`: no transfer stands without
// it. The event is published after the commit and never before. Nothing here
// logs a name, an address, a title or an identifier of a person.
import type { Prisma } from '../../generated/prisma/client.ts';
import { publishCollabEvent } from '../collab/events.ts';
import { displayNameOf } from '../collab/presence.ts';
import { dateText } from '../date-text.ts';
import { db } from '../db.ts';
import { sendEmail, type EmailMessage } from '../email/index.ts';
import { faultOf } from '../fault.ts';
import { securityLogIn } from '../security-log.ts';
import { settings } from '../settings.ts';
import { lockDocument } from './sharing.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The kind of the notification of an offer of ownership (FR-ED-42). Its payload is `{ "offerId": … }` and nothing else. */
export const OFFER_NOTIFICATION = 'ownership_offer';

// What the identifier of a collaborator's row, and of an offer, look like (a cuid); anything else names nothing and is not looked up.
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

/** The notifications of these offers. */
const notificationsOf = (offerIds: string[]): Prisma.NotificationWhereInput => ({
  kind: OFFER_NOTIFICATION,
  OR: offerIds.map((id) => ({ payload: { path: ['offerId'], equals: id } })),
});

/** An offer is open while it is stored pending and its time is ahead ("expired" is derived). */
const open = (now: Date) => ({ state: 'PENDING' as const, expiresAt: { gt: now } });

type Tx = Prisma.TransactionClient;

// ── What may be transferred ─────────────────────────────────────────────────

/**
 * FR-ED-47: "this requirement covers an unrecorded document in a personal
 * workspace". A recorded document, and one in an institutional workspace,
 * cannot be transferred until it is decided (Q34). None exists in α 0.1.0.
 */
const transferable = (document: { recording: string; workspace: { type: string } }) =>
  document.recording === 'UNRECORDED' && document.workspace.type === 'PERSONAL';

// ── Settling what has ended without anyone's action ─────────────────────────

/**
 * FR-ED-47: an offer "is withdrawn without anyone's action where the Editor it
 * names stops holding the Editor role on the document or the document is
 * deleted". Each cause calls the function for it in its own transaction,
 * after the lock: a role change away from Editor, a removal and a leave
 * (`withdrawOffersFor`), and the deletion of the document (`endOffersOf`). The
 * notification of an offer stays only while the offer is pending (FR-ED-42).
 */
export async function withdrawOffersFor(
  tx: Tx,
  documentId: string,
  userId: string,
  now: Date,
): Promise<void> {
  const ended = await tx.ownershipOffer.updateManyAndReturn({
    where: { documentId, toUserId: userId, ...open(now) },
    data: { state: 'WITHDRAWN', respondedAt: now },
    select: { id: true },
  });
  if (ended.length > 0)
    await tx.notification.deleteMany({ where: notificationsOf(ended.map(({ id }) => id)) });
}

/** The deletion of a document ends its pending offer. Called in the transaction of the deletion. */
export async function endOffersOf(tx: Tx, documentId: string, now: Date): Promise<void> {
  // An offer past its time is left to the timer, which writes it expired, and not withdrawn.
  const ended = await tx.ownershipOffer.updateManyAndReturn({
    where: { documentId, ...open(now) },
    data: { state: 'WITHDRAWN', respondedAt: now },
    select: { id: true },
  });
  if (ended.length > 0)
    await tx.notification.deleteMany({ where: notificationsOf(ended.map(({ id }) => id)) });
}

/**
 * The backstop of the causes above, under the lock: a pending offer past its
 * time is written expired, and one whose recipient does not hold the Editor
 * role, or whose maker is not the Owner, is written withdrawn. Nothing should
 * be found of the second kind; the state is stored, and a reader never trusts
 * it alone.
 */
async function settle(tx: Tx, documentId: string, now: Date): Promise<void> {
  const pending = await tx.ownershipOffer.findMany({
    where: { documentId, state: 'PENDING' },
    select: { id: true, fromUserId: true, toUserId: true, expiresAt: true },
  });
  if (pending.length === 0) return;
  const { ownerId } = await tx.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { ownerId: true },
  });
  const editors = new Set(
    (
      await tx.documentCollaborator.findMany({
        where: { documentId, role: 'EDITOR', userId: { in: pending.map(({ toUserId }) => toUserId) } },
        select: { userId: true },
      })
    ).map(({ userId }) => userId),
  );
  const expired = pending.filter(({ expiresAt }) => expiresAt <= now);
  const withdrawn = pending.filter(
    (offer) => !expired.includes(offer) && (!editors.has(offer.toUserId) || offer.fromUserId !== ownerId),
  );
  for (const [state, offers] of [
    ['EXPIRED', expired],
    ['WITHDRAWN', withdrawn],
  ] as const) {
    if (offers.length === 0) continue;
    const ids = offers.map(({ id }) => id);
    await tx.ownershipOffer.updateMany({ where: { id: { in: ids } }, data: { state, respondedAt: now } });
    await tx.notification.deleteMany({ where: notificationsOf(ids) });
  }
}

/**
 * NFR-RE-15: the expiry of offers, on a timer of the application. Writes every
 * pending offer past its time expired and deletes its notification (FR-ED-42:
 * the notification stays "until the offer is no longer pending"). Idempotent;
 * a second instance finds nothing. Answers how many notifications it deleted,
 * which is what the timer says it deleted.
 */
export async function expireOffers(now: Date = new Date()): Promise<number> {
  return db().$transaction(async (tx) => {
    const ended = await tx.ownershipOffer.updateManyAndReturn({
      where: { state: 'PENDING', expiresAt: { lte: now } },
      data: { state: 'EXPIRED', respondedAt: now },
      select: { id: true },
    });
    if (ended.length === 0) return 0;
    const { count } = await tx.notification.deleteMany({ where: notificationsOf(ended.map(({ id }) => id)) });
    return count;
  });
}

// ── Offering and withdrawing ────────────────────────────────────────────────

export type OfferResult =
  | { outcome: 'offered'; offer: { id: string; expiresAt: Date; name: string } }
  /** No such document, or the caller holds no role on it now: a 404. */
  | { outcome: 'not_found' }
  /** The caller holds a role that is not the Owner's now: a 403. */
  | { outcome: 'no_permission' }
  /** No collaborator of this document has this identifier: a 404. */
  | { outcome: 'no_such_collaborator' }
  /** FR-ED-47: "to one user who holds the Editor role on it, and to no one else": a 409. */
  | { outcome: 'not_an_editor' }
  /** FR-ED-47: "at most one offer is pending for a document": a 409. */
  | { outcome: 'pending' }
  /** A recorded document, or one in an institutional workspace: a 409. */
  | { outcome: 'not_transferable' };

/**
 * The document, read under its row, when the caller is its Owner now. FR-ED-44:
 * `document.ownership.transfer` is fixed to the Owner, and no setting gives it
 * to another role, so the Owner is who holds it.
 */
async function ownedUnderLock(tx: Tx, documentId: string, callerId: string) {
  if (!(await lockDocument(tx, documentId))) return { stop: { outcome: 'not_found' } as const };
  const document = await tx.document.findUnique({
    where: { id: documentId },
    select: {
      ownerId: true,
      recording: true,
      workspace: { select: { type: true } },
      collaborators: { where: { userId: callerId }, select: { id: true } },
    },
  });
  if (!document) return { stop: { outcome: 'not_found' } as const };
  if (document.ownerId !== callerId) {
    return { stop: { outcome: document.collaborators.length > 0 ? 'no_permission' : 'not_found' } as const };
  }
  return { document };
}

/**
 * FR-ED-47: the Owner offers the ownership of the document to the collaborator
 * whose row this is. In one transaction under the document's row: the offer
 * and the Editor's notification (FR-ED-42). The email is `deliverOffer`'s,
 * after the response.
 */
export async function makeOffer(
  documentId: string,
  callerId: string,
  collaboratorId: unknown,
  now: Date = new Date(),
): Promise<OfferResult> {
  try {
    return await db().$transaction(async (tx): Promise<OfferResult> => {
      const owned = await ownedUnderLock(tx, documentId, callerId);
      if (owned.stop) return owned.stop;
      if (!transferable(owned.document)) return { outcome: 'not_transferable' };

      const found =
        typeof collaboratorId === 'string' && IDENTIFIER.test(collaboratorId)
          ? await tx.documentCollaborator.findFirst({
              where: { id: collaboratorId, documentId },
              select: { userId: true, role: true, user: { select: { name: true, email: true } } },
            })
          : null;
      if (!found) return { outcome: 'no_such_collaborator' };
      // A deleted account has no address and "holds no role" (FR-AU-58): it is offered nothing.
      if (found.role !== 'EDITOR' || !found.user.email) return { outcome: 'not_an_editor' };

      await settle(tx, documentId, now);
      if (
        await tx.ownershipOffer.findFirst({ where: { documentId, state: 'PENDING' }, select: { id: true } })
      ) {
        return { outcome: 'pending' };
      }
      const expiresAt = new Date(now.getTime() + settings().ownershipOfferDays * DAY_MS);
      const { id } = await tx.ownershipOffer.create({
        data: { documentId, fromUserId: callerId, toUserId: found.userId, createdAt: now, expiresAt },
        select: { id: true },
      });
      await tx.notification.create({
        data: {
          recipientId: found.userId,
          kind: OFFER_NOTIFICATION,
          payload: { offerId: id },
          createdAt: now,
        },
      });
      return { outcome: 'offered', offer: { id, expiresAt, name: displayNameOf(found.user) } };
    });
  } catch (error) {
    // The index of one pending offer for a document, were the lock ever not enough.
    if ((error as { code?: unknown } | null)?.code === 'P2002') return { outcome: 'pending' };
    throw error;
  }
}

export type WithdrawResult =
  | { outcome: 'withdrawn'; name: string }
  | { outcome: 'not_found' }
  | { outcome: 'no_permission' }
  /** No offer is open for this document: a 404. */
  | { outcome: 'none' };

/** FR-ED-47: the Owner withdraws the pending offer. An offer past its time is over and cannot be withdrawn. */
export async function withdrawOffer(
  documentId: string,
  callerId: string,
  now: Date = new Date(),
): Promise<WithdrawResult> {
  return db().$transaction(async (tx): Promise<WithdrawResult> => {
    const owned = await ownedUnderLock(tx, documentId, callerId);
    if (owned.stop) return owned.stop;
    const [ended] = await tx.ownershipOffer.updateManyAndReturn({
      where: { documentId, ...open(now) },
      data: { state: 'WITHDRAWN', respondedAt: now },
      select: { id: true, toUserId: true },
    });
    if (!ended) return { outcome: 'none' };
    await tx.notification.deleteMany({ where: notificationsOf([ended.id]) });
    const to = await tx.user.findUnique({
      where: { id: ended.toUserId },
      select: { name: true, email: true },
    });
    return { outcome: 'withdrawn', name: to ? displayNameOf(to) : '' };
  });
}

/** What the sharing page shows the Owner: the open offer, if there is one. */
export async function openOfferOf(
  documentId: string,
  now: Date = new Date(),
): Promise<{ toName: string; expiresAt: Date } | null> {
  const offer = await db().ownershipOffer.findFirst({
    where: { documentId, ...open(now) },
    select: { expiresAt: true, to: { select: { name: true, email: true } } },
  });
  return offer ? { toName: displayNameOf(offer.to), expiresAt: offer.expiresAt } : null;
}

// ── The email, after the response ───────────────────────────────────────────

/**
 * FR-ED-47, verbatim: the subject and the fixed text of the email. It states
 * who made the offer and "carries neither the title nor any content of the
 * document" (the owner's decision of 19 October 2026: no title reaches the
 * email provider). `[link]` is the notification list; `[date]` the expiry in
 * the one form of a date with " UTC".
 */
export function offerEmail(to: string, ownerName: string, expiresAt: Date): EmailMessage {
  const link = `${settings().appOrigin}/notifications`;
  return {
    to,
    subject: 'An offer of ownership of a document in Ekdotico',
    text: `${ownerName} has offered you ownership of a document that you edit in Ekdotico. To accept or decline, open your notifications in Ekdotico: ${link}. The offer is open until ${dateText(expiresAt, 'utc')}. If you accept, you become the Owner of the document and ${ownerName} becomes an Editor.`,
  };
}

/**
 * After the response (NFR-RE-15; FR-ED-47 "in the manner of FR-ED-21"): the
 * row is marked before the email is handed over, and a marked row is never
 * handed over again, nor tried again. An offer that is no longer open is sent
 * nothing. It never rejects; a failure is one line naming the offer.
 */
export async function deliverOffer(
  offerId: string,
  send: (message: EmailMessage) => Promise<void> = sendEmail,
): Promise<void> {
  try {
    const now = new Date();
    const { count } = await db().ownershipOffer.updateMany({
      where: { id: offerId, emailClaimedAt: null, ...open(now) },
      data: { emailClaimedAt: now },
    });
    if (count !== 1) return;
    const offer = await db().ownershipOffer.findUnique({
      where: { id: offerId },
      select: {
        expiresAt: true,
        from: { select: { name: true, email: true } },
        to: { select: { email: true } },
      },
    });
    if (!offer?.to.email) return;
    await send(offerEmail(offer.to.email, displayNameOf(offer.from), offer.expiresAt));
  } catch (error) {
    console.error(`ownership offer ${offerId}: email not delivered (${faultOf(error)})`);
  }
}

// ── Answering ───────────────────────────────────────────────────────────────

export type OfferView =
  /** Pending, and this account may answer it. */
  | { outcome: 'open'; ownerName: string; title: string; expiresAt: Date }
  /** Accepted by this account, which holds the document: it is where the offer leads. */
  | { outcome: 'accepted'; documentId: string }
  /** The statement to the account the offer names. */
  | { outcome: 'no_longer_open' }
  /** The statement to any other account, and for an offer that does not exist: it shows nothing of either. */
  | { outcome: 'not_open_to_account' };

type Client = Pick<Tx, 'ownershipOffer' | 'user'>;

async function judge(client: Client, userId: string, offerId: string, now: Date) {
  const offer = IDENTIFIER.test(offerId)
    ? await client.ownershipOffer.findUnique({
        where: { id: offerId },
        include: {
          from: { select: { name: true, email: true } },
          document: {
            select: {
              ownerId: true,
              title: true,
              deletedAt: true,
              recording: true,
              workspace: { select: { type: true } },
              collaborators: { where: { userId }, select: { role: true } },
            },
          },
        },
      })
    : null;
  // FR-ED-47: "only the account the offer names can act on it". Any other account is told what it is told of an offer that does not exist.
  if (!offer || offer.toUserId !== userId) return { view: { outcome: 'not_open_to_account' } as OfferView };
  const user = await client.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user?.email) return { view: { outcome: 'not_open_to_account' } as OfferView };
  const { document } = offer;
  if (offer.state === 'ACCEPTED' && document.ownerId === userId && !document.deletedAt) {
    return { view: { outcome: 'accepted', documentId: offer.documentId } as OfferView };
  }
  // Open only while the document is live and may be transferred, the recipient holds the Editor
  // role on it NOW, and the offer is the Owner's NOW (docs/plan/slice-17.md, section 2).
  const isOpen =
    offer.state === 'PENDING' &&
    offer.expiresAt > now &&
    !document.deletedAt &&
    document.collaborators[0]?.role === 'EDITOR' &&
    document.ownerId === offer.fromUserId &&
    transferable(document);
  // `stale`: still stored pending, and no longer open, which an answer settles under the document's row.
  if (!isOpen) {
    return {
      view: { outcome: 'no_longer_open' } as OfferView,
      stale: offer.state === 'PENDING' ? offer.documentId : undefined,
    };
  }
  return {
    view: {
      outcome: 'open',
      ownerName: displayNameOf(offer.from),
      title: document.title,
      expiresAt: offer.expiresAt,
    } as OfferView,
    offer,
  };
}

/** What the page of an offer shows this account (FR-ED-47). */
export async function viewOffer(userId: string, offerId: string, now: Date = new Date()): Promise<OfferView> {
  return (await judge(db(), userId, offerId, now)).view;
}

export type AnswerResult =
  | { outcome: 'accepted'; documentId: string }
  | { outcome: 'declined' }
  | { outcome: 'no_longer_open' }
  | { outcome: 'not_open_to_account' };

/** After the commit: tells the collaboration server to look at this person's connections to this document. */
const announce = (documentId: string, userId: string) =>
  publishCollabEvent({ kind: 'collaborator-changed', documentId, userId });

/**
 * FR-ED-47: the account the offer names accepts or declines it. Under the
 * document's row, the offer is judged again and claimed in one write that
 * names its state, its time and its recipient. Accepting, in the same
 * transaction: the offer accepted; the document's Owner and workspace; the
 * new Owner's row deleted and the former Owner's written as an Editor; the
 * notification gone; and the entry of the log. FR-ED-40 (h): once it has
 * committed, and only then, the connections of both people are told to look.
 */
export async function answerOffer(
  userId: string,
  offerId: string,
  answer: 'accept' | 'decline',
  now: Date = new Date(),
): Promise<AnswerResult> {
  const done = await db().$transaction(async (tx): Promise<AnswerResult & { from?: string }> => {
    const first = await judge(tx, userId, offerId, now);
    const documentId = first.offer?.documentId ?? first.stale;
    if (!documentId) {
      const { outcome } = first.view;
      return outcome === 'accepted' ? { outcome: 'no_longer_open' } : (first.view as AnswerResult);
    }
    if (!(await lockDocument(tx, documentId))) return { outcome: 'no_longer_open' };
    // Again, under the row: what was read a moment ago may have been decided since.
    const judged = await judge(tx, userId, offerId, now);
    if (!judged.offer) {
      if (judged.stale) await settle(tx, documentId, now);
      const { outcome } = judged.view;
      return outcome === 'accepted' ? { outcome: 'no_longer_open' } : (judged.view as AnswerResult);
    }
    const { offer } = judged;
    const { count } = await tx.ownershipOffer.updateMany({
      where: { id: offer.id, toUserId: userId, ...open(now) },
      data: { state: answer === 'accept' ? 'ACCEPTED' : 'DECLINED', respondedAt: now },
    });
    if (count !== 1) return { outcome: 'no_longer_open' };
    // FR-ED-42: the notification of an offer stays until the offer is no longer pending.
    await tx.notification.deleteMany({ where: notificationsOf([offer.id]) });
    if (answer === 'decline') return { outcome: 'declined' };

    // FR-AU-13: "the document moves to the personal workspace of its new Owner", the one exception.
    // The workspace is created where it is missing (the backstop of FR-AU-09).
    let workspace = await tx.workspace.findUnique({ where: { ownerId: userId }, select: { id: true } });
    if (!workspace) {
      await tx.workspace.createMany({ data: [{ type: 'PERSONAL', ownerId: userId }], skipDuplicates: true });
      workspace = await tx.workspace.findUniqueOrThrow({ where: { ownerId: userId }, select: { id: true } });
    }
    // `updatedAt` is not named: a transfer is not an edit.
    const moved = await tx.document.updateMany({
      where: { id: documentId, ownerId: offer.fromUserId },
      data: { ownerId: userId, workspaceId: workspace.id },
    });
    if (moved.count !== 1) throw new Error('The document is not held by the maker of the offer.');
    // FR-ED-19: the Owner holds no row; the former Owner becomes an Editor.
    const left = await tx.documentCollaborator.deleteMany({ where: { documentId, userId } });
    if (left.count !== 1) throw new Error('The new Owner held no collaborator row.');
    await tx.documentCollaborator.create({
      data: { documentId, userId: offer.fromUserId, role: 'EDITOR', addedAt: now, roleSince: now },
    });
    await securityLogIn(tx, { kind: 'owner_changed', userId, documentId });
    return { outcome: 'accepted', documentId, from: offer.fromUserId };
  });
  if (done.outcome === 'accepted') {
    await Promise.all([announce(done.documentId, done.from!), announce(done.documentId, userId)]);
  }
  return done.outcome === 'accepted' ? { outcome: 'accepted', documentId: done.documentId } : done;
}

// ── The notification list (FR-ED-42) ───────────────────────────────────────

export interface OfferNotificationView {
  id: string;
  createdAt: Date;
  read: boolean;
  ownerName: string;
  title: string;
  offerId: string;
}

/**
 * The account's notifications of offers whose offer is still open, newest
 * first, with how many are unread. The list is additive to the invitations'
 * (./sharing.ts, `listNotifications`), which the route and the page join to it.
 * One whose offer is past its time is left out from that moment (the timer
 * deletes its row); so is one whose recipient no longer holds the Editor role.
 */
export async function listOfferNotifications(
  userId: string,
  now: Date = new Date(),
): Promise<{ unread: number; notifications: OfferNotificationView[] }> {
  const rows = await db().notification.findMany({
    where: { recipientId: userId, kind: OFFER_NOTIFICATION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const ids = rows.flatMap(({ payload }) => {
    const id = (payload as { offerId?: unknown } | null)?.offerId;
    return typeof id === 'string' ? [id] : [];
  });
  const offers = new Map(
    (
      await db().ownershipOffer.findMany({
        where: {
          id: { in: ids },
          toUserId: userId,
          ...open(now),
          document: { deletedAt: null, collaborators: { some: { userId, role: 'EDITOR' } } },
        },
        select: {
          id: true,
          from: { select: { name: true, email: true } },
          document: { select: { title: true } },
        },
      })
    ).map((offer) => [offer.id, offer]),
  );
  const notifications = rows.flatMap((row) => {
    const offerId = (row.payload as { offerId?: string }).offerId ?? '';
    const offer = offers.get(offerId);
    if (!offer) return [];
    return [
      {
        id: row.id,
        createdAt: row.createdAt,
        read: row.readAt !== null,
        ownerName: displayNameOf(offer.from),
        title: offer.document.title,
        offerId,
      },
    ];
  });
  return { unread: notifications.filter(({ read }) => !read).length, notifications };
}

/** Marks a notification of an offer of this account read. False where the account has no such notification in its list. */
export async function markOfferNotificationRead(
  userId: string,
  id: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof id !== 'string') return false;
  // Only a notification the list shows: one whose offer is over is not there (FR-ED-42).
  // ponytail: reads the whole list, which holds a few offers; a query of one if it grows.
  const { notifications } = await listOfferNotifications(userId, now);
  if (!notifications.some((shown) => shown.id === id)) return false;
  await db().notification.updateMany({
    where: { id, recipientId: userId, readAt: null },
    data: { readAt: now },
  });
  return true;
}
