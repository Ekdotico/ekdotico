// The change of an account's name (FR-AU-90) and of its email address
// (FR-AU-02, FR-AU-03, FR-AU-87 (b) and (e); NFR-SE-07, the row of the
// confirmation email; register D88), as endpoints of the application's own
// inside the identity library. auth.ts mounts each under the library's own
// name, so the library's endpoint of that name no longer exists. As they ship
// at 1.7.7 the library's three do less or more than the text:
//
// - its change of a user takes any column a request names, and validates the
//   session against the signed copy;
// - its change of an address asks for no password, answers differently for an
//   address that is taken, and takes a place to go to from the request;
// - its confirmation is a GET, so a program that fetches the links of an email
//   would make the change, and it ends no session.
//
// The answer to Q3 of the plan (the owner, 7 October 2026): the link opens a
// page with one control, the change is made by that control, and "every
// session ends except the confirming browser's own". Next.js serves no route
// handler where a page is, so the control is `POST /api/auth/verify-email`
// with the token in its body, as the link of a lock email has its own. By the
// owner's decision of 9 October 2026 (its register row is pending) that
// control needs a session of the account that asked for the change, so the
// confirming browser always has one; the part of Q3 that let the link be
// confirmed in a browser without a session is taken back.
//
// NFR-SE-19: nothing here logs an address, a name, a token or a password. The
// token leaves this module once, inside the email of FR-AU-87 (b).
import { randomUUID } from 'node:crypto';
import { createAuthEndpoint } from 'better-auth/api';
import { afterResponse, assertCollecting } from '../after-response.ts';
import { db } from '../db.ts';
import { handOver } from '../email/hand-over.ts';
import type { EmailMessage } from '../email/index.ts';
import { acceptedAddress, acceptedName, addressSpelling, NAME_REFUSAL } from '../field-text.ts';
import { errorResponse, textFields } from '../http.ts';
import { takeLimit } from '../rate-limit.ts';
import { securityLog, securityLogIn } from '../security-log.ts';
import { settings } from '../settings.ts';
import { hashToken, newToken, RESET_LINK, TOKEN } from '../token.ts';
import { ADDRESS_LINK, changeOf, pendingChange, voidAddressLinks } from './address-links.ts';
import { notAdmitted, refusedOrigin, tooManyRequests, unauthenticated } from './route-answers.ts';
import { SECOND_STEP } from './second-step.ts';
import { holdSession, validateSessionRow } from './session.ts';
import { voidSignInLinks } from './sign-in-lock.ts';
import { checkCredentials, SIGN_IN_REFUSED, stillVerified } from './sign-in.ts';
import { freshCopy, ofFoundingTeam } from './two-factor.ts';

// FR-AU-03: "a single-use link sent to the new address, which is valid for
// 1 hour". Not a setting: the fixed text of the email says the hour.
const ADDRESS_LINK_MS = 60 * 60 * 1000;

/**
 * FR-AU-03: "asking for the change is answered in the same way whether or not
 * the new address already belongs to another account", and a request that
 * names a listed address "is answered in the same way as any other". The one
 * answer to every request that passed its prompt. Text for a person (the
 * owner's answer to Q6 of the plan: approved with the pull request).
 */
export const CHANGE_ASKED =
  'Ekdotico sends a confirmation link only to an address that can become the address of this account. If the new address can, it receives an email with a link that works once and is valid for 1 hour. The address of the account stays as it is until that link is opened.';

// Text for a person (Q6). FR-AU-03 fixes no statement for a link that no
// longer works, and FR-AU-90 none for a name that is refused at its change.
const MESSAGES = {
  nameShape: 'The request must hold a name, and nothing else.',
  nameRule:
    'The name was not changed, because it does not meet its rule. Change what is marked and try again.',
  changeShape: 'The request must hold a new email address and the current password, and nothing else.',
  addressRule:
    'The email address was not changed, because what was entered cannot be an email address. Change what is marked and try again.',
  address: 'Enter one email address of at most 254 characters, in the form name@example.com.',
  tokenShape: 'The request must hold the token of a link, and nothing else.',
  linkNotValid:
    'This link is no longer valid. A link to confirm a new email address works once and is valid for 1 hour. Ask for a new one in the account settings.',
};

