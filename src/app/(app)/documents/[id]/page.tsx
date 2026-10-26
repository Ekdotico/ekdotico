// The page of one document (the owner's decision E4 of 8 October 2026: its
// address is `/documents/[id]`): the title, the mark "Not recorded"
// (FR-ED-43), and the editor.
//
// The page authorises the request itself, by the one function every route of a
// document asks (NFR-SE-04, FR-ED-39). To an account that holds no role on the
// document, the address is no page: a document that does not exist, one that
// is deleted, and one of another account are the same answer (the owner's
// answer to Q8 of the plan), but for a document deleted before a clearing, which those who held a role on it may
// read until the day (FR-AU-91; the owner's answer to S23-1, 26 Oct 2026). Nothing of the document's content is rendered
// here: it arrives over the collaboration connection, which authorises the
// account again (FR-AU-08).
import type { Metadata } from 'next';
import Link from 'next/link';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { Cluster, PageHeading, Stack, Tooltip } from '@ekdotico/domico/components';
import { noticeRuns } from '../../../../lib/clearing/period.ts';
import { authorise } from '../../../../lib/documents/access.ts';
import { holds } from '../../../../lib/documents/permissions.ts';
import { settings } from '../../../../lib/settings.ts';
import { reading } from '../../../page-fault.ts';
import styles from '../../../pages.module.css';
import { currentAccount, titled } from '../../account.ts';
import { NOT_RECORDED, NOT_RECORDED_EXPLANATION } from '../../not-recorded.ts';
import { DocumentView } from './document-view.tsx';
import { ExportDraft } from './export-draft.tsx';
import { PEOPLE_SLOT } from './people-slot.ts';

type Props = { params: Promise<{ id: string }> };

// Once for each request, for the title and for the page. The account is the
// session's, validated in account.ts; the identifier is whatever the address
// holds, and `authorise` reads it as one or as none.
const open = cache(async (id: string) => {
  const { userId } = await currentAccount();
  // A fault of the read is the page of a fault, and one line (page-fault.ts).
  return reading(() => authorise(userId, id, 'document.view'));
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // FR-AU-55: nothing of the document while the notice is due, its title included.
  if ((await currentAccount()).noticeDue) return titled('Document');
  const access = await open((await params).id);
  return titled(access.outcome === 'allowed' ? access.document.title : 'Page not found');
}

export default async function DocumentPage({ params }: Props) {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const access = await open((await params).id);
  // `document.view` is held by every role (FR-ED-44), so there is no 403 here.
  if (access.outcome !== 'allowed') notFound();
  const { document, role } = access;
  return (
    <Stack gap={5}>
      <Cluster gap={3}>
        {/* The title is text, whatever it holds (NFR-SE-08). */}
        <PageHeading className={styles.breakable}>{document.title}</PageHeading>
        {document.recording === 'UNRECORDED' ? (
          <Tooltip content={NOT_RECORDED_EXPLANATION}>{NOT_RECORDED}</Tooltip>
        ) : null}
        {/* FR-ED-21, FR-ED-37: the sharing settings, for every role. */}
        {document.deletedAt === null ? <Link href={`/documents/${document.id}/sharing`}>Sharing</Link> : null}
        {/* FR-EX-36, FR-ED-44: the draft export, for a role that holds the permission. The editor has this page read
            again when its role or its permissions change (FR-ED-40 (g)), so the control follows them. */}
        {holds(document.permissionSet, role, 'document.export.draft') || noticeRuns(document, new Date()) ? (
          <ExportDraft documentId={document.id} />
        ) : null}
        {/* FR-ED-17: the people who have the document open, which the editor draws here once it is connected. */}
        <span id={PEOPLE_SLOT} className={styles.peopleSlot} />
      </Cluster>
      <DocumentView
        documentId={document.id}
        // FR-ED-44: fixed by role. The server discards what a role that cannot
        // edit sends (FR-ED-39); this only withdraws the controls.
        canEdit={holds(document.permissionSet, role, 'document.content.edit') && document.clearingAt === null}
        // FR-ED-23: "30 seconds (an initial value)".
        errorAfterMs={settings().collabErrorAfterMs}
        imageDays={settings().imageUnreferencedDays}
        // FR-AU-91: the page is opened already read-only, with the fixed statement, for a document in a clearing.
        deletedOn={document.clearingAt?.toISOString() ?? null}
        alreadyDeleted={document.deletedAt !== null}
      />
    </Stack>
  );
}
