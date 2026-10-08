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
import { settings } from '../settings.ts';
import { signInEmail, signOut } from './sign-in.ts';

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
  // FR-AU-84: signing out ends the session at once and clears the browser's
  // cookies. The application's own too.
  'POST /sign-out',
]);

// FR-AU-81, FR-AU-84: the application's sign-in and sign-out. A plugin's
// endpoint replaces the library's of the same name, so the library's own
// sign-in and sign-out are not in the handler and not in `auth().api`.
const ownSignIn = {
  id: 'ekdotico-sign-in',
  endpoints: { signInEmail, signOut },
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
  // NFR-SE-17 (b), (c): the library also reads variables of its own, which can
  // switch its telemetry on and add trusted origins whatever is written below.
  // The configuration is this file and the application's settings, and nothing else.
  const stray = Object.keys(process.env).filter((name) => name.startsWith('BETTER_AUTH_'));
  if (stray.length > 0) {
    throw new Error(
      `Unset ${stray.join(', ')}: the identity library is configured by the application alone.`,
    );
  }
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
    // authenticator application with recovery codes (FR-AU-83). Its code by
    // email exists only where a function to send one is configured; none is.
    // `admissionSignUp` (FR-AU-90) has one endpoint, without a path: the
    // handler cannot reach it, and only `POST /api/sign-up` calls it.
    plugins: [twoFactor(), surface, ownSignIn, admissionSignUp],
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
    // sign-up, a database fault with the values of its query). It logs nothing,
    // and a fault is reported by its class alone.
    logger: { disabled: true },
    onAPIError: {
      onError: (error) => {
        // A refusal of the request itself, the library's or its router's, is no fault.
        if (isAPIError(error) && error.statusCode < 500) return;
        console.error(`identity: request failed (${error instanceof Error ? error.name : 'unknown'})`);
        // Left here, the library's router prints the fault whole, with whatever
        // the database or Valkey put in it, and answers with no body. It
        // answers an API error thrown from this function instead: the one
        // shape of an error, in the words of proxy.ts (NFR-SE-06 A10).
        throw new APIError('INTERNAL_SERVER_ERROR', {
          error: {
            code: 'internal',
            message:
              'The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes.',
          },
        });
      },
    },
  });
}

let instance: ReturnType<typeof create> | undefined;

/** The one instance of a process, created at its first use. */
export function auth(): ReturnType<typeof create> {
  return (instance ??= create());
}
