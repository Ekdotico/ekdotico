// Clearing the documents of an account (FR-AU-91): the confirmation, the cancellation, the leaving of a
// document whose ownership passes, and what the deletion screen shows. The deletion itself, which the timer
// repeats until it is done, is in ./deletion.ts.
//
// Nothing here is of Next.js, and nothing here asks for a password: the route does that first
// (src/app/api/account/documents/clear/route.ts), "immediately before the action", and this runs only for a
// request whose password and code were right.
//
// THE ROWS DECIDE AND THE REQUEST NAMES. The request gives the identifiers the user confirmed; they are compared
// with the documents the account owns under the locks of their rows, and are never the documents deleted. The
// documents are those the rows say, written into `DocumentClearing` in the same transaction, and everything
// that follows reads that record and the rows, not the request.
import type { Prisma } from '../../generated/prisma/client.ts';
import type { Standing } from '../account/deletion.ts';
import { holdOwnableAccount } from '../account/in-deletion.ts';
import type { Spend } from '../account/prompt.ts';
import { publishCollabEvent } from '../collab/events.ts';
import { db } from '../db.ts';
import { notificationsOf } from '../documents/sharing.ts';
import { settings } from '../settings.ts';
import { replaceWithCancelled, tellClearing } from './notices.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The most documents one confirmation names (docs/plan/slice-23.md, S23-7). */
export const CLEAR_MOST_DOCUMENTS = 6000;

/** The two scopes of a clearing (FR-AU-91): every document the account owns, or the deleted ones alone. */
export type Scope = 'all' | 'deleted';

/** A document's identifier in canonical lower-case text (FR-ED-35), the only form that is compared. */
export const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Tx = Prisma.TransactionClient;

/** Whether two lists name the same documents, each once. */
function sameDocuments(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return (
    left.size === a.length &&
    right.size === b.length &&
    left.size === right.size &&
    [...left].every((id) => right.has(id))
  );
}

/** What the confirmation names (FR-AU-91): the number of documents, how many are shared, and with how many people in all. */
export interface Counted {
  documentIds: string[];
  documents: number;
  shared: number;
  people: number;
}

/**
 * The documents the account owns that a clearing of this scope would delete: those that are not in a clearing
 * already (a document in a period keeps its day, and "a further clearing ... covers only the other documents
 * the account then owns"). Read without a lock, for the screen; the confirmation reads them again under one.
 */
export async function countScope(userId: string, scope: Scope): Promise<Counted> {
  const owned = await db().document.findMany({
    where: {
      ownerId: userId,
      clearingAt: null,
      ...(scope === 'deleted' ? { deletedAt: { not: null } } : {}),
    },
    select: { id: true, collaborators: { select: { userId: true } } },
    orderBy: { id: 'asc' },
  });
  const people = new Set(owned.flatMap(({ collaborators }) => collaborators.map(({ userId: each }) => each)));
  return {
    documentIds: owned.map(({ id }) => id),
    documents: owned.length,
    shared: owned.filter(({ collaborators }) => collaborators.length > 0).length,
    people: people.size,
  };
}

export type ConfirmResult =
  | {
      outcome: 'confirmed';
      clearingId: string;
      documentIds: string[];
      /** Those of them deleted at once, and those that wait for their day. */
      sharedIds: string[];
      deleteOn: Date | null;
    }
  /** The session ended since the request was authorised (FR-AU-84): nothing was recorded. */
  | { outcome: 'ended' }
  /** The password was set since it was verified (FR-AU-85, FR-AU-86): nothing was recorded. */
  | { outcome: 'outrun' }
  /** There is no such account, or its deletion is confirmed: it cannot clear. */
  | { outcome: 'not_found' }
  /** FR-AU-91: the identifiers are not exactly the documents of the scope now. Nothing is recorded. */
  | { outcome: 'changed' }
  /** There is no document to clear in this scope. Nothing is recorded. */
  | { outcome: 'nothing' }
  /** The recovery code that was entered was spent by another request: nothing is recorded. */
  | { outcome: 'code_gone' };