/** The 422 of a field that does not meet its rule, which it names. */
const fieldRefused = (message: string, fields: Record<string, string>) =>
  Response.json(
    { error: { code: 'invalid', message, fields } },
    { status: 422, headers: { 'Cache-Control': 'no-store' } },
  );

/**
 * FR-AU-87 (b), verbatim, in the form the owner gave the invitation's email on
 * 8 October 2026: the link stands on a line of its own, with nothing touching
 * it. Plain text; nothing of a person but the address it is sent to.
 */
export function confirmationEmail(to: string, token: string): EmailMessage {
  return {
    to,
    subject: 'Confirm your new email address for Ekdotico',
    text: `You asked to change the email address of your Ekdotico account to this address. To confirm, open this link:\n${settings().appOrigin}/confirm-address/${token}\nThe link works once and is valid for 1 hour. If you did not ask for this, you can ignore this email, and nothing changes.`,
  };
}

/**
 * FR-AU-87 (e), verbatim, sent to the old address. "Until the contact address
 * exists the last sentence reads" as it does here (register D121, Q35): there
 * is no setting for the address yet, and none is made up.
 */
export function addressChangedEmail(to: string): EmailMessage {
  return {
    to,
    subject: 'The email address of your Ekdotico account was changed',
    text: 'The email address of your Ekdotico account was changed, and this address no longer signs in to it. If you did not change it, contact the Ekdotico team.',
  };
}

/** The columns of an account that a change of its address reads. */
const ACCOUNT = { email: true, emailVerified: true, twoFactorEnabled: true } as const;

/** FR-AU-03, FR-AU-83 (register A102, assumed): whether an address is on the list of the founding team. */
const listed = (email: string) => settings().foundingTeamEmails.includes(addressSpelling(email));

// ── The name ────────────────────────────────────────────────────────────────

/**
 * FR-AU-90: `POST /api/auth/update-user`, with `{ "name" }`. "The name is the
 * display name of FR-ED-17, and the user can change it in the account
 * settings", under the rule of the sign-up (../field-text.ts). The request
 * names the name and nothing else, so it changes no other column. NFR-SE-08:
 * stored as it was typed, and never read as markup.
 */
export const updateUser = createAuthEndpoint(
  '/update-user',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    // NFR-SE-17 (c): a request that changes state reads the session's row.
    const validation = await validateSessionRow(ctx.headers);
    const own = validation.session;
    if (!own) return notAdmitted(validation);
    const entered = textFields(ctx.body, 'name');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.nameShape);
    const name = acceptedName(entered.name);
    if (!name) return fieldRefused(MESSAGES.nameRule, { name: NAME_REFUSAL });

    const changed = await db().$transaction(async (tx) => {
      // FR-AU-84: a session that has ended changes nothing.
      if (!(await holdSession(tx, own))) return false;
      await tx.user.update({ where: { id: own.userId }, data: { name } });
      return true;
    });
    if (!changed) return unauthenticated();

    // The signed copy carries the name: this browser reads the new one at once.
    await freshCopy(ctx, 'name');
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  },
);

// ── Asking for a change of the address ──────────────────────────────────────

