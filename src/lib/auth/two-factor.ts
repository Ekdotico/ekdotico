// Two-factor authentication by authenticator application, with recovery codes
// (FR-AU-83; NFR-SE-07, the row of wrong codes; NFR-SE-17 (a), (c), (d)), as
// endpoints of the application's own inside the identity library. auth.ts
// mounts each under the library's own name and path, so the plugin's endpoint
// of that name no longer exists. As they ship at 1.7.7 the plugin's five do
// less or more than the text:
//
// - its enrolment checks the password without counting a wrong one, takes the
//   name shown in the authenticator from the request, validates the session
//   against the signed copy, and hands out the recovery codes before the
//   first code has turned anything on;
// - its two endpoints of the second step return the session's token in the
//   body, take `trustDevice` and then remember the device for 30 days, count
//   the fifth wrong code only when a sixth request arrives, and keep a count
//   and a lock of their own on the account (10 wrong codes, 15 minutes), which
//   no requirement has;
// - its turning off asks for the password alone, and its replacement of the
//   recovery codes sends no notice. None of the five reads the session's row.
//
// What is kept of the plugin is its table and the form of what it stores: the
// secret and the recovery codes are encrypted by the library's own function
// under the library's secret, which is held in the environment
// (NFR-SE-17 (a), (e)).
//
// NFR-SE-19: nothing here logs an address, a secret, a code or a password. The
// secret leaves this module once, in the answer to the request that begins an
// enrolment, and each set of recovery codes once, in the answer to the request
// that made it.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuthContext, GenericEndpointContext } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setCookieCache, setSessionCookie } from 'better-auth/cookies';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { Prisma } from '../../generated/prisma/client.ts';
import { inDeletion } from '../account/in-deletion.ts';
import { afterResponse, assertCollecting } from '../after-response.ts';
import { db } from '../db.ts';
import { handOver } from '../email/hand-over.ts';
import type { EmailMessage } from '../email/index.ts';
import { faultOf } from '../fault.ts';
import { errorResponse, textFields } from '../http.ts';
import { oncePer } from '../rate-limit.ts';
import { securityLog, securityLogIn } from '../security-log.ts';
import { settings } from '../settings.ts';
import { hashToken, TOKEN } from '../token.ts';
import { valkey } from '../valkey.ts';
import { stoppedByFoundingGate, type GatedAccount } from './founding-gate.ts';
import { notAdmitted, refusedOrigin, unauthenticated } from './route-answers.ts';
import { LINK_STEP, SECOND_STEP, SECOND_STEP_COOKIE } from './second-step.ts';
import { sessionEnded, userOfSessionToken } from './session-end.ts';
import { holdSession, validateSessionRow, type ValidSession } from './session.ts';
import {
  claimSignInLink,
  lockedUntilOf,
  lockInForce,
  openSignInLinkOf,
  SIGN_IN_LINK_NOT_VALID,
  voidSignInLinks,
} from './sign-in-lock.ts';
import {
  checkCodeAtPrompt,
  checkCredentials,
  clearFailedSignIns,
  countFailedSignIn,
  failedSignInsReached,
  orEndSession,
  SIGN_IN_REFUSED,
  stillVerified,
} from './sign-in.ts';

/**
 * The name an authenticator application shows beside the account. No
 * requirement gives one: it is the product's name, for the owner's approval.
 */
const ISSUER = 'Ekdotico';

// Text for a person (the owner's answer to Q6 of the plan: approved with the
// pull request). FR-AU-83 fixes none of these statements.
const MESSAGES = {
  passwordShape: 'The request must hold the current password, and nothing else.',
  codeShape: 'The request must hold a code, and nothing else.',
  offShape: 'The request must hold the current password and a code, and nothing else.',
  code: 'The code is not correct. Enter the code that the authenticator application shows now.',
  recoveryCode:
    'The recovery code is not correct, or it has been used. Enter a recovery code that has not been used.',
  eitherCode:
    'The code is not correct. Enter the code that the authenticator application shows now, or a recovery code that has not been used.',
  again:
    'This sign-in can no longer complete, because its time has passed or too many codes were not correct. Begin again with the email address and the password.',
  // Both end alike. `on` is also shown on the screen that stands in place of
  // every page (FR-AU-83), where a reload shows the page that was asked for and
  // not the settings: so "the current state".
  on: 'Two-factor authentication is already turned on for this account. Reload the page to see the current state.',
  notOn:
    'Two-factor authentication is not turned on for this account. Reload the page to see the current state.',
  notBegun: 'There is no secret to confirm. Enter the password to begin again.',
  foundingTeam:
    'This account belongs to the Ekdotico team, so two-factor authentication cannot be turned off for it.',
};

