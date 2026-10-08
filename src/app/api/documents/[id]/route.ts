// FR-ED-35: one document's metadata, and its renaming (API design,
// "Documents"). Each request is authorised by src/lib/documents/access.ts,
// against the caller's role and the document's permission set as they are now
// (FR-ED-39, NFR-SE-04). The Yjs state joins the GET with the editor.
import { fault, unauthenticated } from '../../../../lib/auth/route-answers.ts';
import { validateSession, validateSessionRow } from '../../../../lib/auth/session.ts';
import { authorise, refusal } from '../../../../lib/documents/access.ts';
import {
  readTitle,
  renameDocument,
  summary,
  TITLE_MAX_CHARACTERS,
} from '../../../../lib/documents/documents.ts';
import { errorResponse, readJson } from '../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// More than any honest request holds: a title of 200 characters, each written
// as two escapes of six bytes, and the JSON around them.
const MAX_BODY_BYTES = 4096;

type Context = { params: Promise<{ id: string }> };

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  invalid: 'The request must give the title as text, and nothing else. The title was not changed.',
  refused: 'The title was not changed, because it does not meet its rule. Change the title and try again.',
  tooLong: `A title has at most ${TITLE_MAX_CHARACTERS} characters. Enter a shorter title.`,
  notStorable: 'The title holds a character that cannot be stored. Remove the character and try again.',
};

/** It reads, so the signed copy of the session serves (NFR-SE-02). */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    const { session } = await validateSession(request.method, request.headers);
    if (!session) return unauthenticated();

    const { id } = await params;
    const access = await authorise(session.userId, id, 'document.view');
    if (access.outcome !== 'allowed') return refusal(access, session.userId, id);

    return Response.json(summary(access.document), { headers: NO_STORE });
  } catch (error) {
    return fault('documents', error);
  }
}

/**
 * It changes state, so it reads the session's row (NFR-SE-17 (c)); the origin
 * check is the proxy's. The body: `{ "title": "…" }`, and nothing else, so
 * that no request moves a document to another workspace (FR-AU-13), changes
 * its Owner, or touches whether it is recorded (FR-ED-43).
 */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  try {
    const { session } = await validateSessionRow(request.headers);
    if (!session) return unauthenticated();

    // Authorisation before validation (the owner's answer to Q8): nothing is
    // said of the body to a caller who may not rename the document.
    const { id } = await params;
    const access = await authorise(session.userId, id, 'document.rename');
    if (access.outcome !== 'allowed') return refusal(access, session.userId, id);

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

    return Response.json(await renameDocument(access.document.id, read.title), { headers: NO_STORE });
  } catch (error) {
    return fault('documents', error);
  }
}
