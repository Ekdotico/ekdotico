// What the collaboration server records for one connection to one document
// (NFR-SE-03 (a)), and what follows from it. The record is the context of the
// connection in the collaboration server; the slices that count connections
// and that end or switch them read it there.
//
// Nothing here reads the database or is of Next.js.
import { holds, PERMISSIONS, type DocumentRole, type Permission } from '../documents/permissions.ts';
/**
 * NFR-SE-03 (a): "the user, the document, the user's document-level role and
 * the permissions that role holds on the document, and the identifier of the
 * session that was presented". Exactly those, as they stood at the handshake.
 */
export interface CollabConnection {
  userId: string;
  /** `Document.id`. */
  documentId: string;
  role: DocumentRole;
  /** Every permission of FR-ED-44 that the role holds on this document. */
  permissions: readonly Permission[];
  /** `Session.id` of the session whose cookie the handshake presented. */
  sessionId: string;
  /**
   * FR-AU-91, FR-ED-40 (i): the day on which a clearing deletes the document (ISO 8601, UTC), or null. While
   * it is set the connection is read-only whatever the role: `permissions` does not hold the right to edit.
   */
  deletedOn: string | null;
}

export function recordConnection(
  session: { userId: string; sessionId: string },
  document: { id: string; permissionSet: unknown; clearingAt: Date | null },
  role: DocumentRole,
): CollabConnection {
  const clearing = document.clearingAt !== null;
  return {
    userId: session.userId,
    documentId: document.id,
    role,
    // FR-ED-40 (i): "every connection to it becomes read-only in place, as under (f), whatever its role, the
    // Owner's included ... While the period lasts, no event of (b) or (g) makes a connection to the document
    // editable". The one place the rule is written: a role raised to Editor, or a permission set changed, is
    // read through here, and cannot give back what the period takes.
    permissions: (Object.keys(PERMISSIONS) as Permission[]).filter(
      (permission) =>
        holds(document.permissionSet, role, permission) &&
        !(clearing && permission === 'document.content.edit'),
    ),
    sessionId: session.sessionId,
    deletedOn: document.clearingAt?.toISOString() ?? null,
  };
}

/** Whether two lists of permissions are the same, in order: `recordConnection` writes them in the order of the table. */
export function sameList(a: readonly Permission[], b: readonly Permission[]): boolean {
  return a.length === b.length && a.every((permission, at) => permission === b[at]);
}

/**
 * NFR-SE-03 (a): "A connection whose role cannot edit is read-only at the
 * protocol level." Decided from what was recorded, so the two cannot differ.
 */
export function isReadOnly(connection: Pick<CollabConnection, 'permissions'>): boolean {
  return !connection.permissions.includes('document.content.edit');
}
