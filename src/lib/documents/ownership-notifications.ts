// The notification of an offer of ownership in the one list (FR-ED-42, FR-ED-47),
// kept in its own module beside ./access-notifications.ts so that the kinds of the
// list are added in one place (`listNotifications` of ./sharing.ts) and without
// a cycle: ./ownership.ts reads the kind from here, and ./sharing.ts reads the
// list from here.
//
// The notification is written in the transaction of the offer (./ownership.ts) and
// stays only while the offer is pending. Its payload is `{ "offerId": … }` and
// nothing else; the title is read when the list is read (register row S17-2, D202).
import type { Prisma } from '../../generated/prisma/client.ts';
import { displayNameOf } from '../collab/presence.ts';
import { db } from '../db.ts';

/** The kind of the notification of an offer of ownership (FR-ED-42). */
export const OFFER_NOTIFICATION = 'ownership_offer';

/**
 * The kind of the notification the Owner is given when an offer ends without the Owner's own action
 * (the owner's decision S17-5). Its payload is `{ documentId, toUserId, end }` and nothing else: identifiers
 * and the way it ended. The title and the name are read when the list is read.
 */
export const OFFER_ENDED_NOTIFICATION = 'ownership_offer_ended';

/**
 * How an offer ended without the Owner's own action: the Editor declined it; its 14 days passed; or the
 * system ended it, since the Editor it names stopped holding the Editor role (removed, left, or given another role).
 * The Owner's own withdrawal, and the deletion of the document by the Owner, are the Owner's acts and write none.
 */
export type OfferEnd = 'declined' | 'expired' | 'ended';
const ENDS: readonly string[] = ['declined', 'expired', 'ended'];

/**
 * The Owner is told, in the transaction that ended the offer, so that an offer never ends without it and the
 * reverse. Never to the Editor who declined, and only to the account that is the Owner: where the maker of the
 * offer is no longer the Owner (which the backstop of `settle` may find), nothing is written.
 */
export async function notifyOfferEnded(
  tx: Prisma.TransactionClient,
  {
    ownerId,
    toUserId,
    documentId,
    end,
  }: { ownerId: string; toUserId: string; documentId: string; end: OfferEnd },
): Promise<void> {
  if (ownerId === toUserId) return;
  await tx.notification.create({
    data: { recipientId: ownerId, kind: OFFER_ENDED_NOTIFICATION, payload: { documentId, toUserId, end } },
  });
}

/**
 * Takes away the notifications of ended offers of this document that this account holds, as the Owner it was:
 * their subject, the Owner's offer, goes with the ownership. Called in the transaction of the acceptance for the
 * former Owner, so that it is not shown them, nor shown again if the document comes back to them.
 */
export async function endOfferEndedNotifications(
  tx: Prisma.TransactionClient,
  userId: string,
  documentId: string,
): Promise<void> {
  await tx.notification.deleteMany({
    where: {
      recipientId: userId,
      kind: OFFER_ENDED_NOTIFICATION,
      payload: { path: ['documentId'], equals: documentId },
    },
  });
}

export interface OfferEndedNotificationView {
  kind: typeof OFFER_ENDED_NOTIFICATION;
  id: string;
  createdAt: Date;
  read: boolean;
  end: OfferEnd;
  documentId: string;
  /** The document's title as it stands when the list is read; the account is its Owner. */
  title: string;
  /** The Editor the offer was made to; empty where that account is deleted. */
  editorName: string;
}

/**
 * The account's notifications of ended offers whose subject still stands, newest first: the account is the
 * Owner of a document that is not deleted. They stay until the account is no longer its Owner or the document
 * is deleted, and are read or unread meanwhile (FR-ED-42).
 */
export async function listOfferEndedNotifications(userId: string): Promise<OfferEndedNotificationView[]> {
  const rows = await db().notification.findMany({
    where: { recipientId: userId, kind: OFFER_ENDED_NOTIFICATION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const payloads = rows.map((row) => ({
    row,
    ...(row.payload as { documentId?: unknown; toUserId?: unknown; end?: unknown }),
  }));
  const documentIds = payloads.flatMap(({ documentId }) =>
    typeof documentId === 'string' ? [documentId] : [],
  );
  const toUserIds = payloads.flatMap(({ toUserId }) => (typeof toUserId === 'string' ? [toUserId] : []));
  const documents = new Map(
    (
      await db().document.findMany({
        where: { id: { in: documentIds }, ownerId: userId, deletedAt: null },
        select: { id: true, title: true },
      })
    ).map((document) => [document.id, document.title]),
  );
  const editors = new Map(
    (
      await db().user.findMany({
        where: { id: { in: toUserIds } },
        select: { id: true, name: true, email: true },
      })
    ).map((user) => [user.id, displayNameOf(user)]),
  );
  return payloads.flatMap(({ row, documentId, toUserId, end }): OfferEndedNotificationView[] => {
    const title = typeof documentId === 'string' ? documents.get(documentId) : undefined;
    if (title === undefined || typeof end !== 'string' || !ENDS.includes(end)) return [];
    return [
      {
        kind: OFFER_ENDED_NOTIFICATION,
        id: row.id,
        createdAt: row.createdAt,
        read: row.readAt !== null,
        end: end as OfferEnd,
        documentId: documentId as string,
        title,
        editorName: typeof toUserId === 'string' ? (editors.get(toUserId) ?? '') : '',
      },
    ];
  });
}

export interface OfferNotificationView {
  kind: typeof OFFER_NOTIFICATION;
  id: string;
  createdAt: Date;
  read: boolean;
  ownerName: string;
  title: string;
  offerId: string;
}

/**
 * The account's notifications of offers whose offer is still open, newest
 * first. One whose offer is past its time is left out from that moment (the
 * timer deletes its row); so is one whose recipient no longer holds the Editor
 * role, and one the page of the offer would call no longer open.
 */
export async function listOfferNotifications(
  userId: string,
  now: Date = new Date(),
): Promise<OfferNotificationView[]> {
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
          state: 'PENDING',
          expiresAt: { gt: now },
          document: {
            deletedAt: null,
            recording: 'UNRECORDED',
            workspace: { type: 'PERSONAL' },
            collaborators: { some: { userId, role: 'EDITOR' } },
          },
        },
        select: {
          id: true,
          fromUserId: true,
          from: { select: { name: true, email: true } },
          document: { select: { title: true, ownerId: true } },
        },
      })
    )
      // As the page of the offer judges it: the maker is still the Owner (the one thing a where cannot say).
      .filter((offer) => offer.document.ownerId === offer.fromUserId)
      .map((offer) => [offer.id, offer]),
  );
  return rows.flatMap((row): OfferNotificationView[] => {
    const offerId = (row.payload as { offerId?: string }).offerId ?? '';
    const offer = offers.get(offerId);
    if (!offer) return [];
    return [
      {
        kind: OFFER_NOTIFICATION,
        id: row.id,
        createdAt: row.createdAt,
        read: row.readAt !== null,
        ownerName: displayNameOf(offer.from),
        title: offer.document.title,
        offerId,
      },
    ];
  });
}
