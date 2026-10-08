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
import type { AuthContext } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { deleteSessionCookie, expireCookie, setSessionCookie } from 'better-auth/cookies';
import { addressBucket } from '../client-address.ts';
import { db } from '../db.ts';
import { errorResponse } from '../http.ts';
import { checkLimit, logLimitReached, takeLimit, type LimitResult } from '../rate-limit.ts';
import { securityLog } from '../security-log.ts';
import { passwordLength } from '../password-rules.ts';
import { settings, type LimitName } from '../settings.ts';
import { valkey } from '../valkey.ts';
import { beginSecondStep, SECOND_STEP_COOKIE } from './second-step.ts';

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

// NFR-SE-07: "a completed password reset … clears the counters of this row for
// that email address". The count for one address from one network address is
// kept under a key for each network address, and those cannot be listed to be
// deleted. So every key of both counts holds a number kept for the address,
// and clearing raises the number: the counts made under the earlier one are
// never read again, and leave Valkey when their periods have passed.
// ponytail: the number has no expiry, one small key for each address that ever
// reset; were Valkey to evict it, the counts made since the reset are lost with it.
const generationKey = (email: string) =>
  `sign-in-generation:${createHmac('sha256', settings().authSecret).update(`sign-in-generation:${email}`).digest('hex')}`;

/**
 * Clears both counts of failed sign-ins for an email address, from every
 * network address (NFR-SE-07, FR-AU-86). The link of a lock email calls it
 * too (FR-AU-81).
 */
export async function clearFailedSignIns(email: string): Promise<void> {
  await valkey().incr(generationKey(email.toLowerCase()));
}

/** A limit on failed sign-ins as a check found it, with the key it is counted under. */
type Reached = [name: LimitName, key: string, limit: LimitResult];

/** The address as it is stored and compared (FR-AU-02), and bounded: no address is longer than 254 characters. */
const normalised = (email: string) => email.slice(0, 255).toLowerCase();

/**
 * The keys of the two counts of NFR-SE-07 for an address as `normalised`
 * gives it: 5 in 15 minutes "for one email address from one network address",
 * and 20 in an hour for the address entered, from everywhere. Neither the
 * number nor a bucket holds a space, so the first key cannot be read in two ways.
 */
async function countKeys(email: string, headers: Headers | undefined) {
  const generation = (await valkey().get(generationKey(email))) ?? '0';
  return {
    pair: `${generation} ${addressBucket(headers ?? new Headers())} ${email}`,
    everywhere: `${generation} ${email}`,
  };
}

/**
 * NFR-SE-07: "An abandoned second step counts as a failed sign-in for that
 * email address under the row above". One failure, under the two counts of a
 * wrong password and from the network address of the request that abandoned
 * it. Where a limit is already reached nothing is counted, as for a refused
 * attempt (the owner's answer to Q10).
 */
export async function countFailedSignIn(headers: Headers | undefined, enteredEmail: string): Promise<void> {
  const { pair, everywhere } = await countKeys(normalised(enteredEmail), headers);
  await takeLimit('FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS', pair);
  await takeLimit('FAILED_SIGN_IN_PER_EMAIL', everywhere);
}

/**
 * One check of a password for an email address, as a sign-in makes it and as
 * every prompt for the current password does: "every wrong password at any
 * prompt counts" as a failed sign-in, "a refused attempt counts toward
 * nothing" (the owner's answer to Q10). It checks the two limits of
 * NFR-SE-07, verifies, and counts a failure, as one step for the address.
 *
 * `passed` is false whatever the cause, and the caller answers with the one
 * statement of FR-AU-81. `user` is the account of the address, where there is
 * one. `limits` are the two limits as they stood, each with the key it is
 * counted under, for the caller that logs one reached (NFR-SE-19).
 *
 * An attempt that got no turn in time is a refusal and no fault: it verified
 * nothing and counts nothing, nothing was read of the address, and it is
 * answered as every other refusal is.
 */
export async function checkCredentials(
  context: Pick<AuthContext, 'internalAdapter' | 'password'>,
  headers: Headers | undefined,
  enteredEmail: string,
  enteredPassword: string,
) {
  const email = normalised(enteredEmail);
  const { internalAdapter, password: hasher } = context;

  return inTurn(email, async () => {
    const { pair, everywhere } = await countKeys(email, headers);
    // Both are asked, and the account is read, on every path: the same work
    // whether a limit is reached, the address is known, or the password is right.
    const [byPair, byEmail] = await Promise.all([
      checkLimit('FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS', pair),
      checkLimit('FAILED_SIGN_IN_PER_EMAIL', everywhere),
    ]);
    const open = byPair.ok && byEmail.ok;
    // Two reads on every path. Asked for the user with its credentials in one
    // call, the library reads the credentials only where it found a user: one
    // read fewer for an address that belongs to no account.
    const user = (await internalAdapter.findUserByEmail(email))?.user;
    const credential = (await internalAdapter.findAccounts(user?.id ?? '')).find(
      (account) => account.providerId === 'credential' && account.accountId === user?.id,
    );
    const hash = credential?.password;
    // Verified only where the attempt could succeed: no limit is reached (a
    // refused attempt is not verified; the owner's answer to Q10), the address
    // belongs to an account with a password, the address is verified
    // (FR-AU-81), and the password is no longer than one can be (FR-AU-82).
    // Every other attempt hashes once instead, as the library does for an
    // unknown address, so each path runs scrypt exactly once.
    const passed =
      open && user?.emailVerified && hash && passwordLength(enteredPassword) <= settings().passwordMaxLength
        ? await hasher.verify({ hash, password: enteredPassword })
        : (await hasher.hash(''), false);
    // Counted on each failure, for an address that belongs to no account as
    // for one that does. An attempt refused by a limit is not counted and
    // extends nothing (Q10). A successful sign-in clears neither count: the
    // table names a completed password reset and the link of a lock email, and
    // nothing else.
    if (open && !passed) {
      await takeLimit('FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS', pair);
      await takeLimit('FAILED_SIGN_IN_PER_EMAIL', everywhere);
    }
    // The row whose hash was verified, for the caller that acts on the check
    // later: by then the password may be another (FR-AU-85, FR-AU-86).
    const verified =
      passed && credential && hash ? { id: credential.id, hash, updatedAt: credential.updatedAt } : null;
    const limits: Reached[] = [
      ['FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS', pair, byPair],
      ['FAILED_SIGN_IN_PER_EMAIL', everywhere, byEmail],
    ];
    return { user, passed, verified, limits };
  }).catch((error: unknown) => {
    if (error instanceof NoTurn) return { user: undefined, passed: false, verified: null, limits: [] };
    throw error;
  });
}

