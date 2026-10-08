// The request-interception layer (NFR-SE-02, NFR-SE-05, NFR-SE-07). In
// Next.js 16 it is this file, and it runs on the Node.js runtime, so it can
// read the session's row.
//
// It exports no `config.matcher`: it runs on every request. A path a matcher
// left out would be a path without validation that the list below does not
// show, and the list is what is reviewed on each deployment (NFR-SE-05).
import { NextResponse, type NextRequest } from 'next/server';
import { IDENTITY_BASE_PATH } from './lib/auth/auth.ts';
import { FORBIDDEN, notAdmitted, tooManyRequests } from './lib/auth/route-answers.ts';
import { validateSession } from './lib/auth/session.ts';
import { addressBucket } from './lib/client-address.ts';
import { faultOf } from './lib/fault.ts';
import { errorResponse, INTERNAL_FAULT, onlyReads, returnPath } from './lib/http.ts';
import { isOwnOrigin } from './lib/origin.ts';
import { takeLimit } from './lib/rate-limit.ts';
import { securityLog } from './lib/security-log.ts';
import { settings } from './lib/settings.ts';

/** Where a visitor without a session is sent (FR-AU-07; API design, "Sign-in and identity"). */
export const SIGN_IN_PATH = '/sign-in';
/** The query parameter that carries where to return to. The name is this file's. */
export const RETURN_PARAMETER = 'return';

type Group = 'a' | 'b' | 'c';

/**
 * NFR-SE-05: the request paths that carry no session, and the only ones. A
 * path that is not here requires a session. A method that is not here does
 * too, and a HEAD goes where its GET goes.
 *
 * Matching is exact, on the path as Next.js hands it over: no folding of case,
 * no trailing slash, no decoding. `[token]` and `[id]` stand for one segment
 * of letters, digits, `-` and `_`, which is what a token and an identifier are
 * made of; a segment with anything else in it, an encoded slash included, is
 * not on the list. The paths are those of the API design page.
 */
export const SESSIONLESS: readonly { group: Group; methods: readonly string[]; path: string }[] = [
  // (a) The pages a person without a session opens (FR-AU-88).
  { group: 'a', methods: ['GET'], path: '/sign-in' }, // FR-AU-81
  { group: 'a', methods: ['GET'], path: '/sign-in/two-factor' }, // FR-AU-81, FR-AU-83, FR-AU-88: the page of the second step, between the password and the session; the path is this application's
  { group: 'a', methods: ['GET', 'POST'], path: '/sign-in/link/[token]' }, // FR-AU-81: the link of a lock email; the POST is its one control (register D115; A104, assumed)
  { group: 'a', methods: ['GET'], path: '/sign-up' }, // FR-AU-90: "without a token" it shows the fixed statement (the owner's decision of 8 October 2026)
  { group: 'a', methods: ['GET'], path: '/sign-up/[token]' }, // FR-AU-90: the link of an admission invitation
  { group: 'a', methods: ['GET'], path: '/reset-password' }, // FR-AU-86
  { group: 'a', methods: ['GET'], path: '/reset-password/[token]' }, // FR-AU-86
  { group: 'a', methods: ['GET'], path: '/confirm-address/[token]' }, // FR-AU-03
  // (a) The endpoints of the identity library that a person without a session
  // must reach, one by one and never the prefix: every other endpoint under
  // /api/auth is validated here like any route. Each is also on the list of
  // src/lib/auth/auth.ts, without which the handler does not serve it.
  { group: 'a', methods: ['POST'], path: `${IDENTITY_BASE_PATH}/sign-in/email` }, // FR-AU-81
  { group: 'a', methods: ['POST'], path: `${IDENTITY_BASE_PATH}/two-factor/verify-totp` }, // FR-AU-81, FR-AU-83: the second step, authorised by the cookie of a step that is open; under a session, the first code of an enrolment, whose session the endpoint reads itself
  { group: 'a', methods: ['POST'], path: `${IDENTITY_BASE_PATH}/two-factor/verify-backup-code` }, // FR-AU-83: the second step, by a recovery code
  { group: 'a', methods: ['POST'], path: `${IDENTITY_BASE_PATH}/request-password-reset` }, // FR-AU-86
  { group: 'a', methods: ['POST'], path: `${IDENTITY_BASE_PATH}/reset-password` }, // FR-AU-86: authorised by the token of a reset link
  // (a) The application's own endpoint that accepts an admission invitation.
  { group: 'a', methods: ['POST'], path: '/api/sign-up' }, // FR-AU-90
  // (b) The admission endpoints, authenticated by signature in the route (FR-AU-89).
  { group: 'b', methods: ['POST', 'GET'], path: '/api/admission/invitations' }, // FR-AU-89 (a), (b)
  { group: 'b', methods: ['DELETE'], path: '/api/admission/invitations/[id]' }, // FR-AU-89 (c)
  // (c) The health check (NFR-RE-03).
  { group: 'c', methods: ['GET'], path: '/api/health' },
];