/**
 * Everything of a request for a change that depends on the new address, run
 * after the answer has been returned, so that neither the answer nor the time
 * it takes shows whether the address belongs to an account (FR-AU-03).
 *
 * Nothing is written and nothing sent:
 * - for an account of the founding team, and for a new address on that list:
 *   "sends nothing, and changes nothing" (FR-AU-03; register A102, assumed);
 * - for an address that belongs to an account, this one included. FR-AU-03
 *   says of it only that it "is never taken"; that nothing is sent to it is
 *   this file's reading, and its register row is pending.
 *
 * Every request that passed its prompt makes void the earlier link of the
 * account, before any of that is looked at (the owner, 9 October 2026: "a
 * later request voids the earlier link"). Were the earlier link left standing
 * where nothing is sent, the person who asked would read from their own link
 * whether the address they named next belongs to an account or is listed.
 */
async function sendConfirmation(
  userId: string,
  account: { email: string; emailVerified: boolean; twoFactorEnabled: boolean | null },
  newEmail: string,
  now: Date = new Date(),
): Promise<void> {
  const token = newToken();
  const written = await db().$transaction(async (tx) => {
    await voidAddressLinks(tx, userId);
    if (ofFoundingTeam(account) || listed(newEmail)) return false;
    if ((await tx.user.count({ where: { email: newEmail } })) > 0) return false;
    await tx.verification.create({
      data: {
        id: randomUUID(),
        identifier: ADDRESS_LINK + hashToken(token),
        value: pendingChange(userId, newEmail),
        expiresAt: new Date(now.getTime() + ADDRESS_LINK_MS),
      },
    });
    return true;
  });
  if (written) await handOver(confirmationEmail(newEmail, token), 'confirmation of an address');
}

/**
 * FR-AU-03: `POST /api/auth/change-email`, with `{ "newEmail", "password" }`.
 * "The user may change it in the account settings, after entering the current
 * password." Nothing changes here: "until then the old address stands".
 *
 * The order is that of the owner's answer to Q8: the session, the password,
 * and only then what was entered. Before the answer the request reads nothing
 * of the new address but its form, and takes its limit; whether a link is
 * written and an email sent is settled after the answer has been returned.
 */
export const changeEmail = createAuthEndpoint(
  '/change-email',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    assertCollecting();
    // NFR-SE-17 (c): a change of the address reads the session's row.
    const validation = await validateSessionRow(ctx.headers);
    const own = validation.session;
    if (!own) return notAdmitted(validation);
    const entered = textFields(ctx.body, 'newEmail', 'password');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.changeShape);
    const account = await db().user.findUnique({ where: { id: own.userId }, select: ACCOUNT });
    if (!account?.email) return unauthenticated();
    const { email } = account;

    // The owner's answer to Q10: a wrong password at this prompt counts as a
    // failed sign-in, and a prompt refused by a limit or by a lock is answered
    // as a wrong password is, with the statement of FR-AU-81. The session
    // stays. NFR-SE-19: a 403.
    const { verified } = await checkCredentials(ctx.context, ctx.headers, email, entered.password);
    if (!verified) {
      await securityLog({ kind: 'forbidden', userId: own.userId });
      return errorResponse(403, 'password_refused', SIGN_IN_REFUSED);
    }
    // FR-AU-02: lower case, and no longer than an address can be.
    const newEmail = acceptedAddress(entered.newEmail);
    if (!newEmail) return fieldRefused(MESSAGES.addressRule, { newEmail: MESSAGES.address });

    // NFR-SE-07: "confirmation email for a changed address, for each
    // authenticated user: 3 in any hour", answered 429. Each request that
    // passed its prompt is counted, whether or not an email follows it: counted
    // only where one is sent, the limit would show which addresses are taken.
    const limit = await takeLimit('CONFIRMATION_EMAIL_PER_USER', own.userId);
    if (!limit.ok) {
      return tooManyRequests('CONFIRMATION_EMAIL_PER_USER', own.userId, limit.retryAfterSeconds, own.userId);
    }

    afterResponse('address confirmation', () =>
      sendConfirmation(own.userId, { ...account, email }, newEmail),
    );
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({ message: CHANGE_ASKED });
  },
);

// ── Confirming it ───────────────────────────────────────────────────────────

