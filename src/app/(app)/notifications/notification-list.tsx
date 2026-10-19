'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { send, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';
import { InBrowser, LocalTime } from '../local-time.tsx';
import { NOTIFICATIONS_CHANGED } from './changed.ts';
import { OfferNotification, type OfferNotificationItem } from './offer-notification.tsx';

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
export function NotificationList({
  notifications,
  offers = [],
}: {
  notifications: NotificationItem[];
  /** FR-ED-47: the offers of ownership, in the same list (docs/plan/slice-17.md, section 3). */
  offers?: OfferNotificationItem[];
}) {
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
    // notification, and not to the page (WCAG 2.4.3).
    document.getElementById(`open-${id}`)?.focus();
    router.refresh();
  }

  // Newest first, whatever the kind (ISO 8601 in UTC sorts as it reads).
  const entries = [
    ...notifications.map((notification) => ({ at: notification.createdAt, notification })),
    ...offers.map((offer) => ({ at: offer.createdAt, offer })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return (
    <Stack gap={5}>
      <PageHeading>Notifications</PageHeading>
      {fault ? <FormFault title={fault.message} autoFocus={false} /> : null}
      {notifications.length + offers.length === 0 ? (
        <p className={styles.text}>There are no notifications.</p>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => {
            if ('offer' in entry) {
              return (
                <OfferNotification
                  key={entry.offer.id}
                  notification={entry.offer}
                  marking={marking !== null}
                  onMarkRead={(id) => void markRead(id)}
                />
              );
            }
            const { notification } = entry;
            return (
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
                    <Link
                      id={`open-${notification.id}`}
                      href={`/invitations/received/${encodeURIComponent(notification.invitationId)}`}
                    >
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
            );
          })}
        </ul>
      )}
    </Stack>
  );
}
