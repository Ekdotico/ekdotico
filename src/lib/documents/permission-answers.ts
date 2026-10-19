// What the route that changes a permission set answers (FR-ED-45), in one
// place. Text for a person: src/lib/documents/permission-texts.ts, written
// for the owner's approval (plan Q6; docs/plan/slice-16.md, §7).
//
// Nothing here is of Next.js.
import { errorResponse } from '../http.ts';
import { refusal } from './access.ts';
import { PERMISSION_MESSAGES } from './permission-texts.ts';
import type { RequestRefusal } from './permission-rules.ts';
import type { SetResult } from './permission-settings.ts';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** A 422 for a request that `readRequest` refused. Authorisation came first: the caller may change the set. */
export function refusedRequest(why: RequestRefusal): Response {
  switch (why) {
    case 'invalid_request':
      return errorResponse(422, 'invalid_request', PERMISSION_MESSAGES.invalidRequest);
    case 'cell_fixed':
      return errorResponse(422, 'cell_fixed', PERMISSION_MESSAGES.cellFixed);
    case 'not_offered':
      return errorResponse(422, 'not_offered', PERMISSION_MESSAGES.notOffered);
  }
}

/**
 * The answer to a change: its statement and the whole set as it is now, or the
 * refusal. A 404 for a document or a role that is not there, as everywhere; a
 * 403 for a role that does not hold the permission, written to the security
 * log with the user and the document and nothing else (NFR-SE-19).
 */
export async function setAnswer(result: SetResult, userId: string, documentId: string): Promise<Response> {
  if (result.outcome === 'not_found') return refusal({ outcome: 'not_found' }, userId, documentId);
  if (result.outcome === 'no_permission') {
    return refusal({ outcome: 'forbidden' }, userId, documentId, 'document.permissions.edit');
  }
  const message =
    result.outcome === 'changed'
      ? result.defaults
        ? PERMISSION_MESSAGES.reset
        : PERMISSION_MESSAGES.changed
      : result.defaults
        ? PERMISSION_MESSAGES.resetUnchanged
        : PERMISSION_MESSAGES.unchanged;
  return Response.json({ message, set: result.set }, { headers: NO_STORE });
}
