// The answers a route gives in the same words as the request-interception
// layer (src/proxy.ts), which a route does not rest on: each validates the
// session itself (NFR-SE-02). And the answer to a limit reached, which the
// proxy gives for its limits and a route for its own (NFR-SE-07).
import { addressBucket } from '../client-address.ts';
import { faultOf } from '../fault.ts';
import { errorResponse, INTERNAL_FAULT } from '../http.ts';
import { isOwnOrigin } from '../origin.ts';
import { logLimitReached, oncePer } from '../rate-limit.ts';
import { securityLog } from '../security-log.ts';
import { settings, type LimitName } from '../settings.ts';
import type { Validation } from './session.ts';

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

/**
 * NFR-SE-17 (c): the origin check of an endpoint that changes state without a
 * session, made by the endpoint itself, since the proxy can be skipped
 * (docs/operations/deployment.md) and the identity library checks the origin
 * only of a request that carries a cookie. Null where the `Origin` header is
 * the application's own; otherwise the proxy's answer, to be returned before
 * anything of the request is read.
 *
 * NFR-SE-19: a 403 has its entry. The proxy writes one for each refusal,
 * after it has taken the limit for the network address, which bounds them. No
 * limit was taken where the proxy was skipped, so here it is one entry for
 * each period of that limit and each network address, by the mark of
 * rate-limit.ts: a flood from another origin writes to the database no faster.
 */
export async function refusedOrigin(headers: Headers | undefined): Promise<Response | null> {
  if (isOwnOrigin(headers?.get('origin'))) return null;
  const { windowSeconds } = settings().limits.SESSIONLESS_PER_ADDRESS;
  if (await oncePer(`foreign-origin:${addressBucket(headers ?? new Headers())}`, windowSeconds)) {
    await securityLog({ kind: 'forbidden' });
  }
  return errorResponse(403, 'forbidden', FORBIDDEN);
}

/** FR-AU-07: no valid session. */
export function unauthenticated(): Response {
  return errorResponse(
    401,
    'unauthenticated',
    'This request needs a signed-in session. Sign in and try again.',
  );
}

/**
 * FR-AU-83: the statement of the 403 that the founding-team gate answers (the
 * owner's answer to Q8). Text for a person (the owner's answer to Q6).
 */
export const TWO_FACTOR_REQUIRED =
  'This account belongs to the Ekdotico team, and it cannot be used until two-factor authentication is turned on. Open Ekdotico in the browser and turn it on.';

/**
 * The answer of a route to a request whose validation gave it no session:
 * 401 where there is none (FR-AU-07), and 403 where the session is that of an
 * account the founding-team gate stops, since "every API route refuses the
 * account's requests other than those of the enrolment itself" (FR-AU-83).
 * NFR-SE-19: a 403 has its entry.
 */
export async function notAdmitted({ stopped }: Pick<Validation, 'stopped'>): Promise<Response> {
  if (!stopped) return unauthenticated();
  await securityLog({ kind: 'forbidden', userId: stopped.userId });
  return errorResponse(403, 'two_factor_required', TWO_FACTOR_REQUIRED);
}

/**
 * NFR-SE-06, A10: a fault is answered without a word of it. NFR-SE-19: the log
 * holds its class and its code, since an error of the database can quote a row.
 */
export function fault(route: string, error: unknown): Response {
  console.error(`${route}: request failed (${faultOf(error)})`);
  return errorResponse(500, 'internal', INTERNAL_FAULT);
}