/**
 * FR-AU-83: what the founding-team gate lets through for an account that it
 * stops: "every API route refuses the account's requests other than those of
 * the enrolment itself", and the screen of the enrolment has "the means to
 * sign out beside it". The first code of the enrolment is the third request,
 * and is on the list above. Each endpoint lets such an account through itself
 * as well (two-factor.ts; sign-in.ts), since the proxy can be skipped.
 */
export const PAST_THE_GATE: ReadonlySet<string> = new Set([
  `POST ${IDENTITY_BASE_PATH}/two-factor/enable`,
  `POST ${IDENTITY_BASE_PATH}/sign-out`,
]);

/**
 * (a) "The static assets they load": the files of the build, which Next.js
 * serves under this prefix and nowhere else, to a GET alone. The application
 * has no `public` directory, and the image optimiser (`/_next/image`) is not
 * on the list.
 */
export const STATIC_PREFIX = '/_next/static/';

const PATTERNS = SESSIONLESS.map((entry) => ({
  ...entry,
  pattern: new RegExp(`^${entry.path.replace(/\[[a-z]+\]/g, '[A-Za-z0-9_-]+')}$`),
}));

/** What the list says of a request: one of its groups, a static asset, or a session. */
export function classify(method: string, pathname: string): Group | 'static' | 'session' {
  const asked = method === 'HEAD' ? 'GET' : method;
  // The one match by prefix. The platform's URL parser has resolved `..` before
  // a path arrives here; a path that still holds a way out of the prefix, plain
  // or encoded, is not a file of the build.
  if (asked === 'GET' && pathname.startsWith(STATIC_PREFIX) && !/\.\.|\/\/|\\|%2e|%2f|%5c/i.test(pathname)) {
    return 'static';
  }
  const entry = PATTERNS.find((each) => each.pattern.test(pathname) && each.methods.includes(asked));
  return entry ? entry.group : 'session';
}

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  unauthenticated: 'This request needs a signed-in session. Sign in and try again.',
  forbidden: FORBIDDEN,
  internal: INTERNAL_FAULT,
};

function withCookies<T extends Response>(response: T, setCookie: readonly string[]): T {
  for (const cookie of setCookie) response.headers.append('Set-Cookie', cookie);
  return response;
}

// NFR-SE-17 (c), NFR-SE-19: a 403, and its entry in the security log.
async function forbidden(userId?: string): Promise<Response> {
  await securityLog({ kind: 'forbidden', userId });
  return errorResponse(403, 'forbidden', MESSAGES.forbidden);
}

/** What a request was waiting on, set before each wait, so that the line of a fault names it. */
interface Progress {
  stage: 'start' | 'limit' | 'session' | 'origin' | 'gate' | 'log mark';
}

