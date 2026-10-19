// The words of the transfer of ownership, which the server and the browser
// both show (FR-ED-47). Imports nothing, so that a page of the browser can
// take them. Written under the Expression Guidelines for the owner's approval
// (plan Q6; docs/plan/slice-17.md, section 7). The email's subject and text are
// FR-ED-47's own, verbatim, and are in ./ownership.ts beside the function that
// fills them.

export const OFFER_TITLE = 'Offer of ownership';

export const OFFER_STATEMENTS = {
  // The neutral statement of an offer that is not this account's, or does not exist (docs/plan/slice-17.md, S13-3's rule).
  notOpenToAccount:
    'This offer is not open to this account. An offer of ownership can be accepted only by the Editor it was made to.',
  noLongerOpen: 'This offer is no longer open. It was accepted, declined, or withdrawn, or it expired.',
  declined: 'Offer declined.',
  noSuchAction: 'There is no such action.',
};

/** What the routes of the Owner answer, the server's text shown as it is given. */
export const OFFER_MESSAGES = {
  offered: (name: string) => `Ownership offered to ${name}.`,
  withdrawn: (name: string) => `Offer of ownership to ${name} withdrawn.`,
  invalid: 'No offer was made. Choose an Editor.',
  notAnEditor:
    'No offer was made. Ownership can be offered only to a collaborator who holds the Editor role.',
  pending:
    'No offer was made. An offer of ownership is already open for this document. Withdraw it to offer ownership to someone else.',
  notTransferable: 'No offer was made. This document cannot be transferred in this release.',
  noSuchCollaborator:
    'This person is not a collaborator on this document. Reload the page to see the people.',
  noOpenOffer:
    'There is no open offer of ownership for this document. Reload the page to see its current state.',
};
