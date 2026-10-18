// FR-ED-37: send an invitation again, which is a new invitation with a new
// link and a new period, and revokes the earlier one where it is pending (API
// design, "Documents, Sharing"). Made by `documentRoute`, for
// `document.collaborators.invite`. No body. Answered as an invitation is.
import { after } from 'next/server';
import { createdAnswer, INVITATION_MESSAGES } from '../../../../../../../lib/documents/invitation-answers.ts';
import { documentRoute } from '../../../../../../../lib/documents/route.ts';
import { resendInvitation } from '../../../../../../../lib/documents/sharing.ts';
import { errorResponse } from '../../../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

export const POST = documentRoute('document.collaborators.invite', async ({ document, session, params }) => {
  const result = await resendInvitation(document, session.userId, String(params.invitationId));
  if (!result) return errorResponse(404, 'not_found', INVITATION_MESSAGES.notFound);
  return createdAnswer(result, document.id, session.userId, after);
});
