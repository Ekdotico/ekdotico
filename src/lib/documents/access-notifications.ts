// The notifications of a change of role and of a removal (FR-ED-42; register
// row S15-2, decided by the owner on 19 October 2026; docs/plan/presence-row.md,
// section 2.5). Two kinds in the table that slice 13 wrote for invitations
// (`Notification`: `kind` is text, `payload` is JSON), kept in their own module
// so that the kinds added beside them (an offer of ownership) change the list
// in one place only (`listNotifications` of ./sharing.ts).
//
// WRITTEN IN THE TRANSACTION OF THE CHANGE (`collaborators.ts`), so that a
// change never stands without its notification and the reverse. Never to the
// person who acted: both writers refuse an actor as the recipient, whatever
// calls them. A leave is the person's own act and writes none.
//
// The payload holds identifiers and the role and never a title or a name
// (FR-ED-42: "without quoting document content"). The title of a role change is
// read when the list is read.
import type { Prisma } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';
import { OFFER_ENDED_NOTIFICATION } from './ownership-notifications.ts';
import { COLLABORATOR_ROLE, type DocumentRole } from './permissions.ts';

export const ROLE_CHANGED_NOTIFICATION = 'role_changed';
export const REMOVED_NOTIFICATION = 'removed';

/** How long the notification of a removal stays in the list (register row PR-8): it has no subject to end it. */
export const REMOVED_STAYS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The role a change of role gives, as the payload keeps it: the roles an Owner may give (FR-ED-38; the Reviewer is not offered). */
export type GivenRole = 'editor' | 'viewer';

/**
 * A change of role: the person whose role it is is told. Nothing is written for
 * the actor, who cannot be the recipient of a change they made to their own role
 * (it is refused: FR-ED-44 (b)), and the guard is here too.
 */
export async function notifyRoleChanged(
  tx: Prisma.TransactionClient,
  {
    recipientId,
    actorId,
    documentId,
    role,
  }: { recipientId: string; actorId: string; documentId: string; role: GivenRole },
): Promise<void> {
  if (recipientId === actorId) return;
  // A new role takes the place of the one before it: the earlier notification is no longer true.
  await endRoleChanges(tx, recipientId, documentId);
  await tx.notification.create({
    data: { recipientId, kind: ROLE_CHANGED_NOTIFICATION, payload: { documentId, role } },
  });
}

/**
 * Takes away the notifications of changes of this person's role on this
 * document (register row PR-10): their subject, the role, ends when the role is
 * changed again, and when the person is removed or leaves; and a person who is
 * invited again holds a new role, not the one an old notification names. Called
 * in the transaction of each of those, so that no change stands beside a
 * notification that has stopped being true.
 */
export async function endRoleChanges(
  tx: Prisma.TransactionClient,
  userId: string,
  documentId: string,
): Promise<void> {
  await tx.notification.deleteMany({
    where: {
      recipientId: userId,
      kind: ROLE_CHANGED_NOTIFICATION,
      payload: { path: ['documentId'], equals: documentId },
    },
  });
}

/**
 * The notifications of removals that are older than they stay (register row
 * PR-8), by the timer of src/lib/timers.ts (NFR-RE-15). The list does not show
 * them from that moment either, so the timer only keeps the table from
 * growing. Idempotent; answers with the number of rows it deleted.
 */
export async function deleteExpiredRemovedNotifications(now: Date = new Date()): Promise<number> {
  const { count } = await db().notification.deleteMany({
    where: {
      kind: REMOVED_NOTIFICATION,
      createdAt: { lte: new Date(now.getTime() - REMOVED_STAYS_DAYS * DAY_MS) },
    },
  });
  return count;
}

/** A removal: the person removed is told. Nothing for the actor, and none for a leave (which is the person's own act). */
export async function notifyRemoved(
  tx: Prisma.TransactionClient,
  { recipientId, actorId, documentId }: { recipientId: string; actorId: string; documentId: string },
): Promise<void> {
  if (recipientId === actorId) return;
  // The role is gone, and with it the notifications of its changes.
  await endRoleChanges(tx, recipientId, documentId);
  await tx.notification.create({
    data: { recipientId, kind: REMOVED_NOTIFICATION, payload: { documentId } },
  });
}

/** The permanent deletion of a document takes these notifications with it, and the Owner's notices of ended offers (S17-5). */
export async function deleteAccessNotificationsOf(
  tx: Prisma.TransactionClient,
  documentId: string,
): Promise<void> {
  await tx.notification.deleteMany({
    where: {
      kind: { in: [ROLE_CHANGED_NOTIFICATION, REMOVED_NOTIFICATION, OFFER_ENDED_NOTIFICATION] },
      payload: { path: ['documentId'], equals: documentId },
    },
  });
}

/** One notification of these kinds, as the list shows it. */
export type AccessNotificationView = {
  id: string;
  createdAt: Date;
  read: boolean;
} & (
  | {
      kind: typeof ROLE_CHANGED_NOTIFICATION;
      documentId: string;
      /** The document's title as it stands when the list is read; the person holds a role on it. */
      title: string;
      role: DocumentRole;
    }
  | { kind: typeof REMOVED_NOTIFICATION }
);

const GIVEN_ROLES: readonly string[] = ['editor', 'viewer'];

/**
 * The account's notifications of a change of role and of a removal whose
 * subject still stands, newest first.
 *
 * - A change of role stands while the account still holds a role on a document
 *   that is not deleted (the subject is the role): it is left out once the
 *   person is removed or leaves, and when the document is deleted.
 * - A removal has no subject to link to and stays for `REMOVED_STAYS_DAYS`.
 */
export async function listAccessNotifications(
  userId: string,
  now: Date = new Date(),
): Promise<AccessNotificationView[]> {
  const rows = await db().notification.findMany({
    where: {
      recipientId: userId,
      OR: [
        { kind: ROLE_CHANGED_NOTIFICATION },
        {
          kind: REMOVED_NOTIFICATION,
          createdAt: { gt: new Date(now.getTime() - REMOVED_STAYS_DAYS * DAY_MS) },
        },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const documentIds = rows.flatMap((row) => {
    const id = (row.payload as { documentId?: unknown } | null)?.documentId;
    return row.kind === ROLE_CHANGED_NOTIFICATION && typeof id === 'string' ? [id] : [];
  });
  const documents = new Map(
    (
      await db().document.findMany({
        where: {
          id: { in: documentIds },
          deletedAt: null,
          OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }],
        },
        select: { id: true, title: true },
      })
    ).map((document) => [document.id, document.title]),
  );
  return rows.flatMap((row): AccessNotificationView[] => {
    const shown = { id: row.id, createdAt: row.createdAt, read: row.readAt !== null };
    if (row.kind === REMOVED_NOTIFICATION) return [{ ...shown, kind: REMOVED_NOTIFICATION }];
    const { documentId, role } = row.payload as { documentId?: unknown; role?: unknown };
    const title = typeof documentId === 'string' ? documents.get(documentId) : undefined;
    if (title === undefined || typeof role !== 'string' || !GIVEN_ROLES.includes(role)) return [];
    return [
      {
        ...shown,
        kind: ROLE_CHANGED_NOTIFICATION,
        documentId: documentId as string,
        title,
        role: COLLABORATOR_ROLE[role.toUpperCase() as 'EDITOR' | 'VIEWER'],
      },
    ];
  });
}
