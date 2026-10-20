'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { send, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';
import { InBrowser, LocalTime } from '../local-time.tsx';
import { NOTIFICATIONS_CHANGED } from './changed.ts';

interface Shown {
  id: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  read: boolean;
}

/** One notification, by kind (src/lib/documents/sharing.ts, `ListedNotification`). */
export type NotificationItem =
  | (Shown & { kind: 'document_invitation'; inviterName: string; role: string; invitationId: string })
  // FR-ED-42, FR-ED-48: the one reminder, 3 days before the invitation expires; it names no title (S18-4).
  | (Shown & {
      kind: 'document_invitation_reminder';
      inviterName: string;
      role: string;
      invitationId: string;
      /** ISO 8601, UTC; null once the invitation was accepted (S18-2). */
      expiresAt: string | null;
    })
  // FR-ED-42, S15-2: the person's role on a document was changed; they hold it still.
  | (Shown & { kind: 'role_changed'; documentId: string; title: string; role: string })
  // FR-ED-42, S15-2: the person was removed. It names no document and links to nothing (register row PR-5).
  | (Shown & { kind: 'removed' })
  // FR-ED-42, FR-ED-47: ownership of a document is offered to the person; the title is shown, behind sign-in (S17-2, D202).
  | (Shown & { kind: 'ownership_offer'; ownerName: string; title: string; offerId: string });

/** What a notification says, in the words approved with docs/plan/presence-row.md, section 5. */
function Statement({ notification }: { notification: NotificationItem }) {
  switch (notification.kind) {
    case 'document_invitation':
      return (
        <>
          <bdi>{notification.inviterName}</bdi> invited you to a document as {notification.role}.
        </>
      );
    case 'document_invitation_reminder':
      return (
        <>
          Reminder: <bdi>{notification.inviterName}</bdi> invited you to a document as {notification.role}.{' '}
          {notification.expiresAt === null ? null : (
            <InBrowser>
              The invitation expires on <LocalTime at={notification.expiresAt} />.
            </InBrowser>
          )}
        </>
      );
    case 'role_changed':
      return (
        <>
          Your role on <bdi>{notification.title}</bdi> was changed to {notification.role}.
        </>
      );
    case 'removed':
      return <>You no longer have access to a document.</>;
    case 'ownership_offer':
      return (
        <>
          {/* The name and the title are text, whatever they hold (NFR-SE-08). */}
          <bdi>{notification.ownerName}</bdi> offered you ownership of <bdi>{notification.title}</bdi>.
        </>
      );
  }
}

/** The link to the subject of a notification, or null for one that has none. */
function Subject({ notification }: { notification: NotificationItem }) {
  switch (notification.kind) {
    case 'document_invitation':
    case 'document_invitation_reminder':
      return (
        <Link
          id={`open-${notification.id}`}
          href={`/invitations/received/${encodeURIComponent(notification.invitationId)}`}
        >
          Open the invitation
        </Link>
      );
    case 'role_changed':
      return (
        <Link
          id={`open-${notification.id}`}
          href={`/documents/${encodeURIComponent(notification.documentId)}`}
        >
          Open the document
        </Link>
      );
    case 'ownership_offer':
      return (
        <Link
          id={`open-${notification.id}`}
          href={`/ownership-offers/${encodeURIComponent(notification.offerId)}`}
        >
          Open the offer
        </Link>
      );
    case 'removed':
      return null;
  }
}

/**
 * FR-ED-42: the account's notifications, each stating what happened without
 * quoting document content and linking to its subject, shown as read or
 * unread in words. Text for a person (plan Q6; docs/plan/slice-13.md, §5).
 */
export function NotificationList({ notifications }: { notifications: NotificationItem[] }) {
  const router = useRouter();
  const [fault, setFault] = useState<Fault | null>(null);
  const [marking, setMarking] = useState<string | null>(null);

  async function markRead(id: string) {
    setMarking(id);
    setFault(null);
    const refused = await send(`/api/notifications/${encodeURIComponent(id)}`, undefined, 'PATCH');
    setMarking(null);
    if (refused) return setFault(refused);
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
    // The button goes with the unread state: focus moves to the link of the same
    // notification, and not to the page (WCAG 2.4.3). One with no link (a removal)
    // moves it to its own words.
    (document.getElementById(`open-${id}`) ?? document.getElementById(`words-${id}`))?.focus();
    router.refresh();
  }

  return (
    <Stack gap={5}>
      <PageHeading>Notifications</PageHeading>
      {fault ? <FormFault title={fault.message} autoFocus={false} /> : null}
      {notifications.length === 0 ? (
        <p className={styles.text}>There are no notifications.</p>
      ) : (
        <ul className={styles.list}>
          {notifications.map((notification) => (
            <li key={notification.id} className={styles.row}>
              <Stack gap={2}>
                <Cluster gap={3}>
                  {notification.read ? null : <Badge variant="new">Unread</Badge>}
                  <p id={`words-${notification.id}`} tabIndex={-1} className={styles.text}>
                    <Statement notification={notification} />
                  </p>
                </Cluster>
                <InBrowser>
                  <p className={styles.meta}>
                    <LocalTime at={notification.createdAt} />
                  </p>
                </InBrowser>
                <Cluster gap={3}>
                  <Subject notification={notification} />
                  {notification.read ? null : (
                    <Button
                      variant="quiet"
                      disabled={marking !== null}
                      onClick={() => void markRead(notification.id)}
                    >
                      Mark as read
                    </Button>
                  )}
                </Cluster>
              </Stack>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}
