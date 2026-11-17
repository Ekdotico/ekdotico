// What the routes of the transfer of ownership answer (FR-ED-47), in one place.
// Text for a person: ./ownership-texts.ts, for the owner's approval (plan Q6;
// docs/plan/slice-17.md, section 7).
//
// Nothing here is of Next.js: the route hands over its `after`.
import { guardAnswer } from '../account/prompt.ts';
import { tooManyRequests } from '../auth/route-answers.ts';
import { CLEARING_MESSAGES } from '../clearing/texts.ts';
import { errorResponse } from '../http.ts';
import { refusal } from './access.ts';
import { deliverOffer, type AnswerResult, type OfferResult, type WithdrawResult } from './ownership.ts';
import { OFFER_MESSAGES, OFFER_STATEMENTS } from './ownership-texts.ts';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The answer to an offer made by the Owner. A 404 for a document or a role
 * that is not there; a 403 for a role that is not the Owner's, written to the
 * security log with the user and the document and nothing else (NFR-SE-19).
 * The email is left for after the response (NFR-RE-15): `later` is `after` of
 * Next.js.
 */
export async function offeredAnswer(
  result: OfferResult,
  userId: string,
  documentId: string,
  later: (task: () => Promise<void>) => void,
): Promise<Response> {
  switch (result.outcome) {
    case 'offered': {
      const { id, name, expiresAt } = result.offer;
      later(() => deliverOffer(id));
      return Response.json(
        { message: OFFER_MESSAGES.offered(name), expiresAt: expiresAt.toISOString() },
        { status: 201, headers: NO_STORE },
      );
    }
    case 'not_found':
      return refusal({ outcome: 'not_found' }, userId, documentId);
    case 'no_permission':
      return refusal({ outcome: 'forbidden' }, userId, documentId, 'document.ownership.transfer');
    case 'no_such_collaborator':
      return errorResponse(404, 'not_found', OFFER_MESSAGES.noSuchCollaborator);
    case 'not_an_editor':
      return errorResponse(409, 'not_an_editor', OFFER_MESSAGES.notAnEditor);
    case 'pending':
      return errorResponse(409, 'offer_pending', OFFER_MESSAGES.pending);
    case 'not_transferable':
      return errorResponse(409, 'not_transferable', OFFER_MESSAGES.notTransferable);
    case 'clearing_over':
      return errorResponse(409, 'too_late', CLEARING_MESSAGES.offerTooLate);
    case 'rate_limited':
      // NFR-SE-07, S17-7: the same answer, in the same words, as the limit of invitations.
      return tooManyRequests('OFFERS_PER_USER', userId, result.retryAfterSeconds, userId);
    case 'ended':
    case 'outrun':
    case 'code_gone':
      // FR-ED-47, D285: the prompt no longer stands, as the confirmation of a clearing answers it.
      return guardAnswer(userId, result);
  }
}

export async function withdrawnAnswer(
  result: WithdrawResult,
  userId: string,
  documentId: string,
): Promise<Response> {
  switch (result.outcome) {
    case 'withdrawn':
      return Response.json({ message: OFFER_MESSAGES.withdrawn(result.name) }, { headers: NO_STORE });
    case 'not_found':
      return refusal({ outcome: 'not_found' }, userId, documentId);
    case 'no_permission':
      return refusal({ outcome: 'forbidden' }, userId, documentId, 'document.ownership.transfer');
    case 'none':
      return errorResponse(404, 'no_open_offer', OFFER_MESSAGES.noOpenOffer);
  }
}

/**
 * The answer to accepting or declining: 200 with the document's identifier,
 * 200 with the statement of a decline, or a 404 with one of the two neutral
 * statements, which name no document.
 */
export function answered(result: AnswerResult): Response {
  switch (result.outcome) {
    case 'accepted':
      return Response.json({ documentId: result.documentId }, { headers: NO_STORE });
    case 'declined':
      return Response.json({ message: OFFER_STATEMENTS.declined }, { headers: NO_STORE });
    case 'no_longer_open':
      return errorResponse(404, 'no_longer_open', OFFER_STATEMENTS.noLongerOpen);
    case 'clearing_over':
      return errorResponse(409, 'too_late', CLEARING_MESSAGES.acceptTooLate);
    case 'not_open_to_account':
      return errorResponse(404, 'not_open_to_account', OFFER_STATEMENTS.notOpenToAccount);
  }
}