/** Thrown inside the transaction of the confirmation, to undo it. */
class CodeGone extends Error {
  name = 'CodeGone';
}

/**
 * FR-AU-91: "On confirmation Ekdotico records the clearing with the identifiers of the documents the confirmation
 * counted, and for each of those documents, and for no other, carries out the deletion".
 *
 * In one transaction, in this order:
 *
 *  1. the password and the session asked again (`standing`), as every change under a prompt asks them, first, so
 *     that the credentials, the session and the rows below are taken in the order a deletion takes them;
 *  2. the documents of the scope locked `FOR UPDATE`, in the order of their identifiers: two confirmations, or
 *     a confirmation and the acceptance of an offer, cannot wait for each other in a circle. The statement does
 *     not filter on `deletedAt`: a document that was deleted before is in the scope, and `lockDocument` would
 *     not find it. Every change to who holds a role takes the same row (`lockDocument`), so a collaborator
 *     added a moment ago is counted, and one added a moment later finds the invitation revoked;
 *  3. the account's row `FOR SHARE`, and its deletion asked for (`holdOwnableAccount`): of a clearing and the
 *     confirmation of the account's deletion, one waits for the other. An account in deletion clears nothing;
 *  4. the identifiers compared as sets, and the collaborators read: a document is shared where at least one
 *     other user holds a role on it, a pending invitation alone does not make it so, and a document deleted
 *     before is read the same way, on the rows a deletion leaves (so deleting first is no way round the notice);
 *  5. the record, the column `clearingAt` (the day for a shared document, this moment for the rest: S23-2), the
 *     pending invitations of every document revoked with their notifications (FR-ED-37), and one notification
 *     for each person who holds a role on a shared document.
 *
 * The events are published once it has committed, and never before; a notice that is lost is made good by the
 * re-check of the collaboration servers within 60 seconds (FR-ED-41).
 */
export async function confirmClearing(
  userId: string,
  { scope, documentIds, spend }: { scope: Scope; documentIds: readonly string[]; spend?: Spend | null },
  standing: Standing,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  let result: ConfirmResult;
  try {
    result = await db().$transaction(async (tx): Promise<ConfirmResult> => {
      const stands = await standing(tx);
      if (stands !== 'held') return { outcome: stands };

      const rows =
        scope === 'all'
          ? await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "ekdotico"."Document"
            WHERE "ownerId" = ${userId} AND "clearingAt" IS NULL
            ORDER BY "id" FOR UPDATE`
          : await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "ekdotico"."Document"
            WHERE "ownerId" = ${userId} AND "clearingAt" IS NULL AND "deletedAt" IS NOT NULL
            ORDER BY "id" FOR UPDATE`;
      if (!(await holdOwnableAccount(tx, userId))) return { outcome: 'not_found' };

      const ids = rows.map(({ id }) => id);
      if (!sameDocuments(ids, documentIds)) return { outcome: 'changed' };
      if (ids.length === 0) return { outcome: 'nothing' };

      const holders = await tx.documentCollaborator.findMany({
        where: { documentId: { in: ids } },
        select: { documentId: true },
      });
      const sharedSet = new Set(holders.map(({ documentId }) => documentId));
      const shared = ids.filter((id) => sharedSet.has(id));
      const unshared = ids.filter((id) => !sharedSet.has(id));
      const deleteSharedAt =
        shared.length > 0 ? new Date(now.getTime() + settings().clearingNoticeDays * DAY_MS) : null;

      const { id: clearingId } = await tx.documentClearing.create({
        data: {
          userId,
          scope: scope === 'all' ? 'ALL' : 'DELETED_ONLY',
          documentIds: ids,
          sharedDocumentIds: shared,
          requestedAt: now,
          deleteSharedAt,
        },
        select: { id: true },
      });
      // The day for a shared document, and for the rest the moment of the confirmation (S23-2): from here neither
      // is edited, shared, renamed, deleted by hand or restored, and the rest are due.
      if (deleteSharedAt) {
        await tx.document.updateMany({ where: { id: { in: shared } }, data: { clearingAt: deleteSharedAt } });
      }
      if (unshared.length > 0) {
        await tx.document.updateMany({ where: { id: { in: unshared } }, data: { clearingAt: now } });
      }

      // FR-AU-91: "its pending invitations are revoked when the clearing is confirmed (FR-ED-37), so that no one
      // joins a document that is about to be deleted"; FR-ED-42: their notifications go with them.
      const revoked = await tx.documentInvitation.updateManyAndReturn({
        where: { documentId: { in: ids }, state: 'PENDING' },
        data: { state: 'REVOKED', respondedAt: now },
        select: { id: true },
      });
      if (revoked.length > 0) {
        await tx.notification.deleteMany({ where: notificationsOf(revoked.map(({ id }) => id)) });
      }

      await tellClearing(tx, { clearingId, documentIds: shared, now });
      // The recovery code that was entered is spent last, and only where the clearing is recorded: a refusal above
      // leaves it its owner's, and a code that another request spent first rolls this back (review item 1).
      if (spend && !(await spend(tx))) throw new CodeGone();
      return {
        outcome: 'confirmed',
        clearingId,
        documentIds: ids,
        sharedIds: shared,
        deleteOn: deleteSharedAt,
      };
    });
  } catch (error) {
    // The recovery code was spent by another request first: everything this transaction wrote is undone.
    if (error instanceof CodeGone) return { outcome: 'code_gone' };
    throw error;
  }
  if (result.outcome === 'confirmed') await announce(result.documentIds);
  return result;
}

