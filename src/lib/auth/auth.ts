// The application's one configuration of the identity library, Better Auth
// (FR-AU-05, NFR-SE-01, NFR-SE-17). The web application and the collaboration
// server load this module and no other (NFR-SE-17 (f)), so it imports nothing
// of Next.js, and it reads no environment until `auth()` is first called.
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { admissionSignUp } from '../admission/sign-up.ts';
import { clientAddress, UNKNOWN_ADDRESS } from '../client-address.ts';
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';
import { INTERNAL_FAULT } from '../http.ts';
import { securityLog } from '../security-log.ts';
import { settings } from '../settings.ts';
import { changeEmail, updateUser, verifyEmail } from './name-and-address.ts';
import { changePassword, requestPasswordReset, resetPassword } from './password.ts';
import { FORBIDDEN } from './route-answers.ts';
import { revokeOtherSessions, revokeSession } from './session-list.ts';
import { signInEmail, signInLink, signOut } from './sign-in.ts';
import {
  disableTwoFactor,
  enableTwoFactor,
  generateBackupCodes,
  verifyBackupCode,
  verifyTOTP,
} from './two-factor.ts';

// Text for a person, for the owner's approval: the statement of the router's
// 400 and 415, which the library words in its own way.
const NOT_JSON =
  'Ekdotico could not read the request, and nothing was changed. A request to this address holds JSON, sent with the content type application/json.';

/** Where the library's handler is mounted (API design, "Sign-in and identity"). */
export const IDENTITY_BASE_PATH = '/api/auth';

/**
 * NFR-SE-17 (d): the endpoints of the library that answer a request, as method
 * and path under `IDENTITY_BASE_PATH`. Every other request to the handler is
 * answered 404 before the library reads it, so an endpoint the library has, or
 * gains in an update, is off until it is written here (NFR-IC-20).
 *
 * An endpoint is written here by the slice that builds its requirement whole,
 * with that slice's tests, because as the library ships them several do less
 * or more than their requirement: the second step of a sign-in can remember a
 * device, which FR-AU-83 forbids; two-factor authentication is turned off with
 * the password alone; a change of password ends the other sessions only where
 * the request asks (FR-AU-85); and the sessions are ended by their tokens.
 */
export const IDENTITY_ENDPOINTS: ReadonlySet<string> = new Set([
  // FR-AU-81: sign-in by email address and password, the only way to sign in.
  // The endpoint is the application's own (sign-in.ts).
  'POST /sign-in/email',
  // FR-AU-81: the one exception, the single-use sign-in link of a lock email
  // (register D115; A104, assumed). The application's own (sign-in.ts), and
  // not the library's magic link, which is not installed (NFR-SE-17 (d)).
  'POST /sign-in/link',
  // FR-AU-84: signing out ends the session at once and clears the browser's
  // cookies. The application's own too.
  'POST /sign-out',
  // FR-AU-86: the request for a password reset, and its completion by the
  // token of the emailed link. Both the application's own (password.ts).
  'POST /request-password-reset',
  'POST /reset-password',
  // FR-AU-85: the change of the password in the account settings, which ends
  // every other session. The application's own (password.ts).
  'POST /change-password',
  // FR-AU-85: ending one session, named by its identifier and never by its
  // token, and ending all but the one in use. The application's own
  // (session-list.ts). The list itself is read by the settings page and is no
  // endpoint: the library's returns every session's token.
  'POST /revoke-session',
  'POST /revoke-other-sessions',
  // FR-AU-83: two-factor authentication by authenticator application, with
  // recovery codes. All five are the application's own (two-factor.ts), under
  // the plugin's names and paths: the beginning of an enrolment; a code of the
  // authenticator, which confirms an enrolment under a session and is the
  // second step of a sign-in without one (FR-AU-81); the second step by a
  // recovery code; turning it off; and replacing the recovery codes. The
  // plugin's code by email (`/two-factor/send-otp`, `/two-factor/verify-otp`)
  // and its `/two-factor/get-totp-uri`, which shows a secret again, are not
  // in the handler at all (`secondFactor`, below).
  'POST /two-factor/enable',
  'POST /two-factor/verify-totp',
  'POST /two-factor/verify-backup-code',
  'POST /two-factor/disable',
  'POST /two-factor/generate-backup-codes',
  // FR-AU-90: the change of the name in the account settings. FR-AU-03: the
  // request for a change of the address, and its confirmation by the token of
  // the link sent to the new address, which is a POST and never the library's
  // GET (the owner's answer to Q3 of the plan). All three are the
  // application's own (name-and-address.ts), under the library's paths.
  'POST /update-user',
  'POST /change-email',
  'POST /verify-email',
]);

