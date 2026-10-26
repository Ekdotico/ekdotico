// FR-AU-58: the deletion screen. Where the account owns a document it states how many and
// offers no deletion ("Only when the account owns no document does Ekdotico offer the deletion
// itself"); the refusal is the route's as well and does not rest on this (src/app/api/account/route.ts).
// "Clear all documents" and "Transfer ownership of all documents" join it with slices 23 and 24. The
// path is this application's choice: no page of the specification names one.
import Link from 'next/link';
import { PageHeading, Stack } from '@ekdotico/domico/components';
import { ownedDocuments } from '../../../../lib/account/deletion.ts';
import { db } from '../../../../lib/db.ts';
import { reading } from '../../../page-fault.ts';
import styles from '../../../pages.module.css';
import { currentAccount, titled } from '../../account.ts';
import { DeleteAccount } from './delete-account.tsx';

export const generateMetadata = () => titled('Delete account');

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const documents = (count: number) => `${count} ${count === 1 ? 'document' : 'documents'}`;

export default async function DeleteAccountPage() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { userId } = await currentAccount();
  // A fault of either read is the page of a fault, and one line (page-fault.ts).
  const [owned, user] = await reading(() =>
    Promise.all([
      ownedDocuments(userId),
      db().user.findUnique({ where: { id: userId }, select: { email: true, twoFactorEnabled: true } }),
    ]),
  );

  return (
    <Stack gap={8}>
      <PageHeading>Delete account</PageHeading>
      <div className={styles.narrow}>
        {owned.owned > 0 ? (
          <Stack gap={5}>
            <p className={styles.text}>
              This account owns {documents(owned.owned)}. An account that owns a document cannot be deleted,
              because every document needs an Owner. Delete{' '}
              {owned.owned === 1 ? 'the document' : 'each document you own'}, or transfer its ownership to an
              Editor who accepts it, and then return to this page.
            </p>
            {owned.deleted > 0 ? (
              <p className={styles.text}>
                {owned.deleted} of them {owned.deleted === 1 ? 'is' : 'are'} in the list of deleted documents.
                A deleted document still counts until it is deleted permanently.{' '}
                <Link href="/deleted">Deleted documents</Link>
              </p>
            ) : null}
          </Stack>
        ) : (
          <DeleteAccount email={user?.email ?? ''} secondFactor={user?.twoFactorEnabled === true} />
        )}
      </div>
    </Stack>
  );
}
