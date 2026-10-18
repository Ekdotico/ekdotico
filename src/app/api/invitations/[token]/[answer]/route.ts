// FR-ED-21, FR-ED-37: accept or decline an invitation by the token of its
// link (API design: `POST /api/invitations/[token]/accept` and `…/decline`).
// The link alone grants nothing: the session's account must hold the invited
// address as verified (src/lib/documents/sharing.ts, `answerInvitation`).
import { fault, notAdmitted, refusedOrigin } from '../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../lib/auth/session.ts';
import { answered } from '../../../../../lib/documents/invitation-answers.ts';
import { answerInvitation } from '../../../../../lib/documents/sharing.ts';
import { errorResponse } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const ANSWERS = ['accept', 'decline'] as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string; answer: string }> },
): Promise<Response> {
  try {
    // NFR-SE-17 (c), D164: the origin first.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);

    const { token, answer } = await context.params;
    const chosen = ANSWERS.find((one) => one === answer);
    if (!chosen) return errorResponse(404, 'not_found', 'There is no such action.');
    return answered(await answerInvitation(session.userId, { token: String(token) }, chosen));
  } catch (error) {
    return fault('invitations', error);
  }
}
