// The page of an invitation opened from the notification list (FR-ED-42),
// keyed by its identifier, for the account that holds the invited address
// (the owner's answer to Q2 of the plan).
import { currentAccount, titled } from '../../../account.ts';
import { InvitationPage } from '../../invitation-page.tsx';
import { INVITATION_TITLE } from '../../../../../lib/documents/invitation-texts.ts';

export const generateMetadata = () => titled(INVITATION_TITLE);

export default async function FromTheList({ params }: { params: Promise<{ invitationId: string }> }) {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { invitationId } = await params;
  return (
    <InvitationPage
      invitation={{ id: invitationId }}
      path={`/api/invitations/received/${encodeURIComponent(invitationId)}`}
    />
  );
}
