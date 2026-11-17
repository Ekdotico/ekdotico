// FR-AU-92: "Transfer ownership of all documents" (API design, "Account"). It changes state, so it reads the session's
// row (NFR-SE-17 (c)); the origin check is the proxy's and, since the proxy can be skipped, this route's own as well
// (the owner's decision R50 of 12 October 2026). The account is the session's and never the request's.
//
// In this order (the owner's answer to Q8, "authorisation before validation"): the origin (403), the session (401, or
// the 403 of the founding-team gate), the body (415, 422), the password and, where two-factor authentication is on, the
// code (422 where absent, 403 where wrong; FR-AU-92, D285; register Q82 point 6), and the action
// (src/lib/account/transfer.ts), which compares the identifiers with the documents it would offer under the locks of
// their rows (409) and asks again whether the password and the session stand.
import { after } from 'next/server';
import {
  confirmTransfer,
  TRANSFER_MOST_DOCUMENTS,
  COLLABORATOR_ID,
} from '../../../../../lib/account/transfer.ts';
import { deliverBatch } from '../../../../../lib/account/transfer-email.ts';
import { TRANSFER_MESSAGES } from '../../../../../lib/account/transfer-texts.ts';
import { askPrompt, guardAnswer } from '../../../../../lib/account/prompt.ts';
import { afterResponse, collecting } from '../../../../../lib/after-response.ts';
import {
  fault,
  notAdmitted,
  refusedOrigin,
  tooManyRequests,
  unauthenticated,
} from '../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../lib/auth/session.ts';
import { DOCUMENT_ID } from '../../../../../lib/clearing/clearing.ts';
import { errorResponse, notJson, readWhole, sentAsJson } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// The body that holds the most documents one transfer names: 6,000 identifiers of 36 characters with their quotes and
// commas, and the fields around them, the password and the code included (the same bound as a clearing;
// docs/plan/slice-23.md, S23-7).
const MAX_BODY_BYTES = 256 * 1024;

/** The request as exactly its named fields, or null. */
function readRequest(
  body: unknown,
):
  | { ok: true; mode: 'longest'; documentIds: string[] }
  | { ok: true; mode: 'person'; collaboratorId: string; documentIds: string[] }
  | { ok: false; why: 'shape' | 'too_many' } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, why: 'shape' };
  const given = body as Record<string, unknown>;
  const { mode, documentIds, collaboratorId } = given;
  const names = mode === 'person' ? ['mode', 'collaboratorId', 'documentIds'] : ['mode', 'documentIds'];
  if (Object.keys(given).length !== names.length || !names.every((name) => Object.hasOwn(given, name))) {
    return { ok: false, why: 'shape' };
  }
  if (mode !== 'longest' && mode !== 'person') return { ok: false, why: 'shape' };
  if (!Array.isArray(documentIds)) return { ok: false, why: 'shape' };
  if (documentIds.length > TRANSFER_MOST_DOCUMENTS) return { ok: false, why: 'too_many' };
  if (!documentIds.every((id): id is string => typeof id === 'string' && DOCUMENT_ID.test(id))) {
    return { ok: false, why: 'shape' };
  }
  if (mode === 'longest') return { ok: true, mode, documentIds };
  if (typeof collaboratorId !== 'string' || !COLLABORATOR_ID.test(collaboratorId)) {
    return { ok: false, why: 'shape' };
  }
  return { ok: true, mode, collaboratorId, documentIds };
}

async function transfer(request: Request): Promise<Response> {
  try {
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);

    // R28: a body that is not sent as JSON is a 415, after the session and before anything is read.
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const bytes = await readWhole(request, MAX_BODY_BYTES);
    if (bytes === null) {
      return errorResponse(422, 'invalid_request', TRANSFER_MESSAGES.tooMany(TRANSFER_MOST_DOCUMENTS));
    }
    let body: unknown = null;
    try {
      body = sentAsJson(request) ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null;
    } catch {
      body = null;
    }
    // FR-AU-92, D285; register Q82 point 6: the password, and the code where two-factor authentication is on, are
    // asked for here, immediately before the action and every time; a request without them is refused whatever
    // its session. A wrong one counts as a failed sign-in (src/lib/account/prompt.ts).
    const prompt = await askPrompt(request, session, body, {
      password: TRANSFER_MESSAGES.password,
      passwordAndCode: TRANSFER_MESSAGES.passwordAndCode,
    });
    if (!prompt.ok) return prompt.response;
    const read = readRequest(prompt.rest);
    if (!read.ok) {
      return errorResponse(
        422,
        'invalid_request',
        read.why === 'too_many'
          ? TRANSFER_MESSAGES.tooMany(TRANSFER_MOST_DOCUMENTS)
          : TRANSFER_MESSAGES.shape,
      );
    }

    const result = await confirmTransfer(session, read, undefined, prompt.guard);
    switch (result.outcome) {
      case 'outrun':
      case 'code_gone':
        return await guardAnswer(session.userId, result);
      case 'ended':
      case 'not_found':
        return unauthenticated();
      case 'changed':
        return errorResponse(409, 'documents_changed', TRANSFER_MESSAGES.changed);
      case 'nothing':
        return errorResponse(409, 'nothing_to_offer', TRANSFER_MESSAGES.nothing);
      case 'no_such_person':
        return errorResponse(404, 'not_found', TRANSFER_MESSAGES.noSuchPerson);
      case 'over_limit':
        return errorResponse(409, 'too_many_offers', TRANSFER_MESSAGES.overLimit(result.most, result.wanted));
      case 'rate_limited':
        return await tooManyRequests(
          'OFFERS_PER_USER',
          session.userId,
          result.retryAfterSeconds,
          session.userId,
        );
      case 'offered':
        // NFR-RE-15: one email to each person offered, after the response; the timer repeats what is not handed over.
        for (const { userId } of result.recipients) {
          afterResponse('transfer email', () => deliverBatch(result.batchId, userId));
        }
        return Response.json(
          { offered: result.offered, kept: result.kept, cannot: result.cannot },
          { status: result.offered > 0 ? 201 : 200, headers: NO_STORE },
        );
    }
  } catch (error) {
    return fault('transfer', error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
  } catch (error) {
    return fault('transfer', error);
  }
  const { result, tasks } = await collecting(() => transfer(request));
  for (const task of tasks) after(task);
  return result;
}
