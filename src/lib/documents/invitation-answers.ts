// What the routes of invitations answer (FR-ED-21, FR-ED-37), in one place so
// that inviting and sending again say the same. Text for a person: the fixed
// texts of the requirements verbatim, and the rest written under the
// Expression Guidelines for the owner's approval (plan Q6; docs/plan/slice-13.md, §5).
//
// Nothing here is of Next.js: the route hands over its `after`.
import { tooManyRequests } from '../auth/route-answers.ts';
import { errorResponse } from '../http.ts';
import { ANSWER_STATEMENTS } from './invitation-texts.ts';
import { deliverInvitations, type AnswerResult, type CreateResult } from './sharing.ts';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** FR-ED-21, verbatim: the one confirmation, whatever the address. */
export const confirmation = (address: string) =>
  `Invitation created for ${address}. Ekdotico sends an invitation only to an address that belongs to an account. If this address does, the person receives an email and a notification.`;

/** FR-ED-37, verbatim. */
export const LIMIT_STATEMENT =
  'This document has reached its limit of ten people. Remove a collaborator or revoke an invitation to invite another.';

export const INVITATION_MESSAGES = {
  own: (address: string) => `No invitation was created: ${address} is an address of this account.`,
  collaborator: (address: string) =>
    `No invitation was created: the person at ${address} already has a role on this document.`,
  reviewer: 'The Reviewer role is not offered in this release. Choose Editor or Viewer.',
  invalid: 'Enter 1 to 10 email addresses, one on each line, and choose a role. No invitation was created.',
  notAnAddress: (entry: string) => `No invitation was created: ${entry} is not an email address.`,
  notFound: 'This invitation is no longer pending. Reload the page to see the pending invitations.',
  revoked: (address: string) => `Invitation to ${address} revoked.`,
};

/**
 * The answer to accepting or declining (FR-ED-21, FR-ED-37): 200 with the
 * document's identifier, 200 with the statement of a decline, or a 404 with
 * one of the two neutral statements, which name no document.
 */
export function answered(result: AnswerResult): Response {
  switch (result.outcome) {
    case 'accepted':
      return Response.json({ documentId: result.documentId }, { headers: NO_STORE });
    case 'declined':
      return Response.json({ message: ANSWER_STATEMENTS.declined }, { headers: NO_STORE });
    case 'no_longer_open':
      return errorResponse(404, 'no_longer_open', ANSWER_STATEMENTS.noLongerOpen);
    case 'not_open_to_account':
      return errorResponse(404, 'not_open_to_account', ANSWER_STATEMENTS.notOpenToAccount);
  }
}

/**
 * The answer to an attempt to create invitations, and the delivery left for
 * after it (NFR-RE-15): the same status and the same body for every address
 * (FR-ED-21). `later` is `after` of Next.js, which runs a task once the
 * response has been returned.
 */
export async function createdAnswer(
  result: CreateResult,
  documentId: string,
  inviterId: string,
  later: (task: () => Promise<void>) => void,
): Promise<Response> {
  switch (result.outcome) {
    case 'created': {
      const { invitations } = result;
      later(() => deliverInvitations(documentId, inviterId, invitations));
      return Response.json(
        { confirmations: invitations.map(({ email }) => confirmation(email)) },
        { status: 201, headers: NO_STORE },
      );
    }
    case 'own_address':
      return errorResponse(409, 'own_address', INVITATION_MESSAGES.own(result.email));
    case 'collaborator_address':
      return errorResponse(409, 'collaborator_address', INVITATION_MESSAGES.collaborator(result.email));
    case 'limit':
      return errorResponse(409, 'people_limit', LIMIT_STATEMENT);
    case 'rate_limited':
      return tooManyRequests('INVITATIONS_PER_USER', inviterId, result.retryAfterSeconds, inviterId);
    case 'not_found':
      return errorResponse(404, 'not_found', INVITATION_MESSAGES.notFound);
  }
}
