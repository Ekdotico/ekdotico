// The page an invitation's link opens, from its email (FR-ED-21; API design:
// `GET /invitations/[token]`).
import { currentAccount, titled } from '../../account.ts';
import { InvitationPage } from '../invitation-page.tsx';
import { INVITATION_TITLE } from '../../../../lib/documents/invitation-texts.ts';

export const generateMetadata = () => titled(INVITATION_TITLE);

export default async function ByLink({ params }: { params: Promise<{ token: string }> }) {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { token } = await params;
  return <InvitationPage invitation={{ token }} path={`/api/invitations/${encodeURIComponent(token)}`} />;
}
