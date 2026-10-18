// The words of an invitation's page, which the server and the browser both
// show (FR-ED-21, FR-ED-37). Imports nothing, so that a page of the browser
// can take them. Written under the Expression Guidelines for the owner's
// approval (plan Q6; docs/plan/slice-13.md, §5).

export const INVITATION_TITLE = 'Invitation to a document';

export const ANSWER_STATEMENTS = {
  // FR-ED-21: "a neutral statement that the invitation is not open to that account, without naming the document".
  notOpenToAccount:
    'This invitation is not open to this account. An invitation can be accepted only by the account that holds the address it was sent to.',
  // FR-ED-37: "a neutral statement that the invitation is no longer open, without naming the document".
  noLongerOpen: 'This invitation is no longer open. It was accepted, declined, or revoked, or it expired.',
  declined: 'Invitation declined.',
};
