// FR-ED-47: offer the ownership of a document to one of its Editors, and
// withdraw the offer (API design, "Documents, Sharing"). Each handler is made
// by `documentRoute` for `document.ownership.transfer`, which the table fixes
// to the Owner and gives to no other role: the origin, the session's row, the
// document and the permission are decided before the body is read, and
// `ownership.ts` reads the Owner again under the document's row.
import { after } from 'next/server';
import { askPrompt } from '../../../../../lib/account/prompt.ts';
import { collecting } from '../../../../../lib/after-response.ts';
import { offeredAnswer, withdrawnAnswer } from '../../../../../lib/documents/ownership-answers.ts';
import { OFFER_MESSAGES } from '../../../../../lib/documents/ownership-texts.ts';
import { makeOffer, withdrawOffer } from '../../../../../lib/documents/ownership.ts';
import { documentRoute } from '../../../../../lib/documents/route.ts';
import { errorResponse, notJson, readJson } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

// An identifier of 64 characters written as escapes, a password at its longest, a code, and the JSON around them.
const MAX_BODY_BYTES = 4096;

/**
 * The body: `{ "collaboratorId": "<the identifier of a collaborator's row>" }`,
 * and nothing else (register row S17-1: the people list carries no account
 * identifier). The Owner is offered nothing: ownership is offered to an Editor.
 */
export const POST = documentRoute(
  'document.ownership.transfer',
  async ({ request, document, session }) => {
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const body = await readJson(request, MAX_BODY_BYTES);
    // A wrong password is counted as a failed sign-in, which leaves its lock for after the response
    // (src/lib/after-response.ts): the request collects what it leaves and hands it to `after`.
    const { result, tasks } = await collecting(async () => {
      // FR-ED-47, D285; register Q82 point 6: the password, and the code where two-factor authentication is on,
      // are asked for here, immediately before the action and every time, and a request without them is refused
      // whatever its session. A wrong one counts as a failed sign-in (src/lib/account/prompt.ts).
      const prompt = await askPrompt(request, session, body, {
        password: OFFER_MESSAGES.password,
        passwordAndCode: OFFER_MESSAGES.passwordAndCode,
      });
      if (!prompt.ok) return prompt.response;
      const { collaboratorId, ...rest } = prompt.rest;
      if (Object.keys(rest).length > 0 || typeof collaboratorId !== 'string') {
        return errorResponse(422, 'invalid_request', OFFER_MESSAGES.invalid);
      }
      const made = await makeOffer(document.id, session.userId, collaboratorId, new Date(), prompt.guard);
      return offeredAnswer(made, session.userId, document.id, after);
    });
    for (const task of tasks) after(task);
    return result;
  },
  // FR-AU-91: "An offer of ownership may still be made for the document, and its acceptance takes the
  // document out of the clearing".
  { duringClearing: 'allowed' },
);

/** No body, and none is read. */
export const DELETE = documentRoute(
  'document.ownership.transfer',
  async ({ document, session }) =>
    withdrawnAnswer(await withdrawOffer(document.id, session.userId), session.userId, document.id),
  { duringClearing: 'allowed' },
);