/** FR-ED-40 (i): the collaboration servers look at each document's connections (within 5 seconds of the commit). */
export async function announce(documentIds: readonly string[]): Promise<void> {
  await Promise.all(
    documentIds.map((documentId) => publishCollabEvent({ kind: 'clearing-changed', documentId })),
  );
}

/**
 * Takes one document out of its clearing, in the transaction of the cancellation or of the acceptance of an offer
 * that makes it another account's, with its row already held: the column is cleared, the clearing that holds it
 * lists it as out ("it is no longer part of the clearing"; S23-4 for a document whose ownership passed), and the
 * notice of the period is replaced by "will not be deleted" for the people who hold a role on it NOW.
 * False where the document was in no clearing.
 */
export async function takeOutOfClearing(
  tx: Tx,
  { documentId, ownerId, now }: { documentId: string; ownerId: string; now: Date },
): Promise<boolean> {
  const { count } = await tx.document.updateMany({
    where: { id: documentId, clearingAt: { not: null } },
    data: { clearingAt: null },
  });
  if (count !== 1) return false;
  // The clearing of the account that owned it, the one that holds the document and has not let it go.
  const holding = (
    await tx.documentClearing.findMany({
      where: { userId: ownerId, completedAt: null, documentIds: { has: documentId } },
      select: { id: true, cancelledDocumentIds: true },
    })
  ).filter(({ cancelledDocumentIds }) => !cancelledDocumentIds.includes(documentId));
  for (const { id } of holding) {
    await tx.documentClearing.update({ where: { id }, data: { cancelledDocumentIds: { push: documentId } } });
  }
  await replaceWithCancelled(tx, { documentId, now });
  await completeClearings(tx, ownerId, now);
  return true;
}

export type CancelResult =
  | { outcome: 'cancelled'; documentIds: string[] }
  /** FR-AU-91: no document of the account is waiting for its day (or not this one). */
  | { outcome: 'none' }
  /** The day has come, or a timer holds the document for its deletion: it can no longer be cancelled. */
  | { outcome: 'too_late' };

/**
 * FR-AU-91: "The Owner may cancel the clearing during the period, for one shared document or for all of them".
 * `documentId` is one document, or null for every document of the account whose period runs. In one transaction,
 * under the rows' locks: only a document the account owns NOW, whose day is ahead and which no timer has claimed.
 * The prompt is the session's row alone (docs/plan/slice-23.md, S23-5).
 */
