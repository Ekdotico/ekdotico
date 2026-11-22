'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { sendFor, type Fault } from '../../../components/send.ts';
import { DELETED_ACCOUNT } from '../../../lib/account/deleted-account.ts';
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
 * The sender by name and by email address, "Ada Owner (ada@example.com)"; by name alone where the account has no
 * address left. A sender whose account was deleted has neither, and is the fixed text (FR-AU-58 (e)).
 */
export function Sender({ name, email }: { name: string; email: string | null }) {
  return (
    <>
      <bdi>{name === '' ? DELETED_ACCOUNT : name}</bdi>
      {email === null ? null : (
        <>
          {' '}
          (<bdi>{email}</bdi>)
        </>
      )}
    </>
  );
}

/**
 * Who invited, to what, and in which role (D202): the sender by name and by email address, and the
 * document by its title, or by the pseudonym that stands for it where the inviter hid the title. The
 * words are the owner's to approve. Names, addresses, titles and pseudonyms are text, whatever they hold
 * (NFR-SE-08); `<bdi>` keeps a name of the other direction from reordering the sentence around it.
 */
export function InvitedBy({
  inviterName,
  inviterEmail,
  title,
  pseudonym,
  role,
}: {
  inviterName: string;
  inviterEmail: string | null;
  title: string | null;
  pseudonym: string | null;
  role: string;
}) {
  const sender = <Sender name={inviterName} email={inviterEmail} />;
  if (title !== null) {
    return (
      <>
        {sender} invited you to the document <bdi>{title}</bdi> as {role}.
      </>
    );
  }
  return (
    <>
      {sender} invited you to a document as {role}.
      {pseudonym === null ? null : (
        <>
          {' '}
          The title of the document is hidden until you accept. It is shown here as <bdi>{pseudonym}</bdi>.
        </>
      )}
    </>
  );
}

/**
 * FR-ED-21, D202: the invitation, to the account that holds the invited address,
 * with the two answers. It names who invited, by name and by email address, the
 * role, and the title of the document or the pseudonym that stands for it. `path`
 * is where the answers are sent: `/api/invitations/<token>` or
 * `/api/invitations/received/<id>`.
 */
export function OpenInvitation({
  path,
  inviterName,
  inviterEmail,
  titleShown,
  role,
  expiresAt,
}: {
  path: string;
  inviterName: string;
  inviterEmail: string | null;
  titleShown: { title: string | null; pseudonym: string | null };
  role: string;
  /** ISO 8601, UTC. */
  expiresAt: string;
}) {
  const router = useRouter();
  const [sending, setSending] = useState<'accept' | 'decline' | null>(null);
  const [fault, setFault] = useState<Fault | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const said = useRef<HTMLParagraphElement>(null);
  // The buttons go with the answer: focus moves to what was said (WCAG 2.4.3).
  useEffect(() => {
    if (declined !== null) said.current?.focus();
  }, [declined]);

  async function answer(chosen: 'accept' | 'decline') {
    if (sending) return;
    setSending(chosen);
    setFault(null);
    const sent = await sendFor(`${path}/${chosen}`);
    setSending(null);
    if ('fault' in sent) return setFault(sent.fault);
    const { documentId, message } = (sent.answer ?? {}) as { documentId?: string; message?: string };
    if (chosen === 'accept' && documentId) return router.push(`/documents/${documentId}`);
    setDeclined(message ?? '');
  }

  return (
    <Stack gap={4}>
      <PageHeading>{INVITATION_TITLE}</PageHeading>
      <p className={styles.text}>
        <InvitedBy
          inviterName={inviterName}
          inviterEmail={inviterEmail}
          title={titleShown.title}
          pseudonym={titleShown.pseudonym}
          role={role}
        />{' '}
        <InBrowser>
          The invitation is open until <LocalTime at={expiresAt} />.
        </InBrowser>
      </p>
      {declined !== null ? (
        <p className={styles.text} role="status" ref={said} tabIndex={-1}>
          {declined}
        </p>
      ) : (
        <Cluster gap={3}>
          <Button
            variant="primary"
            pending={sending === 'accept'}
            disabled={sending === 'decline'}
            onClick={() => void answer('accept')}
          >
            Accept
          </Button>
          <Button
            variant="quiet"
            pending={sending === 'decline'}
            disabled={sending === 'accept'}
            onClick={() => void answer('decline')}
          >
            Decline
          </Button>
        </Cluster>
      )}
      {fault ? <FormFault title={fault.message} autoFocus={false} /> : null}
    </Stack>
  );
}
