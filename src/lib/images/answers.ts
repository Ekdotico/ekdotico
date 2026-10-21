// What the routes of the images say (docs/plan/slice-19.md, section 7): text
// for a person, written under the Expression Guidelines, each stating what
// happened and what to do next, and blaming no one. None is given by a
// requirement, and all are for the owner's approval with the pull request
// (the owner's answer to Q6). The statuses are the owner's answer to Q8: 415
// for a type that is not accepted, 413 for the two sizes.
import { errorResponse } from '../http.ts';

export const IMAGE_MESSAGES = {
  notAccepted:
    'That file is not a PNG, JPEG, GIF, or WebP image, so it was not added. Choose an image in one of those formats.',
  tooLarge:
    'That image is larger than 20 MB, so it was not added. Choose a smaller image, or reduce its size first.',
  // NFR-SE-18: "refused with a statement of the limit". Every stored object counts toward it (the owner's answer to Q14),
  // so the words say that an image taken out of the document does not free the room at once.
  full: (limit: string, days: number) =>
    `This document holds as many images as it can, ${limit}, so this image was not added. An image you take out of the document stops counting once it is deleted from storage, within ${days} ${days === 1 ? 'day' : 'days'}.`,
  // A body that did not arrive whole: the client reset the connection, or the proxy cut it.
  notReceived: 'The image did not arrive in full, so it was not added. Choose it again and try again.',
  limited: (seconds: number) => {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `Too many images were uploaded in a short time. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  },
  // The 403 of a document that cannot be changed is the one of src/lib/documents/access.ts, `FORBIDDEN_FOR`.
  unavailable: 'Images cannot be stored in this setup of Ekdotico, so the image was not added.',
} as const;

/** The limit as a person reads it: whole megabytes. */
export const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export const notAcceptedAnswer = () =>
  errorResponse(415, 'image_type_not_accepted', IMAGE_MESSAGES.notAccepted);
export const tooLargeAnswer = () => errorResponse(413, 'image_too_large', IMAGE_MESSAGES.tooLarge);
export const fullAnswer = (limitBytes: number, days: number) =>
  errorResponse(413, 'image_document_full', IMAGE_MESSAGES.full(megabytes(limitBytes), days));
export const notReceivedAnswer = () => errorResponse(400, 'invalid_request', IMAGE_MESSAGES.notReceived);
export const limitedAnswer = (seconds: number) =>
  errorResponse(429, 'rate_limited', IMAGE_MESSAGES.limited(seconds), { 'Retry-After': String(seconds) });
export const unavailableAnswer = () => errorResponse(503, 'images_unavailable', IMAGE_MESSAGES.unavailable);