export interface OpenAddressChange {
  /** The row of the link. */
  id: string;
  userId: string;
  oldEmail: string;
  newEmail: string;
}

/**
 * The pending change whose unused, unexpired link this token is, for the page
 * the link opens and for its confirmation. Null for no token and for a link
 * that is spent, void, expired, or not known, and null where the change can
 * no longer be made: "the list is checked again when the link is opened", and
 * "an address that does [belong to another account] is never taken"
 * (FR-AU-03). The caller is told nothing of which. It changes nothing, so a
 * program that fetches the links of an email spends none.
 */
export async function findOpenAddressChange(
  token: unknown,
  now: Date = new Date(),
): Promise<OpenAddressChange | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const row = await db().verification.findFirst({
    where: { identifier: ADDRESS_LINK + hashToken(token), expiresAt: { gt: now } },
    select: { id: true, value: true },
  });
  if (!row) return null;
  const { userId, newEmail } = changeOf(row.value);
  const account = await db().user.findUnique({ where: { id: userId }, select: ACCOUNT });
  if (!account?.email || !account.emailVerified) return null;
  if (ofFoundingTeam(account) || listed(newEmail)) return null;
  if ((await db().user.count({ where: { email: newEmail } })) > 0) return null;
  return { id: row.id, userId, oldEmail: account.email, newEmail };
}

// Thrown inside the transaction that makes the change, to undo it.
const LINK_GONE = new Error('address confirmation: the link is void');
const SESSION_ENDED = new Error('address confirmation: session ended');
// The unique index of the address refused the row: the address was taken meanwhile.
const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';

/**
 * FR-AU-03: `POST /api/auth/verify-email`, with `{ "token" }`: the one control
 * of the page that the confirmation link opens. The answer to success is
 * `{}`; it signs no one in and sets no cookie of a session.
 *
 * The owner's decision of 9 October 2026 (its register row is pending), which
 * takes back the part of the answer to Q3 that let the link be confirmed
 * "elsewhere": the request needs a session of the account, read from its row,
 * and the token of a change that this account asked for. The token alone
 * confirms nothing, so a new address that was typed wrongly does not hand the
 * account to whoever holds that mailbox. A link of another account is answered
 * as one that is not valid, and no refused attempt spends a link.
 *
 * "When the change takes effect the application sends a notice to the old
 * address (FR-AU-87) and every other session of the account ends": every
 * session but that of the browser that confirms. The link of a lock email is void "when the …
 * address of the account is changed" (FR-AU-81). With them, in the one
 * transaction: the reset links that were mailed to the old address, the second
 * steps that a sign-in with the old address began, and every other pending
 * change.
 *
 * It reads and writes rows, and never the signed copy (NFR-SE-17 (c)).
 */
