// FR-AU-58: the deletion of the current account (API design, "Account",
// `DELETE /api/account`). It changes state, so it reads the session's row
// (NFR-SE-17 (c)); the origin check is the proxy's and, since the proxy can be
// skipped, this route's own as well (the owner's decision R50 of 12 October 2026).
// The account is the session's and never the request's.
//
// In this order (the owner's answer to Q8, "authorisation before validation"):
// the origin (403), the session (401, or the 403 of the founding-team gate), the
// refusal while the account owns a document (409, "made on the server, by the
// route that deletes an account, and does not rest on what the screen offers"),
// the body (415, 422), the password (403) and, where two-factor authentication
// is on, the code (403) "immediately before the action", and the record of the
// deletion (./lib/account/deletion.ts), which counts the documents again under
// the account's row and asks again whether the password and the session stand.
//
// A wrong password or code here "is counted as a failed sign-in is (NFR-SE-07)"
// (Q10), by the one function for every prompt (src/lib/auth/sign-in.ts).
//
// The route sends nothing to the owner of the account: no requirement gives a
// notice of a deletion, and the address is cleared by it (FR-AU-87 lists none).
import { after } from 'next/server';
import { carryOutDeletions } from '../../../lib/account/deletion-steps.ts';
import { confirmDeletion, ownedDocuments } from '../../../lib/account/deletion.ts';
import { afterResponse, collecting } from '../../../lib/after-response.ts';
import { auth } from '../../../lib/auth/auth.ts';
import { fault, notAdmitted, refusedOrigin, unauthenticated } from '../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../lib/auth/session.ts';
import { checkCredentials, SIGN_IN_REFUSED } from '../../../lib/auth/sign-in.ts';
import { checkSecondFactorAtPrompt, standing } from '../../../lib/auth/two-factor.ts';
import { db } from '../../../lib/db.ts';
import { errorResponse, notJson, readJson, textFields } from '../../../lib/http.ts';
import { securityLog } from '../../../lib/security-log.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// A password at its longest, a code, and the JSON around them (src/lib/http.ts).
const MAX_BODY_BYTES = 4096;

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  passwordShape: 'The request must hold the current password, and nothing else. The account was not deleted.',
  codeShape:
    'The request must hold the current password and a code, and nothing else. The account was not deleted.',
  code: 'The code is not correct. Enter the code that the authenticator application shows now, or a recovery code that has not been used.',
};

/** FR-AU-58: "the answer states how many". The deletion screen words it again for the page; this is for a program. */
function ownsDocuments(documents: number): Response {
  return Response.json(
    {
      error: {
        code: 'owns_documents',
        message: `This account owns ${documents} ${documents === 1 ? 'document' : 'documents'}, so it cannot be deleted. Clear or transfer ${documents === 1 ? 'it' : 'them'} first. The account was not deleted.`,
      },
      documents,
    },
    { status: 409, headers: NO_STORE },
  );
}

/**
 * NFR-SE-17 (c): the origin first, before anything of the request is read, and in the form
 * tests/unit/route-origin.test.ts holds every handler that changes state to. A fault of the check is
 * answered as every other fault of the route is.
 */
async function refusal(request: Request): Promise<Response | null> {
  try {
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
  } catch (error) {
    return fault('account', error);
  }
  return null;
}

async function handle(request: Request): Promise<Response> {
  try {
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    const { userId } = session;

    // FR-AU-58: refused on the server while the account owns any document, a deleted one within its
    // retention included, before the password is asked for: the first request of the screen's own
    // sequence (API design, sequence 9) carries none. The record below counts again.
    const { owned } = await ownedDocuments(userId);
    if (owned > 0) return ownsDocuments(owned);

    // R28: a body that is not sent as JSON is a 415, after the session and before anything is read.
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const body = await readJson(request, MAX_BODY_BYTES);

    const account = await db().user.findUnique({
      where: { id: userId },
      select: { email: true, twoFactorEnabled: true },
    });
    if (!account?.email) return unauthenticated();
    const secondFactor = account.twoFactorEnabled === true;
    // "…and for a code where two-factor authentication is on": the shape depends on the account, as
    // the server reads it now, and a page that was drawn before it changed is told so.
    const withCode = secondFactor ? textFields(body, 'password', 'code') : null;
    const withoutCode = secondFactor ? null : textFields(body, 'password');
    const entered = withCode ?? withoutCode;
    if (!entered) {
      return errorResponse(
        422,
        'invalid_request',
        secondFactor ? MESSAGES.codeShape : MESSAGES.passwordShape,
      );
    }

    const context = await auth().$context;
    // Q10: a wrong password counts as a failed sign-in; a prompt refused by a limit or a lock, or by the
    // deletion itself, is answered as a wrong password is, with the statement of FR-AU-81. NFR-SE-19: a 403.
    const { verified } = await checkCredentials(context, request.headers, account.email, entered.password);
    const refusedPassword = async () => {
      await securityLog({ kind: 'forbidden', userId });
      return errorResponse(403, 'password_refused', SIGN_IN_REFUSED);
    };
    if (!verified) return await refusedPassword();

    // A recovery code is looked for here and not spent, as at the turning off of two-factor authentication
    // (src/lib/auth/two-factor.ts): the code of the authenticator is single-use at the check
    // (`acceptCode`), and a recovery code that opens a confirmation which the record then refuses (the
    // account owns a document by now, or its password was set meanwhile) is still its owner's. Where the
    // confirmation commits, the second-factor row goes with the account in step (d), and the code with it,
    // so there is nothing left to spend. Spending it in the transaction of the record would cost a write to
    // a row that step (d) deletes within the hour (docs/plan/slice-22.md, S22-14).
    if (withCode) {
      const factor = await db().twoFactor.findUnique({ where: { userId } });
      const right =
        factor?.verified === true &&
        (await checkSecondFactorAtPrompt({ context }, request.headers, account.email, factor, withCode.code));
      if (!right) {
        await securityLog({ kind: 'forbidden', userId });
        return errorResponse(403, 'code_refused', MESSAGES.code);
      }
    }

    // Inside the transaction of the record the password and the session are asked again, each as a write,
    // as every change under a prompt asks them.
    const confirmed = await confirmDeletion(userId, (tx) => standing(tx, verified, session));
    switch (confirmed.outcome) {
      case 'owns_documents':
        return ownsDocuments(confirmed.documents);
      case 'ended':
      case 'not_found':
        return unauthenticated();
      case 'outrun':
        return await refusedPassword();
      case 'confirmed':
      case 'already_confirmed':
        // "so that a confirmed deletion completes without the user": the steps begin once the
        // response has been returned, and the timer repeats whichever of them fails.
        afterResponse('account deletion', () => carryOutDeletions());
        return Response.json({}, { headers: NO_STORE });
    }
  } catch (error) {
    return fault('account', error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const refused = await refusal(request);
  if (refused) return refused;
  const { result, tasks } = await collecting(() => handle(request));
  for (const task of tasks) after(task);
  return result;
}