// ── The code of an authenticator application (RFC 6238 over RFC 4226) ───────
// Six digits (NFR-SE-07: "a six-digit code"), a step of 30 seconds, and
// HMAC-SHA-1: what an authenticator application takes where it is told nothing
// else. The library's own function for this is in a package the application
// does not depend on, and is the same arithmetic; a test holds the two equal.
const DIGITS = 6;
const STEP_SECONDS = 30;
// A code of the step before and of the step after is accepted too, for a
// clock that is off and for the time a person takes: RFC 6238, 5.2, "at most
// one time step". FR-AU-83 states no number; this one is the library's.
const DRIFT_STEPS = 1;

/** The code of one step. The secret is used as its bytes, as the library uses it. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The step of the moment: the one whose code an authenticator application shows now. */
export const totpStep = (now: number = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** What was typed, without the spaces and hyphens a code is often shown with (`OneTimeCodeField`). */
const digitsOf = (entered: string) => entered.replace(/[\s-]/g, '');
const isCode = (entered: string) => new RegExp(`^[0-9]{${DIGITS}}$`).test(digitsOf(entered));

/** Equal, in a time that does not depend on where two texts first differ. */
function same(a: string, b: string): boolean {
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether what was entered is a code of this secret that may be accepted now.
 * Every step of the window is computed and compared, whichever matches.
 *
 * A code is accepted once: RFC 6238, 5.2, "the verifier MUST NOT accept the
 * second attempt of the OTP after the successful validation", and FR-AU-83
 * names that document. The mark is kept in Valkey for as long as the step can
 * be accepted, under a keyed digest of the secret and the step (rate-limit.ts),
 * so Valkey holds nothing of either. A code used again is answered as a wrong
 * one. The mark is set before the transaction of whatever the code allows, on
 * purpose: no replay first, so a fault after a right code costs that code.
 */
async function acceptCode(secret: string, entered: string): Promise<boolean> {
  const code = digitsOf(entered);
  const now = totpStep();
  let accepted: number | null = null;
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    if (same(code, totpAt(secret, step))) accepted = step;
  }
  if (accepted === null) return false;
  return oncePer(`totp-used:${secret}:${accepted}`, STEP_SECONDS * (2 * DRIFT_STEPS + 1));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 4648, without padding: the form in which a secret is typed into an authenticator application. */
function base32(text: string): string {
  const bits = [...Buffer.from(text)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return (bits.match(/.{1,5}/g) ?? []).map((five) => BASE32[parseInt(five.padEnd(5, '0'), 2)]).join('');
}

// ── What is stored (NFR-SE-17 (a)) ──────────────────────────────────────────
const seal = (ctx: Keyed, data: string) => symmetricEncrypt({ key: ctx.context.secretConfig, data });
// What the reading of a stored secret asks of a request: the library's key, which an endpoint of the
// library has as its context and a route of the application has as `await auth().$context`.
type Keyed = { context: Pick<AuthContext, 'secretConfig'> };
const unseal = (ctx: Keyed, data: string) => symmetricDecrypt({ key: ctx.context.secretConfig, data });

/**
 * FR-AU-83: "ten single-use recovery codes". Each is ten letters and digits
 * from the platform's cryptographic source, shown in two groups of five: 59
 * bits, behind the 5 wrong codes of a sign-in.
 */
function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const code = generateRandomString(10, 'a-z', 'A-Z', '0-9');
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** The recovery codes of a row that have not been used. */
async function recoveryCodes(ctx: Keyed, sealed: string): Promise<string[]> {
  const codes: unknown = JSON.parse(await unseal(ctx, sealed));
  return Array.isArray(codes) ? codes.filter((code): code is string => typeof code === 'string') : [];
}

/** What is left of the codes once the one entered is spent, or null where it is none of them. Every code is compared. */
function without(codes: string[], entered: string): string[] | null {
  const code = entered.trim();
  const left = codes.filter((each) => !same(each, code));
  return left.length === codes.length ? null : left;
}

// ── The email of the account (FR-AU-87) ─────────────────────────────────────

// FR-AU-87 (f), verbatim: the subject, and "the subject as a sentence,
// followed by" the fixed sentence.
function turnedEmail(to: string, turned: 'on' | 'off'): EmailMessage {
  const subject = `Two-factor authentication was turned ${turned} for your Ekdotico account`;
  return {
    to,
    subject,
    text: `${subject}. If you did not do this, set a new password from the sign-in page.`,
  };
}

// FR-AU-87 (g), verbatim.
function codesReplacedEmail(to: string): EmailMessage {
  return {
    to,
    subject: 'The recovery codes of your Ekdotico account were replaced',
    text: 'The recovery codes of your Ekdotico account were replaced, and the earlier codes no longer work. If you did not do this, set a new password from the sign-in page.',
  };
}

// ── What the endpoints with a session share ─────────────────────────────────

/** The account of a session as the endpoints here read it, from its row. */
const accountOf = (userId: string) =>
  db().user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, twoFactorEnabled: true },
  });

/** FR-AU-83: "An account of the founding team is one whose verified email address is on the list", whatever its second factor. */
export const ofFoundingTeam = (account: GatedAccount) =>
  stoppedByFoundingGate({ ...account, twoFactorEnabled: false });

