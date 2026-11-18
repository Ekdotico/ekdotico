// The offer of enrolment after the forced re-enrolment of NFR-SE-17 (e) (register D302, Q82 points 1 to 3; FR-AU-83;
// docs@da33e58): "an account of the founding team cannot sign in until it enrols again (FR-AU-83), and any other
// account is offered enrolment and may decline it". The founding team is stopped by the gate that FR-AU-83 already
// gives (src/lib/auth/founding-gate.ts); this is the offer to every other account that lost its second factor.
//
// It is a notification of the one list (FR-ED-42), written by the script of the rotation in the transaction of the
// deletions (scripts/rotate-auth-secret.ts), with no subject and no payload. To decline is to leave it unread or to
// mark it read; to accept is to turn two-factor authentication on in the settings, and the offer is then no longer
// listed, since there is nothing left to offer.
import { db } from '../db.ts';
import { TWO_FACTOR_OFFER } from './enrolment-offer-text.ts';

export { TWO_FACTOR_OFFER };

export interface TwoFactorOfferView {
  kind: typeof TWO_FACTOR_OFFER;
  id: string;
  createdAt: Date;
  read: boolean;
}

/** The account's offers, while two-factor authentication is off: turning it on is the end of the offer. */
export async function listTwoFactorOffers(userId: string): Promise<TwoFactorOfferView[]> {
  const rows = await db().notification.findMany({
    where: { recipientId: userId, kind: TWO_FACTOR_OFFER, recipient: { twoFactorEnabled: { not: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map((row) => ({
    kind: TWO_FACTOR_OFFER,
    id: row.id,
    createdAt: row.createdAt,
    read: row.readAt !== null,
  }));
}
