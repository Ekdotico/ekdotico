// FR-AU-58: the deletion screen. Where the account owns a document it states how many and
// offers no deletion ("Only when the account owns no document does Ekdotico offer the deletion
// itself"); the refusal is the route's as well and does not rest on this (src/app/api/account/route.ts).
// It offers the two actions that FR-AU-58 names: "Clear all documents" (FR-AU-91; slice 23), with the
// documents that wait for their day and the means to cancel each, and "Transfer ownership of all
// documents" (FR-AU-92; slice 24). The path is this application's choice: no page of
// the specification names one.
import Link from 'next/link';
import { PageHeading, Stack } from '@ekdotico/domico/components';
import { ownedDocuments } from '../../../../lib/account/deletion.ts';
import { transferScreen } from '../../../../lib/account/transfer.ts';
import { clearingScreen } from '../../../../lib/clearing/clearing.ts';
import { db } from '../../../../lib/db.ts';
import { settings } from '../../../../lib/settings.ts';
import { reading } from '../../../page-fault.ts';
import styles from '../../../pages.module.css';
import { currentAccount, titled } from '../../account.ts';
import { Clearing } from './clear-documents.tsx';
import { DeleteAccount } from './delete-account.tsx';
import { TransferDocuments } from './transfer-documents.tsx';

export const generateMetadata = () => titled('Delete account');

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const documents = (count: number) => `${count} ${count === 1 ? 'document' : 'documents'}`;

export default async function DeleteAccountPage() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { userId } = await currentAccount();
  // A fault of any read is the page of a fault, and one line (page-fault.ts).
  const [owned, user, screen, transfer] = await reading(() =>
    Promise.all([
      ownedDocuments(userId),
      db().user.findUnique({ where: { id: userId }, select: { email: true, twoFactorEnabled: true } }),
      clearingScreen(userId),
      transferScreen(userId),
    ]),
  );
  // "The account cannot be deleted before [date]" is true only where every document it owns waits for that day.
  const lastDay = screen.all.documentIds.length === 0 ? (screen.waiting.at(-1)?.deleteOn ?? null) : null;

  return (
    <Stack gap={8}>
      <PageHeading>Delete account</PageHeading>
      <div className={styles.narrow}>
        {owned.owned > 0 ? (
          <Stack gap={8}>
            <Stack gap={5}>
              <p className={styles.text}>
                This account owns {documents(owned.owned)}. An account that owns a document cannot be deleted,
                because every document needs an Owner.{' '}
                {owned.owned === 1
                  ? 'Delete the document, transfer its ownership to an Editor who accepts it, or clear it, and then return to this page.'
                  : 'Delete each document you own, transfer its ownership to an Editor who accepts it, or clear all the documents, and then return to this page.'}
              </p>
              {owned.deleted > 0 ? (
                <p className={styles.text}>
                  {owned.deleted} of them {owned.deleted === 1 ? 'is' : 'are'} in the list of deleted
                  documents. A deleted document still counts until it is deleted permanently.{' '}
                  <Link href="/deleted">Deleted documents</Link>
                </p>
              ) : null}
            </Stack>
            <TransferDocuments
              documents={transfer.documents.map(({ id, title, state }) => ({
                id,
                title,
                // NFR-I18-06: stored and sent in UTC; the browser shows it in its own zone.
                state:
                  state.kind === 'offered' ? { ...state, expiresAt: state.expiresAt.toISOString() } : state,
              }))}
              accepted={transfer.accepted}
              longest={transfer.longest}
              people={transfer.people}
              days={settings().ownershipOfferDays}
              email={user?.email ?? ''}
              secondFactor={user?.twoFactorEnabled === true}
            />
            <Clearing
              all={{
                scope: 'all',
                documentIds: screen.all.documentIds,
                shared: screen.all.shared,
                people: screen.all.people,
              }}
              deleted={{
                scope: 'deleted',
                documentIds: screen.deleted.documentIds,
                shared: screen.deleted.shared,
                people: screen.deleted.people,
              }}
              waiting={screen.waiting.map(({ id, title, deleteOn }) => ({
                id,
                title,
                // NFR-I18-06: stored and sent in UTC; the browser shows it in its own zone.
                deleteOn: deleteOn.toISOString(),
              }))}
              deleting={screen.deleting}
              email={user?.email ?? ''}
              secondFactor={user?.twoFactorEnabled === true}
              noticeDays={settings().clearingNoticeDays}
              lastDay={lastDay?.toISOString() ?? null}
            />
          </Stack>
        ) : (
          <DeleteAccount email={user?.email ?? ''} secondFactor={user?.twoFactorEnabled === true} />
        )}
      </div>
    </Stack>
  );
}
