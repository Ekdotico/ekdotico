// FR-ED-38: change a collaborator's role, and remove a collaborator (API
// design, "Documents, Sharing"; the segment is the collaborator's row
// identifier, register row S15-1). Each handler is made by `documentRoute`: the
// origin, the session's row, the document and the permission are decided
// before the body is read, and `collaborators.ts` reads the caller's role and
// the permission again under the lock of the document, so that what the
// request was authorised for is what it acts on (FR-ED-44 (b)).
import {
  changedAnswer,
  COLLABORATOR_MESSAGES,
  removedAnswer,
} from '../../../../../../lib/documents/collaborator-answers.ts';
import { changeRole, removeCollaborator } from '../../../../../../lib/documents/collaborators.ts';
import { documentRoute } from '../../../../../../lib/documents/route.ts';
import { OFFERED, type OfferedRole } from '../../../../../../lib/documents/sharing.ts';
import { errorResponse, notJson, readJson } from '../../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

// A role written as an escape, and the JSON around it, many times over.
const MAX_BODY_BYTES = 1024;

/**
 * The body: `{ "role": "editor" | "viewer" }`, and nothing else. The Reviewer
 * is not offered in α 0.1.0 (FR-ED-44) and is refused with a 422, as an
 * invitation for it is (slice 13). Authorisation before validation (the
 * owner's answer to Q8): nothing is said of the body to a caller who may not.
 */
export const PATCH = documentRoute(
  'document.collaborators.roles',
  async ({ request, document, session, params }) => {
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const body = await readJson(request, MAX_BODY_BYTES);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return errorResponse(422, 'invalid_request', COLLABORATOR_MESSAGES.invalidRole);
    }
    const { role, ...rest } = body as Record<string, unknown>;
    if (role === 'reviewer' && Object.keys(rest).length === 0) {
      return errorResponse(422, 'role_not_offered', COLLABORATOR_MESSAGES.reviewer);
    }
    if (Object.keys(rest).length > 0 || typeof role !== 'string' || !Object.hasOwn(OFFERED, role)) {
      return errorResponse(422, 'invalid_request', COLLABORATOR_MESSAGES.invalidRole);
    }
    const result = await changeRole(
      document.id,
      session.userId,
      String(params.collaboratorId),
      role as OfferedRole,
    );
    return changedAnswer(result, session.userId, document.id);
  },
  // FR-AU-91: a change of role does not change the document, and does not bring the day forward; no role makes a
  // connection editable while the period lasts (FR-ED-40 (i)).
  { duringClearing: 'allowed' },
);

/** No body, and none is read. */
export const DELETE = documentRoute(
  'document.collaborators.remove',
  async ({ document, session, params }) =>
    removedAnswer(
      await removeCollaborator(document.id, session.userId, String(params.collaboratorId)),
      session.userId,
      document.id,
    ),
  // FR-AU-91: "Removing a collaborator during the period does not bring the deletion forward".
  { duringClearing: 'allowed' },
);
