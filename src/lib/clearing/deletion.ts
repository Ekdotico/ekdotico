// The deletion of the documents of a clearing (FR-AU-91, NFR-RE-15): "the permanent deletion of each of those
// documents is idempotent and is repeated on a timer in the application until every one is deleted". A document that
// is not shared is due at once and a shared one on its day; the route runs this as the confirmation returns, and the
// timer `clearing-deletion` of src/lib/timers.ts each hour and at start.
//
// ONE FUNCTION DELETES, the one that the retention uses (`deletePermanently` of src/lib/documents/deletion.ts):
// Istorico first where it reports the erasure capability, then the images in storage, then the row with the
// entry `document_deleted_permanently` in the transaction that removes it. This module says WHICH documents, and
// what a clearing adds on the two sides of the claim:
//
//  - on claiming, the document is marked deleted and the collaboration servers are told, which "ends every
//    collaborator's access" and "closes every connection (FR-ED-40 (c))" before the images go;
//  - in the transaction that deletes the row: the pending invitations are revoked and their notifications go, a
//    pending offer of ownership is withdrawn, the notices of the period go, and each person who held a role is
//    told by one notification that names the title, which is kept in it for 30 days and nowhere else.
//
// THE CLAIM is the document's `deletionClaimedAt` (two instances delete a document once), and is made only for a
// document the clearing owes: its Owner is still the account, its day is one of the clearing's two, and the day
// has come. So a document whose ownership passed, one cancelled, one that came to the account after the
// confirmation, and one of another clearing are never claimed by this one, however the lists read.
import { publishCollabEvent } from '../collab/events.ts';
import { db } from '../db.ts';
import { deletePermanently, type DeletionBasis } from '../documents/deletion.ts';
import { endOffersOf } from '../documents/ownership.ts';
import { endInvitationsOf } from '../documents/sharing.ts';
import { faultOf } from '../fault.ts';
import { completeClearings } from './clearing.ts';
import { deleteClearingNoticesOf, tellDeleted } from './notices.ts';

export interface ClearingRun {
  /** Documents this call deleted. */
  deleted: number;
  /** Documents it had to leave for the next run (Istorico did not erase, or a step could not be done). */
  kept: number;
}

/**
 * Deletes every document of every open clearing that is due, each once whatever number of instances run this
 * together, and marks complete the clearings that owe nothing more. One document that cannot be deleted does not
 * hold the others back: it is one line, with the clearing's and the document's identifiers and the class of the
 * fault, and nothing else (NFR-SE-19: never a title), and the run goes on.
 *
 * `now` is when the run began, for the tests; each claim is marked with the time that has passed since.
 */
export async function carryOutClearings(now: Date = new Date()): Promise<ClearingRun> {
  const began = Date.now();
  const clearings = await db().documentClearing.findMany({
    where: { completedAt: null },
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
  });
  let deleted = 0;
  let kept = 0;
  for (const clearing of clearings) {
    const days = [clearing.requestedAt, clearing.deleteSharedAt].filter((day): day is Date => day !== null);
    const owed = clearing.documentIds.filter((id) => !clearing.cancelledDocumentIds.includes(id));
    const due = await db().document.findMany({
      where: { id: { in: owed }, ownerId: clearing.userId, clearingAt: { in: days, lte: now } },
      select: { id: true, ownerId: true, recording: true },
    });
    for (const document of due) {
      const basis = clearingBasis(clearing.userId, document.id, days, now);
      let fault = 'Istorico did not erase';
      let outcome: Awaited<ReturnType<typeof deletePermanently>> = 'kept';
      try {
        const claimedAt = new Date(now.getTime() + Date.now() - began);
        outcome = await deletePermanently(document, basis, claimedAt);
      } catch (error) {
        fault = faultOf(error);
      }
      if (outcome === 'deleted') deleted += 1;
      if (outcome === 'kept') {
        kept += 1;
        console.error(`clearing ${clearing.id}: document ${document.id} kept (${fault})`);
      }
    }
    try {
      await db().$transaction((tx) => completeClearings(tx, clearing.userId, new Date()));
    } catch (error) {
      console.error(`clearing ${clearing.id}: not completed (${faultOf(error)})`);
    }
  }
  return { deleted, kept };
}

/** The condition of the claim, and the two sides of it, for one document of a clearing of this account. */
function clearingBasis(userId: string, documentId: string, days: Date[], now: Date): DeletionBasis {
  return {
    claimWhere: { ownerId: userId, clearingAt: { in: days, lte: now } },
    // The access ends in the statement that claims the document (`authorise` finds no deleted document,
    // `lockDocument` finds none, so an offer cannot be accepted, nor anyone invited, nor a role changed, after
    // the claim): marked as the Owner's act, which it is. A document deleted before has its mark moved, which
    // costs it nothing, since it is deleted now.
    claimData: { deletedAt: now, deletedById: userId },
    onClaimed: async () => {
      await publishCollabEvent({ kind: 'document-deleted', documentId });
    },
    inTransaction: async (tx, title) => {
      await endInvitationsOf(tx, documentId, now);
      await endOffersOf(tx, documentId, now);
      await deleteClearingNoticesOf(tx, documentId);
      await tellDeleted(tx, { documentId, title, now });
    },
  };
}
