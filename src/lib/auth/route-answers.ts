// The two answers every route with a session gives in the same words as the
// request-interception layer (src/proxy.ts), which a route does not rest on:
// each validates the session itself (NFR-SE-02).
import { faultOf } from '../fault.ts';
import { errorResponse } from '../http.ts';

/** FR-AU-07: no valid session. */
export function unauthenticated(): Response {
  return errorResponse(
    401,
    'unauthenticated',
    'This request needs a signed-in session. Sign in and try again.',
  );
}

/**
 * NFR-SE-06, A10: a fault is answered without a word of it. NFR-SE-19: the log
 * holds its class and its code, since an error of the database can quote a row.
 */
export function fault(route: string, error: unknown): Response {
  console.error(`${route}: request failed (${faultOf(error)})`);
  return errorResponse(
    500,
    'internal',
    'The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes.',
  );
}
