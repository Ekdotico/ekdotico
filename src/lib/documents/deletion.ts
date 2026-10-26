// Deleting a document, the list of deleted documents, restoring one, and the
// permanent deletion when the retention ends (FR-ED-36; NFR-RE-15). Whether a
// caller may do any of it is not decided here: the routes ask ./access.ts
// first, and the timer acts for no one. Nothing here is of Next.js.
//
// NOT HERE, each for the slice that builds what it needs:
// - "revokes its pending invitations (FR-ED-37)": in the transaction of
//   `deleteDocument`, with sharing. The collaborators need nothing: their rows
//   and roles stay as they are, a deleted document is `not_found` to everyone
//   in `authorise`, and so a restore returns them "as they were at deletion".
// - The refusal of FR-ED-36 for an export-locked document (no route applies a
//   lock in α 0.1.0, and the column arrives with export). The 409 of a document
//   in the notice period of a clearing, and of a restore of one a clearing treats
//   as shared, is here (FR-AU-91; slice 23): `clearingAt: null` in the writes.
// - The images of a document, deleted from storage with it (NFR-SE-18): one
//   call, marked in `deletePermanently`.
import type { Prisma } from '../../generated/prisma/client.ts';
import { publishCollabEvent } from '../collab/events.ts';
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';
import { deleteImagesOfDocumentNow } from '../images/deletion.ts';
import { istorico } from '../istorico/index.ts';
import { securityLogIn } from '../security-log.ts';
import { settings } from '../settings.ts';
import type { DocumentRow } from './access.ts';
import { deleteAccessNotificationsOf } from './access-notifications.ts';
import { summary, type DocumentSummary } from './documents.ts';
import { endOffersOf } from './ownership.ts';
import { endInvitationsOf } from './sharing.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
// A claim of a permanent deletion that is this old was not finished: its
// process stopped between the claim and the deletion. The timer runs each
// hour, and each step of a deletion is bounded in seconds (src/lib/db.ts), so
// nothing that is still running holds a claim this long.
export const CLAIM_STALE_MS = 60 * 60 * 1000;

/** A deleted document, as its Owner's list shows it (API design, "Documents"). */
export interface DeletedDocumentSummary extends DocumentSummary {
  deletedAt: Date;
  /** FR-ED-36: when the retention ends. The document is deleted permanently by the first run of the timer after it. */
  permanentDeletionAt: Date;
  /** FR-AU-91: the day a clearing deletes it, for a document that cannot be restored until the clearing is cancelled for it; else null. */
  clearingAt: Date | null;
}

/**
 * FR-ED-36: a document deleted before this moment has had its retention ("30
 * days (an initial value)").
 *
 * The moment is this instance's: its own clock, and its own setting, against
 * a `deletedAt` that the clock of the instance that deleted the document
 * wrote. So the instances must agree on the time and on the setting, and a
 * setting that is lowered applies to the documents already deleted
 * (docs/operations/deployment.md). The comparison is not moved to the
 * database's clock, which would need SQL written by hand (NFR-SE-06, A05).
 */
export function retainedSince(now: Date): Date {
  return new Date(now.getTime() - settings().deletedDocumentRetentionDays * DAY_MS);
}

/**
 * Whether a document is deleted, within its retention, and not claimed for
 * its permanent deletion: what its Owner still sees and may restore.
 */
export function isRetained(
  document: Pick<DocumentRow, 'deletedAt' | 'deletionClaimedAt'>,
  now: Date,
): boolean {
  return (
    document.deletedAt !== null && document.deletedAt > retainedSince(now) && !document.deletionClaimedAt
  );
}

/**
 * FR-ED-36: deletes a document its Owner was authorised to delete. False
 * where it was deleted already, by a request that ran beside this one.
 *
 * The row stays, with its state, its permission set and (when there are any)
 * its collaborators: it is marked, and every reader leaves a marked document
 * out. NFR-SE-19: the entry of the deletion is written in the same
 * transaction, so neither stands without the other.
 *
 * A deletion is not an edit: `updatedAt` is not named, and so stays what the
 * last edit made it, one that committed beside this request included
 * (src/lib/documents/documents.ts, `renameDocument`).
 *
 * FR-ED-40 (c): once the deletion is committed, and only then, every
 * collaboration server instance is told to close the connections to the
 * document. A notice that could not be published fails nothing here: the
 * deletion stands, and `publishCollabEvent` has said so on stderr.
 */