async function decide(request: NextRequest, progress: Progress): Promise<Response> {
  const { method, headers } = request;
  const { pathname, search } = request.nextUrl;
  const changesState = !onlyReads(method);
  const group = classify(method, pathname);

  // (c) The health check is exempt from every limit (NFR-SE-07), and static
  // assets are not among the rows of its table.
  if (group === 'c' || group === 'static') return NextResponse.next();

  // (b) The admission endpoints pass untouched. Their limit, 60 in any minute
  // in all, cannot rightly be taken here: "a request whose signature does not
  // verify is rejected whatever the count" (NFR-SE-07), and the signature is
  // verified "before any processing" (NFR-SE-05 (b)), in the route, which
  // holds the body and the secret. Counted here, unsigned requests would spend
  // the limit and keep the team's command out. The route verifies, and then
  // takes the limit. Nor is the origin check theirs: they carry no session,
  // are called by a command and never from a browser, and the signature is
  // what authenticates them (NFR-SE-17 (c); API design, "Admission").
  if (group === 'b') return NextResponse.next();

  // (a) The pages and endpoints of a person without a session: limited for
  // each network address (NFR-SE-07), and counted before anything else, so
  // that the refusals below are bounded too.
  if (group === 'a') {
    const address = addressBucket(headers);
    progress.stage = 'limit';
    const limit = await takeLimit('SESSIONLESS_PER_ADDRESS', address);
    if (!limit.ok) {
      progress.stage = 'log mark';
      return await tooManyRequests('SESSIONLESS_PER_ADDRESS', address, limit.retryAfterSeconds);
    }
    // NFR-SE-17 (c): "every request that changes state", a sign-in and the
    // acceptance of an invitation among them.
    if (changesState && !isOwnOrigin(headers.get('origin'))) {
      progress.stage = 'origin';
      return await forbidden();
    }
    return NextResponse.next();
  }

  // Every other path requires a session. The order is that of the owner's
  // answer to Q8, "authorisation before validation": who is asking (401),
  // whether the request may be made at all (403), and only then anything about
  // the request itself, which is the route's (422 and the rest). The limit
  // comes after the origin check, so that a page on another origin cannot
  // spend a user's limit with requests that are refused anyway.
  progress.stage = 'session';
  const { session: admitted, stopped, setCookie } = await validateSession(method, headers);
  // The session of an account the founding-team gate stops is a session: the
  // account is known, and is refused below, where the gate sits.
  const session = admitted ?? stopped;
  const api = pathname === '/api' || pathname.startsWith('/api/');
  if (!session) {
    // FR-AU-07: 401 for an API route, and for anything that changes state. A
    // page that is read sends its visitor to sign in, with the place to return to.
    if (changesState || api) {
      return withCookies(errorResponse(401, 'unauthenticated', MESSAGES.unauthenticated), setCookie);
    }
    const signIn = new URL(SIGN_IN_PATH, settings().appOrigin);
    signIn.searchParams.set(RETURN_PARAMETER, returnPath(pathname + search));
    return withCookies(NextResponse.redirect(signIn), setCookie);
  }

  // NFR-SE-17 (c): refused unless the `Origin` header is the application's own.
  if (changesState && !isOwnOrigin(headers.get('origin'))) {
    progress.stage = 'origin';
    return await forbidden(session.userId);
  }

  // NFR-SE-07: requests to API routes, for each authenticated user. Signing
  // out is not held back by it: it "ends the session at once" (FR-AU-84), and
  // a session can be ended once.
  const signsOut = method === 'POST' && pathname === `${IDENTITY_BASE_PATH}/sign-out`;
  if (pathname.startsWith('/api/') && !signsOut) {
    progress.stage = 'limit';
    const limit = await takeLimit('API_PER_USER', session.userId);
    if (!limit.ok) {
      progress.stage = 'log mark';
      return await tooManyRequests('API_PER_USER', session.userId, limit.retryAfterSeconds, session.userId);
    }
  }

  // The founding-team gate of FR-AU-83: "every API route refuses the
  // account's requests other than those of the enrolment itself" (403, by the
  // owner's answer to Q8), and so does anything else that changes state. It
  // sits after the limit, so that the entries of its refusals are bounded as
  // the requests are (NFR-SE-19). A page that is read passes: the signed-in
  // layout shows the enrolment "in place of its content"
  // (src/app/(app)/account.ts), which is decided on the server there.
  if (stopped && (changesState || api) && !PAST_THE_GATE.has(`${method} ${pathname}`)) {
    progress.stage = 'gate';
    return withCookies(await notAdmitted({ stopped }), setCookie);
  }

  // The route validates again where it needs the user (session.ts): no header
  // carries the identity from here, so there is none for a client to forge.
  return withCookies(NextResponse.next(), setCookie);
}

export async function proxy(request: NextRequest): Promise<Response> {
  const progress: Progress = { stage: 'start' };
  try {
    return await decide(request, progress);
  } catch (error) {
    // NFR-SE-06, A10: where the database, Valkey, or the library cannot answer,
    // the request is refused and never passed on, and the answer says nothing
    // of the fault. The log holds the stage it was at, and the class and code
    // of the fault, and nothing else (NFR-SE-19).
    console.error(`proxy: request refused at ${progress.stage} (${faultOf(error)})`);
    return errorResponse(500, 'internal', MESSAGES.internal);
  }
}
