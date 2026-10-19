'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { sendFor, type Fault } from '../../../components/send.ts';
import { OFFER_TITLE } from '../../../lib/documents/ownership-texts.ts';
import styles from '../../pages.module.css';
import { InBrowser, LocalTime } from '../local-time.tsx';

/** A statement in place of the offer: it names no document. */
export function OfferStatement({ statement }: { statement: string }) {
  return (
    <Stack gap={4}>
      <PageHeading>{OFFER_TITLE}</PageHeading>
      <p className={styles.text}>{statement}</p>
    </Stack>
  );
}

/**
 * FR-ED-47: the offer, to the account it names, with the two answers. It says
 * what accepting does, as the email does, and names the document by its title
 * (register row S17-2, with D202): the account already holds a role on it.
 * Text for a person (plan Q6; docs/plan/slice-17.md, section 7).
 */
export function OpenOffer({
  path,
  ownerName,
  title,
  expiresAt,
}: {
  /** Where the answers are sent: `/api/ownership-offers/<id>`. */
  path: string;
  ownerName: string;
  title: string;
  /** ISO 8601, UTC. */
  expiresAt: string;
}) {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const said = useRef<HTMLParagraphElement>(null);
  // The buttons go with the answer: focus moves to what was said (WCAG 2.4.3).
  useEffect(() => {
    if (declined !== null) said.current?.focus();
  }, [declined]);

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
      <PageHeading>{OFFER_TITLE}</PageHeading>
      <p className={styles.text}>
        {/* The name and the title are text, whatever they hold (NFR-SE-08). */}
        <bdi>{ownerName}</bdi> has offered you ownership of <bdi>{title}</bdi>. If you accept, you become the
        Owner of the document and <bdi>{ownerName}</bdi> becomes an Editor. The document moves to your
        personal workspace.{' '}
        <InBrowser>
          The offer is open until <LocalTime at={expiresAt} />.
        </InBrowser>
      </p>
      {declined !== null ? (
        <p className={styles.text} role="status" ref={said} tabIndex={-1}>
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
