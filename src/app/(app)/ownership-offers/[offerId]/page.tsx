// The page on which an offer of ownership is accepted or declined (FR-ED-47;
// FR-ED-42 links the notification to it; the address is the application's
// choice, register row S17-1). It needs a session, which the proxy requires of
// every path not on its list. What it shows is decided by `viewOffer`, against
// the session's own account: any other account, and an identifier that names
// no offer, are told the same.
import { redirect } from 'next/navigation';
import { OFFER_STATEMENTS, OFFER_TITLE } from '../../../../lib/documents/ownership-texts.ts';
import { viewOffer } from '../../../../lib/documents/ownership.ts';
import { reading } from '../../../page-fault.ts';
import { currentAccount, titled } from '../../account.ts';
import { OfferStatement, OpenOffer } from '../offer-view.tsx';

export const generateMetadata = () => titled(OFFER_TITLE);

export default async function Offer({ params }: { params: Promise<{ offerId: string }> }) {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { userId } = await currentAccount();
  const { offerId } = await params;
  const view = await reading(() => viewOffer(userId, offerId));
  switch (view.outcome) {
    case 'accepted':
      redirect(`/documents/${view.documentId}`);
    // falls through: `redirect` does not return
    case 'no_longer_open':
      return <OfferStatement statement={OFFER_STATEMENTS.noLongerOpen} />;
    case 'not_open_to_account':
      return <OfferStatement statement={OFFER_STATEMENTS.notOpenToAccount} />;
    case 'open':
      return (
        <OpenOffer
          path={`/api/ownership-offers/${encodeURIComponent(offerId)}`}
          ownerName={view.ownerName}
          title={view.title}
          expiresAt={view.expiresAt.toISOString()}
        />
      );
  }
}
