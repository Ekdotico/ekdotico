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

import { fault, notAdmitted, refusedOrigin, unauthenticated } from '../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../lib/auth/session.ts';

import { standing } from '../../../lib/auth/two-factor.ts';
import { passwordRefused, promptAccount, verifyPrompt } from '../../../lib/account/prompt.ts';
import { errorResponse, notJson, readJson, textFields } from '../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// A password at its longest, a code, and the JSON around them (src/lib/http.ts).
const MAX_BODY_BYTES = 4096;

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  passwordShape: 'The request must hold the current password, and nothing else. The account was not deleted.',
  codeShape:
    'The request must hold the current password and a code, and nothing else. The account was not deleted.',
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

    const account = await promptAccount(userId);
    if (!account) return unauthenticated();
    const { secondFactor } = account;
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

    // Q10 and the code: src/lib/account/prompt.ts, the one prompt of the two confirmations of the screen.
    const prompt = await verifyPrompt(request, userId, account, {
      password: entered.password,
      ...(withCode ? { code: withCode.code } : {}),
    });
    if (!prompt.ok) return prompt.response;
    const { verified } = prompt;

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
        return await passwordRefused(userId);
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