export async function cancelClearing(
  userId: string,
  documentId: string | null,
  now: Date = new Date(),
): Promise<CancelResult> {
  // An identifier that is not a document's names nothing, and is never handed to the database as one.
  if (documentId !== null && !DOCUMENT_ID.test(documentId)) return { outcome: 'none' };
  const result = await db().$transaction(async (tx): Promise<CancelResult> => {
    const rows =
      documentId === null
        ? await tx.$queryRaw<{ id: string; clearingAt: Date; deletionClaimedAt: Date | null }[]>`
            SELECT "id", "clearingAt", "deletionClaimedAt" FROM "ekdotico"."Document"
            WHERE "ownerId" = ${userId} AND "clearingAt" IS NOT NULL
            ORDER BY "id" FOR UPDATE`
        : await tx.$queryRaw<{ id: string; clearingAt: Date; deletionClaimedAt: Date | null }[]>`
            SELECT "id", "clearingAt", "deletionClaimedAt" FROM "ekdotico"."Document"
            WHERE "id" = ${documentId}::uuid AND "ownerId" = ${userId} AND "clearingAt" IS NOT NULL
            FOR UPDATE`;
    const open = rows.filter((row) => row.clearingAt > now && row.deletionClaimedAt === null);
    if (open.length === 0) return rows.length > 0 ? { outcome: 'too_late' } : { outcome: 'none' };
    const out: string[] = [];
    for (const { id } of open) {
      if (await takeOutOfClearing(tx, { documentId: id, ownerId: userId, now })) out.push(id);
    }
    return { outcome: 'cancelled', documentIds: out };
  });
  if (result.outcome === 'cancelled') await announce(result.documentIds);
  return result;
}

/**
 * Writes `completedAt` on the clearings of this account that owe nothing more: every document they confirmed is
 * deleted, was taken out, or is under another day. Idempotent; the timer calls it too.
 */
export async function completeClearings(tx: Tx, userId: string, now: Date): Promise<void> {
  const open = await tx.documentClearing.findMany({ where: { userId, completedAt: null } });
  for (const clearing of open) {
    const days = [clearing.requestedAt, clearing.deleteSharedAt].filter((day): day is Date => day !== null);
    const owed = clearing.documentIds.filter((id) => !clearing.cancelledDocumentIds.includes(id));
    const remaining =
      owed.length === 0
        ? 0
        : await tx.document.count({ where: { id: { in: owed }, ownerId: userId, clearingAt: { in: days } } });
    if (remaining === 0) {
      await tx.documentClearing.updateMany({
        where: { id: clearing.id, completedAt: null },
        data: { completedAt: now < clearing.requestedAt ? clearing.requestedAt : now },
      });
    }
  }
}

/** A document waiting for its day, as the deletion screen lists it. */
export interface WaitingDocument {
  id: string;
  title: string;
  deleteOn: Date;
}

/** What the deletion screen shows of a clearing (FR-AU-58, FR-AU-91). */
export interface ClearingScreen {
  all: Counted;
  deleted: Counted;
  /** Documents whose period runs, and may be cancelled. */
  waiting: WaitingDocument[];
  /** Documents whose day has come and which the timer has not yet deleted: shown, and not cancellable. */
  deleting: number;
}

export async function clearingScreen(userId: string, now: Date = new Date()): Promise<ClearingScreen> {
  const [all, deleted, inClearing] = await Promise.all([
    countScope(userId, 'all'),
    countScope(userId, 'deleted'),
    db().document.findMany({
      where: { ownerId: userId, clearingAt: { not: null } },
      select: { id: true, title: true, clearingAt: true, deletionClaimedAt: true },
      orderBy: [{ clearingAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  const waiting = inClearing
    .filter(({ clearingAt, deletionClaimedAt }) => clearingAt! > now && deletionClaimedAt === null)
    .map(({ id, title, clearingAt }) => ({ id, title, deleteOn: clearingAt! }));
  return { all, deleted, waiting, deleting: inClearing.length - waiting.length };
}
