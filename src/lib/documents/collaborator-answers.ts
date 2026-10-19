// What the routes that change a role, remove a collaborator and leave a
// document answer (FR-ED-38, FR-ED-44 (b)), in one place. Text for a person,
// written under the Expression Guidelines for the owner's approval (plan Q6;
// docs/plan/slice-15.md, §7).
//
// Nothing here is of Next.js.
import { errorResponse } from '../http.ts';
import { securityLog } from '../security-log.ts';
import { refusal } from './access.ts';
import type { ChangeResult, Outcome, RemoveResult } from './collaborators.ts';
import { ROLE_NAME } from './permissions.ts';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const COLLABORATOR_MESSAGES = {
  noSuchCollaborator:
    'This person is not a collaborator on this document. Reload the page to see the people.',
  // FR-ED-44 (b): an Editor never acts on another Editor.
  actsOnEditor:
    'The role of this account on the document can act on a Reviewer or a Viewer and never on an Editor. The Owner of the document can act on an Editor.',
  // FR-ED-44 (b): "a holder who wants to go leaves the document".
  actsOnSelf: 'This account cannot change its own role or remove itself. To go, leave the document.',
  invalidRole: 'The role was not changed. Choose Editor or Viewer.',
  reviewer:
    'The role was not changed. The Reviewer role is not offered in this release. Choose Editor or Viewer.',
  changed: (name: string, role: 'editor' | 'viewer') => `Role of ${name} changed to ${ROLE_NAME[role]}.`,
  unchanged: (name: string, role: 'editor' | 'viewer') => `Role of ${name} is already ${ROLE_NAME[role]}.`,
  removed: (name: string) => `${name} removed from this document.`,
};

/**
 * The answer to an action that was not carried out. A 404 for a document or a
 * role that is not there, as everywhere; a 403 for the rest, written to the
 * security log with the user and the document and nothing else (NFR-SE-19).
 */
async function notDone(result: Outcome, userId: string, documentId: string): Promise<Response> {
  switch (result.outcome) {
    case 'not_found':
      return refusal({ outcome: 'not_found' }, userId, documentId);
    case 'no_permission':
      return refusal({ outcome: 'forbidden' }, userId, documentId);
    case 'no_such_collaborator':
      return errorResponse(404, 'not_found', COLLABORATOR_MESSAGES.noSuchCollaborator);
    case 'refused':
      await securityLog({ kind: 'forbidden', userId, documentId });
      return errorResponse(
        403,
        'forbidden',
        result.why === 'self' ? COLLABORATOR_MESSAGES.actsOnSelf : COLLABORATOR_MESSAGES.actsOnEditor,
      );
  }
}

export async function changedAnswer(
  result: ChangeResult,
  userId: string,
  documentId: string,
): Promise<Response> {
  if (result.outcome === 'changed') {
    return Response.json(
      { message: COLLABORATOR_MESSAGES.changed(result.name, result.role) },
      { headers: NO_STORE },
    );
  }
  if (result.outcome === 'unchanged') {
    return Response.json(
      { message: COLLABORATOR_MESSAGES.unchanged(result.name, result.role) },
      { headers: NO_STORE },
    );
  }
  return notDone(result, userId, documentId);
}

export async function removedAnswer(
  result: RemoveResult,
  userId: string,
  documentId: string,
): Promise<Response> {
  if (result.outcome === 'removed') {
    return Response.json({ message: COLLABORATOR_MESSAGES.removed(result.name) }, { headers: NO_STORE });
  }
  return notDone(result, userId, documentId);
}
