// The 100 MB of images a document holds (NFR-SE-18; the owner's answer to Q14:
// every stored object counts). The check and the row it admits are one step
// under a lock held for the document, so that two uploads at once cannot both
// pass a limit that only one of them fits under.
import type { DocumentImage } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';
import { settings } from '../settings.ts';

export type Reservation =
  | { ok: true; image: DocumentImage }
  /** Over the limit: what the document holds, and the limit, for the statement of it (NFR-SE-18). */
  | { ok: false; heldBytes: number; limitBytes: number };

/**
 * Admits an image of `byteSize` bytes to a document, by writing its row, or
 * refuses it where the document would then hold more than the limit. The row
 * starts with `unreferencedAt` set: an image is in no document until its
 * block is stored, and one that is never placed is deleted as one taken out
 * (src/lib/images/deletion.ts). The object is put after this, under the key
 * the row holds; a put that fails deletes the row (`discardReservation`).
 *
 * `between` is for the tests: it runs after the sum is read and before the row
 * is written, where two uploads without the lock would both have read the same sum.
 */
export async function reserveImage(
  input: {
    documentId: string;
    uploadedById: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
  },
  now: Date = new Date(),
  between?: () => Promise<void>,
): Promise<Reservation> {
  const limitBytes = settings().imageDocumentBytes;
  return db().$transaction(async (transaction) => {
    // One lock for a document, released at the end of the transaction. A hash of the
    // document's identifier: two documents that share one only wait for each other.
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`images:${input.documentId}`}))`;
    const { _sum } = await transaction.documentImage.aggregate({
      where: { documentId: input.documentId },
      _sum: { byteSize: true },
    });
    const heldBytes = _sum.byteSize ?? 0;
    if (heldBytes + input.byteSize > limitBytes) return { ok: false, heldBytes, limitBytes } as const;
    await between?.();
    const image = await transaction.documentImage.create({ data: { ...input, unreferencedAt: now } });
    return { ok: true, image } as const;
  });
}

/** Deletes the row of an image whose object could not be put, so that it counts for nothing. */
export async function discardReservation(id: string): Promise<void> {
  await db().documentImage.deleteMany({ where: { id } });
}