/**
 * The prompt for the current password (FR-AU-83: "the user enters the current
 * password"). The owner's answer to Q10: a wrong password at a prompt counts
 * as a failed sign-in, and a prompt refused by a limit is answered as a wrong
 * password is, with the statement of FR-AU-81. NFR-SE-19: a 403.
 */
async function refusedPassword(userId: string): Promise<Response> {
  await securityLog({ kind: 'forbidden', userId });
  return errorResponse(403, 'password_refused', SIGN_IN_REFUSED);
}

type Verified = NonNullable<Awaited<ReturnType<typeof checkCredentials>>['verified']>;

/**
 * Asked inside the transaction of a change, before it writes: whether the
 * password is still the one that was verified and the session still stands.
 * Each is asked as a write, which waits for a reset, a change of password or
 * the end of the session that has not yet committed (FR-AU-84 to FR-AU-86).
 * The password first, as a change and a reset take it, so that none of them
 * waits for another in a circle; and that write holds the account's row, so
 * two changes of one account run one after the other.
 */
export async function standing(
  tx: Prisma.TransactionClient,
  verified: Verified,
  own: ValidSession,
): Promise<'held' | 'ended' | 'outrun'> {
  const unchanged = await stillVerified(verified, tx);
  if (!(await holdSession(tx, own))) return 'ended';
  return unchanged ? 'held' : 'outrun';
}

/**
 * The browser's signed copy of the session carries the account, with whether
 * two-factor authentication is on, and a page reads it for up to a minute
 * (NFR-SE-17 (c)). After a change the copy is written again from the rows, so
 * that the page which follows shows the account as it now is, and the
 * founding-team gate opens at once for the browser that turned it on. The
 * change of a name and of an address write it again too, under their own
 * word in the line of a fault (name-and-address.ts).
 */
export async function freshCopy(ctx: GenericEndpointContext, what = 'two-factor'): Promise<void> {
  const { authCookies, secret, internalAdapter } = ctx.context;
  try {
    const token = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
    const held = token ? await internalAdapter.findSession(token) : null;
    if (held) await setCookieCache(ctx, held, false);
  } catch (error) {
    // The change has committed, so a fault here is no reason to answer that
    // nothing was changed, and at an enrolment that answer would lose the
    // recovery codes. The browser's copy is then at most a minute behind.
    // NFR-SE-19: the class of the fault, and nothing of its message.
    console.error(`${what}: changed, signed copy not written again (${faultOf(error)})`);
  }
}

/**
 * NFR-SE-07: one more request with a code under this key, and its number. The
 * count is made before the code is looked at, so requests that arrive together
 * cannot each be the fifth. The expiry is set before anything is counted, so
 * no count outlives what it counts for. A fault of Valkey rejects, and the
 * request is refused (NFR-SE-06 A10).
 */
async function countCode(key: string, seconds: number = settings().secondStepSeconds): Promise<number> {
  await valkey().set(key, 0, 'EX', seconds, 'NX');
  return valkey().incr(key);
}

// ── Turning it on ───────────────────────────────────────────────────────────

/**
 * FR-AU-83: `POST /api/auth/two-factor/enable`, with `{ "password" }`. "The
 * user enters the current password, adds to an authenticator application the
 * secret the application shows, as a QR code and as text": the answer is the
 * secret as text and as the address a QR code holds. Nothing is on yet: the
 * row is not verified, and neither a sign-in nor the gate reads it.
 *
 * An enrolment begun again replaces the secret of one that was not confirmed.
 * It is one of the two requests the founding-team gate lets through.
 */
export const enableTwoFactor = createAuthEndpoint(
  '/two-factor/enable',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    // NFR-SE-17 (c): turning two-factor authentication on reads the session's row.
    const validation = await validateSessionRow(ctx.headers);
    const own = validation.session ?? validation.stopped;
    if (!own) return unauthenticated();
    const entered = textFields(ctx.body, 'password');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.passwordShape);
    const account = await accountOf(own.userId);
    if (!account?.email) return unauthenticated();

    const { verified } = await checkCredentials(ctx.context, ctx.headers, account.email, entered.password);
    if (!verified) return refusedPassword(own.userId);

    // 32 characters of the library's alphabet: more than the 160 bits RFC 4226 asks for.
    const secret = generateRandomString(32);
    const data = {
      secret: await seal(ctx, secret),
      backupCodes: await seal(ctx, '[]'),
      verified: false,
      // The time the first code is waited for runs from this password.
      createdAt: new Date(),
    };
    const outcome = await db().$transaction(async (tx) => {
      const stands = await standing(tx, verified, own);
      if (stands !== 'held') return stands;
      // Only over a row that is not verified: the secret of a second factor
      // that is on is never replaced by this request.
      const replaced = await tx.twoFactor.updateMany({
        where: { userId: own.userId, verified: false },
        data,
      });
      if (replaced.count === 1) return 'begun';
      if ((await tx.twoFactor.count({ where: { userId: own.userId } })) > 0) return 'on';
      await tx.twoFactor.create({ data: { id: randomUUID(), userId: own.userId, ...data } });
      return 'begun';
    });
    if (outcome === 'ended') return unauthenticated();
    if (outcome === 'outrun') return refusedPassword(own.userId);
    if (outcome === 'on') return errorResponse(409, 'two_factor_on', MESSAGES.on);

    const label = `${ISSUER}:${encodeURIComponent(account.email)}`;
    const query = new URLSearchParams({
      secret: base32(secret),
      issuer: ISSUER,
      digits: String(DIGITS),
      period: String(STEP_SECONDS),
    });
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({ secret: base32(secret), totpURI: `otpauth://totp/${label}?${query}` });
  },
);

