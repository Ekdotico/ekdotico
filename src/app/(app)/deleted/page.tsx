// FR-ED-36: the deleted documents of the account, each with the day it is
// deleted permanently, and the means to restore one. The address is the
// application's choice: the Docs name no page for the list.
import { listDeletedDocuments } from '../../../lib/documents/deletion.ts';
import { settings } from '../../../lib/settings.ts';
import { reading } from '../../page-fault.ts';
import { currentAccount, titled } from '../account.ts';
import { DeletedDocuments } from './deleted-documents.tsx';

export const generateMetadata = () => titled('Deleted documents');

export default async function Deleted() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  // The account is the session's, validated in account.ts, and the list is its
  // own, as the Owner: nothing of the request chooses whose documents are read.
  const { userId } = await currentAccount();
  // A fault of the read is the page of a fault, and one line (page-fault.ts).
  const documents = await reading(() => listDeletedDocuments(userId));
  return (
    <DeletedDocuments
      documents={documents.map(({ id, title, deletedAt, permanentDeletionAt, clearingAt }) => ({
        id,
        title,
        // NFR-I18-06: stored and sent in UTC; the browser shows them in its own zone.
        deletedAt: deletedAt.toISOString(),
        permanentDeletionAt: permanentDeletionAt.toISOString(),
        // FR-AU-91: the day a clearing deletes it; it cannot be restored until the clearing is cancelled for it.
        deleteOn: clearingAt?.toISOString() ?? null,
      }))}
      retentionDays={settings().deletedDocumentRetentionDays}
    />
  );
}
