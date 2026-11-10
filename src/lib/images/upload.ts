// The upload of an image (FR-ED-08, NFR-SE-18), called by
// POST /api/documents/[id]/images once `documentRoute` has decided the origin,
// the session's row, the limit of API requests for the user (which the proxy
// takes on every other route; it does not see this one, so that Next.js does
// not hold its body: src/proxy.ts, `config`), the document, and
// `document.content.edit`. The checks, in the order of docs/plan/slice-19.md,
// section 4:
//
//   1. a store to put it in (503 where there is none);
//   2. the limit of 30 in any 10 minutes for the user (429), counted before
//      the work, and given back only where the work FAILS BY A FAULT OF OURS
//      after the body was read whole: a file that is refused is counted, which
//      is what the limit is for, and so is a body that was never received
//      (a client that aborts is not a fault of ours: the review of pull
//      request 52);
//   3. the size, from `Content-Length` before one byte is read (413), and the
//      body read to the bound whatever the header said;
//   4. the type, from the content (415), and the metadata removed from a file
//      that parses to its end (src/lib/images/prepare.ts);
//   5. the 100 MB of the document under the lock of its row, where the role
//      and the document are read again, and the row (413, 404, 403);
//   6. the object, under a key that names its document, with the type the
//      server established; where the put fails the object is removed, and
//      the row with it, or the row is kept where the object cannot be removed,
//      and the timer removes both (a put that threw may have kept the bytes).
//
// The body is the bytes of the image and nothing else. No file name is read
// from anywhere, and the declared `Content-Type` is not looked at.
import { fault } from '../auth/route-answers.ts';
import { db } from '../db.ts';
import { refusedByClearing } from '../clearing/answer.ts';
import { refusal } from '../documents/access.ts';
import type { DocumentCall } from '../documents/route.ts';
import { faultOf } from '../fault.ts';
import { readBytes } from '../http.ts';
import { logLimitReached, takeLimitReturnable } from '../rate-limit.ts';
import { settings } from '../settings.ts';
import {
  fullAnswer,
  limitedAnswer,
  notAcceptedAnswer,
  notReceivedAnswer,
  tooLargeAnswer,
  unavailableAnswer,
} from './answers.ts';
import { IMAGE_MOST_BYTES } from './node.ts';
import { prepareImage } from './prepare.ts';
import { discardReservation, reserveImage } from './quota.ts';
import { newObjectKey } from './storage.ts';
import { imageStorage } from './store.ts';

export async function uploadImage({ request, document, session }: DocumentCall): Promise<Response> {
  const storage = imageStorage();
  if (!storage) return unavailableAnswer();

  const limit = await takeLimitReturnable('IMAGE_UPLOADS_PER_USER', session.userId);
  if (!limit.ok) {
    await logLimitReached('IMAGE_UPLOADS_PER_USER', session.userId, limit.retryAfterSeconds, session.userId);
    return limitedAnswer(limit.retryAfterSeconds);
  }

  // Before one byte is read: a length that is declared over the limit is refused as it is.
  const declared = request.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > IMAGE_MOST_BYTES) {
    return tooLargeAnswer();
  }
  // And whatever was declared, no more than the limit is read: a body that has no length, or lies about it, is
  // stopped here. A body that cannot be read to its end (the client reset the connection) is the client's: the
  // count stays, or a client could send nearly 20 MB again and again and never be counted.
  let body: Buffer | null;
  try {
    body = await readBytes(request, IMAGE_MOST_BYTES);
  } catch {
    return notReceivedAnswer();
  }
  if (!body) return tooLargeAnswer();

  let reserved: string | null = null;
  let objectKey: string | null = null;
  try {
    const prepared = prepareImage(body);
    if (!prepared.ok) return prepared.reason === 'too_large' ? tooLargeAnswer() : notAcceptedAnswer();

    objectKey = newObjectKey(document.id);
    const reservation = await reserveImage({
      documentId: document.id,
      uploadedById: session.userId,
      objectKey,
      contentType: prepared.contentType,
      byteSize: prepared.bytes.length,
    });
    if (!reservation.ok) {
      if (reservation.reason === 'full')
        return fullAnswer(reservation.limitBytes, settings().imageUnreferencedDays);
      // FR-AU-91: the document entered a clearing since the request was authorised: a 409, as for every request that
      // would change its images.
      if (reservation.reason === 'clearing') {
        return (
          (await refusedByClearing(document.id, 'change')) ??
          (await refusal({ outcome: 'not_found' }, session.userId, document.id))
        );
      }
      // Read again under the lock: the 404 and the 403 of every route of a document, the 403 written to the log.
      return reservation.reason === 'not_found'
        ? await refusal({ outcome: 'not_found' }, session.userId, document.id)
        : await refusal({ outcome: 'forbidden' }, session.userId, document.id, 'document.content.edit');
    }
    reserved = reservation.image.id;

    await storage.put(objectKey, prepared.bytes, prepared.contentType);
    // The document may have been deleted between the reservation and the put (a clearing deletes its images as it
    // deletes it): the row is gone, and an object put after it would be one that nothing names and nothing deletes.
    if (
      !(await db().documentImage.findUnique({ where: { id: reservation.image.id }, select: { id: true } }))
    ) {
      await storage.remove(objectKey);
      reserved = null;
      return await refusal({ outcome: 'not_found' }, session.userId, document.id);
    }
    return Response.json(
      { id: reservation.image.id, contentType: prepared.contentType, byteSize: prepared.bytes.length },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // A fault of ours: the upload the user was counted for is given back. A put that threw may have kept the bytes
    // (the answer was lost, or the last of the attempts timed out), so the object is removed first; the row is
    // discarded only where that worked, and is kept where it did not, with `unreferencedAt` set, so that the timer
    // finds the object through it within 30 days, and the room it takes is counted until then (Q14).
    if (reserved && objectKey) {
      const removed = await storage.remove(objectKey).then(
        () => true,
        (failed: unknown) => {
          console.error(
            `images: object of image ${reserved} not removed after a failed upload (${faultOf(failed)})`,
          );
          return false;
        },
      );
      if (removed) await discardReservation(reserved).catch(() => undefined);
    }
    await limit.giveBack().catch(() => undefined);
    return fault('images', error);
  }
}
