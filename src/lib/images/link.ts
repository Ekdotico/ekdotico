// The link to an image (FR-ED-08, NFR-SE-18): "A link to an image is issued only
// by a route that requires a session and access to the document, is valid for
// 5 minutes (an initial value), and is the only way an image is served". Called
// by GET /api/documents/[id]/images/[imageId] once `documentRoute` has decided,
// from the session's row and never from the signed copy in the cookie, the
// document and `document.view`.
//
// The image is looked up by its identifier AND this document: an image of
// another document, however its identifier was come by, is a 404 for this one,
// the same 404 as an identifier that names nothing (so that no document's
// images are told apart from none), and so is an image whose deletion has been
// claimed. The link is signed for the object's key, which names its document,
// for the lifetime of the setting and for a GET alone; it is never stored, and
// it is not a request path of the application (NFR-SE-05).
import { fault } from '../auth/route-answers.ts';
import { refusal } from '../documents/access.ts';
import type { DocumentCall } from '../documents/route.ts';
import { db } from '../db.ts';
import { settings } from '../settings.ts';
import { unavailableAnswer } from './answers.ts';
import { imageStorage } from './store.ts';

export async function issueLink({ document, params, session }: DocumentCall): Promise<Response> {
  try {
    const storage = imageStorage();
    if (!storage) return unavailableAnswer();
    const image = await db().documentImage.findFirst({
      where: { id: params.imageId ?? '', documentId: document.id, deletionClaimedAt: null },
      select: { objectKey: true, contentType: true },
    });
    // The 404 of a document that is not there, byte for byte (src/lib/documents/access.ts).
    if (!image) return await refusal({ outcome: 'not_found' }, session.userId, document.id);
    const seconds = settings().imageLinkSeconds;
    const url = await storage.link(image.objectKey, seconds, image.contentType);
    return Response.json(
      { url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return fault('images', error);
  }
}
