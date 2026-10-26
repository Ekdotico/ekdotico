// The three notifications of a clearing (FR-ED-42, FR-AU-91), kinds of the one list that slice 13 made
// (`Notification`: `kind` is text, `payload` is JSON):
//
//   clearing_notice     "[Title] will be deleted by its Owner on [date]. You can take a draft export until then."
//                       one for each person who holds a role on a shared document, written when the clearing is
//                       confirmed; it stays until the document is deleted or the clearing is cancelled for it, or
//                       the document passes to another Owner, and is then replaced by
//   clearing_cancelled  "[Title] will not be deleted."
//   clearing_deleted    "[Title] was deleted by its Owner. It cannot be restored." written in the transaction that
//                       deletes the row, with the title kept in the notification for that purpose alone (FR-AU-91),
//                       no subject to link to, and 30 days in the list.
//
// WRITTEN IN THE TRANSACTION OF THE CHANGE, so that a change never stands without its notice and the reverse. The
// payload holds identifiers, and the title only of the last (FR-ED-42: "without quoting document content"). The
// title of the other two is read when the list is read, as the title of a change of role is.
//
// Nothing is written for an account whose deletion is confirmed: its notifications are "retained against its
// tombstone and are shown to no one" (FR-AU-58) and it cannot read this one.
import type { Prisma } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';

export const CLEARING_NOTICE = 'clearing_notice';
export const CLEARING_CANCELLED = 'clearing_cancelled';
export const CLEARING_DELETED = 'clearing_deleted';
export const CLEARING_KINDS = [CLEARING_NOTICE, CLEARING_CANCELLED, CLEARING_DELETED];

/** FR-AU-91: "stays in the list for 30 days (an initial value)". */
export const CLEARING_DELETED_STAYS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The people who hold a role on the document and can be told: not an account whose deletion is confirmed. */
async function collaboratorsToTell(tx: Prisma.TransactionClient, documentIds: string[]) {
  return tx.documentCollaborator.findMany({
    where: { documentId: { in: documentIds }, user: { deletion: null } },
    select: { documentId: true, userId: true },
  });
}

/** The confirmation: one notice for each person and each shared document. Returns how many were written. */
export async function tellClearing(
  tx: Prisma.TransactionClient,
  { clearingId, documentIds, now }: { clearingId: string; documentIds: string[]; now: Date },
): Promise<number> {
  if (documentIds.length === 0) return 0;
  const people = await collaboratorsToTell(tx, documentIds);
  const { count } = await tx.notification.createMany({
    data: people.map(({ documentId, userId }) => ({
      recipientId: userId,
      kind: CLEARING_NOTICE,
      payload: { documentId, clearingId },
      createdAt: now,
    })),
  });
  return count;
}

/** Takes away the notices of a document that are about its period (the notice and the cancellation). */
export async function deleteClearingNoticesOf(tx: Prisma.TransactionClient, documentId: string): Promise<void> {
  await tx.notification.deleteMany({
    where: {
      kind: { in: [CLEARING_NOTICE, CLEARING_CANCELLED] },
      payload: { path: ['documentId'], equals: documentId },
    },
  });
}

/**
 * A clearing cancelled for the document, or its ownership passed: "it is replaced by a notice that the document
 * will not be deleted" (FR-ED-42). The notice of the period goes, and an earlier "will not be deleted" with it,
 * so that a document that is cleared, cancelled and cleared again is not announced twice.
 */
export async function replaceWithCancelled(
  tx: Prisma.TransactionClient,
  { documentId, now }: { documentId: string; now: Date },
): Promise<void> {
  await deleteClearingNoticesOf(tx, documentId);
  const people = await collaboratorsToTell(tx, [documentId]);
  await tx.notification.createMany({
    data: people.map(({ userId }) => ({
      recipientId: userId,
      kind: CLEARING_CANCELLED,
      payload: { documentId },
      createdAt: now,
    })),
  });
}

/**
 * The end of the period: "each person who then held a role on it is told by one notification, with no further
 * email". The title is the one place a title is stored for a purpose of its own, and is deleted with the
 * notification after 30 days (src/lib/documents/access-notifications.ts).
 */
export async function tellDeleted(
  tx: Prisma.TransactionClient,
  { documentId, title, now }: { documentId: string; title: string; now: Date },
): Promise<void> {
  const people = await collaboratorsToTell(tx, [documentId]);
  await tx.notification.createMany({
    data: people.map(({ userId }) => ({
      recipientId: userId,
      kind: CLEARING_DELETED,
      payload: { title },
      createdAt: now,
    })),
  });
}

/** One notification of these kinds, as the list shows it. */
export type ClearingNotificationView = {
  id: string;
  createdAt: Date;
  read: boolean;
} & (
  | { kind: typeof CLEARING_NOTICE; documentId: string; title: string; deleteOn: Date }
  | { kind: typeof CLEARING_CANCELLED; documentId: string; title: string }
  | { kind: typeof CLEARING_DELETED; title: string }
);

const payloadText = (payload: unknown, key: string): string | undefined => {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * The account's notifications of a clearing whose subject still stands, newest first.
 *
 * - The notice of the period stands while the person holds a role on the document and the document is in a
 *   clearing: the document may be deleted already (one deleted before the clearing), and its title is read all
 *   the same, since the notice names it and FR-AU-91 requires the person to be told.
 * - The notice of a cancellation stands while the person holds a role on a document that is not deleted.
 * - The notice of a deletion has no subject and stays for 30 days.
 */
export async function listClearingNotifications(
  userId: string,
  now: Date = new Date(),
): Promise<ClearingNotificationView[]> {
  const rows = await db().notification.findMany({
    where: {
      recipientId: userId,
      OR: [
        { kind: { in: [CLEARING_NOTICE, CLEARING_CANCELLED] } },
        {
          kind: CLEARING_DELETED,
          createdAt: { gt: new Date(now.getTime() - CLEARING_DELETED_STAYS_DAYS * DAY_MS) },
        },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const ids = rows.flatMap((row) => {
    const id = payloadText(row.payload, 'documentId');
    return row.kind !== CLEARING_DELETED && id ? [id] : [];
  });
  const documents = new Map(
    (
      await db().document.findMany({
        // Only a document the account holds a role on: a notice outlives a removal otherwise.
        where: { id: { in: ids }, OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }] },
        select: { id: true, title: true, clearingAt: true, deletedAt: true },
      })
    ).map((document) => [document.id, document]),
  );
  return rows.flatMap((row): ClearingNotificationView[] => {
    const shown = { id: row.id, createdAt: row.createdAt, read: row.readAt !== null };
    if (row.kind === CLEARING_DELETED) {
      const title = payloadText(row.payload, 'title');
      return title === undefined ? [] : [{ ...shown, kind: CLEARING_DELETED, title }];
    }
    const documentId = payloadText(row.payload, 'documentId');
    const document = documentId ? documents.get(documentId) : undefined;
    if (!documentId || !document) return [];
    if (row.kind === CLEARING_NOTICE) {
      return document.clearingAt
        ? [{ ...shown, kind: CLEARING_NOTICE, documentId, title: document.title, deleteOn: document.clearingAt }]
        : [];
    }
    return document.deletedAt === null && document.clearingAt === null
      ? [{ ...shown, kind: CLEARING_CANCELLED, documentId, title: document.title }]
      : [];
  });
}
