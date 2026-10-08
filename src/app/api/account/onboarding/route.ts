// FR-AU-55, FR-AU-56: whether the onboarding wizard is due for the current
// account (API design, "Account"). It reads, so the signed copy of the session
// serves (NFR-SE-02). The page does not ask here: the layout decides on the
// server, from the same record.
import { fault, notAdmitted } from '../../../../lib/auth/route-answers.ts';
import { validateSession } from '../../../../lib/auth/session.ts';
import { onboarding } from '../../../../lib/onboarding.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const validation = await validateSession(request.method, request.headers);
    const { session } = validation;
    // FR-AU-83: 403 for an account the founding-team gate stops; 401 without a session.
    if (!session) return await notAdmitted(validation);
    return Response.json(await onboarding(session.userId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fault('onboarding', error);
  }
}
