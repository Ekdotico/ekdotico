// FR-ED-42 with the owner's answer to Q2 of the plan: accept or decline an
// invitation from the notification list, by the invitation's identifier, for
// the signed-in account that holds the invited address. The same decision as
// the link's route (src/lib/documents/sharing.ts, `answerInvitation`).
import { fault, notAdmitted, refusedOrigin } from '../../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../../lib/auth/session.ts';
import { answered } from '../../../../../../lib/documents/invitation-answers.ts';
import { answerInvitation } from '../../../../../../lib/documents/sharing.ts';
import { errorResponse } from '../../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const ANSWERS = ['accept', 'decline'] as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ invitationId: string; answer: string }> },
): Promise<Response> {
  try {
    // NFR-SE-17 (c), D164: the origin first.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);

    const { invitationId, answer } = await context.params;
    const chosen = ANSWERS.find((one) => one === answer);
    if (!chosen) return errorResponse(404, 'not_found', 'There is no such action.');
    return answered(await answerInvitation(session.userId, { id: String(invitationId) }, chosen));
  } catch (error) {
    return fault('invitations', error);
  }
}
