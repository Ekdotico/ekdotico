// The prompt that FR-AU-58 puts in front of the two things that cannot be undone on the deletion screen: "the
// confirmation of the deletion, and the confirmation of a clearing (FR-AU-91), each ask for the account's current
// password, and for a code where two-factor authentication is on (FR-AU-83), immediately before the action, and
// the action is carried out only where they are right. A wrong password or code there is counted as a failed
// sign-in is (NFR-SE-07)." One module for both routes, so that the two cannot differ (Q10).
//
// What is asked again inside the transaction of the action (`standing`, src/lib/auth/two-factor.ts) is the
// route's: it needs the transaction. This is the part before it.
import type { Prisma } from '../../generated/prisma/client.ts';
import { auth } from '../auth/auth.ts';
import { unauthenticated } from '../auth/route-answers.ts';
import type { ValidSession } from '../auth/session.ts';
import { checkCredentials, SIGN_IN_REFUSED } from '../auth/sign-in.ts';
import { checkSecondFactorToSpend, standing } from '../auth/two-factor.ts';
import { db } from '../db.ts';
import { errorResponse } from '../http.ts';
import { securityLog } from '../security-log.ts';
import type { Guard, GuardRefusal } from './guard.ts';

/** The write that spends the recovery code that was entered, for the transaction of an action that spends it (S23, review item 1). */
export type Spend = (tx: Prisma.TransactionClient) => Promise<boolean>;

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

/** The answer of a route to a refusal of the guard, as the confirmation of a clearing answers each (S23). */
export async function guardAnswer(userId: string, refusal: GuardRefusal): Promise<Response> {
  if (refusal.outcome === 'ended') return unauthenticated();
  if (refusal.outcome === 'outrun') return passwordRefused(userId);
  await securityLog({ kind: 'forbidden', userId });
  return errorResponse(403, 'code_refused', CODE_REFUSED);
}

/**
 * FR-ED-47 and FR-AU-92 (D285; register Q82 point 6): the password, and the code where two-factor authentication is
 * on, are asked for immediately before the action, each time, by the route and not by the page. Takes them out of
 * the body, which holds them beside the fields of the action; a body without them, or with a code the account
 * does not ask for, is refused whole (a 422, in the words the route gives). A wrong password or code counts as a
 * failed sign-in (NFR-SE-07) toward the lock of FR-AU-81 and is answered as FR-AU-58 answers it, because it is
 * `verifyPrompt`, the one function of the confirmation of a deletion and of a clearing, that checks it.
 */
export async function askPrompt(
  request: Request,
  session: ValidSession,
  body: unknown,
  shape: { password: string; passwordAndCode: string },
): Promise<{ ok: true; rest: Record<string, unknown>; guard: Guard } | { ok: false; response: Response }> {
  const { userId } = session;
  const account = await promptAccount(userId);
  if (!account) return { ok: false, response: unauthenticated() };
  const refuse = (): { ok: false; response: Response } => ({
    ok: false,
    response: errorResponse(
      422,
      'invalid_request',
      account.secondFactor ? shape.passwordAndCode : shape.password,
    ),
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse();
  const { password, code, ...rest } = body as Record<string, unknown>;
  if (typeof password !== 'string' || password === '') return refuse();
  if (account.secondFactor ? typeof code !== 'string' || code === '' : code !== undefined) return refuse();
  const prompt = await verifyPrompt(request, userId, account, {
    password,
    ...(typeof code === 'string' ? { code } : {}),
  });
  if (!prompt.ok) return prompt;
  return {
    ok: true,
    rest,
    guard: { standing: (tx) => standing(tx, prompt.verified, session), spend: prompt.spend },
  };
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
): Promise<{ ok: true; verified: Verified; spend: Spend | null } | { ok: false; response: Response }> {
  const context = await auth().$context;
  const { verified } = await checkCredentials(context, request.headers, account.email, entered.password);
  if (!verified) return { ok: false, response: await passwordRefused(userId) };
  let spend: Spend | null = null;
  if (account.secondFactor) {
    const factor = await db().twoFactor.findUnique({ where: { userId } });
    const checked =
      factor?.verified === true && entered.code !== undefined
        ? await checkSecondFactorToSpend({ context }, request.headers, account.email, factor, entered.code)
        : { right: false, spend: null };
    if (!checked.right) {
      await securityLog({ kind: 'forbidden', userId });
      return { ok: false, response: errorResponse(403, 'code_refused', CODE_REFUSED) };
    }
    spend = checked.spend;
  }
  return { ok: true, verified, spend };
}
