// FR-AU-95: whether the feedback notice is due for the current account, and which text its version stands for. It reads, so
// the signed copy of the session serves (NFR-SE-02). Closed as a route that does not exist while FEEDBACK_INTAKE_ENABLED is
// off, as POST /api/feedback is.
import { feedbackIntakeEnabled } from '../../../../lib/account/feedback-step.ts';
import { fault, notAdmitted } from '../../../../lib/auth/route-answers.ts';
import { validateSession } from '../../../../lib/auth/session.ts';
import { feedbackNotice } from '../../../../lib/feedback/notice.ts';
import { errorResponse } from '../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    if (!feedbackIntakeEnabled()) return errorResponse(404, 'not_found', '');
    const validation = await validateSession(request.method, request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    return Response.json(await feedbackNotice(session.userId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fault('feedback-notice', error);
  }
}