/**
 * Whether the password of the account is still the one that was verified,
 * asked as a write that changes nothing: the statement waits for a reset or a
 * change of password that has not yet committed, and then finds its hash. A
 * plain read would not wait, and would see the old hash beside a transaction
 * that has already deleted the sessions it could see.
 */
export async function stillVerified(
  verified: { id: string; hash: string; updatedAt: Date },
  client: Pick<ReturnType<typeof db>, 'account'> = db(),
) {
  const { count } = await client.account.updateMany({
    where: { id: verified.id, password: verified.hash },
    // Its own value: without it Prisma would write the time of this statement.
    data: { updatedAt: verified.updatedAt },
  });
  return count === 1;
}

/** FR-AU-81: `POST /api/auth/sign-in/email`. The answer to success is `{}`: the session is the cookie alone (FR-AU-84). */
export const signInEmail = createAuthEndpoint('/sign-in/email', { method: 'POST' }, async (ctx) => {
  const entered = credentials(ctx.body);
  if (!entered) return errorResponse(422, 'invalid_request', INVALID_REQUEST);
  const { internalAdapter, authCookies, secret } = ctx.context;
  const { user, verified, limits } = await checkCredentials(
    ctx.context,
    ctx.headers,
    entered.email,
    entered.password,
  );
  const refused = async () => {
    // NFR-SE-19: the user where the address belongs to an account, and never the address.
    await securityLog({ kind: 'sign_in_refused', userId: user?.id });
    // NFR-SE-19: a sign-in refused because a limit was already reached is that
    // event too, once for each period of the limit. The same work for an
    // address with an account as for one without.
    for (const [name, key, limit] of limits) {
      if (!limit.ok) await logLimitReached(name, key, limit.retryAfterSeconds, user?.id);
    }
    // The owner's answer to Q1: no 429 for these limits, which would show that an address is limited.
    return errorResponse(401, 'sign_in_refused', SIGN_IN_REFUSED);
  };
  if (!user || !verified) return refused();

  // FR-AU-81, FR-AU-83: "where the account has two-factor authentication on,
  // the password is followed by the second step …, and the session begins
  // only after it". No session is made here. The answer says that a code is
  // asked for, and nothing else.
  if ((user as { twoFactorEnabled?: unknown }).twoFactorEnabled === true) {
    const step = await beginSecondStep(ctx, user.id);
    // As below: the step is begun first and the password asked after, so that
    // none begun by a password that was set meanwhile stands. A reset and a
    // change of the password delete the steps they can see (password.ts).
    if (!(await stillVerified(verified))) {
      await db().verification.deleteMany({ where: { id: step } });
      expireCookie(ctx, ctx.context.createAuthCookie(SECOND_STEP_COOKIE));
      return refused();
    }
    // A session the browser already holds is ended here, as it is below, and
    // its cookies cleared: the code that follows is then asked of a browser
    // without a session, which is how its endpoint tells the second step of a
    // sign-in from the first code of an enrolment (two-factor.ts).
    const held = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
    if (held) {
      await db().session.deleteMany({ where: { token: held } });
      deleteSessionCookie(ctx);
    }
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({ twoFactorRedirect: true });
  }

  const session = await internalAdapter.createSession(user.id);
  if (!session) throw new NoSession('sign-in: no session');
  // FR-AU-85, FR-AU-86: "setting it ends every session of the account". A
  // password set since the check has ended the sessions it could see, and this
  // one may not have been among them, so it is ended here: the session is
  // made first and the password asked after, which leaves no order in which
  // one made by the old password stands. Not counted as a failed sign-in: the
  // password was the right one when it was checked.
  if (!(await stillVerified(verified))) {
    // By the application's own client, which rejects on a fault: the
    // library's deletion can skip the row without a word.
    await db().session.deleteMany({ where: { token: session.token } });
    return refused();
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

  // `false`: the cookie lasts as long as the session, whatever an earlier cookie said.
  await setSessionCookie(ctx, { session, user }, false);
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
