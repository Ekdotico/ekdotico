// FR-AU-91: "Clear all documents" and its cancellation (API design, "Account"). Both change state, so each reads
// the session's row (NFR-SE-17 (c)); the origin check is the proxy's and, since the proxy can be skipped, this
// route's own as well (the owner's decision R50 of 12 October 2026). The account is the session's and never the
// request's.
//
// POST, in this order (the owner's answer to Q8, "authorisation before validation"): the origin (403), the
// session (401, or the 403 of the founding-team gate), the body (415, 422), the password (403) and, where
// two-factor authentication is on, the code (403) "immediately before the action", and the confirmation
// (src/lib/clearing/clearing.ts), which compares the identifiers with the documents the account owns under the
// locks of their rows (409) and asks again whether the password and the session stand.
//
// DELETE cancels the clearing for every document of the account whose notice period runs. It asks for the
// session's row and no password: FR-AU-58 asks for it at "the confirmation of the deletion, and the confirmation
// of a clearing", and a cancellation keeps what exists (docs/plan/slice-23.md, S23-5).
import { after } from 'next/server';
import { passwordRefused, promptAccount, verifyPrompt } from '../../../../../lib/account/prompt.ts';
import { afterResponse, collecting } from '../../../../../lib/after-response.ts';
import { fault, notAdmitted, refusedOrigin, unauthenticated } from '../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../lib/auth/session.ts';
import { standing } from '../../../../../lib/auth/two-factor.ts';
import { cancelClearing, CLEAR_MOST_DOCUMENTS, confirmClearing, DOCUMENT_ID, type Scope } from '../../../../../lib/clearing/clearing.ts';
import { carryOutClearings } from '../../../../../lib/clearing/deletion.ts';
import { deliverClearingEmails } from '../../../../../lib/clearing/email.ts';
import { CLEARING_MESSAGES } from '../../../../../lib/clearing/texts.ts';
import { errorResponse, notJson, readJson } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// The body that holds the most documents one confirmation names (CLEAR_MOST_DOCUMENTS): 6,000 identifiers of 36 characters
// with their quotes and commas, a password, and a code (docs/plan/slice-23.md, S23-7).

const MAX_BODY_BYTES = 256 * 1024;

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
    return fault('clearing', error);
  }
  return null;
}

/** The request as exactly its named fields, or null. The code is asked for where, and only where, the account has a second factor. */
function readRequest(
  body: unknown,
  secondFactor: boolean,
):
  | { ok: true; scope: Scope; documentIds: string[]; password: string; code?: string }
  | { ok: false; why: 'shape' | 'too_many' } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, why: 'shape' };
  const given = body as Record<string, unknown>;
  const names = secondFactor ? ['scope', 'documentIds', 'password', 'code'] : ['scope', 'documentIds', 'password'];
  if (Object.keys(given).length !== names.length || !names.every((name) => Object.hasOwn(given, name))) {
    return { ok: false, why: 'shape' };
  }
  const { scope, documentIds, password, code } = given;
  if (scope !== 'all' && scope !== 'deleted') return { ok: false, why: 'shape' };
  if (!Array.isArray(documentIds)) return { ok: false, why: 'shape' };
  if (documentIds.length > CLEAR_MOST_DOCUMENTS) return { ok: false, why: 'too_many' };
  if (!documentIds.every((id): id is string => typeof id === 'string' && DOCUMENT_ID.test(id))) {
    return { ok: false, why: 'shape' };
  }
  if (typeof password !== 'string' || (secondFactor && typeof code !== 'string')) return { ok: false, why: 'shape' };
  return {
    ok: true,
    scope,
    documentIds,
    password,
    ...(secondFactor ? { code: code as string } : {}),
  };
}

async function confirm(request: Request): Promise<Response> {
  try {
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    const { userId } = session;

    // R28: a body that is not sent as JSON is a 415, after the session and before anything is read.
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const body = await readJson(request, MAX_BODY_BYTES);

    const account = await promptAccount(userId);
    if (!account) return unauthenticated();
    const read = readRequest(body, account.secondFactor);
    if (!read.ok) {
      return errorResponse(
        422,
        'invalid_request',
        read.why === 'too_many'
          ? CLEARING_MESSAGES.tooMany(CLEAR_MOST_DOCUMENTS)
          : account.secondFactor
            ? CLEARING_MESSAGES.shapeWithCode
            : CLEARING_MESSAGES.shape,
      );
    }

    const prompt = await verifyPrompt(request, userId, account, {
      password: read.password,
      ...(read.code === undefined ? {} : { code: read.code }),
    });
    if (!prompt.ok) return prompt.response;

    // Inside the transaction of the record the password and the session are asked again, each as a write.
    const confirmed = await confirmClearing(
      userId,
      { scope: read.scope, documentIds: read.documentIds },
      (tx) => standing(tx, prompt.verified, session),
    );
    switch (confirmed.outcome) {
      case 'ended':
      case 'not_found':
        return unauthenticated();
      case 'outrun':
        return await passwordRefused(userId);
      case 'changed':
        return errorResponse(409, 'documents_changed', CLEARING_MESSAGES.changed);
      case 'nothing':
        return errorResponse(409, 'nothing_to_clear', CLEARING_MESSAGES.nothing);
      case 'confirmed':
        // "so that the clearing completes without the user": what is due is deleted once the response has
        // been returned (a document that is not shared "at once"), the email is handed over, and the timer
        // repeats whatever does not complete.
        afterResponse('clearing', () => carryOutClearings());
        afterResponse('clearing email', () => deliverClearingEmails(confirmed.clearingId));
        return Response.json(
          {
            documents: confirmed.documentIds.length,
            shared: confirmed.sharedIds.length,
            deleteOn: confirmed.deleteOn?.toISOString() ?? null,
          },
          { headers: NO_STORE },
        );
    }
  } catch (error) {
    return fault('clearing', error);
  }
}

async function cancel(request: Request): Promise<Response> {
  try {
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    const result = await cancelClearing(session.userId, null);
    switch (result.outcome) {
      case 'none':
        return errorResponse(409, 'nothing_waiting', CLEARING_MESSAGES.nothingWaiting);
      case 'too_late':
        return errorResponse(409, 'too_late', CLEARING_MESSAGES.tooLate);
      case 'cancelled':
        return Response.json({ cancelled: result.documentIds.length }, { headers: NO_STORE });
    }
  } catch (error) {
    return fault('clearing', error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const refused = await refusal(request);
  if (refused) return refused;
  const { result, tasks } = await collecting(() => confirm(request));
  for (const task of tasks) after(task);
  return result;
}

export async function DELETE(request: Request): Promise<Response> {
  const refused = await refusal(request);
  if (refused) return refused;
  return cancel(request);
}
