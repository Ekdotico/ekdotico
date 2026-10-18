// FR-ED-37: revoke a pending invitation (API design, "Documents, Sharing").
// Made by `documentRoute`, for `document.collaborators.invite`. No body.
import { documentRoute } from '../../../../../../lib/documents/route.ts';
import { INVITATION_MESSAGES } from '../../../../../../lib/documents/invitation-answers.ts';
import { revokeInvitation } from '../../../../../../lib/documents/sharing.ts';
import { errorResponse } from '../../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

/** 200 with the statement; 404 for an invitation of another document, or one that is not pending. */
export const DELETE = documentRoute('document.collaborators.invite', async ({ document, params }) => {
  const revoked = await revokeInvitation(document.id, String(params.invitationId));
  if (!revoked) return errorResponse(404, 'not_found', INVITATION_MESSAGES.notFound);
  return Response.json(
    { message: INVITATION_MESSAGES.revoked(revoked.email) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
