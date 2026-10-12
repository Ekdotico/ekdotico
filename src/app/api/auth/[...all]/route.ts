// The identity library's handler (API design, "Sign-in and identity"). Which of
// its endpoints answer is settled in src/lib/auth/auth.ts, and which of them a
// person without a session reaches, in src/proxy.ts. No endpoint that answers
// is a GET, so no GET is mounted.
import { after } from 'next/server';
import { collecting } from '../../../../lib/after-response.ts';
import { auth, NOT_JSON } from '../../../../lib/auth/auth.ts';
import { refusedOrigin } from '../../../../lib/auth/route-answers.ts';
import { faultOf } from '../../../../lib/fault.ts';
import { errorResponse, INTERNAL_FAULT, sentAsJson } from '../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

/**
 * A request that holds no body, by its headers: the sign-out and the ending
 * of the other sessions are sent so (src/components/send.ts), and their
 * endpoints read none. A body sent without a type has a length that is not 0,
 * or is sent in chunks.
 */
function holdsNoBody({ headers }: Request): boolean {
  return (
    !headers.has('content-type') &&
    !headers.has('transfer-encoding') &&
    (headers.get('content-length') ?? '0') === '0'
  );
}

/**
 * What is refused before the library reads anything. Its router holds a body
 * to `application/json` only where the endpoint reads one, and loosely; here
 * every endpoint is held to it, as `readJson` holds the application's own
 * routes (src/lib/http.ts), and answered as the router answers.
 */
async function refusal(request: Request): Promise<Response | null> {
  try {
    // NFR-SE-17 (c): the origin first, and here as well as in the proxy, which
    // can be skipped: a request of another origin is refused for that, and
    // nothing else of it is looked at.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
  } catch (error) {
    // NFR-SE-06, A10; NFR-SE-19: as the library's own faults are answered (auth.ts).
    console.error(`identity: request failed (${faultOf(error)})`);
    return errorResponse(500, 'internal', INTERNAL_FAULT);
  }
  if (sentAsJson(request) || holdsNoBody(request)) return null;
  return errorResponse(415, 'invalid_request', NOT_JSON);
}

export async function POST(request: Request) {
  const refused = await refusal(request);
  if (refused) return refused;
  const { result, tasks } = await collecting(() => auth().handler(request));
  // FR-AU-86, FR-AU-87, NFR-RE-15: what an endpoint left for after its
  // response, the email of the account above all, starts once the response
  // has been returned.
  for (const task of tasks) after(task);
  return result;
}
