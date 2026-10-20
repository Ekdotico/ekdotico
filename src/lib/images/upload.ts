// The upload of an image (FR-ED-08, NFR-SE-18), called by
// POST /api/documents/[id]/images once `documentRoute` has decided the origin,
// the session's row, the document, and `document.content.edit`. The checks, in
// the order of docs/plan/slice-19.md, section 4:
//
//   1. a store to put it in (503 where there is none);
//   2. the limit of 30 in any 10 minutes for the user (429), counted before
//      the work, and given back only where the work fails by a fault of ours:
//      a file that is refused is counted, which is what the limit is for;
//   3. the size, from `Content-Length` before one byte is read (413), and the
//      body read to the bound whatever the header said;
//   4. the type, from the content (415), and the metadata removed from a file
//      that parses to its end (src/lib/images/prepare.ts);
//   5. the 100 MB of the document, under a lock, and the row (413);
//   6. the object, under a key that names its document, with the type the
//      server established; a put that fails deletes the row.
//
// The body is the bytes of the image and nothing else. No file name is read
// from anywhere, and the declared `Content-Type` is not looked at.
import { fault } from '../auth/route-answers.ts';
import type { DocumentCall } from '../documents/route.ts';
import { readBytes } from '../http.ts';
import { logLimitReached, takeLimitReturnable } from '../rate-limit.ts';
import {
  fullAnswer,
  limitedAnswer,
  notAcceptedAnswer,
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

  let reserved: string | null = null;
  try {
    // Before one byte is read: a length that is declared over the limit is refused as it is.
    const declared = request.headers.get('content-length');
    if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > IMAGE_MOST_BYTES) {
      return tooLargeAnswer();
    }
    // And whatever was declared, no more than the limit is read: a body that has no length, or lies about it, is stopped here.
    const body = await readBytes(request, IMAGE_MOST_BYTES);
    if (!body) return tooLargeAnswer();

    const prepared = prepareImage(body);
    if (!prepared.ok) return prepared.reason === 'too_large' ? tooLargeAnswer() : notAcceptedAnswer();

    const objectKey = newObjectKey(document.id);
    const reservation = await reserveImage({
      documentId: document.id,
      uploadedById: session.userId,
      objectKey,
      contentType: prepared.contentType,
      byteSize: prepared.bytes.length,
    });
    if (!reservation.ok) return fullAnswer(reservation.limitBytes);
    reserved = reservation.image.id;

    await storage.put(objectKey, prepared.bytes, prepared.contentType);
    return Response.json(
      { id: reservation.image.id, contentType: prepared.contentType, byteSize: prepared.bytes.length },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    // A fault of ours: the room the row took is given back, and so is the upload the user was counted.
    if (reserved) await discardReservation(reserved).catch(() => undefined);
    await limit.giveBack().catch(() => undefined);
    return fault('images', error);
  }
}
