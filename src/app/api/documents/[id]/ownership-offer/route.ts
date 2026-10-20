// FR-ED-47: offer the ownership of a document to one of its Editors, and
// withdraw the offer (API design, "Documents, Sharing"). Each handler is made
// by `documentRoute` for `document.ownership.transfer`, which the table fixes
// to the Owner and gives to no other role: the origin, the session's row, the
// document and the permission are decided before the body is read, and
// `ownership.ts` reads the Owner again under the document's row.
import { after } from 'next/server';
import { offeredAnswer, withdrawnAnswer } from '../../../../../lib/documents/ownership-answers.ts';
import { OFFER_MESSAGES } from '../../../../../lib/documents/ownership-texts.ts';
import { makeOffer, withdrawOffer } from '../../../../../lib/documents/ownership.ts';
import { documentRoute } from '../../../../../lib/documents/route.ts';
import { errorResponse, notJson, readJson } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

// An identifier of 64 characters written as escapes, and the JSON around it.
const MAX_BODY_BYTES = 1024;

/**
 * The body: `{ "collaboratorId": "<the identifier of a collaborator's row>" }`,
 * and nothing else (register row S17-1: the people list carries no account
 * identifier). The Owner is offered nothing: ownership is offered to an Editor.
 */
export const POST = documentRoute('document.ownership.transfer', async ({ request, document, session }) => {
  const unsupported = notJson(request);
  if (unsupported) return unsupported;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorResponse(422, 'invalid_request', OFFER_MESSAGES.invalid);
  }
  const { collaboratorId, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof collaboratorId !== 'string') {
    return errorResponse(422, 'invalid_request', OFFER_MESSAGES.invalid);
  }
  const result = await makeOffer(document.id, session.userId, collaboratorId);
  return offeredAnswer(result, session.userId, document.id, after);
});

/** No body, and none is read. */
export const DELETE = documentRoute('document.ownership.transfer', async ({ document, session }) =>
  withdrawnAnswer(await withdrawOffer(document.id, session.userId), session.userId, document.id),
);
