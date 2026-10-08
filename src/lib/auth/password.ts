// The reset of a password by an emailed link (FR-AU-86) and the change of a
// password in the account settings (FR-AU-85), as endpoints of the
// application's own inside the identity library. auth.ts mounts each under the
// library's own name, so the library's endpoint of that name no longer exists.
// As they ship at 1.7.7 the library's three do less or more than the text:
//
// - its request for a reset stores the token as it is, looks the account up
//   and writes the token before it answers, refuses an address that is no
//   address in other words, takes a place to go to from the request, and
//   counts nothing;
// - its completion counts a password in UTF-16 units, checks no list, spends
//   the token before the password is judged, leaves the other links valid, and
//   ends the sessions only where a setting says so;
// - its change of password ends the other sessions only where the request
//   asks, returns a session token in the body, and counts no wrong password.
//
// NFR-SE-19: nothing here logs an address, a token or a password. The token
// leaves this module once, inside the email of FR-AU-87 (c).
import { randomUUID } from 'node:crypto';
import { createAuthEndpoint } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import { afterResponse, assertCollecting } from '../after-response.ts';
import { addressBucket } from '../client-address.ts';
import { db } from '../db.ts';
import { handOver } from '../email/hand-over.ts';
import type { EmailMessage } from '../email/index.ts';
import { errorResponse, textFields } from '../http.ts';
import { checkPassword } from '../password-rules.ts';
import { logLimitReached, takeLimit } from '../rate-limit.ts';
import { securityLog } from '../security-log.ts';
import { settings } from '../settings.ts';
import { hashToken, newToken, RESET_LINK, TOKEN } from '../token.ts';
import { voidAddressLinks } from './address-links.ts';
import { notAdmitted, refusedOrigin, tooManyRequests, unauthenticated } from './route-answers.ts';
import { validateSessionRow } from './session.ts';
import { checkCredentials, clearFailedSignIns, SIGN_IN_REFUSED } from './sign-in.ts';
import { SECOND_STEP } from './second-step.ts';
import { liftLock, voidSignInLinks } from './sign-in-lock.ts';

/** FR-AU-86: the one answer to every request for a reset, verbatim. */
export const RESET_REQUESTED =
  'If this address belongs to an account, Ekdotico has sent it an email with a link to set a new password.';

// FR-AU-86: "a single-use link that is valid for 1 hour". Not a setting: the
// fixed text of the email says the hour.
const RESET_LINK_MS = 60 * 60 * 1000;

// Text for a person (the owner's answer to Q6 of the plan: approved with the
// pull request). FR-AU-86 fixes no statement for a link that no longer works.
const MESSAGES = {
  requestShape: 'The request must hold an email address, and nothing else.',
  resetShape: 'The request must hold the token of a link and a new password, and nothing else.',
  changeShape: 'The request must hold the current password and a new password, and nothing else.',
  linkNotValid:
    'This link is no longer valid. A link to set a new password works once and is valid for 1 hour. Ask for a new one.',
  passwordRule:
    'The password was not changed, because the new password does not meet its rule. Change what is marked and try again.',
};

// The reset links of the account are rows of the identity library's table of
// single-use tokens (../token.ts).
const RESET = RESET_LINK;

// FR-AU-87 (c), verbatim. Plain text; nothing of a person but the address it is sent to.
function resetEmail(to: string, token: string): EmailMessage {
  const link = `${settings().appOrigin}/reset-password/${token}`;
  return {
    to,
    subject: 'Set a new password for Ekdotico',
    text: `You asked to set a new password for your Ekdotico account. To set it, open this link: ${link}. The link works once and is valid for 1 hour. If you did not ask for this, you can ignore this email, and your password stays as it is.`,
  };
}

// FR-AU-87 (d), verbatim.
function passwordChangedEmail(to: string): EmailMessage {
  return {
    to,
    subject: 'The password of your Ekdotico account was changed',
    text: 'The password of your Ekdotico account was changed. If you did not change it, set a new password from the sign-in page.',
  };
}

/**
 * Everything of a request for a reset that depends on the address, run after
 * the answer has been returned. "Where the address is the verified address of
 * an account, the application sends one email"; for any other address it does
 * nothing. An earlier link of the account is left as it is: "asking again
 * does not make an earlier link void".
 */
