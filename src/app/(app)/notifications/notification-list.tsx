'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Cluster, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { send, type Fault } from '../../../components/send.ts';
import { TWO_FACTOR_OFFER_TEXT } from '../../../lib/auth/enrolment-offer-text.ts';
import styles from '../../pages.module.css';
import { InvitedBy, Sender } from '../invitations/invitation-view.tsx';
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
  // D202, Q49: the sender by name and by email address, and the title or the pseudonym that stands for it.
  | (Shown & {
      kind: 'document_invitation';
      inviterName: string;
      inviterEmail: string | null;
      role: string;
      invitationId: string;
      title: string | null;
      pseudonym: string | null;
    })
  // FR-ED-42, FR-ED-48: the one reminder, 3 days before the invitation expires; it names the sender by name and address and no title (S18-4).
  | (Shown & {
      kind: 'document_invitation_reminder';
      inviterName: string;
      inviterEmail: string | null;
      role: string;
      invitationId: string;
      /** ISO 8601, UTC; null once the invitation was accepted (S18-2). */
      expiresAt: string | null;
    })
  // FR-ED-42, S15-2: the person's role on a document was changed; they hold it still.
  | (Shown & { kind: 'role_changed'; documentId: string; title: string; role: string })
  // FR-ED-42, S15-2: the person was removed. It names no document and links to nothing (register row PR-5).
  | (Shown & { kind: 'removed' })
  // NFR-SE-17 (e), D302: after a forced re-enrolment, an account that had two-factor authentication is offered it again.
  | (Shown & { kind: 'two_factor_offer' })
  // FR-ED-42, FR-ED-47: ownership of a document is offered to the person; the title is shown, behind sign-in (S17-2, D202).
  | (Shown & { kind: 'ownership_offer'; ownerName: string; title: string; offerId: string })
  // FR-ED-42, FR-AU-91: the document will be deleted by a clearing of its Owner's documents, on the day (ISO 8601, UTC).
  | (Shown & { kind: 'clearing_notice'; documentId: string; title: string; deleteOn: string })
  // FR-ED-42, FR-AU-91: the clearing was cancelled for the document, or its ownership passed: it will not be deleted.
  | (Shown & { kind: 'clearing_cancelled'; documentId: string; title: string })
  // FR-ED-42, FR-AU-91: the document was deleted; there is nothing to link to, and the title is kept for 30 days.
  | (Shown & { kind: 'clearing_deleted'; title: string })
  // FR-ED-42, S17-5: the Owner's offer ended without the Owner's own action; the Owner holds the document still.
  | (Shown & {
      kind: 'ownership_offer_ended';
      end: 'declined' | 'expired' | 'ended' | 'deleted';
      documentId: string;
      title: string;
      editorName: string;
      /** The document is in the trash: the link leads to the deleted documents, from which it can be restored. */
      inTrash: boolean;
    });

/** What a notification says, in the words approved with docs/plan/presence-row.md, section 5. */
function Statement({ notification }: { notification: NotificationItem }) {
  switch (notification.kind) {
    case 'document_invitation':
      return (
        <InvitedBy
          inviterName={notification.inviterName}
          inviterEmail={notification.inviterEmail}
          title={notification.title}
          pseudonym={notification.pseudonym}
          role={notification.role}
        />
      );
    case 'document_invitation_reminder':
      return (
        <>
          Reminder: <Sender name={notification.inviterName} email={notification.inviterEmail} /> invited you
          to a document as {notification.role}.{' '}
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
    case 'two_factor_offer':
      // NFR-SE-17 (e), D302: for the owner's approval.
      return <>{TWO_FACTOR_OFFER_TEXT}</>;
    case 'ownership_offer':
      return (
        <>
          {/* The name and the title are text, whatever they hold (NFR-SE-08). */}
          <bdi>{notification.ownerName}</bdi> offered you ownership of <bdi>{notification.title}</bdi>.
        </>
      );
    case 'ownership_offer_ended':
      return <OfferEnded notification={notification} />;
    // FR-AU-91, verbatim, the title and the day filled in. The day is in the browser's zone, so the sentence is the browser's.
    case 'clearing_notice':
      return (
        <InBrowser>
          <bdi>{notification.title}</bdi> will be deleted by its Owner on{' '}
          <LocalTime at={notification.deleteOn} />. You can take a draft export until then.
        </InBrowser>
      );
    case 'clearing_cancelled':
      return (
        <>
          <bdi>{notification.title}</bdi> will not be deleted.
        </>
      );
    case 'clearing_deleted':
      return (
        <>
          <bdi>{notification.title}</bdi> was deleted by its Owner. It cannot be restored.
        </>
      );
  }
}

/**
 * S17-5: what the Owner is told when an offer ends without the Owner's own action. The words are the
 * owner's to approve. An Editor whose account is deleted has no name left, and is "the Editor".
 */
function OfferEnded({
  notification,
}: {
  notification: Extract<NotificationItem, { kind: 'ownership_offer_ended' }>;
}) {
  const { end, title, editorName } = notification;
  const named = editorName === '' ? null : <bdi>{editorName}</bdi>;
  switch (end) {
    case 'declined':
      return (
        <>
          {named ?? 'The Editor'} declined your offer of ownership of <bdi>{title}</bdi>. You are still its
          Owner.
        </>
      );
    case 'expired':
      return (
        <>
          Your offer of ownership of <bdi>{title}</bdi> to {named ?? 'the Editor'} expired without an answer.
          You are still its Owner.
        </>
      );
    case 'ended':
      return (
        <>
          Your offer of ownership of <bdi>{title}</bdi> to {named ?? 'the Editor'} ended, because{' '}
          {named ?? 'the Editor'} no longer holds the Editor role on it. You are still its Owner.
        </>
      );
    case 'deleted':
      // D217: the deletion of the document ends the offer, and the Owner is told.
      return (
        <>
          Your offer of ownership of <bdi>{title}</bdi> to {named ?? 'the Editor'} ended, because you deleted
          the document.
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
          aria-describedby={`words-${notification.id}`}
          href={`/invitations/received/${encodeURIComponent(notification.invitationId)}`}
        >
          Open the invitation
        </Link>
      );
    case 'ownership_offer_ended':
      if (notification.inTrash) {
        return (
          <Link id={`open-${notification.id}`} aria-describedby={`words-${notification.id}`} href="/deleted">
            Open the deleted documents
          </Link>
        );
      }
    // falls through: a document that stands is opened as for a change of role
    case 'role_changed':
    case 'clearing_notice':
    case 'clearing_cancelled':
      return (
        <Link
          id={`open-${notification.id}`}
          aria-describedby={`words-${notification.id}`}
          href={`/documents/${encodeURIComponent(notification.documentId)}`}
        >
          Open the document
        </Link>
      );
    case 'ownership_offer':
      return (
        <Link
          id={`open-${notification.id}`}
          aria-describedby={`words-${notification.id}`}
          href={`/ownership-offers/${encodeURIComponent(notification.offerId)}`}
        >
          Open the offer
        </Link>
      );
    case 'two_factor_offer':
      return (
        <Link id={`open-${notification.id}`} aria-describedby={`words-${notification.id}`} href="/settings">
          Open the settings
        </Link>
      );
    case 'removed':
    case 'clearing_deleted':
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
                      pending={marking !== null}
                      aria-describedby={`words-${notification.id}`}
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