export async function deleteDocument(
  document: Pick<DocumentRow, 'id'>,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const deleted = await db().$transaction(async (transaction) => {
    // The Owner is a condition of the write: a deletion authorised just before a transfer committed
    // does not delete the document in the name of someone who is no longer its Owner (FR-ED-47).
    const { count } = await transaction.document.updateMany({
      // FR-AU-91: not a document in a clearing: its deletion by hand "is refused" for the period.
      where: { id: document.id, deletedAt: null, ownerId: userId, clearingAt: null },
      data: { deletedAt: now, deletedById: userId },
    });
    if (count !== 1) return false;
    // FR-ED-37: "deleting the document revokes its pending invitations"; FR-ED-42: their notifications go.
    await endInvitationsOf(transaction, document.id, now);
    // FR-ED-47: an offer is "withdrawn without anyone's action where … the document is deleted".
    await endOffersOf(transaction, document.id, now);
    await securityLogIn(transaction, { kind: 'document_deleted', userId, documentId: document.id });
    return true;
  });
  if (deleted) await publishCollabEvent({ kind: 'document-deleted', documentId: document.id });
  return deleted;
}

/**
 * The deleted documents of this account that are still within their
 * retention (FR-ED-36: "only the Owner can see it, in a list of deleted
 * documents"), the last deleted first. No other role is ever shown one, so
 * the list is by the Owner and joins nothing when sharing is built.
 */
export async function listDeletedDocuments(
  userId: string,
  now: Date = new Date(),
): Promise<DeletedDocumentSummary[]> {
  const documents = await db().document.findMany({
    where: { ownerId: userId, deletedAt: { gt: retainedSince(now) }, deletionClaimedAt: null },
    orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
  });
  const retentionMs = settings().deletedDocumentRetentionDays * DAY_MS;
  return documents.map((document) => ({
    ...summary(document),
    deletedAt: document.deletedAt!,
    permanentDeletionAt: new Date(document.deletedAt!.getTime() + retentionMs),
    clearingAt: document.clearingAt,
  }));
}

/**
 * FR-ED-36: restores a deleted document its Owner was authorised to restore
 * (`authoriseDeleted`), or null where it can no longer be: its retention
 * ended, or the timer claimed it, between the authorisation and this write.
 * The condition is in the write, so that a restore and a permanent deletion
 * of one document cannot both succeed.
 *
 * Nothing but the two marks is changed: the document returns with its title,
 * its state, its permission set, and its collaborators and their roles, "as
 * they were at deletion". NFR-SE-19 lists the deletion of a document and not
 * its restoring, so no entry is written. What is answered is the row the
 * write returned, and not the one read at the authorisation: the collaboration
 * server may have stored the document's last changes in between
 * (src/lib/collab/state.ts, `storeFinalState`).
 */
export async function restoreDocument(
  document: Pick<DocumentRow, 'id'>,
  now: Date = new Date(),
): Promise<DocumentSummary | null> {
  const [restored] = await db().document.updateManyAndReturn({
    // FR-AU-91: and not one in a clearing, which "cannot be restored" until the clearing is cancelled for it.
    where: {
      id: document.id,
      deletedAt: { gt: retainedSince(now) },
      deletionClaimedAt: null,
      clearingAt: null,
    },
    data: { deletedAt: null, deletedById: null },
  });
  return restored ? summary(restored) : null;
}

export type Due = Pick<DocumentRow, 'id' | 'ownerId' | 'recording'>;

/**
 * What distinguishes one permanent deletion from another: under which condition the row may be claimed, and
 * what is done on the two sides of the claim. The retention (FR-ED-36) and a clearing (FR-AU-91) delete a
 * document by the same steps, in the same order, in the same function; they differ in this alone.
 */
export interface DeletionBasis {
  /** The condition, besides the document's identifier and a free or stale claim, under which the claim is made. */
  claimWhere: Prisma.DocumentWhereInput;
  /** Written in the same statement as the claim, so that nothing falls between the two. */
  claimData?: Prisma.DocumentUpdateManyMutationInput;
  /** Once the row is claimed, before Istorico is asked. A clearing ends every collaborator's access here. */
  onClaimed?: (claimedAt: Date) => Promise<void>;
  /** In the transaction that deletes the row, before it does, with the title the row holds. */
  inTransaction?: (tx: Prisma.TransactionClient, title: string) => Promise<void>;
}

