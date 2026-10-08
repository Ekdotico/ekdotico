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
import type { GenericEndpointContext } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { expireCookie, setCookieCache, setSessionCookie } from 'better-auth/cookies';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { Prisma } from '../../generated/prisma/client.ts';
import { afterResponse, assertCollecting } from '../after-response.ts';
import { db } from '../db.ts';
import { handOver } from '../email/hand-over.ts';
import type { EmailMessage } from '../email/index.ts';
import { errorResponse, textFields } from '../http.ts';
import { oncePer } from '../rate-limit.ts';
import { securityLog } from '../security-log.ts';
import { settings } from '../settings.ts';
import { hashToken, TOKEN } from '../token.ts';
import { valkey } from '../valkey.ts';
import { stoppedByFoundingGate, type GatedAccount } from './founding-gate.ts';
import { notAdmitted, unauthenticated } from './route-answers.ts';
import { SECOND_STEP, SECOND_STEP_COOKIE } from './second-step.ts';
import { holdSession, validateSessionRow, type ValidSession } from './session.ts';
import { checkCredentials, countFailedSignIn, SIGN_IN_REFUSED, stillVerified } from './sign-in.ts';

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
    'This sign-in can no longer be completed, because its time has passed or too many codes were not correct. Begin again with the email address and the password.',
  on: 'Two-factor authentication is already turned on for this account.',
  notOn: 'Two-factor authentication is not turned on for this account.',
  notBegun: 'No secret is waiting for its first code. Enter the password to begin again.',
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
 * one.
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
const seal = (ctx: GenericEndpointContext, data: string) =>
  symmetricEncrypt({ key: ctx.context.secretConfig, data });
const unseal = (ctx: GenericEndpointContext, data: string) =>
  symmetricDecrypt({ key: ctx.context.secretConfig, data });

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
async function recoveryCodes(ctx: GenericEndpointContext, sealed: string): Promise<string[]> {
  const codes: unknown = JSON.parse(await unseal(ctx, sealed));
  return Array.isArray(codes) ? codes.filter((code): code is string => typeof code === 'string') : [];
}

/** What is left of the codes once the one entered is spent, or null where it is none of them. Every code is compared. */
function without(codes: string[], entered: string): string[] | null {
  const code = entered.trim();
  const left = codes.filter((each) => !same(each, code));
  return left.length === codes.length ? null : left;
}

type Factor = { id: string; secret: string; backupCodes: string; verified: boolean };

/**
 * FR-AU-83: "a recovery code is accepted in its place and is then spent". The
 * row is written only over the codes that were read, so of two requests with
 * one code the second finds it gone, and codes replaced meanwhile stay as
 * they were set.
 */
