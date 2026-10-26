// The prompt that FR-AU-58 puts in front of the two things that cannot be undone on the deletion screen: "the
// confirmation of the deletion, and the confirmation of a clearing (FR-AU-91), each ask for the account's current
// password, and for a code where two-factor authentication is on (FR-AU-83), immediately before the action, and
// the action is carried out only where they are right. A wrong password or code there is counted as a failed
// sign-in is (NFR-SE-07)." One module for both routes, so that the two cannot differ (Q10).
//
// What is asked again inside the transaction of the action (`standing`, src/lib/auth/two-factor.ts) is the
// route's: it needs the transaction. This is the part before it.
import { auth } from '../auth/auth.ts';
import { checkCredentials, SIGN_IN_REFUSED } from '../auth/sign-in.ts';
import { checkSecondFactorAtPrompt } from '../auth/two-factor.ts';
import { db } from '../db.ts';
import { errorResponse } from '../http.ts';
import { securityLog } from '../security-log.ts';

export type Verified = NonNullable<Awaited<ReturnType<typeof checkCredentials>>['verified']>;

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
export const CODE_REFUSED =
  'The code is not correct. Enter the code that the authenticator application shows now, or a recovery code that has not been used.';

/** The account as the prompt needs it: its address, and whether a code is asked for as well. Null for no account. */
export async function promptAccount(
  userId: string,
): Promise<{ email: string; secondFactor: boolean } | null> {
  const account = await db().user.findUnique({
    where: { id: userId },
    select: { email: true, twoFactorEnabled: true },
  });
  return account?.email ? { email: account.email, secondFactor: account.twoFactorEnabled === true } : null;
}

/**
 * Q10: a wrong password counts as a failed sign-in; a prompt refused by a limit or a lock, or by the deletion
 * itself, is answered as a wrong password is, with the statement of FR-AU-81. NFR-SE-19: a 403.
 */
export async function passwordRefused(userId: string): Promise<Response> {
  await securityLog({ kind: 'forbidden', userId });
  return errorResponse(403, 'password_refused', SIGN_IN_REFUSED);
}

/**
 * Checks the password, and the code where there is one to check. A recovery code is looked for here and not spent,
 * as at the turning off of two-factor authentication: the code of the authenticator is single-use at the check, and
 * a recovery code that opens a confirmation which the record then refuses is still its owner's (docs/plan/slice-22.md,
 * S22-14).
 */
export async function verifyPrompt(
  request: Request,
  userId: string,
  account: { email: string; secondFactor: boolean },
  entered: { password: string; code?: string },
): Promise<{ ok: true; verified: Verified } | { ok: false; response: Response }> {
  const context = await auth().$context;
  const { verified } = await checkCredentials(context, request.headers, account.email, entered.password);
  if (!verified) return { ok: false, response: await passwordRefused(userId) };
  if (account.secondFactor) {
    const factor = await db().twoFactor.findUnique({ where: { userId } });
    const right =
      factor?.verified === true &&
      entered.code !== undefined &&
      (await checkSecondFactorAtPrompt({ context }, request.headers, account.email, factor, entered.code));
    if (!right) {
      await securityLog({ kind: 'forbidden', userId });
      return { ok: false, response: errorResponse(403, 'code_refused', CODE_REFUSED) };
    }
  }
  return { ok: true, verified };
}
