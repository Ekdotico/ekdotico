// The beginning of the second step of a sign-in (FR-AU-81, FR-AU-83): what
// stands between the password and the session, "and the session begins only
// after it". The identity library's plugin would make a session at the
// password and delete it again, and could be told to remember a device; here
// no session exists until a code has been accepted (two-factor.ts), and
// nothing but this row and its cookie says that a password was right.
//
// A file of its own, so that sign-in.ts, which begins a step, and password.ts,
// which makes one void, load nothing of the endpoints that complete it.
import { randomUUID } from 'node:crypto';
import type { GenericEndpointContext } from 'better-auth';
import { db } from '../db.ts';
import { settings } from '../settings.ts';
import { hashToken, newToken } from '../token.ts';

// A second step that is open is a row of the identity library's table of
// single-use tokens (Data models, `Verification`), as a reset link is: the
// identifier is this prefix and the hash of the token, the value is the user,
// and the expiry is the 10 minutes of FR-AU-83. A reset and a change of the
// password delete the rows of the account by the prefix (password.ts).
export const SECOND_STEP = 'second-step:';
// A step that began from the sign-in link of a lock email (FR-AU-81; register
// A104, assumed) is told by this longer prefix, which no hash begins with.
// Whatever deletes the steps of an account by `SECOND_STEP` deletes these too.
export const LINK_STEP = `${SECOND_STEP}link:`;

/** The cookie that holds the token of the step. The name is the library's own for it. */
export const SECOND_STEP_COOKIE = 'two_factor';

/**
 * Begins the second step for an account whose password, or whose sign-in
 * link (FR-AU-81), was just accepted: writes the row and sets the cookie,
 * which has the attributes of every cookie of the application (NFR-SE-17 (c))
 * and lasts as long as the step. The token has 256 bits and is stored only as
 * a hash. Returns the identifier of the row, for a caller that must undo it.
 *
 * `linkUntil` is given where the step begins from the sign-in link of a lock
 * email, and is the end of that link: the step is marked, and is over no
 * later than the link is ("the link is valid until the lock would have ended").
 */
export async function beginSecondStep(
  ctx: GenericEndpointContext,
  userId: string,
  linkUntil?: Date,
): Promise<string> {
  const token = newToken();
  // FR-AU-83: "completed within 10 minutes of the password (an initial value)".
  const now = Date.now();
  const ends = Math.min(now + settings().secondStepSeconds * 1000, linkUntil?.getTime() ?? Infinity);
  const seconds = Math.max(1, Math.ceil((ends - now) / 1000));
  const { id } = await db().verification.create({
    data: {
      id: randomUUID(),
      identifier: (linkUntil ? LINK_STEP : SECOND_STEP) + hashToken(token),
      value: userId,
      expiresAt: new Date(ends),
    },
    select: { id: true },
  });
  // One step is open for an account: every other is over once this one is
  // written, so a right password cannot be used to keep opening steps of five
  // codes each beside one another (NFR-SE-07: "no more than 100 codes … in any
  // hour"). Two statements and no transaction, the row first: a transaction
  // would not see a step that another is writing at the same moment, and both
  // would stand. So of two sign-ins at one moment at most one step is left,
  // and it may be neither: both then begin again.
  await db().verification.deleteMany({
    where: { value: userId, identifier: { startsWith: SECOND_STEP }, id: { not: id } },
  });
  const cookie = ctx.context.createAuthCookie(SECOND_STEP_COOKIE, { maxAge: seconds });
  await ctx.setSignedCookie(cookie.name, token, ctx.context.secret, cookie.attributes);
  return id;
}
