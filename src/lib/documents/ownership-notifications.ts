// The notification of an offer of ownership in the one list (FR-ED-42, FR-ED-47),
// kept in its own module beside ./access-notifications.ts so that the kinds of the
// list are added in one place (`listNotifications` of ./sharing.ts) and without
// a cycle: ./ownership.ts reads the kind from here, and ./sharing.ts reads the
// list from here.
//
// The notification is written in the transaction of the offer (./ownership.ts) and
// stays only while the offer is pending. Its payload is `{ "offerId": … }` and
// nothing else; the title is read when the list is read (register row S17-2, D202).
import { displayNameOf } from '../collab/presence.ts';
import { db } from '../db.ts';

/** The kind of the notification of an offer of ownership (FR-ED-42). */
export const OFFER_NOTIFICATION = 'ownership_offer';

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