async function sendResetLink(email: string, now: Date = new Date()): Promise<void> {
  // No address holds a control character, and the database refuses the first of them.
  if (/[\u0000-\u001f\u007f]/.test(email)) return;
  const user = await db().user.findUnique({ where: { email }, select: { id: true, emailVerified: true } });
  if (!user?.emailVerified) return;
  const token = newToken();
  // For the slice that builds the change of address (FR-AU-03): a link is
  // bound to the user, not to the address it was mailed to, so that slice
  // deletes the account's `reset-password:` rows in the transaction that
  // changes the address.
  await db().verification.create({
    data: {
      id: randomUUID(),
      identifier: RESET + hashToken(token),
      value: user.id,
      expiresAt: new Date(now.getTime() + RESET_LINK_MS),
    },
  });
  await handOver(resetEmail(email, token));
}

/**
 * FR-AU-86: `POST /api/auth/request-password-reset`, with `{ "email" }`.
 * Every request is answered in the same way. Before the answer it asks Valkey
 * for its two limits and does nothing else; the account is looked up, the
 * link written and the email handed over after the answer has been returned.
 */
export const requestPasswordReset = createAuthEndpoint(
  '/request-password-reset',
  { method: 'POST' },
  async (ctx) => {
    // NFR-SE-17 (c): before anything of the request is read.
    const foreign = await refusedOrigin(ctx.headers);
    if (foreign) return foreign;
    assertCollecting();
    const entered = textFields(ctx.body, 'email');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.requestShape);
    // FR-AU-02: lower case, as an address is stored. Bounded, whatever was sent.
    const email = entered.email.slice(0, 255).toLowerCase();

    // NFR-SE-07: 10 in any hour for each network address, answered 429.
    const bucket = addressBucket(ctx.headers ?? new Headers());
    const byAddress = await takeLimit('RESET_PER_ADDRESS', bucket);
    if (!byAddress.ok) return tooManyRequests('RESET_PER_ADDRESS', bucket, byAddress.retryAfterSeconds);

    // NFR-SE-07: 3 in any hour for each email address entered. "A request
    // over the limit for an email address receives the same answer as any
    // other and sends nothing" (the owner's answer to Q1: no 429). The entry
    // in the security log waits for the answer too (NFR-SE-19).
    const byEmail = await takeLimit('RESET_PER_EMAIL', email);
    if (byEmail.ok) afterResponse('password reset link', () => sendResetLink(email));
    else {
      const seconds = byEmail.retryAfterSeconds;
      afterResponse('password reset limit', () => logLimitReached('RESET_PER_EMAIL', email, seconds));
    }

    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({ message: RESET_REQUESTED });
  },
);

/**
 * The account whose unused, unexpired reset link this token is, for the page
 * the link opens and for the completion. Null for no token and for one that
 * is spent, expired, or not known: the caller is told nothing of which. It
 * changes nothing, so a program that fetches the links of an email spends none.
 */
export async function findOpenReset(
  token: unknown,
  now: Date = new Date(),
): Promise<{ id: string; userId: string; email: string } | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const row = await db().verification.findFirst({
    where: { identifier: RESET + hashToken(token), expiresAt: { gt: now } },
    select: { id: true, value: true },
  });
  if (!row) return null;
  const user = await db().user.findUnique({ where: { id: row.value }, select: { email: true } });
  return user?.email ? { id: row.id, userId: row.value, email: user.email } : null;
}

/** The 422 of a new password that does not meet a rule of FR-AU-82, which it names. */
const passwordRefused = (refusal: string) =>
  Response.json(
    { error: { code: 'invalid', message: MESSAGES.passwordRule, fields: { newPassword: refusal } } },
    { status: 422, headers: { 'Cache-Control': 'no-store' } },
  );

/**
 * FR-AU-86: `POST /api/auth/reset-password`, with `{ "token", "newPassword" }`.
 * No session: the request is authorised by the token of a reset link, and by
 * nothing else. It "does not sign the person in": the answer is `{}` and sets
 * no cookie of a session.
 */
