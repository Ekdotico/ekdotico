// FR-AU-56: record the current account's acknowledgement of the Closed α
// notice (API design, "Account"). It changes state, so it reads the session's
// row (NFR-SE-17 (c)); the origin check is the proxy's. The account is the
// session's and never the request's: "accepted only from the signed-in account
// itself".
import { fault, notAdmitted } from '../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../lib/auth/session.ts';
import { errorResponse, readJson } from '../../../../../lib/http.ts';
import { acknowledgeNotice, onboarding } from '../../../../../lib/onboarding.ts';

export const dynamic = 'force-dynamic';

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  invalid: 'The request must name the version of the notice, and nothing else.',
  notCurrent: 'The notice has changed since this page was opened. Reload the page and read the notice again.',
};

/** The body: `{ "version": n }`. Any other field is refused (API design). */
async function versionOf(request: Request): Promise<unknown> {
  // Sent as JSON, and no longer than a version and the JSON around it (src/lib/http.ts).
  const body = await readJson(request, 1024);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { version, ...rest } = body as Record<string, unknown>;
  return Number.isSafeInteger(version) && Object.keys(rest).length === 0 ? version : undefined;
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Authorisation before validation (the owner's answer to Q8).
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    // FR-AU-83: 403 for an account the founding-team gate stops, which meets
    // the enrolment "before the Closed α notice"; 401 without a session.
    if (!session) return await notAdmitted(validation);

    const version = await versionOf(request);
    if (version === undefined) return errorResponse(422, 'invalid_request', MESSAGES.invalid);
    // "A version other than the current one is refused with a 409 response."
    if (!(await acknowledgeNotice(session.userId, version))) {
      return errorResponse(409, 'notice_version_not_current', MESSAGES.notCurrent);
    }
    return Response.json(await onboarding(session.userId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fault('onboarding', error);
  }
}
