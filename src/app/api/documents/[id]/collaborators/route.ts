// The people of a document (API design, "Documents, Sharing"): the Owner and
// the collaborators with their roles, the count against the limit of ten
// (FR-ED-37), and the pending invitations for a caller who may invite. The
// caller's own entry is marked `self`, so that a page can offer to leave
// (FR-ED-38).
import { documentRoute } from '../../../../../lib/documents/route.ts';
import { sharingOf } from '../../../../../lib/documents/sharing.ts';

export const dynamic = 'force-dynamic';

/** It reads, so the signed copy of the session serves (NFR-SE-02). */
export const GET = documentRoute('document.collaborators.view', async ({ document, role, session }) =>
  Response.json(await sharingOf(document, role, session.userId), {
    headers: { 'Cache-Control': 'no-store' },
  }),
);
