'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { send, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';
import { InBrowser, LocalTime } from '../local-time.tsx';
import { NOTIFICATIONS_CHANGED } from './changed.ts';

export interface NotificationItem {
  id: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  read: boolean;
  inviterName: string;
  role: string;
  invitationId: string;
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
                  <p className={styles.text}>
                    <bdi>{notification.inviterName}</bdi> invited you to a document as {notification.role}.
                  </p>
                </Cluster>
                <InBrowser>
                  <p className={styles.meta}>
                    <LocalTime at={notification.createdAt} />
                  </p>
                </InBrowser>
                <Cluster gap={3}>
                  <Link href={`/invitations/received/${encodeURIComponent(notification.invitationId)}`}>
                    Open the invitation
                  </Link>
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
