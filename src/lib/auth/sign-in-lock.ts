// The lock of an account after failed sign-ins (FR-AU-81; NFR-SE-07; register
// D91, D115), and the single-use sign-in link in the email of a lock
// (FR-AU-81, FR-AU-87 (h); register A104, assumed: everything of the link is
// in this file's second half and in the endpoint `signInLink` of sign-in.ts,
// so that a change to the row costs little).
//
// The lock is one column of the account's row, `User.lockedUntil` (Data
// models), so it holds on every instance and is "set by the server alone":
// nothing here reads a body, a query, a header or a cookie (NFR-SE-17 (d)).
// A row that cannot be read rejects, and the sign-in that asked is refused
// (NFR-SE-06 A10).
//
// ponytail: the lock runs on the clock of the application's instance, and the
// counts that cause it on Valkey's (rate-limit.ts). With more than one
// instance and clocks that differ, a lock ends on one instance that much
// before it does on another. The upgrade path: the database's `now()` in the
// three conditional statements below that compare a time, in `beginLock` and
// the two of `claimSignInLink`.
//
// NFR-SE-19: nothing here logs an address, a token or a link. The token
// leaves this module once, inside the email of FR-AU-87 (h).
import { randomUUID } from 'node:crypto';
import { dateText } from '../date-text.ts';
import { db } from '../db.ts';
import { handOver } from '../email/hand-over.ts';
import type { EmailMessage } from '../email/index.ts';
import { securityLogIn } from '../security-log.ts';
import { settings } from '../settings.ts';
import { hashToken, newToken, TOKEN } from '../token.ts';

/** What a transaction, or the client itself, offers to the functions below. */
type Rows = Pick<ReturnType<typeof db>, 'user' | 'verification'>;

// ── The lock ────────────────────────────────────────────────────────────────

/**
 * Whether a time read from `User.lockedUntil` is a lock in force. Written so
 * that a time which cannot be read is one: only no time, or a time that has
 * passed, lets a sign-in through (NFR-SE-06 A10).
 */
export function lockInForce(until: Date | null | undefined, now: number = Date.now()): boolean {
  return until != null && !(until.getTime() <= now);
}

/**
 * The time to which sign-in to the account is locked, or null. One read by
 * the primary key, made for an address that belongs to no account as for one
 * that does, so that the work of a sign-in does not show which it is.
 */
export async function lockedUntilOf(userId: string | undefined): Promise<Date | null> {
  const row = await db().user.findFirst({ where: { id: userId ?? '' }, select: { lockedUntil: true } });
  return row?.lockedUntil ?? null;
}

/**
 * NFR-SE-07: "The twentieth failed sign-in for one email address in any hour
 * also locks the account for 1 hour, counted from that failure." Run after the
 * answer to that failure has been returned (sign-in.ts), so that the answer
 * takes as long for an address without an account. Until it has run, the limit
 * that was just reached refuses every attempt as the lock will.
 *
 * One conditional statement begins the lock, so of the calls that arrive
 * together one begins it, and a lock in force is neither begun again nor
 * extended. With it, in one transaction, the one link of the lock is written:
 * "one link is created only when a lock begins". The notice follows, "once
 * for each lock" (FR-AU-87 (h)).
 */
