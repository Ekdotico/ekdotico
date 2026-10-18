// The people of a document (API design, "Documents, Sharing"): the Owner and
// the collaborators with their roles, the count against the limit of ten
// (FR-ED-37), and the pending invitations for a caller who may invite.
import { documentRoute } from '../../../../../lib/documents/route.ts';
import { sharingOf } from '../../../../../lib/documents/sharing.ts';

export const dynamic = 'force-dynamic';

/** It reads, so the signed copy of the session serves (NFR-SE-02). */
export const GET = documentRoute('document.collaborators.view', async ({ document, role }) =>
  Response.json(await sharingOf(document, role), { headers: { 'Cache-Control': 'no-store' } }),
);