/**
 * The first code of an enrolment: "confirms with one code from it; only then
 * is it on. When it is turned on the application shows the user ten single-use
 * recovery codes, once" (FR-AU-83). The answer holds the codes, which are
 * made here and held nowhere else in clear. The notice of FR-AU-87 (f) follows.
 *
 * The request holds a session and no password, so a session in another's
 * hands could guess at the code until one was right, and be shown the recovery
 * codes of a second factor that is then its own. So the first code is asked
 * for under the two bounds of the second step of a sign-in, with its two
 * settings (NFR-SE-07, the row of wrong codes; FR-AU-83, the 10 minutes): the
 * wrong code that reaches the number, and a secret that has waited longer than
 * a second step may, end the enrolment. The row is deleted, and the password
 * is asked for again. It is no sign-in, so no failed sign-in is counted.
 */
async function confirmEnrolment(ctx: GenericEndpointContext, own: ValidSession): Promise<unknown> {
  assertCollecting();
  const entered = textFields(ctx.body, 'code');
  if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.codeShape);
  const account = await accountOf(own.userId);
  const factor = await db().twoFactor.findUnique({ where: { userId: own.userId } });
  if (!account?.email) return unauthenticated();
  const notBegun = () => errorResponse(409, 'two_factor_not_begun', MESSAGES.notBegun);
  if (!factor || factor.verified) return notBegun();
  // Only a row that is not verified, whatever happened meanwhile: a second
  // factor that is on is never deleted here.
  const end = () => db().twoFactor.deleteMany({ where: { id: factor.id, verified: false } });
  if (!(Date.now() < factor.createdAt.getTime() + settings().secondStepSeconds * 1000)) {
    await end();
    return notBegun();
  }
  // The identifier of the row is random and names no one, so it is the key as it is.
  const most = settings().secondStepWrongCodes;
  const attempt = await countCode(`enrolment-codes:${factor.id}`);
  if (attempt > most) {
    await end();
    return notBegun();
  }

  if (!(await acceptCode(await unseal(ctx, factor.secret), entered.code))) {
    if (attempt >= most) {
      await end();
      return notBegun();
    }
    return Response.json(
      { error: { code: 'invalid', message: MESSAGES.code, fields: { code: MESSAGES.code } } },
      { status: 422, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const codes = newRecoveryCodes();
  const backupCodes = await seal(ctx, JSON.stringify(codes));
  const outcome = await db().$transaction(async (tx) => {
    if (!(await holdSession(tx, own))) return 'ended';
    // Only the secret the code was checked against, and only once.
    const turned = await tx.twoFactor.updateMany({
      where: { id: factor.id, verified: false, secret: factor.secret },
      data: { verified: true, backupCodes },
    });
    if (turned.count !== 1) return 'replaced';
    await tx.user.update({ where: { id: own.userId }, data: { twoFactorEnabled: true } });
    return 'on';
  });
  if (outcome === 'ended') return unauthenticated();
  if (outcome === 'replaced') return notBegun();

  const { email } = account;
  afterResponse('two-factor notice', () => handOver(turnedEmail(email, 'on')));
  await freshCopy(ctx);
  ctx.setHeader('Cache-Control', 'no-store');
  return ctx.json({ recoveryCodes: codes });
}

// ── The second step of a sign-in ────────────────────────────────────────────

class NoSession extends Error {
  name = 'SecondStepNoSession';
}
// Thrown inside the transaction that completes a second step, to undo it.
const STEP_GONE = new Error('second step: the step is over');
const CODE_GONE = new Error('second step: the recovery code is spent');

/**
 * FR-AU-81, FR-AU-83: the code after the password, by which the session
 * begins. The request is authorised by the cookie of a step that is open
 * (second-step.ts), and by nothing else; it carries `{ "code" }` and nothing
 * else, so no request can ask for a device to be remembered: "the code is
 * asked for at every sign-in". The answer to success is `{}`: the session is
 * the cookie alone, an ordinary one (FR-AU-84).
 *
 * NFR-SE-07: each request with a code is counted for its step before the code
 * is looked at, so requests that arrive together cannot each be the fifth.
 * The wrong code that reaches the number abandons the sign-in: the step is
 * deleted, "begins again with the password", and "counts as a failed sign-in
 * for that email address", once. No notice is sent for it. This count is the
 * only one: the library's own columns for one are not written (schema.prisma).
 * The owner's answer to Q1: no 429 for this row.
 *
 * NFR-SE-19: every refusal here is a sign-in refused, with the user.
 */
async function secondStep(ctx: GenericEndpointContext, kind: 'totp' | 'recovery'): Promise<unknown> {
  const { internalAdapter, secret } = ctx.context;
  const cookie = ctx.context.createAuthCookie(SECOND_STEP_COOKIE);
  // Authorisation before validation (the owner's answer to Q8). The time of
  // the step is asked here, so that no code is looked at, and none counted,
  // for a step that is over; and again where the step is claimed, below.
  const token = await ctx.getSignedCookie(cookie.name, secret);
  const step =
    typeof token === 'string' && TOKEN.test(token)
      ? await db().verification.findFirst({
          where: {
            identifier: { in: [SECOND_STEP + hashToken(token), LINK_STEP + hashToken(token)] },
            expiresAt: { gt: new Date() },
          },
          select: { id: true, value: true, identifier: true },
        })
      : null;
  const refused = async (
    code: 'sign_in_again' | 'code_refused' | 'sign_in_link_not_valid',
    message: string,
  ) => {
    await securityLog({ kind: 'sign_in_refused', userId: step?.value });
    // A step that cannot be completed leaves no cookie behind.
    if (code !== 'code_refused') expireCookie(ctx, cookie);
    return errorResponse(401, code, message);
  };
  if (!step) return refused('sign_in_again', MESSAGES.again);
  const entered = textFields(ctx.body, 'code');
  if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.codeShape);
  // FR-AU-81: whether the step began from the sign-in link of a lock email
  // (register A104, assumed). The mark is the row's, written by the server.
  const fromLink = step.identifier.startsWith(LINK_STEP);

  const end = () => db().verification.deleteMany({ where: { id: step.id } });
  const user = await internalAdapter.findUserById(step.value);
  const factor = await db().twoFactor.findUnique({ where: { userId: step.value } });
  // Turned off since the password: there is no second step to pass, and the
  // sign-in begins again, with the password alone.
  if (
    !user?.email ||
    (user as { twoFactorEnabled?: unknown }).twoFactorEnabled !== true ||
    !factor?.verified
  ) {
    await end();
    return refused('sign_in_again', MESSAGES.again);
  }
  // FR-AU-58 (a): "From the confirmation, a sign-in to the account is refused": a step that a
  // password began before the confirmation does not complete into a session. Step (d) deletes
  // the steps too; this is the refusal in the time between the two.
  if (await inDeletion(user.id)) {
    await end();
    return refused('sign_in_again', MESSAGES.again);
  }

  // NFR-SE-07: "no more than 100 codes can be tried for one account in any
  // hour". Where the failed sign-ins of the address have reached their number,
  // a step that was opened before then is over too, before a code is looked
  // at. As a refused attempt, it is counted toward nothing (Q10).
  // FR-AU-81: "While it is locked, every sign-in to it is refused", a step
  // that a password began before the lock among them. The step of the lock's
  // own link is the one sign-in a lock lets through, and it stands only while
  // the link does: "used or not, the link is void when the lock ends for any
  // reason". The limit that caused the lock is still reached then, and is not
  // asked of it.
  const locked = lockInForce(await lockedUntilOf(user.id));
  const link = fromLink ? await openSignInLinkOf(user.id) : null;
  if (fromLink && !link) {
    await end();
    return refused('sign_in_link_not_valid', SIGN_IN_LINK_NOT_VALID);
  }
  if (!link && (locked || (await failedSignInsReached(user.email)))) {
    await end();
    return refused('sign_in_again', MESSAGES.again);
  }

  // The identifier of the row is random and names no one, so it is the key as
  // it is. The codes of a link are counted for the link and not for the step:
  // the link is not spent by beginning a step, so counted for the step, a link
  // would give five codes as often as it was opened again, where the row of
  // NFR-SE-07 gives a link five in all ("the link is spent and nothing begins
  // again").
  // An accepted ceiling: that count is in Valkey alone. Were Valkey to lose it
  // within the hour of the lock, the link would have five codes more.
  const most = settings().secondStepWrongCodes;
  const attempt = link
    ? await countCode(`sign-in-link-codes:${link.id}`, settings().signInLockSeconds)
    : await countCode(`second-step-codes:${step.id}`);
  // The link "is spent … when its second step is abandoned after five wrong
  // codes; after that, the person signs in when the lock has ended or after a
  // password reset": the answer is the statement of a link that is spent.
  //
  // NFR-SE-19; the owner's decision of 12 October 2026 (R38; register row
  // D153, pending): the entries beside it (a limit reached, a sign-in refused)
  // record refusals, and are on purpose in no transaction with the deletion
  // of the step and of the link: a refused attempt keeps its entry whatever
  // becomes of those rows. A fault between the statements repairs itself: the
  // count of codes is past its number, so the next request with the step or
  // with the link is abandoned here again.
  const abandoned = async () => {
    await end();
    if (!link) return refused('sign_in_again', MESSAGES.again);
    await voidSignInLinks(db(), user.id);
    return refused('sign_in_link_not_valid', SIGN_IN_LINK_NOT_VALID);
  };
  if (attempt > most) return abandoned();

  const wrong = async () => {
    // NFR-SE-07: where the sign-in began from the link of a lock email, "the
    // abandoned step is not counted, the account being locked".
    if (link) {
      if (attempt < most)
        return refused('code_refused', kind === 'totp' ? MESSAGES.code : MESSAGES.recoveryCode);
      await securityLog({ kind: 'rate_limit_reached', userId: user.id });
      return abandoned();
    }
    // The owner's answer G1 of the pull request: "a second step that had at
    // least one wrong code and did not complete counts as one failed sign-in,
    // counted at its first wrong code." Once for the step, whichever of its
    // requests is first to be wrong; the fifth counts no second one. A step
    // that completes after it keeps the count: a sign-in clears none
    // (sign-in.ts).
    if (await oncePer(`second-step-failed:${step.id}`, settings().secondStepSeconds)) {
      await countFailedSignIn(ctx.headers, user.email);
    }
    if (attempt < most) {
      return refused('code_refused', kind === 'totp' ? MESSAGES.code : MESSAGES.recoveryCode);
    }
    // Abandoned. NFR-SE-19, "a rate limit reached": the number of wrong codes
    // for one sign-in (the owner's answer of the pull request), with the user
    // and nothing of a code, beside the sign-in refused.
    await securityLog({ kind: 'rate_limit_reached', userId: user.id });
    return abandoned();
  };
  // FR-AU-83: "a recovery code is accepted in its place and is then spent".
  // Here it is only looked for among the codes as they were read; it is spent
  // below, with the claim of the step, so that a request which fails between
  // the two has not cost the person a code.
  const left =
    kind === 'recovery' ? without(await recoveryCodes(ctx, factor.backupCodes), entered.code) : null;
  const right =
    kind === 'totp' ? await acceptCode(await unseal(ctx, factor.secret), entered.code) : left !== null;
  if (!right) return wrong();

  // The session is made first and the step claimed after, as a sign-in makes
  // its session before it asks the password again (sign-in.ts): a reset or a
  // change of the password deletes the steps and then the sessions of the
  // account, so in whichever order the two run, either the claim finds the
  // step gone or the session made here is among those ended.
  const session = await internalAdapter.createSession(user.id);
  if (!session) throw new NoSession('second step: no session');
  // The owner's decision of 9 October 2026: a fault from here to the answer
  // leaves no session behind (sign-in.ts).
  return orEndSession(session.token, async () => {
    // The owner's decision S5: "a sign-in ends the session the browser held".
    // The password step ended the one it held then (sign-in.ts), but the browser
    // may have been given another since, and a recovery code is taken here under
    // a session too (`verifyBackupCode`).
    const held = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, secret);
    // Whose it is, read before the transaction deletes it, to tell the collaboration server once it has.
    const heldUser = held ? await userOfSessionToken(held) : null;
    const fewer = left ? await seal(ctx, JSON.stringify(left)) : null;
    // One transaction, so that none of the three happens without the others; a
    // fault of any is a fault of the request, and nothing is swallowed. The
    // session the browser held first, as a change of the password holds its own
    // before it deletes the steps: the two then never wait for each other in a
    // circle.
    const outcome = await db()
      .$transaction(async (tx) => {
        if (held) await tx.session.deleteMany({ where: { token: held } });
        // The step is claimed once, and only while it is open: it may have
        // reached its 10 minutes since it was read above.
        const claimed = await tx.verification.deleteMany({
          where: { id: step.id, expiresAt: { gt: new Date() } },
        });
        if (claimed.count !== 1) throw STEP_GONE;
        if (fewer !== null) {
          // Written only over the codes that were read, so of two requests with
          // one code the second finds it gone, and codes replaced meanwhile stay
          // as they were set.
          const spent = await tx.twoFactor.updateMany({
            where: { id: factor.id, backupCodes: factor.backupCodes },
            data: { backupCodes: fewer },
          });
          if (spent.count !== 1) throw CODE_GONE;
        }
        // FR-AU-81: "the lock is lifted … when that sign-in completes", and the
        // link is spent. A link made void since it was read completes nothing.
        // Last, as a completed reset takes the account's row after the steps.
        if (link) {
          if (!(await claimSignInLink(tx, link))) throw STEP_GONE;
          // NFR-SE-19; the owner's decision of 9 October 2026: the entry of a
          // sign-in by the link, where it completes and not where its step opens.
          await securityLogIn(tx, { kind: 'sign_in_by_link', userId: user.id });
        }
        return 'claimed' as const;
      })
      .catch((error: unknown) => {
        if (error === STEP_GONE || error === CODE_GONE) return error;
        throw error;
      });
    if (outcome !== 'claimed') {
      await db().session.deleteMany({ where: { token: session.token } });
      return outcome === CODE_GONE ? wrong() : refused('sign_in_again', MESSAGES.again);
    }
    // FR-ED-40 (d): the session the browser held ended with the claim.
    if (heldUser) await sessionEnded(heldUser);
    // FR-AU-81: "the counters of failed sign-ins for the address are cleared
    // when that sign-in completes". The sign-in stands whether or not this
    // succeeds, as a reset does (password.ts), with the ceiling stated where
    // the link signs in without a second step (sign-in.ts).
    if (link) {
      await clearFailedSignIns(user.email).catch(() =>
        console.error('second step: signed in by a link, counts of failed sign-ins not cleared'),
      );
    }

    // `false`: the cookie lasts as long as the session.
    await setSessionCookie(ctx, { session, user }, false);
    expireCookie(ctx, cookie);
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  });
}