export const resetPassword = createAuthEndpoint('/reset-password', { method: 'POST' }, async (ctx) => {
  // NFR-SE-17 (c): before anything of the request is read.
  const foreign = await refusedOrigin(ctx.headers);
  if (foreign) return foreign;
  // The notice is left for after the answer, which only a request that
  // collects can take: asked now, before anything is written.
  assertCollecting();
  const entered = textFields(ctx.body, 'token', 'newPassword');
  if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.resetShape);

  // Authorisation before validation (the owner's answer to Q8): whether the
  // link is valid is settled before anything is said of the password.
  const notValid = () => errorResponse(409, 'reset_link_not_valid', MESSAGES.linkNotValid);
  const reset = await findOpenReset(entered.token);
  if (!reset) return notValid();
  const refusal = checkPassword(entered.newPassword, reset.email);
  if (refusal) return passwordRefused(refusal);

  // NFR-SE-17 (a): the library's own function, scrypt with a salt for each
  // password. Made before the transaction, which it would hold open.
  const hash = await ctx.context.password.hash(entered.newPassword);
  const completed = await db().$transaction(async (tx) => {
    // The claim comes first and is one conditional statement: of two
    // submissions of one link the second waits for the first, then deletes
    // nothing and changes nothing.
    const claimed = await tx.verification.deleteMany({
      where: { id: reset.id, expiresAt: { gt: new Date() } },
    });
    if (claimed.count !== 1) return false;
    const changed = await tx.account.updateMany({
      where: { userId: reset.userId, providerId: 'credential' },
      data: { password: hash },
    });
    // No account without a password exists (FR-AU-90). Were one found, nothing
    // is spent and nothing ended.
    if (changed.count !== 1) throw new Error('password reset: no credential');
    // "The completion of a reset makes void every other reset link of the account."
    await tx.verification.deleteMany({ where: { value: reset.userId, identifier: { startsWith: RESET } } });
    // FR-AU-03: a change of address that the old password asked for is not
    // confirmed after it (address-links.ts; its register row is pending).
    // After the reset links, as the confirmation of an address takes them.
    await voidAddressLinks(tx, reset.userId);
    // FR-AU-83: a second step that the old password began does not complete.
    // Before the sessions: the second step makes its session first and claims
    // its row after, so one of the two statements here finds what it made.
    await tx.verification.deleteMany({
      where: { value: reset.userId, identifier: { startsWith: SECOND_STEP } },
    });
    // "Setting it ends every session of the account" (FR-AU-85).
    await tx.session.deleteMany({ where: { userId: reset.userId } });
    // FR-AU-86: it "lifts a lock on the account where one is in force", and
    // makes void "the sign-in link of a lock email where one is outstanding".
    // A second step begun from that link went with the steps, above.
    await liftLock(tx, reset.userId);
    return true;
  });
  if (!completed) return notValid();

  // FR-ED-40 (d): the slice that builds the collaboration server publishes the
  // end of the account's sessions here, once the transaction has committed.

  // NFR-SE-07: "clears the counters of failed sign-ins for the address", so
  // that the person can sign in at once. The reset stands whether or not this
  // succeeds: uncleared, the counts refuse for the rest of their hour and no
  // longer, so a fault of Valkey is no reason to answer that nothing changed.
  await clearFailedSignIns(reset.email).catch(() =>
    console.error('password reset: completed, counts of failed sign-ins not cleared'),
  );
  // FR-AU-87 (d): the notice, after the answer.
  afterResponse('password notice', () => handOver(passwordChangedEmail(reset.email)));

  // A browser that held a session of the account has its cookies cleared: the
  // session has ended, and its signed copy would otherwise read pages for up
  // to a minute (NFR-SE-17 (c)). A session of another account is left alone.
  const { authCookies, secret, internalAdapter } = ctx.context;
  const held = await ctx.getSignedCookie(authCookies.sessionToken.name, secret);
  if (held && !(await internalAdapter.findSession(held))) deleteSessionCookie(ctx);

  ctx.setHeader('Cache-Control', 'no-store');
  return ctx.json({});
});

// Thrown inside the transaction of a change of password, to undo it.
const SESSION_ENDED = new Error('password change: session ended');
const OUTRUN = new Error('password change: the password was set meanwhile');

/**
 * FR-AU-85: `POST /api/auth/change-password`, with `{ "currentPassword",
 * "newPassword" }`. It "requires the current password", and "every other
 * session of the account ends". The session in use stays, with its cookie.
 */
