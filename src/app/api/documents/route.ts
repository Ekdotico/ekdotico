// FR-ED-35: the documents of the current account, and the creation of one (API
// design, "Documents"). Neither request is about a document that exists, so
// neither can ask src/lib/documents/access.ts: the list is the session's own
// account's and takes no identifier from the request, and a creation is
// authorised by the workspace, which must be that account's own (FR-AU-12).
import { AccountInDeletion } from '../../../lib/account/in-deletion.ts';
import { fault, notAdmitted, refusedOrigin, unauthenticated } from '../../../lib/auth/route-answers.ts';
import { validateSession, validateSessionRow } from '../../../lib/auth/session.ts';
import { createDocument, listDocuments } from '../../../lib/documents/documents.ts';
import { errorResponse, notJson, readJson } from '../../../lib/http.ts';
import { securityLog } from '../../../lib/security-log.ts';
import { ensurePersonalWorkspace } from '../../../lib/workspace.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// More than a workspace's identifier and the JSON around it.
const MAX_BODY_BYTES = 1024;

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  forbidden:
    'A document is created in a workspace of the account that creates it. This request named another workspace, and no document was created.',
  invalid: 'The request may name the workspace of the document, and nothing else. No document was created.',
};

/** It reads, so the signed copy of the session serves (NFR-SE-02). */
export async function GET(request: Request): Promise<Response> {
  try {
    const validation = await validateSession(request.method, request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    return Response.json({ documents: await listDocuments(session.userId) }, { headers: NO_STORE });
  } catch (error) {
    return fault('documents', error);
  }
}

/**
 * It changes state, so it reads the session's row (NFR-SE-17 (c)); the origin
 * check is the proxy's and, since the proxy can be skipped, this route's own
 * as well (the owner's decision R50 of 12 October 2026).
 *
 * The body: `{}`, or `{ "workspaceId": "…" }`. Any other field is refused: the
 * Owner is the session's account, the title is the default, and whether the
 * document is recorded is the port's to say (FR-ED-43), none of them the
 * request's.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // NFR-SE-17 (c): the origin first, before anything of the request is read.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;

    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);

    // R28: a body that is not sent as JSON is a 415, after the session and before anything is read.
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const body = await readJson(request, MAX_BODY_BYTES);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse(422, 'invalid_request', MESSAGES.invalid);
    }
    const { workspaceId, ...rest } = body as Record<string, unknown>;

    // Authorisation before validation (the owner's answer to Q8). FR-AU-12:
    // the one workspace an account may create in is its personal workspace. A
    // request that names anything else is refused, and nothing is read of what
    // it named, so the answer is the same whether or not such a workspace
    // exists. NFR-SE-19: a 403, logged with the user and nothing of the request.
    if (workspaceId !== undefined && workspaceId !== (await ensurePersonalWorkspace(session.userId))) {
      await securityLog({ kind: 'forbidden', userId: session.userId });
      return errorResponse(403, 'forbidden', MESSAGES.forbidden);
    }
    if (Object.keys(rest).length > 0) return errorResponse(422, 'invalid_request', MESSAGES.invalid);

    // The workspace is not handed on: `createDocument` takes the account's own.
    return Response.json(await createDocument(session.userId), { status: 201, headers: NO_STORE });
  } catch (error) {
    // FR-AU-58 (a): a request that passed the validation just before the confirmation of the
    // deletion of the account is answered as one without a session (the owner's answer to Q8).
    if (error instanceof AccountInDeletion) return unauthenticated();
    return fault('documents', error);
  }
}