/**
 * `POST /api/auth/two-factor/verify-totp`, with `{ "code" }`: the library's
 * one path for a code of the authenticator application. Under a session it is
 * the first code of an enrolment; without one, the second step of a sign-in.
 * The session's row is read (NFR-SE-17 (c)).
 */
export const verifyTOTP = createAuthEndpoint(
  '/two-factor/verify-totp',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    // NFR-SE-17 (c): the second step carries no session, so the endpoint
    // checks the origin itself, before anything of the request is read.
    const foreign = await refusedOrigin(ctx.headers);
    if (foreign) return foreign;
    const validation = await validateSessionRow(ctx.headers);
    // The enrolment itself: the founding-team gate lets it through (FR-AU-83).
    const own = validation.session ?? validation.stopped;
    return own ? confirmEnrolment(ctx, own) : secondStep(ctx, 'totp');
  },
);

/** `POST /api/auth/two-factor/verify-backup-code`, with `{ "code" }`: the second step, by a recovery code. */
export const verifyBackupCode = createAuthEndpoint(
  '/two-factor/verify-backup-code',
  { method: 'POST', requireHeaders: true },
  // NFR-SE-17 (c): as above.
  async (ctx) => (await refusedOrigin(ctx.headers)) ?? secondStep(ctx, 'recovery'),
);