export const verifyEmail = createAuthEndpoint(
  '/verify-email',
  { method: 'POST', requireHeaders: true },
  async (ctx) => {
    // NFR-SE-17 (c): the library checks the origin only of a request that
    // carries a cookie, so the endpoint checks it for every request, before
    // anything of the request is read.
    const foreign = await refusedOrigin(ctx.headers);
    if (foreign) return foreign;
    // The notice is left for after the answer: asked now, before anything is written.
    assertCollecting();
    // NFR-SE-17 (c): a request that changes state reads the session's row. An
    // account that the founding-team gate stops is answered 403 (FR-AU-83).
    const validation = await validateSessionRow(ctx.headers);
    const own = validation.session;
    if (!own) return notAdmitted(validation);
    const entered = textFields(ctx.body, 'token');
    if (!entered) return errorResponse(422, 'invalid_request', MESSAGES.tokenShape);

    const notValid = () => errorResponse(409, 'address_link_not_valid', MESSAGES.linkNotValid);
    const change = await findOpenAddressChange(entered.token);
    // The link of a change that another account asked for is answered as one
    // that is not valid, and nothing of it is spent or said.
    if (!change || change.userId !== own.userId) return notValid();
    const { userId, oldEmail, newEmail } = change;
    // The password of the account as it is now, to be asked again by the
    // transaction. No account is without one (FR-AU-90).
    const credential = await db().account.findFirst({
      where: { userId, providerId: 'credential' },
      select: { id: true, password: true, updatedAt: true },
    });
    if (!credential?.password) return notValid();
    const password = { id: credential.id, hash: credential.password, updatedAt: credential.updatedAt };

    const changed = await db()
      .$transaction(async (tx) => {
        // The rows are taken in the order a reset and a change of the password
        // take them (password.ts), so that none waits for another in a circle:
        // the reset links, the link of this change, the credentials, the steps,
        // the sessions, and the row of the account last, as a lock takes it.
        await tx.verification.deleteMany({
          where: { value: userId, identifier: { startsWith: RESET_LINK } },
        });
        // The claim is one conditional statement: of two confirmations of one
        // link the second waits for the first, then deletes nothing and changes
        // nothing. A reset or a change of the password that committed first has
        // deleted the row (address-links.ts).
        const claimed = await tx.verification.deleteMany({
          where: { id: change.id, expiresAt: { gt: new Date() } },
        });
        if (claimed.count !== 1) throw LINK_GONE;
        // The row of the credentials, written with its own values: a sign-in
        // with the old address that is on its way waits here, and then finds the
        // new address (sign-in.ts, `stillSignsIn`). One whose password was set
        // meanwhile and has not yet made this link void finds another hash.
        if (!(await stillVerified(password, tx))) throw LINK_GONE;
        await voidAddressLinks(tx, userId);
        // FR-AU-84: a session that has ended since it was read changes nothing.
        // After the credentials, where a change of the password holds its own.
        if (!(await holdSession(tx, own))) throw SESSION_ENDED;
        // Before the sessions, as at a reset: a second step makes its session
        // first and claims its row after.
        await tx.verification.deleteMany({
          where: { value: userId, identifier: { startsWith: SECOND_STEP } },
        });
        // Every session of the account but the one that confirms.
        await tx.session.deleteMany({ where: { userId, id: { not: own.sessionId } } });
        // Only over the address the link was asked under, and only for an
        // account that is still in use. The address stays verified: the link
        // reached the new one (FR-AU-81).
        const moved = await tx.user.updateMany({
          where: { id: userId, email: oldEmail, emailVerified: true },
          data: { email: newEmail },
        });
        if (moved.count !== 1) throw LINK_GONE;
        // Again, now that the row of the account is held: a request for a reset
        // holds that row while it writes its link (password.ts), so one written
        // since the first statement above has committed by now, and is found.
        await tx.verification.deleteMany({
          where: { value: userId, identifier: { startsWith: RESET_LINK } },
        });
        // NFR-SE-19; the owner's decision of 9 October 2026 (S9): one entry for
        // each completed change, in its transaction. The user, never an address.
        await securityLogIn(tx, { kind: 'address_changed', userId });
        await voidSignInLinks(tx, userId);
        return true;
      })
      .catch((error: unknown) => {
        if (error === SESSION_ENDED) return 'ended' as const;
        if (error === LINK_GONE || isUniqueViolation(error)) return false;
        throw error;
      });
    if (changed === 'ended') return unauthenticated();
    if (!changed) return notValid();

    // FR-ED-40 (d): the slice that builds the collaboration server publishes the
    // end of the account's other sessions here, once the transaction has committed.

    // FR-AU-87 (e): the notice to the old address, after the answer.
    afterResponse('address notice', () => handOver(addressChangedEmail(oldEmail)));
    // The signed copy carries the address: the browser that confirmed reads the
    // new one at once. Every other session has ended, and its copy reads for up
    // to a minute more and changes nothing (NFR-SE-17 (c)).
    await freshCopy(ctx, 'address');
    ctx.setHeader('Cache-Control', 'no-store');
    return ctx.json({});
  },
);