// FR-AU-81, FR-AU-84: the application's sign-in and sign-out. A plugin's
// endpoint replaces the library's of the same name, so the library's own
// sign-in and sign-out are not in the handler and not in `auth().api`.
const ownSignIn = {
  id: 'ekdotico-sign-in',
  endpoints: { signInEmail, signInLink, signOut },
} satisfies BetterAuthPlugin;

// FR-AU-85, FR-AU-86: the same for the password and the sessions. The
// library's `requestPasswordResetCallback`, `listSessions` and
// `revokeSessions` are left as they are and answer nothing.
const ownCredentials = {
  id: 'ekdotico-credentials',
  endpoints: { requestPasswordReset, resetPassword, changePassword, revokeSession, revokeOtherSessions },
} satisfies BetterAuthPlugin;

// FR-AU-03, FR-AU-90: the same for the name and the address. The library's
// own change of an address stays switched off in its options as well, below.
const ownAccount = {
  id: 'ekdotico-account',
  endpoints: { updateUser, changeEmail, verifyEmail },
} satisfies BetterAuthPlugin;

// FR-AU-83, NFR-SE-17 (d): two-factor authentication by authenticator
// application, with recovery codes. The library's plugin, as it is given no
// option, with the application's five endpoints in place of all of its own
// (two-factor.ts) and without its step after a sign-in. What is kept of it is
// its schema, which puts `twoFactorEnabled` on the account the library answers
// with a session. What is left out with the rest: its code by email, its
// endpoint that shows a secret again, its function that reads the recovery
// codes of any account, its remembering of a device, and its own count and
// lock of wrong codes. Two plugins that name one path make the library report
// an error at each start, so the five are not mounted from a plugin of their own.
const secondFactor = {
  ...twoFactor(),
  endpoints: { enableTwoFactor, verifyTOTP, verifyBackupCode, disableTwoFactor, generateBackupCodes },
  hooks: undefined,
} satisfies BetterAuthPlugin;

// The application's own gate, and no feature of the library.
const surface = {
  id: 'ekdotico-surface',
  onRequest: async (request) => {
    // The path is compared as it was sent: no decoding, no folding of case, no
    // trailing slash, so nothing but the listed spelling is served.
    const endpoint = new URL(request.url).pathname.slice(IDENTITY_BASE_PATH.length);
    if (IDENTITY_ENDPOINTS.has(`${request.method} ${endpoint}`)) return;
    return { response: new Response(null, { status: 404 }) };
  },
} satisfies BetterAuthPlugin;

