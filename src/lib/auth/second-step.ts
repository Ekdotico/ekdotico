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

/** The cookie that holds the token of the step. The name is the library's own for it. */
export const SECOND_STEP_COOKIE = 'two_factor';

/**
 * Begins the second step for an account whose password, or whose sign-in
 * link (FR-AU-81), was just accepted: writes the row and sets the cookie,
 * which has the attributes of every cookie of the application (NFR-SE-17 (c))
 * and lasts as long as the step. The token has 256 bits and is stored only as
 * a hash. Returns the identifier of the row, for a caller that must undo it.
 */
export async function beginSecondStep(ctx: GenericEndpointContext, userId: string): Promise<string> {
  const token = newToken();
  // FR-AU-83: "completed within 10 minutes of the password (an initial value)".
  const seconds = settings().secondStepSeconds;
  const { id } = await db().verification.create({
    data: {
      id: randomUUID(),
      identifier: SECOND_STEP + hashToken(token),
      value: userId,
      expiresAt: new Date(Date.now() + seconds * 1000),
    },
    select: { id: true },
  });
  const cookie = ctx.context.createAuthCookie(SECOND_STEP_COOKIE, { maxAge: seconds });
  await ctx.setSignedCookie(cookie.name, token, ctx.context.secret, cookie.attributes);
  return id;
}
