'use client';

import { useState, useSyncExternalStore } from 'react';
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

// FR-ED-43, the two fixed texts, word for word: the mark, and its explanation.
const NOT_RECORDED = 'Not recorded';
const NOT_RECORDED_EXPLANATION =
  'This document was created while writing was not being recorded. It has no provenance record, and it can never be sealed.';

// FR-ED-35: the limit of a title and its default, stated where a title is typed.
const TITLE_HINT = 'At most 200 characters. An empty title is stored as “Untitled document”.';

export interface DocumentItem {
  id: string;
  title: string;
  recording: 'RECORDED' | 'UNRECORDED';
  /** ISO 8601, UTC. */
  createdAt: string;
}

const two = (value: number) => String(value).padStart(2, '0');

/** The day and the minute in the zone of the browser, in the one form the Expression Guidelines give a date (ISO 8601). */
function localTime(iso: string): string {
  const at = new Date(iso);
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

const never = () => () => {};

/**
 * NFR-I18-06: a date is shown "in the user's local timezone as reported by the
 * browser". The server does not know that zone, so it renders no date at all,
 * and the browser writes it once the page is its own: nothing the server sent
 * is contradicted, and no date is ever shown in the server's zone.
 */
function Created({ at }: { at: string }) {
  const inBrowser = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  if (!inBrowser) return null;
  return (
    <p className={styles.meta}>
      Created <time dateTime={at}>{localTime(at)}</time>
    </p>
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

/** FR-ED-35, FR-ED-43: the list of the account's documents, the creation of one, and the renaming of one. */
export function Documents({ documents }: { documents: DocumentItem[] }) {
  const router = useRouter();
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [creating, setCreating] = useState(false);
  const ready = useReady();
  const [renaming, setRenaming] = useState<DocumentItem | null>(null);

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
      {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
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
                      {document.title}
                    </bdi>
                    {document.recording === 'UNRECORDED' ? (
                      <Tooltip content={NOT_RECORDED_EXPLANATION}>{NOT_RECORDED}</Tooltip>
                    ) : null}
                  </Cluster>
                  <Created at={document.createdAt} />
                </Stack>
                <Button
                  variant="quiet"
                  disabled={!ready}
                  aria-describedby={`title-${document.id}`}
                  onClick={() => setRenaming(document)}
                >
                  Rename
                </Button>
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
    </Stack>
  );
}