function create() {
  // NFR-SE-17 (b), (c): the configuration is this file and the application's
  // settings, and nothing else. The settings refuse to load where a variable
  // of the library's own is set (settings.ts).
  const {
    appOrigin,
    authSecret,
    sessionIdleSeconds,
    sessionRenewSeconds,
    cookieCacheSeconds,
    passwordMinLength,
    passwordMaxLength,
  } = settings();

  return betterAuth({
    baseURL: appOrigin,
    basePath: IDENTITY_BASE_PATH,
    // NFR-SE-17 (e): signs the cookies, and is the key under which the second
    // factor is encrypted at rest (a).
    secret: authSecret,
    // NFR-SE-17 (b): the tables are in the application schema, under the runtime role.
    database: prismaAdapter(db(), { provider: 'postgresql' }),
    // NFR-SE-17 (c): the allow-list holds the application's own origin and no other.
    trustedOrigins: [appOrigin],
    // NFR-SE-17 (b): nothing is sent to the library's maker.
    telemetry: { enabled: false },

    // NFR-SE-17 (d), FR-AU-81: an email address and a password, and no other way in.
    emailAndPassword: {
      enabled: true,
      // FR-AU-57: an account is created from an admission invitation alone (FR-AU-90).
      disableSignUp: true,
      // FR-AU-81: an account can be used only once its address is verified.
      requireEmailVerification: true,
      // FR-AU-82: the two limits of a password are settings.
      minPasswordLength: passwordMinLength,
      maxPasswordLength: passwordMaxLength,
    },
    // No `socialProviders`, and of the plugins only two-factor authentication by
    // authenticator application with recovery codes (FR-AU-83), whose
    // endpoints are the application's own (`secondFactor`, above).
    // `admissionSignUp` (FR-AU-90) has one endpoint, without a path: the
    // handler cannot reach it, and only `POST /api/sign-up` calls it.
    plugins: [secondFactor, surface, ownSignIn, ownCredentials, ownAccount, admissionSignUp],
    // NFR-SE-17 (d): each is off in the library by default but the linking of
    // accounts; all three are written so that a changed default changes nothing.
    account: { accountLinking: { enabled: false } },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },

    session: {
      // FR-AU-84: 7 days after the last renewal, renewed at most once in 24
      // hours. The 30 days from the beginning are the application's own check,
      // in session.ts: the library has none.
      expiresIn: sessionIdleSeconds,
      updateAge: sessionRenewSeconds,
      // NFR-SE-17 (c): the signed copy, 1 minute old at most, for requests that only read.
      cookieCache: { enabled: true, maxAge: cookieCacheSeconds },
    },
    advanced: {
      // NFR-SE-17 (c): HttpOnly, Secure, SameSite=Lax, and host-only (no
      // `Domain`). Secure follows the origin, which settings.ts lets be plain
      // HTTP on a development machine alone.
      useSecureCookies: appOrigin.startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      crossSubDomainCookies: { enabled: false },
      // NFR-SE-17 (c): the library's own check of the `Origin` of a request
      // that carries cookies stands behind the proxy's. Left unwritten, the
      // library switches it off wherever NODE_ENV is `test`.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    databaseHooks: {
      session: {
        create: {
          // FR-AU-84: the library would record the address from
          // `X-Forwarded-For` as the client wrote it. Whatever it found is
          // replaced by the address the application derives, or by none.
          before: async (session, context) => {
            const headers = context?.headers ?? context?.request?.headers;
            const address = headers ? clientAddress(headers) : UNKNOWN_ADDRESS;
            return { data: { ...session, ipAddress: address === UNKNOWN_ADDRESS ? null : address } };
          },
        },
      },
    },

    // NFR-SE-07: the library's limiter counts in the memory of one instance.
    // It is off; the proxy limits the handler's paths from Valkey.
    rateLimit: { enabled: false },
    // NFR-SE-19: the library logs what a request carried (an address at
    // sign-up, a database fault with the values of its query). Of what it
    // logs, only that it reported an error is printed, never the message or
    // what came with it: an error it logs and continues past would otherwise
    // go unseen. A fault it throws is reported by its class and code.
    logger: {
      level: 'error',
      log: (level) => {
        if (level === 'error') console.error('identity: library reported (error)');
      },
    },
    onAPIError: {
      onError: (error) => {
        // The router answers an API error thrown from this function: the one
        // shape of an error (the owner's answer to Q8), in the words of proxy.ts.
        const answer = (status: 400 | 403 | 415 | 500, code: string, message: string) =>
          new APIError(status, { error: { code, message } }, { 'Cache-Control': 'no-store' });
        if (isAPIError(error) && error.statusCode < 500) {
          // The library's own refusal of a request from another origin, or of
          // a place to go to on one. NFR-SE-19: a 403 has its entry; no user
          // is known here. The library does not wait for this function, so
          // the entry is not waited for; writing it never rejects.
          if (error.statusCode === 403) {
            void securityLog({ kind: 'forbidden' });
            throw answer(403, 'forbidden', FORBIDDEN);
          }
          // Its router's refusal of a body that is not JSON, or not sent as JSON.
          if (error.statusCode === 400 || error.statusCode === 415) {
            throw answer(error.statusCode, 'invalid_request', NOT_JSON);
          }
          // Any other refusal of the request itself is no fault.
          return;
        }
        console.error(`identity: request failed (${faultOf(error)})`);
        // Left here, the library's router prints the fault whole, with whatever
        // the database or Valkey put in it, and answers with no body (NFR-SE-06 A10).
        throw answer(500, 'internal', INTERNAL_FAULT);
      },
    },
  });
}

let instance: ReturnType<typeof create> | undefined;

/** The one instance of a process, created at its first use. */
export function auth(): ReturnType<typeof create> {
  return (instance ??= create());
}
