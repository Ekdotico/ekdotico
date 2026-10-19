'use client';

import Link from 'next/link';
import { Badge, Button, Cluster, Stack } from '@ekdotico/domico/components';
import styles from '../../pages.module.css';
import { InBrowser, LocalTime } from '../local-time.tsx';

export interface OfferNotificationItem {
  id: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  read: boolean;
  ownerName: string;
  title: string;
  offerId: string;
}

/**
 * FR-ED-42: the notification of an offer of ownership (FR-ED-47), which links
 * to the page on which the offer is accepted or declined. It names the document
 * by its title, behind sign-in, to an account that holds a role on it (register
 * row S17-2, with D202); the email carries none. Text for a person (plan Q6;
 * docs/plan/slice-17.md, section 7).
 */
export function OfferNotification({
  notification,
  marking,
  onMarkRead,
}: {
  notification: OfferNotificationItem;
  /** Whether a notification of the list is being marked read. */
  marking: boolean;
  onMarkRead: (id: string) => void;
}) {
  return (
    <li className={styles.row}>
      <Stack gap={2}>
        <Cluster gap={3}>
          {notification.read ? null : <Badge variant="new">Unread</Badge>}
          <p className={styles.text}>
            {/* The name and the title are text, whatever they hold (NFR-SE-08). */}
            <bdi>{notification.ownerName}</bdi> offered you ownership of <bdi>{notification.title}</bdi>.
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
            href={`/ownership-offers/${encodeURIComponent(notification.offerId)}`}
          >
            Open the offer
          </Link>
          {notification.read ? null : (
            <Button variant="quiet" disabled={marking} onClick={() => onMarkRead(notification.id)}>
              Mark as read
            </Button>
          )}
        </Cluster>
      </Stack>
    </li>
  );
}
