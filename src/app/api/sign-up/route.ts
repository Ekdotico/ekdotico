// FR-AU-90: accept an admission invitation. No session (NFR-SE-05 (a)): the
// request is authorised by the token of a pending invitation, and by nothing
// else. The origin check and the limit for each network address are the
// proxy's (src/proxy.ts, group (a)).
import { auth } from '../../../lib/auth/auth.ts';
import { readSignUpBody } from '../../../lib/admission/sign-up.ts';
import { errorResponse } from '../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const MESSAGES = {
  // FR-AU-90, verbatim: one statement, whichever of the reasons applies.
  notOpen: 'This invitation is not open. Ask the Ekdotico team for a new one.',
  // Text for a person (the owner's answer to Q6 of the plan).
  invalid:
    'The account was not created, because the name or the password does not meet its rule. Change what is marked and try again.',
  internal: 'The account could not be created because of a fault on the server. Try again in a few minutes.',
};

export async function POST(request: Request): Promise<Response> {
  try {
    const { headers, response: result } = await auth().api.acceptAdmissionInvitation({
      body: await readSignUpBody(request),
      headers: request.headers,
      returnHeaders: true,
    });
    if (result.outcome === 'not_open') {
      return errorResponse(409, 'invitation_not_open', MESSAGES.notOpen);
    }
    if (result.outcome === 'invalid') {
      return Response.json(
        { error: { code: 'invalid', message: MESSAGES.invalid, fields: result.fields } },
        { status: 422, headers: NO_STORE },
      );
    }
    // The session cookie, and the signed copy of the session beside it.
    const created = Response.json({}, { status: 201, headers: NO_STORE });
    for (const cookie of headers.getSetCookie()) created.headers.append('Set-Cookie', cookie);
    return created;
  } catch (error) {
    // NFR-SE-06, A10; NFR-SE-19: the class of the fault alone, since an error
    // of the database can quote a row.
    console.error(`sign-up: request failed (${error instanceof Error ? error.name : 'unknown'})`);
    return errorResponse(500, 'internal', MESSAGES.internal);
  }
}
