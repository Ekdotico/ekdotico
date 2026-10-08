// Sign-in and sign-out (FR-AU-81, FR-AU-84), as endpoints of the application's
// own inside the identity library. auth.ts mounts each under the library's own
// name, so the library's endpoint of that name no longer exists. As it ships
// at 1.7.7 the library's sign-in answers in its own words and with a 403 where
// the address is not verified, returns the session's token and the user in the
// body, lets the request choose a session of 1 day (`rememberMe`), and counts
// nothing; its sign-out reports success where the row could not be deleted.
// And its deletion of a session reads the row first, takes a fault of that
// read for an absent row, and then deletes nothing and reports nothing: so a
// session is deleted here by the application's own client, which rejects.
//
// Every refusal of a sign-in is the one statement, the one status, one entry
// in the security log, and one run of the password hashing function, whatever
// its cause, so that neither the answer nor the time it takes shows whether
// the address belongs to an account (FR-AU-81). One refusal runs no hashing:
// that of an attempt which waited 10 seconds for its turn and got none, before
// anything of the address was read, so its time shows nothing of the address.
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createAuthEndpoint } from 'better-auth/api';
import { deleteSessionCookie, setSessionCookie } from 'better-auth/cookies';
import { addressBucket } from '../client-address.ts';
import { db } from '../db.ts';
import { errorResponse } from '../http.ts';
import { checkLimit, logLimitReached, takeLimit, type LimitResult } from '../rate-limit.ts';
import { securityLog } from '../security-log.ts';
import { passwordLength } from '../password-rules.ts';
import { settings, type LimitName } from '../settings.ts';
import { valkey } from '../valkey.ts';

/** FR-AU-81: the one fixed statement of a failed sign-in, verbatim. */
export const SIGN_IN_REFUSED = 'The email address or the password is not correct.';

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const INVALID_REQUEST = 'The request must hold an email address and a password, and nothing else.';

/**
 * The body of a sign-in: an email address and a password. Any other field is
 * refused (API design: "any other field is refused"), `rememberMe` and
 * `callbackURL` among them, so the request chooses nothing about the session.
 */
function credentials(body: unknown): { email: string; password: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { email, password, ...rest } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string' || Object.keys(rest).length > 0) return null;
  return { email, password };
}

// How long one attempt may hold its turn, and how long another waits for it.
const TURN_MS = 10_000;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/**
 * One attempt at a time for an email address entered, across instances. The
 * check of the limits, the verification and the count are then one step:
 * without this, attempts made at the same moment would each pass the check
 * before any of them was counted, and a limit of 5 would admit as many guesses
 * as arrive together. Valkey holds a keyed digest of the address (NFR-SE-01).
 *
 * An attempt that gets no turn in time throws `NoTurn`, and the sign-in is
 * refused (NFR-SE-06 A10). A turn ends by itself after `TURN_MS`, so a process
 * that stops holds no address for longer.
 * ponytail: attempts for one address queue; counting before the verification
 * and taking the count back on success, in rate-limit.ts, would need no turn.
 */
async function inTurn<T>(email: string, work: () => Promise<T>): Promise<T> {
  const digest = createHmac('sha256', settings().authSecret).update(`sign-in-turn:${email}`).digest('hex');
  const key = `sign-in-turn:${digest}`;
  const mine = randomUUID();
  const until = Date.now() + TURN_MS;
  while ((await valkey().set(key, mine, 'PX', TURN_MS, 'NX')) !== 'OK') {
    if (Date.now() > until) throw new NoTurn('sign-in: no turn');
    await pause(25);
  }
  try {
    return await work();
  } finally {
    // A release that fails must not take the place of the outcome, a session
    // already decided among them: the turn ends by itself after `TURN_MS`.
    try {
      await valkey().eval(RELEASE, 1, key, mine);
    } catch {
      console.error('sign-in: turn not released');
    }
  }
}

// The application's own faults, each told from any other in a fault line by its name (NFR-SE-19).
class NoTurn extends Error {
  name = 'SignInNoTurn';
}
class NoSession extends Error {
  name = 'SignInNoSession';
}

