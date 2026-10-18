// The sharing settings of a document (FR-ED-21, FR-ED-37; the address is the
// application's choice). Authorised as every request about a document is, by
// `authorise` (NFR-SE-04, FR-ED-39), for `document.collaborators.view`; what
// it shows of the invitations is `sharingOf`'s, by the caller's role.
import { notFound } from 'next/navigation';
import { authorise } from '../../../../../lib/documents/access.ts';
import { ROLE_NAME } from '../../../../../lib/documents/permissions.ts';
import { sharingOf } from '../../../../../lib/documents/sharing.ts';
import { reading } from '../../../../page-fault.ts';
import styles from '../../../../pages.module.css';
import { currentAccount, titled } from '../../../account.ts';
import { SharingSettings } from './sharing-settings.tsx';

export const generateMetadata = () => titled('Sharing');

// Text for a person (plan Q6): a role whose permission set hides the people.
const NOT_SHOWN =
  'The role of this account on the document does not show its people. The Owner of the document can change that.';

export default async function Sharing({ params }: { params: Promise<{ id: string }> }) {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { userId } = await currentAccount();
  const { id } = await params;
  const access = await reading(() => authorise(userId, id, 'document.collaborators.view'));
  if (access.outcome === 'not_found') notFound();
  if (access.outcome === 'forbidden') return <p className={styles.text}>{NOT_SHOWN}</p>;
  const { document, role } = access;
  const sharing = await reading(() => sharingOf(document, role));
  return (
    <SharingSettings
      view={{
        documentId: document.id,
        people: sharing.people,
        limit: sharing.limit,
        owner: sharing.owner.name,
        collaborators: sharing.collaborators.map((one) => ({ ...one, role: ROLE_NAME[one.role] })),
        invitations: sharing.invitations?.map((one) => ({
          ...one,
          role: ROLE_NAME[one.role],
          // NFR-I18-06: sent in UTC; the browser shows it in its own zone.
          expiresAt: one.expiresAt.toISOString(),
        })),
      }}
    />
  );
}
