'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Button,
  Cluster,
  Dialog,
  FormFault,
  PageHeading,
  Stack,
  TextField,
  Tooltip,
} from '@ekdotico/domico/components';
import { useReady } from '../../components/ready.ts';
import { send, type Fault } from '../../components/send.ts';
import styles from '../pages.module.css';
import { InBrowser, LocalTime } from './local-time.tsx';
import { NOT_RECORDED, NOT_RECORDED_EXPLANATION } from './not-recorded.ts';

// FR-ED-35: the limit of a title and its default, stated where a title is typed.
const TITLE_HINT = 'A title has at most 200 characters. An empty title is stored as “Untitled document”.';

export interface DocumentItem {
  id: string;
  title: string;
  recording: 'RECORDED' | 'UNRECORDED';
  /** ISO 8601, UTC. */
  createdAt: string;
  /** Whether the account's role holds the permission (FR-ED-44); a document shared with it may hold neither. */
  canRename: boolean;
  canDelete: boolean;
}

/** Where the list of deleted documents is (FR-ED-36): the application's choice, the Docs name no page. */
const DELETED_PATH = '/deleted';
const DELETE_TITLE_ID = 'delete-document-title';
const DELETE_STATEMENT_ID = 'delete-document-statement';
const CANCEL_ID = 'delete-document-cancel';

/** FR-ED-36: the retention as the confirmation states it, "30 days" by default. */
const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

/**
 * FR-ED-36: the confirmation of a deletion, which states what happens before
 * anything does (Expression Guidelines, system feedback, rule 13). The words
 * are the application's: the requirement gives none (the owner's answer to Q6
 * of the plan: approved with the pull request). Focus opens on Cancel, the
 * way that deletes nothing.
 */
function DeleteConfirmation({
  document,
  retentionDays,
  onDeleted,
  onCancel,
}: {
  document: DocumentItem;
  retentionDays: number;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    const refused = await send(`/api/documents/${document.id}`, undefined, 'DELETE');
    setPending(false);
    if (!refused) return onDeleted();
    setFault(refused);
    setAttempt((count) => count + 1);
  }

  return (
    <Stack gap={5}>
      {fault ? <FormFault title={fault.message} headingLevel={3} focusKey={attempt} /> : null}
      {/* The title is whatever its Owner typed, a sentence about what Ekdotico
          keeps included. So it is no part of the statement: it stands above
          it, on a line of its own under a label that says what it is, set as
          a title is set in the list, and the statement below is the same
          sentence for every document. */}
      <Stack gap={1}>
        <p className={styles.meta}>Document</p>
        <p className={styles.text}>
          <bdi id={DELETE_TITLE_ID} className={styles.documentTitle}>
            {document.title}
          </bdi>
        </p>
      </Stack>
      <p id={DELETE_STATEMENT_ID} className={styles.text}>
        Deleting this document removes it from the list of documents and closes every open connection to it.
        Ekdotico keeps the document for {days(retentionDays)} in the list of deleted documents, where it can
        be restored. After {days(retentionDays)} Ekdotico deletes the document permanently, and it cannot be
        restored.
      </p>
      <Cluster gap={3}>
        <Button variant="destructive" pending={pending} pendingLabel="Deleting document…" onClick={confirm}>
          Delete document
        </Button>
        <Button id={CANCEL_ID} onClick={onCancel}>
          Cancel
        </Button>
      </Cluster>
    </Stack>
  );
}

function RenameForm({
  document,
  onRenamed,
  onCancel,
}: {
  document: DocumentItem;
  onRenamed: () => void;
  onCancel: () => void;
}) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const title = new FormData(event.currentTarget).get('title');
    setPending(true);
    const refused = await send(`/api/documents/${document.id}`, { title }, 'PATCH');
    setPending(false);
    if (!refused) return onRenamed();
    setFault(refused);
    setAttempt((count) => count + 1);
  }

  const rule = fault?.fields?.title;
  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? (
          // The one announcement of a refusal; the rule is also stated beside the field.
          <FormFault
            title={fault.message}
            headingLevel={3}
            faults={rule ? [{ fieldId: 'document-title', message: rule }] : undefined}
            focusKey={attempt}
          />
        ) : null}
        <TextField
          id="document-title"
          name="title"
          label="Title"
          hint={TITLE_HINT}
          defaultValue={document.title}
          autoComplete="off"
          error={rule}
        />
        <Cluster gap={3}>
          <Button variant="primary" type="submit" pending={pending} pendingLabel="Saving…">
            Save
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </Cluster>
      </Stack>
    </form>
  );
}

/**
 * FR-ED-35, FR-ED-36, FR-ED-43: the list of the account's documents, the
 * creation of one, the renaming of one, and the deletion of one.
 * `retentionDays` is the server's setting, which the confirmation states.
 */
