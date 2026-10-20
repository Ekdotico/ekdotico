// The deletion of images from storage (NFR-SE-18, NFR-RE-15, "Deletion from
// storage of an image that no longer appears in its document"): scheduled, at
// least once a day, a timer in the application, and idempotent.
//
// NOT YET IN `TIMERS`, AND NOT YET CALLED BY THE PERMANENT DELETION OF A
// DOCUMENT: both need a store, and the adapter waits on the owner's answer to
// register row S19-1 (docs/plan/slice-19.md). The functions take the store as a
// parameter and are tested against the in-memory one. With no route that
// uploads, no row exists to delete, so the foreign key that restricts the
// document's deletion cannot yet be met.
//
// Order, for a fault at any step to leave nothing lost and nothing orphaned
// that a later run cannot finish:
//
//   1. CLAIM the row, by one conditional UPDATE: only a row that has been
//      unreferenced for the whole period, and that no run holds a claim on (or
//      whose claim is an hour old, the run that made it having died). From the
//      claim on the store of a document no longer brings the image back
//      (src/lib/images/references.ts), so the object is never deleted from
//      under a block that was shown it. Two instances claim a row once.
//   2. REMOVE the object. One that is not there is success: a run that died
//      after this step is finished by the next, and an instance that finds the
//      object gone has nothing to answer for.
//   3. DELETE the row, only where it still holds the claim this run made.
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';
import { settings } from '../settings.ts';
import type { ImageStorage } from './storage.ts';

/** How old a claim is when another run may take it: the run that made it has died. As `CLAIM_STALE_MS` of the permanent deletion of a document. */
export const IMAGE_CLAIM_STALE_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes every image that has been out of its document for the period, the
 * object and the row, and says how many rows this run deleted: 0 for a run
 * that found the work done by another. One image that cannot be deleted does
 * not hold the others back: it is one line, with its identifier and the class
 * of the fault and nothing else (NFR-SE-19), and its claim goes stale and is
 * taken by a later run.
 *
 * `now` is when the run began, for the tests; the claim is marked with the
 * time that has passed since on this instance's clock, so that two claims of
 * one run are told apart from a stale one.
 */
export async function deleteExpiredImages(storage: ImageStorage, now: Date = new Date()): Promise<number> {
  const began = Date.now();
  const unreferenced = new Date(now.getTime() - settings().imageUnreferencedDays * DAY_MS);
  const stale = new Date(now.getTime() - IMAGE_CLAIM_STALE_MS);
  // ponytail: the rows due are found by a scan of the table, once an hour; an index on
  // `unreferencedAt` when the table is large enough for it to show.
  const due = await db().documentImage.findMany({
    where: {
      unreferencedAt: { lte: unreferenced },
      OR: [{ deletionClaimedAt: null }, { deletionClaimedAt: { lt: stale } }],
    },
    select: { id: true, objectKey: true },
  });
  let deleted = 0;
  for (const image of due) {
    try {
      const claimedAt = new Date(now.getTime() + Date.now() - began);
      const claimed = await db().documentImage.updateMany({
        where: {
          id: image.id,
          unreferencedAt: { lte: unreferenced },
          OR: [{ deletionClaimedAt: null }, { deletionClaimedAt: { lt: stale } }],
        },
        data: { deletionClaimedAt: claimedAt },
      });
      if (claimed.count !== 1) continue;
      await storage.remove(image.objectKey);
      const gone = await db().documentImage.deleteMany({
        where: { id: image.id, deletionClaimedAt: claimedAt },
      });
      deleted += gone.count;
    } catch (error) {
      console.error(`image deletion: image ${image.id} kept (${faultOf(error)})`);
    }
  }
  return deleted;
}

/**
 * Deletes every image of a document, objects first and then rows: the step of
 * the permanent deletion of the document that FR-ED-36 asks for ("removes the
 * document's images from storage") and that the clearing of FR-AU-91 will ask
 * for as well. It rejects where the store does, and leaves the rows of the
 * objects it did not remove, so that the document is kept and the next run
 * asks again (src/lib/documents/deletion.ts, the outcome `kept`). An object
 * that is already gone is no fault. Returns how many images it deleted.
 */
export async function deleteImagesOfDocument(storage: ImageStorage, documentId: string): Promise<number> {
  const images = await db().documentImage.findMany({
    where: { documentId },
    select: { id: true, objectKey: true },
  });
  let deleted = 0;
  for (const image of images) {
    await storage.remove(image.objectKey);
    deleted += (await db().documentImage.deleteMany({ where: { id: image.id } })).count;
  }
  return deleted;
}