// ── Turning it off, and replacing the recovery codes ────────────────────────

/**
 * The check of the second factor at a prompt under a session: six digits are a code of the
 * authenticator application, and anything else is looked for among the recovery codes. A wrong one
 * counts as a failed sign-in, as a wrong password at a prompt does, and where a limit is reached the
 * code is refused as a wrong one is (the owner's answer G2 of the pull request; Q10). A recovery
 * code is only looked for here, and spent by the caller's transaction, if its action spends it.
 * The one place for it: turning two-factor authentication off, and the confirmation of the
 * deletion of an account (FR-AU-58: "and for a code where two-factor authentication is on").
 * `ctx` holds the library's key, `await auth().$context` for a route of the application.
 */
export function checkSecondFactorAtPrompt(
  ctx: Keyed,
  headers: Headers | undefined,
  email: string,
  factor: { secret: string; backupCodes: string },
  entered: string,
): Promise<boolean> {
  return checkCodeAtPrompt(headers, email, async () =>
    isCode(entered)
      ? acceptCode(await unseal(ctx, factor.secret), entered)
      : without(await recoveryCodes(ctx, factor.backupCodes), entered) !== null,
  );
}

/**
 * As `checkSecondFactorAtPrompt`, for an action that SPENDS a recovery code (FR-AU-83: "a recovery code is accepted
 * in its place and is then spent"): the clearing of documents, which leaves the account in use, so that a code
 * that opened one confirmation opens no second (docs/plan/slice-23.md, review item 1). `spend` is null for a
 * code of the authenticator, and otherwise a write for the transaction of the action, to be made LAST and only
 * where the action is carried out: over the codes as they were read, so of two requests with one code the second
 * finds it gone (false). A refused action leaves the code its owner's.
 */
