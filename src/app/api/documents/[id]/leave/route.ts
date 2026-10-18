// FR-ED-38: a collaborator leaves the document, "which has the effect of a
// removal" (register row S15-1: its own route, under its own permission). Made
// by `documentRoute` for `document.leave`, which is fixed by role and which
// the Owner does not hold ("The Owner cannot be removed, cannot leave"), so the
// Owner is refused there, with a 403 that is logged. No body, and none is read.
import { refusal } from '../../../../../lib/documents/access.ts';
import { leaveDocument } from '../../../../../lib/documents/collaborators.ts';
import { documentRoute } from '../../../../../lib/documents/route.ts';

export const dynamic = 'force-dynamic';

/** 204; or the 404 of a document, or a role, that is not there now. */
export const POST = documentRoute('document.leave', async ({ document, session }) => {
  const left = await leaveDocument(document.id, session.userId);
  if (left.outcome === 'not_found') return refusal({ outcome: 'not_found' }, session.userId, document.id);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
});
