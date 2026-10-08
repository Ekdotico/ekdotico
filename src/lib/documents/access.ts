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
import { holds, type DocumentRole, type Permission } from './permissions.ts';

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
 * FR-ED-19: the role the user holds on the document, or null. The Owner is
 * `Document.ownerId`. The other roles are held through an accepted invitation
 * (FR-ED-21) and join here with the slice that builds sharing.
 */
function roleOf(document: DocumentRow, userId: string): DocumentRole | null {
  return document.ownerId === userId ? 'owner' : null;
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
  const document = await db().document.findUnique({ where: { id } });
  const role = document && document.deletedAt === null ? roleOf(document, userId) : null;
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
  const document = await db().document.findUnique({ where: { id } });
  const role = document && isRetained(document, now) ? roleOf(document, userId) : null;
  if (!document || !role || !holds(document.permissionSet, role, 'document.delete')) {
    return { outcome: 'not_found' };
  }
  return { outcome: 'allowed', role, document };
}

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request).
const MESSAGES = {
  notFound:
    'No document was found at this address for this account. Check the address, or open the list of documents.',
  forbidden:
    'The role of this account on the document does not hold the permission for this action. The Owner of the document can give it.',
};

/**
 * The answer to a request that `authorise` did not allow. One body for every
 * `not_found`, whatever lay behind it. NFR-SE-19: a 403 is written to the
 * security log, with the user and the document and nothing else.
 */
export async function refusal(
  access: Exclude<Access, { outcome: 'allowed' }>,
  userId: string,
  documentId: string,
): Promise<Response> {
  if (access.outcome === 'not_found') return errorResponse(404, 'not_found', MESSAGES.notFound);
  await securityLog({ kind: 'forbidden', userId, documentId });
  return errorResponse(403, 'forbidden', MESSAGES.forbidden);
}
