// FR-ED-36: the deleted documents of the current account that are still
// within their retention (API design, "Documents"). The request is about no
// one document, so it cannot ask src/lib/documents/access.ts: the list is the
// session's own account's, as the Owner, and takes no identifier from the
// request.
import { fault, unauthenticated } from '../../../../lib/auth/route-answers.ts';
import { validateSession } from '../../../../lib/auth/session.ts';
import { listDeletedDocuments } from '../../../../lib/documents/deletion.ts';

export const dynamic = 'force-dynamic';

/** It reads, so the signed copy of the session serves (NFR-SE-02). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { session } = await validateSession(request.method, request.headers);
    if (!session) return unauthenticated();
    return Response.json(
      { documents: await listDeletedDocuments(session.userId) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return fault('documents', error);
  }
}