export function Documents({
  documents,
  retentionDays,
}: {
  documents: DocumentItem[];
  retentionDays: number;
}) {
  const router = useRouter();
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const ready = useReady();
  const [renaming, setRenaming] = useState<DocumentItem | null>(null);
  const [deleting, setDeleting] = useState<DocumentItem | null>(null);
  // How many documents were deleted from this page: the statement of the last
  // deletion is shown, and takes focus each time one is made.
  const [deleted, setDeleted] = useState(0);
  const statement = useRef<HTMLParagraphElement>(null);
  // The row of a deleted document is gone, and the control that had focus with
  // it. Focus goes to the statement of what was done, which is so read out.
  useEffect(() => {
    if (deleted > 0) statement.current?.focus();
  }, [deleted]);
  // Where the confirmation opens: on Cancel, which deletes nothing. The
  // package's Button takes no ref (reported), so the control is found by its id.
  const cancel = useMemo(
    () => ({
      get current() {
        return globalThis.document.getElementById(CANCEL_ID);
      },
    }),
    [],
  );

  async function create() {
    setCreating(true);
    setFault(null);
    // FR-AU-12: the personal workspace is the only one, so none is chosen.
    const refused = await send('/api/documents', {});
    setCreating(false);
    if (refused) {
      setFault(refused);
      setAttempt((count) => count + 1);
      return;
    }
    // The list is the server's: it is read again, and this page is rendered from it.
    router.refresh();
  }

  return (
    <Stack gap={6}>
      <Cluster justify="between" gap={4}>
        <PageHeading>Documents</PageHeading>
        <Cluster gap={4}>
          <Link href={DELETED_PATH}>Deleted documents</Link>
          <Button
            variant="primary"
            disabled={!ready}
            pending={creating}
            pendingLabel="Creating document…"
            onClick={create}
          >
            New document
          </Button>
        </Cluster>
      </Cluster>
      {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
      {deleted > 0 ? (
        <p ref={statement} role="status" tabIndex={-1} className={styles.text}>
          Document deleted. Ekdotico keeps it for {days(retentionDays)} in the list of deleted documents.
        </p>
      ) : null}
      {documents.length === 0 ? (
        <p className={styles.text}>No documents yet. Choose New document to create the first one.</p>
      ) : (
        <ul className={styles.list}>
          {documents.map((document) => (
            <li key={document.id} className={styles.row}>
              <Cluster justify="between" gap={4}>
                <Stack gap={1}>
                  <Cluster gap={3}>
                    {/* The title is text, whatever it holds (NFR-SE-08), and
                        `bdi` keeps a title written right to left from
                        reordering the mark beside it. */}
                    <bdi id={`title-${document.id}`} className={styles.documentTitle}>
                      {/* The owner's decision E4 of 8 October 2026: the page of a document. */}
                      <Link href={`/documents/${document.id}`}>{document.title}</Link>
                    </bdi>
                    {document.recording === 'UNRECORDED' ? (
                      <Tooltip content={NOT_RECORDED_EXPLANATION}>{NOT_RECORDED}</Tooltip>
                    ) : null}
                  </Cluster>
                  <InBrowser>
                    <p className={styles.meta}>
                      Created <LocalTime at={document.createdAt} />
                    </p>
                  </InBrowser>
                </Stack>
                <Cluster gap={2}>
                  {document.canRename ? (
                    <Button
                      variant="quiet"
                      disabled={!ready}
                      aria-describedby={`title-${document.id}`}
                      onClick={() => setRenaming(document)}
                    >
                      Rename
                    </Button>
                  ) : null}
                  {document.canDelete ? (
                    <Button
                      variant="quiet"
                      disabled={!ready}
                      aria-describedby={`title-${document.id}`}
                      onClick={() => setDeleting(document)}
                    >
                      Delete document
                    </Button>
                  ) : null}
                </Cluster>
              </Cluster>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} title="Rename document">
        {renaming ? (
          <RenameForm
            key={renaming.id}
            document={renaming}
            onCancel={() => setRenaming(null)}
            onRenamed={() => {
              setRenaming(null);
              router.refresh();
            }}
          />
        ) : null}
      </Dialog>
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete document"
        // Which document, and then what happens to it: both are read with the name.
        aria-describedby={`${DELETE_TITLE_ID} ${DELETE_STATEMENT_ID}`}
        initialFocusRef={cancel}
      >
        {deleting ? (
          <DeleteConfirmation
            key={deleting.id}
            document={deleting}
            retentionDays={retentionDays}
            onCancel={() => setDeleting(null)}
            onDeleted={() => {
              setDeleting(null);
              setDeleted((count) => count + 1);
              router.refresh();
            }}
          />
        ) : null}
      </Dialog>
    </Stack>
  );
}
