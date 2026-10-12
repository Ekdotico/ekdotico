'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { useReady } from '../../../components/ready.ts';
import { send, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';
import { InBrowser, LocalTime } from '../local-time.tsx';

export interface DeletedDocumentItem {
  id: string;
  title: string;
  /** ISO 8601, UTC. */
  deletedAt: string;
  /** ISO 8601, UTC: when the retention ends. */
  permanentDeletionAt: string;
}

/**
 * FR-ED-36: the list of deleted documents, which only their Owner sees, and
 * the restoring of one. The words are the application's: the requirement
 * gives none (the owner's answer to Q6 of the plan: approved with the pull
 * request). Restoring is undone by deleting again, so it asks no confirmation.
 */
export function DeletedDocuments({
  documents,
  retentionDays,
}: {
  documents: DeletedDocumentItem[];
  retentionDays: number;
}) {
  const router = useRouter();
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ready = useReady();
  const [restoring, setRestoring] = useState<string | null>(null);
  // How many documents were restored from this page: see the same in ../documents.tsx.
  const [restored, setRestored] = useState(0);
  const statement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (restored > 0) statement.current?.focus();
  }, [restored]);

  async function restore(id: string) {
    if (restoring) return;
    setRestoring(id);
    setFault(null);
    const refused = await send(`/api/documents/${id}/restore`);
    setRestoring(null);
    if (refused) {
      setFault(refused);
      setAttempt((count) => count + 1);
    } else {
      setRestored((count) => count + 1);
    }
    // The list is the server's: it is read again either way, since a refusal
    // can mean that the document is no longer in it.
    router.refresh();
  }

  return (
    <Stack gap={6}>
      <Cluster justify="between" gap={4}>
        <PageHeading>Deleted documents</PageHeading>
        <Link href="/">Documents</Link>
      </Cluster>
      <p className={styles.text}>
        Ekdotico keeps a deleted document for {retentionDays} {retentionDays === 1 ? 'day' : 'days'} and then
        deletes it permanently. Until then it can be restored.
      </p>
      {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
      {restored > 0 ? (
        <p ref={statement} role="status" tabIndex={-1} className={styles.text}>
          Document restored. It is in the list of documents again.
        </p>
      ) : null}
      {documents.length === 0 ? (
        <p className={styles.text}>No deleted documents.</p>
      ) : (
        <ul className={styles.list}>
          {documents.map((document) => (
            <li key={document.id} className={styles.row}>
              <Cluster justify="between" gap={4}>
                <Stack gap={1}>
                  {/* The title is text, whatever it holds (NFR-SE-08). */}
                  <bdi id={`title-${document.id}`} className={styles.documentTitle}>
                    {document.title}
                  </bdi>
                  <InBrowser>
                    <p className={styles.meta}>
                      Deleted <LocalTime at={document.deletedAt} />. Permanent deletion after{' '}
                      <LocalTime at={document.permanentDeletionAt} />.
                    </p>
                  </InBrowser>
                </Stack>
                <Button
                  disabled={!ready}
                  aria-describedby={`title-${document.id}`}
                  pending={restoring === document.id}
                  pendingLabel="Restoring document…"
                  onClick={() => restore(document.id)}
                >
                  Restore
                </Button>
              </Cluster>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}
