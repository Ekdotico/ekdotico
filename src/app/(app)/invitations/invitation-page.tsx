// The page of an invitation, by the token of its link or by its identifier
// (FR-ED-21, FR-ED-37; the owner's answer to Q2 of the plan). It needs a
// session, which the proxy requires of every path not on its list, and is
// counted under the limit of API requests (NFR-SE-07). What it shows is
// decided by `viewInvitation`, against the session's own account.
import { redirect } from 'next/navigation';
import { ANSWER_STATEMENTS } from '../../../lib/documents/invitation-texts.ts';
import { ROLE_NAME } from '../../../lib/documents/permissions.ts';
import { viewInvitation, type InvitationRef } from '../../../lib/documents/sharing.ts';
import { reading } from '../../page-fault.ts';
import { currentAccount } from '../account.ts';
import { InvitationStatement, OpenInvitation } from './invitation-view.tsx';

export async function InvitationPage({ invitation, path }: { invitation: InvitationRef; path: string }) {
  const { userId } = await currentAccount();
  const view = await reading(() => viewInvitation(userId, invitation));
  switch (view.outcome) {
    case 'accepted':
      redirect(`/documents/${view.documentId}`);
    // falls through: `redirect` does not return
    case 'no_longer_open':
      return <InvitationStatement statement={ANSWER_STATEMENTS.noLongerOpen} />;
    case 'not_open_to_account':
      return <InvitationStatement statement={ANSWER_STATEMENTS.notOpenToAccount} />;
    case 'open':
      return (
        <OpenInvitation
          path={path}
          inviterName={view.inviterName}
          role={ROLE_NAME[view.role]}
          expiresAt={view.expiresAt.toISOString()}
        />
      );
  }
}
