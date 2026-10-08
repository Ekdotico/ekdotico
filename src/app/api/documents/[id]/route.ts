// FR-ED-35, FR-ED-36: one document's metadata, its renaming, and its deletion
// (API design, "Documents"). Each handler is made by `documentRoute`, which
// validates the session and authorises the request through
// src/lib/documents/access.ts, against the caller's role and the document's
// permission set as they are now (FR-ED-39, NFR-SE-04), and hands over the one
// document it allowed. The Yjs state joins the GET with the editor.
import { refusal } from '../../../../lib/documents/access.ts';
import { deleteDocument } from '../../../../lib/documents/deletion.ts';
import {
  readTitle,
  renameDocument,
  summary,
  TITLE_MAX_CHARACTERS,
} from '../../../../lib/documents/documents.ts';
import { documentRoute } from '../../../../lib/documents/route.ts';
import { errorResponse, readJson } from '../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// More than any honest request holds: a title of 200 characters, each written
// as two escapes of six bytes, and the JSON around them.
const MAX_BODY_BYTES = 4096;

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  invalid: 'The request must give the title as text, and nothing else. The title was not changed.',
  refused: 'The title was not changed, because it does not meet its rule. Change the title and try again.',
  tooLong: `A title has at most ${TITLE_MAX_CHARACTERS} characters. Enter a shorter title.`,
  notStorable: 'The title holds a character that cannot be stored. Remove the character and try again.',
};

/** It reads, so the signed copy of the session serves (NFR-SE-02). */
export const GET = documentRoute('document.view', ({ document }) =>
  Response.json(summary(document), { headers: NO_STORE }),
);

/**
 * It changes state, so the session's row is read (NFR-SE-17 (c)); the origin
 * check is the proxy's. The body: `{ "title": "…" }`, and nothing else, so
 * that no request moves a document to another workspace (FR-AU-13), changes
 * its Owner, or touches whether it is recorded (FR-ED-43).
 *
 * Authorisation before validation (the owner's answer to Q8): nothing is said
 * of the body to a caller who may not rename the document.
 */
export const PATCH = documentRoute('document.rename', async ({ request, document, session }) => {
  const body = await readJson(request, MAX_BODY_BYTES);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorResponse(422, 'invalid_request', MESSAGES.invalid);
  }
  const { title, ...rest } = body as Record<string, unknown>;
  const read = readTitle(title);
  if (Object.keys(rest).length > 0 || (!read.ok && read.reason === 'not_text')) {
    return errorResponse(422, 'invalid_request', MESSAGES.invalid);
  }
  if (!read.ok) {
    // FR-ED-35: "a title longer than 200 characters is refused". The rule is
    // stated for the field as well, as the sign-up route states its own.
    const rule = read.reason === 'too_long' ? MESSAGES.tooLong : MESSAGES.notStorable;
    return Response.json(
      { error: { code: 'invalid', message: MESSAGES.refused, fields: { title: rule } } },
      { status: 422, headers: NO_STORE },
    );
  }

  const renamed = await renameDocument(document.id, read.title);
  // Deleted by a request beside this one, after it was authorised: nothing
  // was renamed, and the document is gone, as to anyone (FR-ED-36).
  if (!renamed) return refusal({ outcome: 'not_found' }, session.userId, document.id);
  return Response.json(renamed, { headers: NO_STORE });
});

/**
 * FR-ED-36: the Owner deletes the document. `document.delete` is fixed to the
 * Owner and can be given to no other role (FR-ED-44). It changes state, so
 * the session's row is read. The request has no body, and none is read.
 *
 * The answer is a 204 with nothing in it: the page gives no status for it
 * (reported). A document that a request beside this one deleted first is no
 * longer there for this one, and is answered as any document that is not.
 */
export const DELETE = documentRoute('document.delete', async ({ document, session }) => {
  if (!(await deleteDocument(document, session.userId))) {
    return refusal({ outcome: 'not_found' }, session.userId, document.id);
  }
  return new Response(null, { status: 204, headers: NO_STORE });
});
