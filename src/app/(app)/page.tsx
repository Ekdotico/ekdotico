// The first screen after sign-in: the documents of the account (FR-ED-35),
// with the means to create one, to rename one, and to delete one (FR-ED-36).
import { listDocuments } from '../../lib/documents/documents.ts';
import { settings } from '../../lib/settings.ts';
import { reading } from '../page-fault.ts';
import { currentAccount, titled } from './account.ts';
import { Documents } from './documents.tsx';

export const generateMetadata = () => titled('Documents');

export default async function Home() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  // The account is the session's, validated in account.ts, and the list is its
  // own: nothing of the request chooses whose documents are read.
  const { userId } = await currentAccount();
  // A fault of the read is the page of a fault, and one line (page-fault.ts).
  const documents = await reading(() => listDocuments(userId));
  return (
    <Documents
      documents={documents.map(({ id, title, recording, createdAt, canRename, canDelete, clearingAt }) => ({
        id,
        title,
        recording,
        canRename,
        canDelete,
        // FR-AU-91: the day a clearing deletes it, in UTC; the browser shows it in its own zone.
        deleteOn: clearingAt?.toISOString() ?? null,
        // NFR-I18-06: stored and sent in UTC; the browser shows it in its own zone.
        createdAt: createdAt.toISOString(),
      }))}
      // FR-ED-36: the retention, which the confirmation of a deletion states.
      retentionDays={settings().deletedDocumentRetentionDays}
    />
  );
}
