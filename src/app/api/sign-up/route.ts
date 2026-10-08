// FR-AU-90: accept an admission invitation. No session (NFR-SE-05 (a)): the
// request is authorised by the token of a pending invitation, and by nothing
// else. The limit for each network address is the proxy's (src/proxy.ts,
// group (a)); the origin check is the proxy's and, since the proxy can be
// skipped, this route's own as well.
import { auth } from '../../../lib/auth/auth.ts';
import { refusedOrigin } from '../../../lib/auth/route-answers.ts';
import { readSignUpBody } from '../../../lib/admission/sign-up.ts';
import { INVITATION_NOT_OPEN } from '../../../lib/admission/statements.ts';
import { faultOf } from '../../../lib/fault.ts';
import { errorResponse } from '../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const MESSAGES = {
  // Text for a person (the owner's answer to Q6 of the plan).
  invalid:
    'The account was not created, because the name or the password does not meet its rule. Change what is marked and try again.',
  tooLong:
    'The account was not created, because the request is longer than a name and a password can make it. Shorten the name or the password and try again.',
  notRead:
    'The account was not created, because the request could not be read. Reload the page and try again.',
  internal: 'The account could not be created because of a fault on the server. Try again in a few minutes.',
};

export async function POST(request: Request): Promise<Response> {
  try {
    // NFR-SE-17 (c): before anything of the request is read.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
    // A request that cannot be read says nothing of its invitation, so it is
    // answered before the endpoint is called, and never as "not open": the
    // invitation stands, and the form keeps what was typed.
    const body = await readSignUpBody(request);
    if ('refused' in body) {
      return body.refused === 'too_long'
        ? errorResponse(413, 'invalid', MESSAGES.tooLong)
        : errorResponse(422, 'invalid', MESSAGES.notRead);
    }
    const { headers, response: result } = await auth().api.acceptAdmissionInvitation({
      body: body.json,
      headers: request.headers,
      returnHeaders: true,
    });
    if (result.outcome === 'not_open') {
      return errorResponse(409, 'invitation_not_open', INVITATION_NOT_OPEN);
    }
    if (result.outcome === 'invalid') {
      return Response.json(
        { error: { code: 'invalid', message: MESSAGES.invalid, fields: result.fields } },
        { status: 422, headers: NO_STORE },
      );
    }
    // The session cookie, and the signed copy of the session beside it. Where
    // the session could not be started there is neither, and the body says so:
    // the form then opens the sign-in page.
    const created = Response.json({ signedIn: result.signedIn }, { status: 201, headers: NO_STORE });
    for (const cookie of headers.getSetCookie()) created.headers.append('Set-Cookie', cookie);
    return created;
  } catch (error) {
    // NFR-SE-06, A10; NFR-SE-19: the class of the fault and its code, since an
    // error of the database can quote a row.
    console.error(`sign-up: request failed (${faultOf(error)})`);
    return errorResponse(500, 'internal', MESSAGES.internal);
  }
}