async function spendRecoveryCode(ctx: GenericEndpointContext, factor: Factor, entered: string) {
  const left = without(await recoveryCodes(ctx, factor.backupCodes), entered);
  if (!left) return false;
  const { count } = await db().twoFactor.updateMany({
    where: { id: factor.id, backupCodes: factor.backupCodes },
    data: { backupCodes: await seal(ctx, JSON.stringify(left)) },
  });
  return count === 1;
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
async function standing(
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
 * founding-team gate opens at once for the browser that turned it on.
 */
async function freshCopy(ctx: GenericEndpointContext): Promise<void> {
  const { authCookies, secret, internalAdapter } = ctx.context;
  const token = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
  const held = token ? await internalAdapter.findSession(token) : null;
  if (held) await setCookieCache(ctx, held, false);
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
    const data = { secret: await seal(ctx, secret), backupCodes: await seal(ctx, '[]'), verified: false };
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
 */
async function confirmEnrolment(ctx: GenericEndpointContext, own: ValidSession): Promise<unknown> {
  assertCollecting();
  const entered = textFields(ctx.body, 'code');
  if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.codeShape);
  const account = await accountOf(own.userId);
  const factor = await db().twoFactor.findUnique({ where: { userId: own.userId } });
  if (!account?.email) return unauthenticated();
  if (!factor || factor.verified) return errorResponse(409, 'two_factor_not_begun', MESSAGES.notBegun);

  if (!(await acceptCode(await unseal(ctx, factor.secret), entered.code))) {
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
  if (outcome === 'replaced') return errorResponse(409, 'two_factor_not_begun', MESSAGES.notBegun);

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
  // Authorisation before validation (the owner's answer to Q8).
  const token = await ctx.getSignedCookie(cookie.name, secret);
  const step =
    typeof token === 'string' && TOKEN.test(token)
      ? await db().verification.findFirst({
          where: { identifier: SECOND_STEP + hashToken(token), expiresAt: { gt: new Date() } },
          select: { id: true, value: true },
        })
      : null;
  const refused = async (code: 'sign_in_again' | 'code_refused', message: string) => {
    await securityLog({ kind: 'sign_in_refused', userId: step?.value });
    // A step that cannot be completed leaves no cookie behind.
    if (code === 'sign_in_again') expireCookie(ctx, cookie);
    return errorResponse(401, code, message);
  };
  if (!step) return refused('sign_in_again', MESSAGES.again);
  const entered = textFields(ctx.body, 'code');
  if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.codeShape);

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

  // The identifier of the row is random and names no one, so it is the key as it is.
  const counted = `second-step-codes:${step.id}`;
  const most = settings().secondStepWrongCodes;
  // The expiry is set before anything is counted, so no count outlives its step.
  await valkey().set(counted, 0, 'EX', settings().secondStepSeconds, 'NX');
  const attempt = await valkey().incr(counted);
  if (attempt > most) {
    await end();
    return refused('sign_in_again', MESSAGES.again);
  }

  const right =
    kind === 'totp'
      ? await acceptCode(await unseal(ctx, factor.secret), entered.code)
      : await spendRecoveryCode(ctx, factor, entered.code);
  if (!right) {
    if (attempt < most) {
      return refused('code_refused', kind === 'totp' ? MESSAGES.code : MESSAGES.recoveryCode);
    }
    // Abandoned. The slice that builds the lock (FR-AU-81) spends the sign-in
    // link here where the step began from one, and then counts nothing.
    await end();
    await countFailedSignIn(ctx.headers, user.email);
    return refused('sign_in_again', MESSAGES.again);
  }

  // The session is made first and the step claimed after, as a sign-in makes
  // its session before it asks the password again (sign-in.ts): a reset or a
  // change of the password deletes the steps and then the sessions of the
  // account, so in whichever order the two run, either the claim finds the
  // step gone or the session made here is among those ended.
  const session = await internalAdapter.createSession(user.id);
  if (!session) throw new NoSession('second step: no session');
  const claimed = await db().verification.deleteMany({
    where: { id: step.id, expiresAt: { gt: new Date() } },
  });
  if (claimed.count !== 1) {
    await db().session.deleteMany({ where: { token: session.token } });
    return refused('sign_in_again', MESSAGES.again);
  }
  // The slice that builds the lock lifts it here, and clears the counts of
  // failed sign-ins, where the step began from the link of a lock email.

  // The browser holds no session to end: the password step ended the one it
  // held (sign-in.ts), and a request under a session does not come here.
  // `false`: the cookie lasts as long as the session.
  await setSessionCookie(ctx, { session, user }, false);
  expireCookie(ctx, cookie);
  ctx.setHeader('Cache-Control', 'no-store');
  return ctx.json({});
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
  (ctx) => secondStep(ctx, 'recovery'),
);

// ── Turning it off, and replacing the recovery codes ────────────────────────

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
    // else is looked for among the recovery codes. NFR-SE-19: a 403.
    const right = isCode(entered.code)
      ? await acceptCode(await unseal(ctx, factor.secret), entered.code)
      : without(await recoveryCodes(ctx, factor.backupCodes), entered.code) !== null;
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
