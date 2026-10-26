// FR-ED-36: the Owner restores a deleted document within its retention (API
// design, "Documents"). The handler is made by `deletedDocumentRoute`, which
// validates the session by its row, since the request changes state, and
// authorises it through `authoriseDeleted` of src/lib/documents/access.ts: to
// anyone but the Owner, and for a document that is not deleted or whose
// retention has ended, the answer is the 404 of every other document route.
//
// FR-AU-91: a document that a clearing treats as shared "cannot be restored under FR-ED-36 during the period":
// `deletedDocumentRoute` answers it with a 409, and the restore itself carries the condition.
import { refusedByClearing } from '../../../../../lib/clearing/answer.ts';
import { refusal } from '../../../../../lib/documents/access.ts';
import { restoreDocument } from '../../../../../lib/documents/deletion.ts';
import { deletedDocumentRoute } from '../../../../../lib/documents/route.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The request has no body, and none is read. The answer is the document, as a rename answers it. */
export const POST = deletedDocumentRoute(async ({ document, session }) => {
  const restored = await restoreDocument(document);
  // Its retention ended, or the timer took it, since it was authorised: gone, as to anyone.
  // Or a clearing took it since (FR-AU-91): it "cannot be restored under FR-ED-36 during the period", a 409.
  if (!restored) {
    return (
      (await refusedByClearing(document.id, 'restore')) ??
      refusal({ outcome: 'not_found' }, session.userId, document.id)
    );
  }
  return Response.json(restored, { headers: NO_STORE });
});
