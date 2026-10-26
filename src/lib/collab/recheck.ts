// The decision of the re-check of FR-ED-41: given an open connection and what
// the database now says of its session and of its account's access to its
// document, whether the connection stays, is closed, or is switched in place.
// Pure: the collaboration server (src/collab/server.ts) does the reading, the
// timer, and the closing.
//
// The notice period of a clearing (FR-ED-40 (i); FR-AU-91) is read here through the record: the access
// carries the document's row, `recordConnection` leaves the right to edit out of it while `clearingAt` is set,
// and so the re-check is the backstop of the event, as FR-ED-41 asks. NOT CHECKED, because the column that says
// it does not exist yet: whether the document is export-locked (FR-ED-40 (f); FR-EX-03). It is one more reading
// here, and one more cause for `switch`, when its slice adds the column.
//
// Nothing here is of Next.js.
import type { Access } from '../documents/access.ts';
import { recordConnection, sameList, type CollabConnection } from './connection.ts';
import { REFUSAL } from './protocol.ts';

/** FR-ED-41: the period of the re-check, "at least once every 60 seconds". */
export const RECHECK_MS = 60_000;

/** What the database holds of the session a connection was opened under, with the one fact of its account that matters. */
export interface SessionRow {
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  /**
   * False for an account whose deletion is confirmed (FR-AU-58 (a): from the confirmation every connection
   * it holds is closed), and for the tombstone of one that is complete, which has no address (FR-AU-58 (e)).
   */
  accountStands: boolean;
}

/**
 * FR-ED-41: "the session stands only where the row exists, has not expired
 * under either period of FR-AU-84, and belongs to an account that is not
 * deleted". Written so that a time that cannot be read refuses.
 */
export function sessionStands(
  row: SessionRow | null | undefined,
  userId: string,
  now: number,
  maxMs: number,
): boolean {
  if (!row || row.userId !== userId || !row.accountStands) return false;
  return row.expiresAt.getTime() > now && row.createdAt.getTime() + maxMs > now;
}

export type Decision =
  | { action: 'keep' }
  /** FR-ED-40 (a), (c), (d): the connection is closed, with the reason the client shows. */
  | { action: 'close'; reason: typeof REFUSAL.SESSION_ENDED | typeof REFUSAL.ACCESS_ENDED }
  /** FR-ED-40 (b), (g): the connection stays, with this record, and is read-only or editable as it says. */
  | { action: 'switch'; record: CollabConnection };

/**
 * The session is looked at first, as the handshake looks at it, and then the
 * access: the end of a session closes every connection opened under it, and
 * the client is told so (`session-ended`), whatever else changed.
 */
export function decide(
  open: CollabConnection,
  row: SessionRow | null | undefined,
  access: Access,
  now: number,
  sessionMaxMs: number,
): Decision {
  if (!sessionStands(row, open.userId, now, sessionMaxMs)) {
    return { action: 'close', reason: REFUSAL.SESSION_ENDED };
  }
  // Forbidden is the end of access too: every role holds `document.view` (FR-ED-44), so a role
  // that is refused it is a permission set that was never meant to be.
  if (access.outcome !== 'allowed' || access.document.id !== open.documentId) {
    return { action: 'close', reason: REFUSAL.ACCESS_ENDED };
  }
  const record = recordConnection(
    { userId: open.userId, sessionId: open.sessionId },
    access.document,
    access.role,
  );
  // The record holds what the document's permission set gives the role (`recordConnection` asks
  // `holds` of the set the access carries), so a change of the set with the role unchanged is a
  // switch too (FR-ED-40 (g)).
  // FR-ED-40 (i): the day of a clearing is part of the record too, so that a connection that is read-only
  // already (a Viewer) is still told that the document will be deleted, and told again when it will not.
  const same =
    record.role === open.role &&
    sameList(record.permissions, open.permissions) &&
    record.deletedOn === open.deletedOn;
  return same ? { action: 'keep' } : { action: 'switch', record };
}
