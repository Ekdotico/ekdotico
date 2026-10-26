// The words a route of the clearing answers with, for a program, and the statements of the editor; the deletion
// screen words its own (src/app/(app)/settings/delete-account/). Text for a person: the owner's answer to Q6 of
// the plan, approved with the pull request (docs/plan/slice-23.md, section 6). None of them quotes an address or
// an identifier.

/**
 * FR-AU-91, verbatim: "The editor shows, in place of its editing controls, the fixed statement". `day` is the day
 * of the deletion in the reader's own zone and in the one form of a date (src/lib/date-text.ts).
 */
export const CLEARING_NOW = (day: string) =>
  `This document will be deleted on ${day}. You can read it and take a draft export. It cannot be edited.`;

/**
 * The editor of a tab that was told the document will be deleted, and then that it will not: the clearing was
 * cancelled for it, or its ownership passed (FR-ED-40 (i): each connection "returns in place to what its role
 * allows"). FR-AU-91 gives no words for it.
 */
export const CLEARING_ENDED = (canEdit: boolean) =>
  canEdit
    ? 'This document will not be deleted. It can be edited in this tab again.'
    : 'This document will not be deleted.';

/**
 * FR-AU-91: "A change that the server had not acknowledged when a connection became read-only is not accepted: the
 * editor says so and offers to copy the local text". Follows `CLEARING_NOW`; the offer is the control of the
 * editor's own (`Unsaved`).
 */
export const CLEARING_UNSAVED =
  'Your last changes in this tab were not saved. Ekdotico did not keep them, because the document is to be deleted and can no longer be edited.';
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

// ── The deletion screen (FR-AU-58, FR-AU-91) ─────────────────────────────────

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** FR-AU-91, verbatim: "The action is the control "Clear all documents"". */
export const CLEAR_ALL = 'Clear all documents';
/** "The same screen offers the permanent deletion of the already-deleted documents alone": its words are this application's. */
export const CLEAR_DELETED = 'Delete the deleted documents permanently';
/** FR-AU-91: "The confirmation's control reads "Delete [number] documents permanently"". For one document, the singular. */
export const confirmControl = (documents: number) =>
  `Delete ${plural(documents, 'document', 'documents')} permanently`;

/** What a scope is called in the heading of its dialog, and the two lines that introduce it on the page. */
export const SCREEN = {
  heading: 'Clear all documents',
  lead: 'Clearing deletes every document the account owns, permanently, at once and without the days in the list of deleted documents. A document that is shared with other people is given notice first.',
  headingDeleted: 'Deleted documents',
  leadDeleted:
    'The documents in the list of deleted documents can be deleted permanently now, without clearing the others. A document that was shared is given notice first.',
  none: 'The account owns no document that is not waiting for its day.',
  waiting: 'Waiting for their day',
  waitingLead: 'These documents are read-only for everyone, and are deleted on the day shown.',
  cancel: 'Cancel deletion',
  cancelAll: (documents: number) => `Cancel the deletion of all ${documents} documents`,
  cancelled:
    'The deletion was cancelled. The people who hold a role on the document have been told that it will not be deleted.',
  deleting: (documents: number) =>
    `${plural(documents, 'document', 'documents')} ${documents === 1 ? 'is' : 'are'} being deleted now. Ekdotico completes the deletion without you.`,
  accountWaits: (day: string) => `The account cannot be deleted before ${day}.`,
} as const;

/**
 * FR-AU-91: the confirmation "names the number of documents that will be deleted, how many of them are shared, and
 * with how many people in all, states that the documents that are not shared are deleted at once, that the shared
 * ones are deleted on a day it names, 7 days later, after their collaborators have been told, that no document can
 * be restored once it is deleted, and that the account cannot be deleted before that day, ... and says that a copy of
 * a document can be taken first by draft export". And "a user who clears the documents and then keeps the account has
 * an account with no documents; the confirmation says so". The sentences are this application's; the matter is the requirement's.
 */
export function confirmation({
  documents,
  shared,
  people,
  day,
  noticeDays,
}: {
  documents: number;
  shared: number;
  people: number;
  /** The day of the deletion of the shared ones, in the reader's own zone, or null where none is shared. */
  day: string | null;
  noticeDays: number;
}): string[] {
  const lines = [`This deletes ${plural(documents, 'document', 'documents')} permanently.`];
  if (shared === 0) {
    lines.push(documents === 1 ? 'It is not shared.' : 'None of them is shared.');
  } else {
    const some = documents === 1 ? 'It is' : `${shared} of them ${shared === 1 ? 'is' : 'are'}`;
    lines.push(`${some} shared, with ${plural(people, 'person', 'people')} in all.`);
  }
  if (shared < documents) lines.push('A document that is not shared is deleted at once.');
  if (shared > 0 && day !== null) {
    lines.push(
      `${shared === 1 ? 'The shared document is' : 'The shared ones are'} deleted on ${day}, ${plural(noticeDays, 'day', 'days')} from now, after ${shared === 1 ? 'its' : 'their'} collaborators have been told.`,
    );
  }
  lines.push('No document can be restored once it is deleted.');
  if (shared > 0 && day !== null) lines.push(`The account cannot be deleted before ${day}.`);
  lines.push(
    'You can take a copy of a document first by draft export.',
    'Clearing does not delete the account. If you keep it, it has no documents until you create one.',
  );
  return lines;
}

/** After a confirmation: what was done, with the day the shared ones wait for (the server's, in the reader's zone). */
export function cleared({
  documents,
  shared,
  day,
}: {
  documents: number;
  shared: number;
  day: string | null;
}): string {
  const now = documents - shared;
  const parts = [];
  if (now > 0) {
    parts.push(
      `${plural(now, 'document', 'documents')} ${now === 1 ? 'is' : 'are'} being deleted now. Ekdotico completes the deletion without you.`,
    );
  }
  if (shared > 0 && day !== null) {
    parts.push(
      `${plural(shared, 'document', 'documents')} will be deleted on ${day}. ${shared === 1 ? 'Its' : 'Their'} collaborators have been told.`,
    );
  }
  return parts.join(' ');
}