export async function beginLock(email: string, now: Date = new Date()): Promise<void> {
  // No address holds a control character, and the database refuses the first of them.
  if (/[\u0000-\u001f\u007f]/.test(email)) return;
  const until = new Date(now.getTime() + settings().signInLockSeconds * 1000);
  const token = newToken();
  const begun = await db().$transaction(async (tx) => {
    // "An address that belongs to no account is answered in the same way
    // after twenty failures", by the limit alone: there is nothing to lock.
    const account = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (!account) return false;
    const locked = await tx.user.updateMany({
      // FR-AU-81: an account is used only once its address is verified, and
      // the notice goes to no address that is not.
      // FR-AU-03: and only under the address the lock was begun for. A change
      // of the address that committed since the read above leaves this
      // statement nothing: no lock, no link, no entry, and no notice to an
      // address that "no longer signs in to it".
      where: {
        id: account.id,
        email,
        emailVerified: true,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { lockedUntil: until },
    });
    if (locked.count !== 1) return false;
    // NFR-SE-19; the owner's decision of 9 October 2026: one entry for each
    // lock, as there is one link and one email, in the transaction that
    // begins it. The user, and never the address, the token or the link.
    await securityLogIn(tx, { kind: 'sign_in_locked', userId: account.id });
    // The link of a lock that has ended is void, and is not left to the timer.
    await voidSignInLinks(tx, account.id);
    await tx.verification.create({
      data: {
        id: randomUUID(),
        identifier: SIGN_IN_LINK + hashToken(token),
        value: account.id,
        expiresAt: until,
      },
    });
    return true;
  });
  if (begun) await handOver(lockEmail(email, token, until), 'notice of a lock');
}

/** FR-AU-86: "lifts a lock on the account where one is in force". The row of the account before its links (see `claimSignInLink`). */
export async function liftLock(tx: Rows, userId: string): Promise<void> {
  await tx.user.updateMany({ where: { id: userId }, data: { lockedUntil: null } });
  await voidSignInLinks(tx, userId);
}

// ── The sign-in link of a lock email (register A104, assumed) ───────────────

/** FR-AU-81: the one statement of a link that is spent, void, or not known, verbatim. */
export const SIGN_IN_LINK_NOT_VALID =
  'This link is no longer valid. Sign in with your email address and password, or set a new password from the sign-in page.';

// The link of a lock is a row of the identity library's table of single-use
// tokens, "with the other single-use tokens of the account" (A104; Data
// models, `Verification`): the identifier is this prefix and the hash of the
// token, the value is the user, and the expiry is the end of the lock.
const SIGN_IN_LINK = 'sign-in-link:';

const period = (seconds: number): string => {
  const [count, unit] =
    seconds % 3600 === 0
      ? [seconds / 3600, 'hour']
      : seconds % 60 === 0
        ? [seconds / 60, 'minute']
        : [seconds, 'second'];
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
};

/**
 * FR-AU-87 (h), verbatim where the settings have their initial values. In the
 * form the owner gave the invitation's email on 8 October 2026: the link
 * stands on a line of its own, with nothing touching it, and each number is
 * its setting, never a literal.
 *
 * The requirement gives "[time]" no form. It is written here to the minute,
 * never later than the link's end, in the one form a person reads
 * (../date-text.ts; the owner's decision of 9 October 2026), and in UTC, which
 * it says, since an email knows nothing of its reader's clock.
 */
export function lockEmail(to: string, token: string, until: Date): EmailMessage {
  const { appOrigin, signInLockSeconds, limits } = settings();
  const { max, windowSeconds } = limits.FAILED_SIGN_IN_PER_EMAIL;
  const locked = `locked for ${period(signInLockSeconds)}`;
  const within = windowSeconds === 3600 ? 'an hour' : period(windowSeconds);
  const time = dateText(until, 'utc');
  return {
    to,
    subject: `Sign-in to your Ekdotico account is ${locked}`,
    text: `Sign-in to your Ekdotico account is ${locked}, because sign-in to it failed ${max} ${max === 1 ? 'time' : 'times'} within ${within}. To sign in now, open this link:\n${appOrigin}/sign-in/link/${token}\nIt works once, until ${time}, and it lifts the lock. If the failed attempts were not yours, set a new password from the sign-in page.`,
  };
}

export interface OpenSignInLink {
  /** The row of the link. */
  id: string;
  userId: string;
  email: string;
  twoFactorEnabled: boolean;
  /** The end of the lock, and of the link. */
  until: Date;
}

/** The link as an account's row lets it stand: only while the lock it was sent for is in force. */
async function standing(row: { id: string; value: string }, now: Date): Promise<OpenSignInLink | null> {
  const user = await db().user.findUnique({
    where: { id: row.value },
    select: { email: true, emailVerified: true, twoFactorEnabled: true, lockedUntil: true },
  });
  // "The link is void when the lock ends for any reason": no lock in force,
  // no link, whatever the row says. Here a time that cannot be read is none.
  if (
    !user?.email ||
    !user.emailVerified ||
    !user.lockedUntil ||
    !(user.lockedUntil.getTime() > now.getTime())
  ) {
    return null;
  }
  const { email, twoFactorEnabled, lockedUntil: until } = user;
  return { id: row.id, userId: row.value, email, twoFactorEnabled, until };
}

/**
 * The account whose unspent link of a lock in force this token is, for the
 * page the link opens and for its confirmation. Null for no token and for a
 * link that is spent, void, or not known: the caller is told nothing of which.
 * It changes nothing, so "opening the page alone changes nothing".
 */
export async function findOpenSignInLink(
  token: unknown,
  now: Date = new Date(),
): Promise<OpenSignInLink | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const row = await db().verification.findFirst({
    where: { identifier: SIGN_IN_LINK + hashToken(token), expiresAt: { gt: now } },
    select: { id: true, value: true },
  });
  return row ? standing(row, now) : null;
}

/** The same for an account, for the second step that began from its link (two-factor.ts). */
export async function openSignInLinkOf(
  userId: string,
  now: Date = new Date(),
): Promise<OpenSignInLink | null> {
  const row = await db().verification.findFirst({
    where: { value: userId, identifier: { startsWith: SIGN_IN_LINK }, expiresAt: { gt: now } },
    select: { id: true, value: true },
  });
  return row ? standing(row, now) : null;
}

/**
 * Inside the transaction that completes a sign-in by the link: "the lock is
 * lifted" and the link "is spent when its sign-in completes". Each is one
 * conditional statement, so of two requests with one link one finds both, and
 * the other neither. False where either is gone: the caller then undoes the
 * transaction, and signs no one in.
 *
 * The row of the account first, here and wherever a lock begins or is lifted,
 * so that the statements wait for one another in one order.
 *
 * FR-AU-81, FR-AU-83: the claim holds only for an account whose two-factor
 * authentication is as the caller says, asked in the statement that lifts the
 * lock: a claim that makes a session says off, and finds nothing where an
 * enrolment was confirmed since the caller read the account; that statement
 * waits for a confirmation that has not yet committed.
 */
export async function claimSignInLink(
  tx: Rows,
  link: Pick<OpenSignInLink, 'id' | 'userId' | 'twoFactorEnabled'>,
  now: Date = new Date(),
): Promise<boolean> {
  const lifted = await tx.user.updateMany({
    where: { id: link.userId, twoFactorEnabled: link.twoFactorEnabled, lockedUntil: { gt: now } },
    data: { lockedUntil: null },
  });
  if (lifted.count !== 1) return false;
  const spent = await tx.verification.deleteMany({
    where: { id: link.id, identifier: { startsWith: SIGN_IN_LINK }, expiresAt: { gt: now } },
  });
  return spent.count === 1;
}

/**
 * Makes void the sign-in link of the account, "used or not": at a completed
 * reset, at a change of the password (password.ts), and where its second step
 * is abandoned (two-factor.ts). For the slice that builds the change of
 * address (FR-AU-03): "when the … address of the account is changed" too, in
 * the transaction that changes it.
 */
export async function voidSignInLinks(tx: Pick<Rows, 'verification'>, userId: string): Promise<void> {
  await tx.verification.deleteMany({ where: { value: userId, identifier: { startsWith: SIGN_IN_LINK } } });
}
