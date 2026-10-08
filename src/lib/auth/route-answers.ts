// The answers a route gives in the same words as the request-interception
// layer (src/proxy.ts), which a route does not rest on: each validates the
// session itself (NFR-SE-02). And the answer to a limit reached, which the
// proxy gives for its limits and a route for its own (NFR-SE-07).
import { faultOf } from '../fault.ts';
import { errorResponse, INTERNAL_FAULT } from '../http.ts';
import { logLimitReached } from '../rate-limit.ts';
import type { LimitName } from '../settings.ts';

/**
 * NFR-SE-07: a 429 that states when the caller may try again, in a header and
 * in words, with its entry in the security log, one for each period of the
 * limit (NFR-SE-19; rate-limit.ts). The text is for a person (the owner's
 * answer to Q6 of the plan).
 */
export async function tooManyRequests(
  limit: LimitName,
  key: string,
  seconds: number,
  userId?: string,
): Promise<Response> {
  await logLimitReached(limit, key, seconds, userId);
  return errorResponse(
    429,
    'rate_limited',
    `Too many requests were made in a short time. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
    { 'Retry-After': String(seconds) },
  );
}

/**
 * The statement of a 403 for a request that did not come from the
 * application's own origin (NFR-SE-17 (c)): the proxy's, and the identity
 * library's own refusal in the same words (auth.ts).
 */
export const FORBIDDEN =
  'This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again.';

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
  return errorResponse(500, 'internal', INTERNAL_FAULT);
}