export const changePassword = createAuthEndpoint(
  '/change-password',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    assertCollecting();
    // NFR-SE-17 (c): a change of the password reads the session's row.
    const validation = await validateSessionRow(ctx.headers);
    const { session } = validation;
    if (!session) return notAdmitted(validation);
    const entered = textFields(ctx.body, 'currentPassword', 'newPassword');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.changeShape);

    const user = await db().user.findUnique({ where: { id: session.userId }, select: { email: true } });
    if (!user?.email) return unauthenticated();

    // The owner's answer to Q10: a wrong password at this prompt counts as a
    // failed sign-in, and a prompt refused by a limit is answered as a wrong
    // password is, with the statement of FR-AU-81, so that the answer does not
    // show that a limit was reached. The session stays. NFR-SE-19: a 403.
    const { verified } = await checkCredentials(
      ctx.context,
      ctx.headers,
      user.email,
      entered.currentPassword,
    );
    const refused = async () => {
      await securityLog({ kind: 'forbidden', userId: session.userId });
      return errorResponse(403, 'password_refused', SIGN_IN_REFUSED);
    };
    if (!verified) return refused();
    const refusal = checkPassword(entered.newPassword, user.email);
    if (refusal) return passwordRefused(refusal);

    const hash = await ctx.context.password.hash(entered.newPassword);
    // Two runs of scrypt have passed since the session was read and the
    // password verified, and either may have ended meanwhile: the account's
    // owner completed a reset, or ended this session. So the transaction asks
    // both again, each as a write, which waits for whatever has not committed.
    const own = { id: session.sessionId, userId: session.userId };
    const outcome = await db()
      .$transaction(async (tx) => {
        // The owner's decision S6 of the pull request: "Void them at a change
        // of password too." Every reset link of the account that is
        // outstanding is made void, as the completion of a reset makes void
        // the others (FR-AU-86). First of all, as the completion of a reset
        // claims its link before it takes the password: taken after it, the
        // two would wait for each other in a circle. Whatever below finds that
        // nothing is to change throws, so that no link is void without a
        // change.
        await tx.verification.deleteMany({
          where: { value: session.userId, identifier: { startsWith: RESET } },
        });
        // FR-AU-03: and a change of address that the old password asked for,
        // as at a reset. Undone with the rest where nothing is to change.
        await voidAddressLinks(tx, session.userId);
        // The password next, as the completion of a reset takes it, so that
        // neither waits for the other in a circle. Written only over the hash
        // that was verified: one set since then is not overwritten (FR-AU-86).
        const changed = await tx.account.updateMany({
          where: {
            id: verified.id,
            userId: session.userId,
            providerId: 'credential',
            password: verified.hash,
          },
          data: { password: hash },
        });
        if (changed.count !== 1) {
          // Whatever set the other password ended this session too, unless it
          // was a change made under this very session.
          throw (await tx.session.count({ where: own })) === 0 ? SESSION_ENDED : OUTRUN;
        }
        // FR-AU-84: a session that has ended changes nothing. Prisma has no
        // read that locks a row, so the row is written with its own value:
        // from here to the commit no other request can end this session, and
        // one that already has is found.
        const held = await tx.session.findFirst({ where: own, select: { updatedAt: true } });
        const locked = held
          ? await tx.session.updateMany({
              where: { ...own, updatedAt: held.updatedAt },
              data: { updatedAt: held.updatedAt },
            })
          : { count: 0 };
        if (locked.count !== 1) {
          // Thrown, so that the new password is not kept. A row that is there
          // but was renewed between the two statements is a fault, not an end.
          if ((await tx.session.count({ where: own })) === 0) throw SESSION_ENDED;
          throw new Error('password change: session renewed meanwhile');
        }
        // FR-AU-83: a second step that the old password began does not
        // complete, as in the completion of a reset, and in the same order.
        await tx.verification.deleteMany({
          where: { value: session.userId, identifier: { startsWith: SECOND_STEP } },
        });
        await tx.session.deleteMany({ where: { userId: session.userId, id: { not: session.sessionId } } });
        // FR-AU-81: the sign-in link of a lock email is void "when the
        // password … of the account is changed". The lock itself stays: only
        // a completed reset and the link lift one. A step begun from the link
        // went with the steps, above.
        await voidSignInLinks(tx, session.userId);
        return 'changed';
      })
      .catch((error: unknown) => {
        if (error === SESSION_ENDED) return 'ended';
        if (error === OUTRUN) return 'outrun';
        throw error;
      });
    if (outcome === 'ended') return unauthenticated();
    // The password was changed under this session while this request was on
    // its way, so the one it sent is no longer the current password: the
    // answer to a wrong one, with its entry (NFR-SE-19: a 403). Not counted as
    // a failed sign-in: it was the right password when it was checked.
    if (outcome === 'outrun') return refused();
    // FR-ED-40 (d): the slice that builds the collaboration server publishes
    // the end of the other sessions here.

    // FR-AU-87 (d): the notice, after the answer.
    const { email } = user;
    afterResponse('password notice', () => handOver(passwordChangedEmail(email)));
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  },
);

/** NFR-RE-15: removes the single-use tokens that have expired; returns how many. Idempotent. */
export async function deleteExpiredTokens(now: Date = new Date()): Promise<number> {
  // Every row of the table is a token with an expiry, a reset link or
  // another, and one that has expired is refused wherever it is read.
  const { count } = await db().verification.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
