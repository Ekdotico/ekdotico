// The words a route of the clearing answers with, for a program; the deletion screen words its own statements
// (src/app/(app)/settings/delete-account/). Text for a person: the owner's answer to Q6 of the plan, approved
// with the pull request (docs/plan/slice-23.md, section 6). None of them quotes a title, an address or an identifier.
export const CLEARING_MESSAGES = {
  shape:
    'The request must hold the scope, the identifiers of the documents, and the current password, and nothing else. No document was deleted.',
  shapeWithCode:
    'The request must hold the scope, the identifiers of the documents, the current password and a code, and nothing else. No document was deleted.',
  tooMany: (most: number) =>
    `A clearing names at most ${most.toLocaleString('en-GB')} documents. No document was deleted.`,
  changed:
    'The documents of this account are no longer the ones you were shown. Reload the page, check them, and confirm again. No document was deleted.',
  nothing: 'This account owns no document to clear. No document was deleted.',
  nothingWaiting: 'No document of this account is waiting for its deletion.',
  notWaiting: 'This document is not waiting for its deletion.',
  tooLate: 'The day for deleting this document has come, so the deletion can no longer be cancelled.',
} as const;
