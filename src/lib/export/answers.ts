// What the draft export says when it cannot carry out a request (docs/plan/slice-21.md, section 8): text for a
// person, written under the Expression Guidelines, each stating what happened and what to do next. None is given by
// a requirement, and all are for the owner's approval with the pull request (the owner's answer to Q6 of the plan).
// The statuses are FR-EX-36's: a second export meanwhile is a 429, and a request that cannot be completed is a
// statement and no partial file.
import { errorResponse } from '../http.ts';

export const EXPORT_MESSAGES = {
  busy: 'An export of yours is already under way. Wait until it has finished, then try again.',
  limited: (seconds: number) => {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `Too many exports were started in a short time. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  },
  // The document holds images and this setup of Ekdotico has no store to read them from.
  unavailable:
    'Images cannot be stored in this setup of Ekdotico, so the document cannot be exported with them. Nothing was exported.',
} as const;

/** How long a caller is told to wait before it asks again while an export of its own is under way, in seconds. */
export const BUSY_RETRY_SECONDS = 10;

export const busyAnswer = () =>
  errorResponse(429, 'export_in_progress', EXPORT_MESSAGES.busy, {
    'Retry-After': String(BUSY_RETRY_SECONDS),
  });
export const limitedAnswer = (seconds: number) =>
  errorResponse(429, 'rate_limited', EXPORT_MESSAGES.limited(seconds), { 'Retry-After': String(seconds) });
export const unavailableAnswer = () => errorResponse(503, 'images_unavailable', EXPORT_MESSAGES.unavailable);