/** Thrown inside the transaction that deletes the row, where the claim it held is no longer the row's. */
class ClaimLost extends Error {
  name = 'ClaimLost';
}

/**
 * Deletes one document permanently, in the order FR-ED-36 gives: `deleted`
 * where this call deleted the row; `elsewhere` where it is another run's, or
 * no longer due; `kept` where Istorico did not erase, and the row stays for
 * the next run.
 *
 * The claim (NFR-RE-15; plan, C8) is one conditional write: of two instances
 * that reach a document together, the database lets one change the row, and
 * the other finds the condition no longer true and leaves the document alone.
 * The time written is also the mark of this claim: the row is deleted only
 * while it still holds it. A claim is released at once where Istorico did not
 * erase, and otherwise never: one that was not finished, because its process
 * stopped, is taken over by the first run that finds it an hour old
 * (`CLAIM_STALE_MS`), which begins again from the first step. Every step can
 * be repeated: `erase` is idempotent on its request identifier (IC-11).
 *
 * `now` is the moment of THIS claim, and not the start of the run: a run that
 * works for a long time would otherwise write claims that were old when they
 * were made, and another instance would take the last of them over while this
 * one was still at work on it.
 */
export async function deletePermanently(
  document: Due,
  basis: DeletionBasis,
  now: Date,
): Promise<'deleted' | 'elsewhere' | 'kept'> {
  const claim = { id: document.id, deletionClaimedAt: now };
  const claimed = await db().document.updateMany({
    where: {
      AND: [
        // Read again in the write: the Owner may have restored it since the list was read, or cancelled
        // the clearing, or passed the document on (src/lib/clearing/deletion.ts).
        basis.claimWhere,
        {
          id: document.id,
          OR: [
            { deletionClaimedAt: null },
            { deletionClaimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
          ],
        },
      ],
    },
    data: { deletionClaimedAt: now, ...basis.claimData },
  });
  if (claimed.count !== 1) return 'elsewhere';

  let erased = false;
  try {
    // FR-AU-91: a clearing ends every collaborator's access, and closes every connection, from here: the
    // images are deleted next, and no one is to be reading a document that is losing them.
    await basis.onClaimed?.(now);
    // Contract IC-50, the extension point "Permanent deletion"; IC-29. "Ekdotico
    // first asks Istorico … and deletes its own data only after Istorico
    // reports that it has"; "for an unrecorded document, and wherever the
    // adapter does not report the erasure capability … Ekdotico makes no
    // request and deletes its own data" (FR-ED-36). Decided from the
    // capability, never from the adapter's name (IC-14). Not reached in
    // α 0.1.0: the no-op adapter reports no erasure.
    const port = istorico();
    if (port.capabilities().erasure && document.recording === 'RECORDED') {
      const result = await port.erase({
        // The same for every attempt, so that a repeated call is the same
        // request (IC-11). The outbox that carries a request identifier of its
        // own arrives with the release that links Istorico (IC-27, IC-18).
        //
        // CARRIED FORWARD, to be raised with Istorico's owner when that outbox
        // is built, and not built here: if Istorico keys idempotency on the
        // request identifier and answers a repeated identifier with its first
        // outcome, a document once `held` stays held for this caller, whatever
        // has changed since, because every attempt carries this one identifier.
        requestId: document.id,
        subjectUserId: document.ownerId,
        // FR-ED-36 "covers documents in a personal workspace", the only kind there is.
        documents: [{ documentId: document.id, role: 'owner', workspaceKind: 'personal' }],
      });
      const outcome = result.ok
        ? result.value.find((each) => each.documentId === document.id)?.outcome
        : null;
      // IC-29: `erased` and `no-record` are the two outcomes after which the
      // application deletes its rows. Anything else keeps them: an error, a
      // hold, `pseudonymised`, an outcome this version does not know, and an
      // answer that does not name the document.
      erased = outcome === 'erased' || outcome === 'no-record';
    } else {
      erased = true;
    }
    if (!erased) return 'kept';

    // NFR-SE-18, FR-ED-36: the images of the document are deleted from storage
    // HERE, after Istorico and before the row, objects first and then their
    // rows (the row of the document is restricted while one remains). One that
    // cannot be removed rejects, and the document is kept for the next run,
    // which asks again; an object that is gone is no fault.
    await deleteImagesOfDocumentNow(document.id);

    // The row, and with it the document's state. Only while this claim is the
    // one it holds: a claim taken over belongs to the run that took it.
    //
    // NFR-SE-19; the owner's decision R47 of 12 October 2026 (register row
    // D161, pending): "An entry of its own, with the document's identifier
    // and no user, written with the deletion." In the transaction that
    // deletes the row, and only where it deleted it: a row is deleted once,
    // so there is one entry for a document however many instances reach it
    // and however often a claim is taken over, and none where the deletion
    // does not commit. The entry names the document by a column that refers
    // to nothing (prisma/schema.prisma), so it stays when the row is gone.
    //
    // What is outside the database comes before, and is not undone with this
    // transaction: Istorico has erased by now, and so will the images have
    // been deleted. A fault here leaves the row, its claim and no entry; the
    // run that finds the claim an hour old repeats those steps and writes it.
    return await db().$transaction(async (transaction) => {
      // FR-AU-91: what a clearing does in this transaction (the notices of the deletion, the end of the
      // invitations and of the offer) is done only while the claim is still the row's, and is undone
      // with the transaction where it is not.
      if (basis.inTransaction) {
        const held = await transaction.document.findFirst({ where: claim, select: { title: true } });
        if (!held) return 'elsewhere';
        await basis.inTransaction(transaction, held.title);
      }
      const { count } = await transaction.document.deleteMany({ where: claim });
      if (count !== 1) {
        if (basis.inTransaction) throw new ClaimLost();
        return 'elsewhere';
      }
      await securityLogIn(transaction, { kind: 'document_deleted_permanently', documentId: document.id });
      // FR-ED-42: the notifications of a change of role and of a removal named it, and have no subject now.
      await deleteAccessNotificationsOf(transaction, document.id);
      return 'deleted';
    });
  } catch (error) {
    // The claim was another run's by the time the row was to be deleted: everything this transaction wrote is undone.
    if (error instanceof ClaimLost) return 'elsewhere';
    throw error;
  } finally {
    // Istorico did not erase, or threw although the port does not (IC-10): the
    // document is free for the next run, which asks again. Not where a later
    // step failed: Istorico has erased, and the claim grows stale by itself.
    if (!erased) await db().document.updateMany({ where: claim, data: { deletionClaimedAt: null } });
  }
}

/**
 * NFR-RE-15, "Permanent deletion of a deleted document when its retention
 * ends": every document whose retention has ended is deleted, each once
 * whatever number of instances run this together. It returns how many this
 * call deleted and how many it had to leave for the next run.
 *
 * One document that cannot be deleted does not hold the others back: it is
 * one line, with the document's identifier and the class of the fault and
 * nothing else (NFR-SE-19 allows the identifier, and never the title), and
 * the run goes on.
 *
 * `now` is when the run began, for the tests; each claim is marked with the
 * time that has passed since on this instance's clock (`deletePermanently`).
 *
 * ponytail: the documents due are found by a scan of the table, once an
 * hour; an index on `deletedAt` when the table is large enough for it to show.
 */
export async function deleteExpiredDocuments(
  now: Date = new Date(),
): Promise<{ deleted: number; kept: number }> {
  const began = Date.now();
  const retained = retainedSince(now);
  // FR-AU-91: a document in a clearing is deleted on the clearing's day and not by its retention, which may end
  // inside the notice period of a document that was deleted before the clearing; the condition is in the claim too.
  const basis: DeletionBasis = { claimWhere: { deletedAt: { lte: retained }, clearingAt: null } };
  const due: Due[] = await db().document.findMany({
    where: { deletedAt: { lte: retained }, clearingAt: null },
    select: { id: true, ownerId: true, recording: true },
  });
  let deleted = 0;
  let kept = 0;
  for (const document of due) {
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
      console.error(`permanent deletion: document ${document.id} kept (${fault})`);
    }
  }
  return { deleted, kept };
}