/** FR-AU-81: `POST /api/auth/sign-in/email`. The answer to success is `{}`: the session is the cookie alone (FR-AU-84). */
export const signInEmail = createAuthEndpoint('/sign-in/email', { method: 'POST' }, async (ctx) => {
  const entered = credentials(ctx.body);
  if (!entered) return errorResponse(422, 'invalid_request', INVALID_REQUEST);
  // FR-AU-02: an address is stored, and so compared, in lower case.
  // No address is longer than 254 characters; what is looked up and counted
  // is bounded, whatever was sent.
  const email = entered.email.slice(0, 255).toLowerCase();
  const { internalAdapter, password: hasher, authCookies, secret } = ctx.context;
  // NFR-SE-07: 5 in 15 minutes "for one email address from one network
  // address", and 20 in an hour for the address entered, from everywhere. A
  // bucket holds no space, so the first key cannot be read in two ways.
  const pair = `${addressBucket(ctx.headers ?? new Headers())} ${email}`;

  const attempt = await inTurn(email, async () => {
    // Both are asked, and the account is read, on every path: the same work
    // whether a limit is reached, the address is known, or the password is right.
    const [byPair, byEmail] = await Promise.all([
      checkLimit('FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS', pair),
      checkLimit('FAILED_SIGN_IN_PER_EMAIL', email),
    ]);
    const open = byPair.ok && byEmail.ok;
    // Two reads on every path. Asked for the user with its credentials in one
    // call, the library reads the credentials only where it found a user: one
    // read fewer for an address that belongs to no account.
    const user = (await internalAdapter.findUserByEmail(email))?.user;
    const hash = (await internalAdapter.findAccounts(user?.id ?? '')).find(
      (account) => account.providerId === 'credential' && account.accountId === user?.id,
    )?.password;
    // Verified only where the attempt could succeed: no limit is reached (a
    // refused attempt is not verified; the owner's answer to Q10), the address
    // belongs to an account with a password, the address is verified
    // (FR-AU-81), and the password is no longer than one can be (FR-AU-82).
    // Every other attempt hashes once instead, as the library does for an
    // unknown address, so each path runs scrypt exactly once.
    const passed =
      open && user?.emailVerified && hash && passwordLength(entered.password) <= settings().passwordMaxLength
        ? await hasher.verify({ hash, password: entered.password })
        : (await hasher.hash(''), false);
    // Counted on each failure, for an address that belongs to no account as
    // for one that does. An attempt refused by a limit is not counted and
    // extends nothing (Q10). A successful sign-in clears neither count: the
    // table names a completed password reset and the link of a lock email, and
    // nothing else.
    if (open && !passed) {
      await takeLimit('FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS', pair);
      await takeLimit('FAILED_SIGN_IN_PER_EMAIL', email);
    }
    return { user, passed, byPair, byEmail };
  }).catch((error: unknown) => {
    // An attempt that got no turn in time is a refusal and no fault: it
    // verified nothing and counts nothing, and is answered below as every
    // other refusal is.
    if (error instanceof NoTurn) return null;
    throw error;
  });
  const user = attempt?.user;

  if (!user || !attempt?.passed) {
    // NFR-SE-19: the user where the address belongs to an account, and never the address.
    await securityLog({ kind: 'sign_in_refused', userId: user?.id });
    // NFR-SE-19: a sign-in refused because a limit was already reached is that
    // event too, once for each period of the limit (rate-limit.ts). The same
    // work for an address with an account as for one without.
    const limits: [LimitName, string, LimitResult | undefined][] = [
      ['FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS', pair, attempt?.byPair],
      ['FAILED_SIGN_IN_PER_EMAIL', email, attempt?.byEmail],
    ];
    for (const [name, key, limit] of limits) {
      if (limit && !limit.ok) await logLimitReached(name, key, limit.retryAfterSeconds, user?.id);
    }
    // The owner's answer to Q1: no 429 for these limits, which would show that an address is limited.
    return errorResponse(401, 'sign_in_refused', SIGN_IN_REFUSED);
  }

  // A session the browser already holds is ended, whoever it belongs to: its
  // cookie is replaced below, and no browser could sign out of it afterwards.
  // No requirement asks this of a sign-in (FR-AU-81 asks it of the link of a
  // lock email alone): it is the application's choice, raised with the owner
  // in the register questions of the pull request. The row is deleted by the
  // application's own client, which rejects on a fault and is quiet where the
  // row is absent; the library's deletion can skip the row without a word.
  const held = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
  if (held) await db().session.deleteMany({ where: { token: held } });

  const session = await internalAdapter.createSession(user.id);
  if (!session) throw new NoSession('sign-in: no session');
  // `false`: the cookie lasts as long as the session, whatever an earlier cookie said.
  await setSessionCookie(ctx, { session, user }, false);
  // Where two-factor authentication is on, the library's plugin ends this
  // session here, before the answer, and asks for the second step (FR-AU-83).
  ctx.setHeader('Cache-Control', 'no-store');
  return ctx.json({});
});

/**
 * FR-AU-84: `POST /api/auth/sign-out`. "Signing out ends the session at once"
 * and clears the browser's cookies, the signed copy included. The body is not
 * read. A row that cannot be deleted is a fault, and never an answer of success.
 */
export const signOut = createAuthEndpoint(
  '/sign-out',
  { method: 'POST', requireHeaders: true, disableBody: true },
  async (ctx) => {
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
    // The application's own client: it rejects on a fault and is quiet where the row is absent.
    if (token) await db().session.deleteMany({ where: { token } });
    deleteSessionCookie(ctx);
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  },
);