export async function checkSecondFactorToSpend(
  ctx: Keyed,
  headers: Headers | undefined,
  email: string,
  factor: { id: string; secret: string; backupCodes: string },
  entered: string,
): Promise<{ right: boolean; spend: ((tx: Prisma.TransactionClient) => Promise<boolean>) | null }> {
  const read: { fewer: string | null } = { fewer: null };
  const right = await checkCodeAtPrompt(headers, email, async () => {
    if (isCode(entered)) return acceptCode(await unseal(ctx, factor.secret), entered);
    const left = without(await recoveryCodes(ctx, factor.backupCodes), entered);
    if (left === null) return false;
    read.fewer = await seal(ctx, JSON.stringify(left));
    return true;
  });
  const { fewer } = read;
  return {
    right,
    spend:
      right && fewer !== null
        ? async (tx) =>
            (
              await tx.twoFactor.updateMany({
                where: { id: factor.id, backupCodes: factor.backupCodes },
                data: { backupCodes: fewer },
              })
            ).count === 1
        : null,
  };
}

/**
 * FR-AU-83: `POST /api/auth/two-factor/disable`, with `{ "password", "code" }`.
 * "Turning two-factor authentication off requires the password and either a
 * current code or a recovery code." An account of the founding team "cannot
 * turn two-factor authentication off": it is refused before anything of the
 * request is read (the owner's answer to Q8), by the list of the process and
 * the row of the account, and never by anything the request says
 * (NFR-SE-17 (d)). The notice of FR-AU-87 (f) follows.
 */
