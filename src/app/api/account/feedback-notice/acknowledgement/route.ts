// FR-AU-95: record the current account's acknowledgement of the feedback notice. The rules are those of the acknowledgement of
// the Closed α notice (src/app/api/account/closed-alpha-notice/acknowledgement/route.ts): the origin first, the session's row,
// the account the session's and never the request's, a body that is exactly `{ "version": n }`, and a version other than the
// current one refused with a 409. Closed as a route that does not exist while FEEDBACK_INTAKE_ENABLED is off.
import { feedbackIntakeEnabled } from '../../../../../lib/account/feedback-step.ts';
import { fault, notAdmitted, refusedOrigin } from '../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../lib/auth/session.ts';
import { acknowledgeFeedbackNotice, feedbackNotice } from '../../../../../lib/feedback/notice.ts';
import { errorResponse, notJson, readJson } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

// The sentences of the Closed α acknowledgement, reused as they are: the same refusals, the same words.
const MESSAGES = {
  invalid: 'The request must name the version of the notice, and nothing else.',
  notCurrent: 'The notice has changed since this page was opened. Reload the page and read the notice again.',
};

async function versionOf(request: Request): Promise<unknown> {
  const body = await readJson(request, 1024);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { version, ...rest } = body as Record<string, unknown>;
  return Number.isSafeInteger(version) && Object.keys(rest).length === 0 ? version : undefined;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
    if (!feedbackIntakeEnabled()) return errorResponse(404, 'not_found', '');
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const version = await versionOf(request);
    if (version === undefined) return errorResponse(422, 'invalid_request', MESSAGES.invalid);
    if (!(await acknowledgeFeedbackNotice(session.userId, version))) {
      return errorResponse(409, 'notice_version_not_current', MESSAGES.notCurrent);
    }
    return Response.json(await feedbackNotice(session.userId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fault('feedback-notice', error);
  }
}
