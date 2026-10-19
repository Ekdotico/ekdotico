// FR-ED-37: revoke a pending invitation (API design, "Documents, Sharing").
// Made by `documentRoute`, for `document.collaborators.invite`. No body.
import { refusal } from '../../../../../../lib/documents/access.ts';
import { documentRoute } from '../../../../../../lib/documents/route.ts';
import { INVITATION_MESSAGES } from '../../../../../../lib/documents/invitation-answers.ts';
import { revokeInvitation } from '../../../../../../lib/documents/sharing.ts';
import { errorResponse } from '../../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

/** 200 with the statement; 404 for an invitation of another document, or one that is not pending. */
export const DELETE = documentRoute(
  'document.collaborators.invite',
  async ({ document, params, session }) => {
    const revoked = await revokeInvitation(document.id, String(params.invitationId), session.userId);
    // The permission is read again under the document's row (FR-ED-47: ownership may have passed meanwhile).
    if (revoked === 'forbidden') {
      return refusal({ outcome: 'forbidden' }, session.userId, document.id, 'document.collaborators.invite');
    }
    if (!revoked) return errorResponse(404, 'not_found', INVITATION_MESSAGES.notFound);
    return Response.json(
      { message: INVITATION_MESSAGES.revoked(revoked.email) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },
);
