// The 100 MB of images a document holds (NFR-SE-18; the owner's answer to Q14:
// every stored object counts). The check and the row it admits are one step
// under the lock of the document's row, so that two uploads at once cannot both
// pass a limit that only one of them fits under, and so that who may upload,
// and whether the document is there, are read again under the same lock.
import type { DocumentImage } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';
import { lockDocument } from '../documents/sharing.ts';
import { COLLABORATOR_ROLE, holds } from '../documents/permissions.ts';
import { settings } from '../settings.ts';

export type Reservation =
  | { ok: true; image: DocumentImage }
  /** Over the limit: what the document holds, and the limit, for the statement of it (NFR-SE-18). */
  | { ok: false; reason: 'full'; heldBytes: number; limitBytes: number }
  /** The document is gone or deleted, or the uploader holds no role on it now: the 404 of a document (FR-ED-39). */
  | { ok: false; reason: 'not_found' }
  /** The uploader holds a role on it that no longer holds `document.content.edit`: a 403. */
  | { ok: false; reason: 'forbidden' }
  /** FR-AU-91: the document is in a clearing, or claimed for its deletion: no one adds an image to it. */
  | { ok: false; reason: 'clearing' };

/**
 * Admits an image of `byteSize` bytes to a document, by writing its row, or
 * refuses it. UNDER THE LOCK OF THE DOCUMENT'S ROW (`lockDocument`, as every
 * change to who holds a role takes it), the document is read again with the
 * uploader's role and the permission set: the request was authorised before
 * its body was read, which can take minutes for 20 MB, and the Owner may have
 * removed the uploader, lowered the role, passed the ownership on, or put the
 * document in the trash since (the review of pull request 52). Then the limit:
 * the row is refused where the document would hold more than it.
 *
 * The row starts with `unreferencedAt` set: an image is in no document until
 * its block is stored, and one that is never placed is deleted as one taken
 * out (src/lib/images/deletion.ts). The object is put after this, under the
 * key the row holds; where the put fails the upload removes the object and the
 * row, and keeps the row where it cannot remove the object, for the timer
 * (`src/lib/images/upload.ts`).
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
  return db().$transaction(async (transaction): Promise<Reservation> => {
    if (!(await lockDocument(transaction, input.documentId))) return { ok: false, reason: 'not_found' };
    const document = await transaction.document.findUnique({
      where: { id: input.documentId },
      select: {
        ownerId: true,
        permissionSet: true,
        clearingAt: true,
        deletionClaimedAt: true,
        collaborators: { where: { userId: input.uploadedById }, select: { role: true } },
      },
    });
    const held = document?.collaborators[0]?.role;
    const role = !document
      ? null
      : document.ownerId === input.uploadedById
        ? 'owner'
        : held
          ? COLLABORATOR_ROLE[held]
          : null;
    if (!document || !role) return { ok: false, reason: 'not_found' };
    if (!holds(document.permissionSet, role, 'document.content.edit'))
      return { ok: false, reason: 'forbidden' };
    // FR-AU-91: read under the document's row, as the role is: a confirmation that committed while the
    // body was being received is not outrun by the upload.
    if (document.clearingAt !== null || document.deletionClaimedAt !== null) {
      return { ok: false, reason: 'clearing' };
    }

    const { _sum } = await transaction.documentImage.aggregate({
      where: { documentId: input.documentId },
      _sum: { byteSize: true },
    });
    const heldBytes = _sum.byteSize ?? 0;
    if (heldBytes + input.byteSize > limitBytes) return { ok: false, reason: 'full', heldBytes, limitBytes };
    await between?.();
    const image = await transaction.documentImage.create({ data: { ...input, unreferencedAt: now } });
    return { ok: true, image };
  });
}

/** Deletes the row of an image whose object could not be put, so that it counts for nothing. */
export async function discardReservation(id: string): Promise<void> {
  await db().documentImage.deleteMany({ where: { id } });
}
