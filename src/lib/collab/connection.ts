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
}

export function recordConnection(
  session: { userId: string; sessionId: string },
  document: { id: string; permissionSet: unknown },
  role: DocumentRole,
): CollabConnection {
  return {
    userId: session.userId,
    documentId: document.id,
    role,
    permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((permission) =>
      holds(document.permissionSet, role, permission),
    ),
    sessionId: session.sessionId,
  };
}

/**
 * NFR-SE-03 (a): "A connection whose role cannot edit is read-only at the
 * protocol level." Decided from what was recorded, so the two cannot differ.
 */
export function isReadOnly(connection: Pick<CollabConnection, 'permissions'>): boolean {
  return !connection.permissions.includes('document.content.edit');
}