export const disableTwoFactor = createAuthEndpoint(
  '/two-factor/disable',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    assertCollecting();
    // NFR-SE-17 (c): turning two-factor authentication off reads the session's row.
    const validation = await validateSessionRow(ctx.headers);
    const own = validation.session;
    if (!own) return notAdmitted(validation);
    const account = await accountOf(own.userId);
    if (!account?.email) return unauthenticated();
    if (ofFoundingTeam(account)) {
      await securityLog({ kind: 'forbidden', userId: own.userId });
      return errorResponse(403, 'forbidden', MESSAGES.foundingTeam);
    }
    const entered = textFields(ctx.body, 'password', 'code');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.offShape);

    const { verified } = await checkCredentials(ctx.context, ctx.headers, account.email, entered.password);
    if (!verified) return refusedPassword(own.userId);
    const factor = await db().twoFactor.findUnique({ where: { userId: own.userId } });
    if (!account.twoFactorEnabled || !factor?.verified) {
      return errorResponse(409, 'two_factor_not_on', MESSAGES.notOn);
    }
    // Six digits are a code of the authenticator application, and anything
    // else is looked for among the recovery codes. A wrong one counts as a
    // failed sign-in, as a wrong password at this prompt does, and where a
    // limit is reached the code is refused as a wrong one is (the owner's
    // answer G2 of the pull request; Q10). NFR-SE-19: a 403.
    const right = await checkSecondFactorAtPrompt(ctx, ctx.headers, account.email, factor, entered.code);
    if (!right) {
      await securityLog({ kind: 'forbidden', userId: own.userId });
      return errorResponse(403, 'code_refused', MESSAGES.eitherCode);
    }

    const outcome = await db().$transaction(async (tx) => {
      const stands = await standing(tx, verified, own);
      if (stands !== 'held') return stands;
      // Only the row the code was checked against, with its codes as they were read.
      const deleted = await tx.twoFactor.deleteMany({
        where: { id: factor.id, verified: true, secret: factor.secret, backupCodes: factor.backupCodes },
      });
      if (deleted.count !== 1) return 'changed';
      await tx.user.update({ where: { id: own.userId }, data: { twoFactorEnabled: false } });
      return 'off';
    });
    if (outcome === 'ended') return unauthenticated();
    if (outcome === 'outrun') return refusedPassword(own.userId);
    // Turned off, or its codes spent or replaced, by another request meanwhile.
    if (outcome === 'changed') {
      await securityLog({ kind: 'forbidden', userId: own.userId });
      return errorResponse(403, 'code_refused', MESSAGES.eitherCode);
    }

    const { email } = account;
    afterResponse('two-factor notice', () => handOver(turnedEmail(email, 'off')));
    await freshCopy(ctx);
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  },
);

/**
 * FR-AU-83: `POST /api/auth/two-factor/generate-backup-codes`, with
 * `{ "password" }`. "The user can replace them with ten new ones at any time,
 * after entering the password, which makes the old ones void." The answer
 * holds the new codes, once. The notice of FR-AU-87 (g) follows.
 */
export const generateBackupCodes = createAuthEndpoint(
  '/two-factor/generate-backup-codes',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    assertCollecting();
    // NFR-SE-17 (c): replacing the recovery codes reads the session's row.
    const validation = await validateSessionRow(ctx.headers);
    const own = validation.session;
    if (!own) return notAdmitted(validation);
    const entered = textFields(ctx.body, 'password');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.passwordShape);
    const account = await accountOf(own.userId);
    if (!account?.email) return unauthenticated();

    const { verified } = await checkCredentials(ctx.context, ctx.headers, account.email, entered.password);
    if (!verified) return refusedPassword(own.userId);

    const codes = newRecoveryCodes();
    const backupCodes = await seal(ctx, JSON.stringify(codes));
    const outcome = await db().$transaction(async (tx) => {
      const stands = await standing(tx, verified, own);
      if (stands !== 'held') return stands;
      // Only where it is on: an enrolment that is not confirmed has no codes.
      const replaced = await tx.twoFactor.updateMany({
        where: { userId: own.userId, verified: true },
        data: { backupCodes },
      });
      return replaced.count === 1 ? 'replaced' : 'off';
    });
    if (outcome === 'ended') return unauthenticated();
    if (outcome === 'outrun') return refusedPassword(own.userId);
    if (outcome === 'off') return errorResponse(409, 'two_factor_not_on', MESSAGES.notOn);

    const { email } = account;
    afterResponse('recovery codes notice', () => handOver(codesReplacedEmail(email)));
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({ recoveryCodes: codes });
  },
);
