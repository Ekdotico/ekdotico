// What a document in a clearing is (FR-AU-91, FR-ED-40 (i), register A103), asked in one place by everything
// that must not change it: `Document.clearingAt` is the day of its deletion, and while it is set the document is
// read-only for everyone, no invitation is created for it, and it is not renamed, deleted by hand or restored.
//
// Nothing here is of Next.js, and nothing here reads the database: the collaboration server loads it too.
import { dateText } from '../date-text.ts';
import { errorResponse } from '../http.ts';

/** The columns of a document that tell whether it is in a clearing, and for how long. */
export interface ClearingMark {
  clearingAt: Date | null;
  deletionClaimedAt?: Date | null;
}

/**
 * Whether the document is in a clearing: from the confirmation until the document is gone, or taken out of
 * it. Read-only, and closed to every change, for the whole of it.
 */
export function inClearing(document: Pick<ClearingMark, 'clearingAt'>): boolean {
  return document.clearingAt !== null;
}

/**
 * Whether the NOTICE PERIOD runs: the day is ahead, and no timer has claimed the document for its deletion. What
 * FR-AU-91 grants in it holds in it alone: the draft export for every collaborator (FR-ED-44 (d)), and the
 * Owner's cancellation. Once the day has come the document is read-only, waiting for the timer, and no one
 * is given more.
 */
export function noticeRuns(document: ClearingMark, now: Date): boolean {
  return document.clearingAt !== null && document.clearingAt > now && !document.deletionClaimedAt;
}

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request,
// docs/plan/slice-23.md, section 6). The date is the one form of a date, in UTC and said so, as in an email: a
// route's answer does not know the reader's zone.
const WHAT = {
  change: (day: string) =>
    `This document will be deleted on ${day}, so it cannot be changed. Nothing was changed.`,
  invite: (day: string) =>
    `This document will be deleted on ${day}, so no one can be invited to it. No invitation was created.`,
  delete: (day: string) =>
    `This document will be deleted on ${day}, so it cannot be deleted now. The document was not deleted.`,
  restore: (day: string) =>
    `This document will be deleted on ${day}, so it cannot be restored. Its Owner can cancel the deletion first. The document was not restored.`,
} as const;

export type Change = keyof typeof WHAT;

/** The 409 of a request that would change a document in a clearing (FR-AU-91: "refused with a 409 response"). */
export function clearingRefusal(clearingAt: Date, change: Change): Response {
  return errorResponse(409, 'clearing', WHAT[change](dateText(clearingAt, 'utc')));
}
