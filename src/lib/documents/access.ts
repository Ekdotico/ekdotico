// The authorisation of every request about one document (NFR-SE-04, FR-ED-39):
// one function, which every route under /api/documents/[id] calls through
// ./route.ts (tests/unit/routes.test.ts) and which the collaboration handshake
// calls; and beside it the one for a deleted document, which the restore
// calls in the same way.
// It reads the caller's role and the document's permission set from current
// state each time, and keeps nothing between two calls.
//
// Nothing here is of Next.js.
import type { Document } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';
import { errorResponse } from '../http.ts';
import { securityLog } from '../security-log.ts';
import { isRetained } from './deletion.ts';
import { ONLY_OWNER, OWNER_LEAVE } from './permission-texts.ts';
import { COLLABORATOR_ROLE, holds, type DocumentRole, type Permission } from './permissions.ts';

/** A document's row as every query but one reads it: without its content (src/lib/db.ts). */
export type DocumentRow = Omit<Document, 'yjsState'>;

export type Access =
  /** The caller holds a role on the document, and the role holds the permission. */
  | { outcome: 'allowed'; role: DocumentRole; document: DocumentRow }
  /** The caller holds a role on the document, and the role does not hold the permission: a 403 (FR-ED-39). */
  | { outcome: 'forbidden' }
  /**
   * No such document, or one on which the caller holds no role: a 404, the
   * same for both, so that the answer does not show that a document exists
   * (the owner's answer to Q8 of the plan).
   */
  | { outcome: 'not_found' };

// FR-ED-35: "a UUID in canonical lower-case text form", and no other writing
// of it: PostgreSQL would read upper case and braces as the same identifier.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// What is asked of the database for an identifier that is not one: the nil
// UUID, which the database never issues (a version 4 has a 4 in it). So a
// malformed identifier costs the query an unknown one costs.
const NO_DOCUMENT = '00000000-0000-0000-0000-000000000000';

/**
 * The document with this identifier and the role this user holds on it, in
 * one query. FR-ED-19: the Owner is `Document.ownerId`; every other role is a
 * row of `DocumentCollaborator`, made by an accepted invitation (FR-ED-21).
 */
async function documentAndRole(
  id: string,
  userId: string,
): Promise<{ document: DocumentRow | null; role: DocumentRole | null }> {
  const found = await db().document.findUnique({
    where: { id },
    include: { collaborators: { where: { userId }, select: { role: true } } },
  });
  if (!found) return { document: null, role: null };
  const { collaborators, ...document } = found;
  const held = collaborators[0]?.role;
  const role = document.ownerId === userId ? 'owner' : held ? COLLABORATOR_ROLE[held] : null;
  return { document, role };
}

/**
 * Whether this user may take this action on this document, now.
 *
 * `documentId` is whatever the request gave: anything that is not the
 * identifier of a document the user holds a role on is `not_found`. A deleted
 * document is `not_found` to everyone here (FR-ED-36: deletion "ends every
 * collaborator's access"; the Owner meets it only in the list of deleted
 * documents, which is another route's).
 *
 * The caller has validated the session and passes the session's user, never
 * an identifier taken from the request.
 */
export async function authorise(
  userId: string,
  documentId: unknown,
  permission: Permission,
): Promise<Access> {
  const id = typeof documentId === 'string' && UUID.test(documentId) ? documentId : NO_DOCUMENT;
  // One query whatever the outcome, so that "no such document" and "no access"
  // differ in nothing a caller can measure.
  const { document, role: held } = await documentAndRole(id, userId);
  const role = document && document.deletedAt === null ? held : null;
  if (!document || !role) return { outcome: 'not_found' };
  if (!holds(document.permissionSet, role, permission)) return { outcome: 'forbidden' };
  return { outcome: 'allowed', role, document };
}

/**
 * Whether this user may act on this DELETED document, now: the one decision
 * for the restore of FR-ED-36, as `authorise` is for everything else. A second
 * function and not a flag on the first, so that no caller of `authorise` can
 * be handed a deleted document by a mistake in an argument.
 *
 * FR-ED-36: during the retention "only the Owner can see it", so there is no
 * `forbidden` here: to anyone whose role does not hold `document.delete`,
 * which the table fixes to the Owner and gives to no other role (FR-ED-44), a
 * deleted document is `not_found`, as it is to an account with no role. So is
 * a document that is not deleted, one whose retention has ended (API design:
 * the deleted documents "still within their retention"), and one the timer
 * has claimed for its permanent deletion.
 */
export async function authoriseDeleted(
  userId: string,
  documentId: unknown,
  now: Date = new Date(),
): Promise<Exclude<Access, { outcome: 'forbidden' }>> {
  const id = typeof documentId === 'string' && UUID.test(documentId) ? documentId : NO_DOCUMENT;
  // One query whatever the outcome, as above.
  const { document, role: held } = await documentAndRole(id, userId);
  const role = document && isRetained(document, now) ? held : null;
  if (!document || !role || !holds(document.permissionSet, role, 'document.delete')) {
    return { outcome: 'not_found' };
  }
  return { outcome: 'allowed', role, document };
}

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
// `notFound` answers an action taken from a list (rename, delete, restore),
// where the person typed no address, so it speaks of none; the list is the
// server's, and a reload shows it as it is now. One statement whatever lay
// behind the 404.
const MESSAGES = {
  notFound:
    'No document was found for this account. Reload the list of documents to see the documents that exist.',
  forbidden:
    'The role of this account on the document does not hold the permission for this action. The Owner of the document can give it.',
};

// The owner's decision of 19 October 2026 (register row S16-7): for the two permissions that no one
// can give to the role refused, the statement of a 403 does not say that the Owner can. Changing the
// permission set is the Owner's alone; the one role refused leaving is the Owner.
const FORBIDDEN_FOR: Partial<Record<Permission, string>> = {
  'document.permissions.edit': ONLY_OWNER,
  // The owner's decision of 19 October 2026 (S16-7) names two; this slice adds the third permission that no one can give (S17-11).
  'document.ownership.transfer': ONLY_OWNER,
  // The same, for the deletion that a transfer overtook (register row S17-11).
  'document.delete': ONLY_OWNER,
  'document.leave': OWNER_LEAVE,
};

/**
 * The answer to a request that `authorise` did not allow. One body for every
 * `not_found`, whatever lay behind it. NFR-SE-19: a 403 is written to the
 * security log, with the user and the document and nothing else. `permission`
 * is the one the request asked for, where its statement is its own.
 */
export async function refusal(
  access: Exclude<Access, { outcome: 'allowed' }>,
  userId: string,
  documentId: string,
  permission?: Permission,
): Promise<Response> {
  if (access.outcome === 'not_found') return errorResponse(404, 'not_found', MESSAGES.notFound);
  await securityLog({ kind: 'forbidden', userId, documentId });
  const own = permission === undefined ? undefined : FORBIDDEN_FOR[permission];
  return errorResponse(403, 'forbidden', own ?? MESSAGES.forbidden);
}
