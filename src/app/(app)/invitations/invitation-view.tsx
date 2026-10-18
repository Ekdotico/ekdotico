'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { sendFor, type Fault } from '../../../components/send.ts';
import { INVITATION_TITLE } from '../../../lib/documents/invitation-texts.ts';
import styles from '../../pages.module.css';
import { InBrowser, LocalTime } from '../local-time.tsx';

/** A statement in place of the invitation: FR-ED-21's or FR-ED-37's, which names no document. */
export function InvitationStatement({ statement }: { statement: string }) {
  return (
    <Stack gap={4}>
      <PageHeading>{INVITATION_TITLE}</PageHeading>
      <p className={styles.text}>{statement}</p>
    </Stack>
  );
}

/**
 * FR-ED-21: the invitation, to the account that holds the invited address,
 * with the two answers. It names who invited and the role, as the email does,
 * and not the document (S13-2). `path` is where the answers are sent:
 * `/api/invitations/<token>` or `/api/invitations/received/<id>`.
 */
export function OpenInvitation({
  path,
  inviterName,
  role,
  expiresAt,
}: {
  path: string;
  inviterName: string;
  role: string;
  /** ISO 8601, UTC. */
  expiresAt: string;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);

  async function answer(chosen: 'accept' | 'decline') {
    setSending(true);
    setFault(null);
    const sent = await sendFor(`${path}/${chosen}`);
    setSending(false);
    if ('fault' in sent) return setFault(sent.fault);
    const { documentId, message } = (sent.answer ?? {}) as { documentId?: string; message?: string };
    if (chosen === 'accept' && documentId) return router.push(`/documents/${documentId}`);
    setDeclined(message ?? '');
  }

  return (
    <Stack gap={4}>
      <PageHeading>{INVITATION_TITLE}</PageHeading>
      <p className={styles.text}>
        {/* The name is text, whatever it holds (NFR-SE-08). */}
        <bdi>{inviterName}</bdi> invited you to a document as {role}.{' '}
        <InBrowser>
          The invitation is open until <LocalTime at={expiresAt} />.
        </InBrowser>
      </p>
      {declined !== null ? (
        <p className={styles.text} role="status">
          {declined}
        </p>
      ) : (
        <Cluster gap={3}>
          <Button disabled={sending} onClick={() => void answer('accept')}>
            Accept
          </Button>
          <Button variant="quiet" disabled={sending} onClick={() => void answer('decline')}>
            Decline
          </Button>
        </Cluster>
      )}
      {fault ? <FormFault title={fault.message} autoFocus={false} /> : null}
    </Stack>
  );
}
