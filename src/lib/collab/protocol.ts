// The contract of the collaboration connection (API design, "Collaboration
// connection"; FR-AU-08, NFR-SE-03), as far as a client must know it. The
// collaboration server (src/collab/server.ts) and the editor both import this
// module and neither writes any of it a second time.
//
// Nothing here reads a setting, the database, or anything of Next.js or of
// Node.js: it loads in a browser as it is.
import { ROLES, type DocumentRole } from '../documents/permissions.ts';
import { COLLABORATOR_COLOURS, isSlot } from './presence.ts';
import type { Limit } from './shape.ts';

/**
 * Where the collaboration server is reached, on the application's own origin
 * (FR-AU-08; docs/operations/deployment.md): this path exactly, with no query
 * and no trailing slash. One socket carries every document a page has open.
 */
export const COLLAB_PATH = '/collab';

/**
 * The name of a document on the connection: `Document.id`, a UUID in canonical
 * lower-case text (FR-ED-35), and nothing before or after it.
 */
export function documentName(documentId: string): string {
  return documentId;
}

/** The name of the fragment of the Yjs document that holds the document's content. */
export const FRAGMENT_NAME = 'default';

/**
 * Why the server refused or ended the connection to one document. It arrives
 * as the reason of the refusal of a document's authentication, or of the close
 * of a document's connection; the socket itself stays open for the other
 * documents it carries. A reason that is not listed here is a fault.
 *
 * A handshake that is refused as a whole never becomes a WebSocket: it is
 * answered with an HTTP status (404 another path, 403 another origin or the
 * founding-team gate, 401 no session, 429 the limit of handshakes, 503 the
 * server is stopping), which a browser does not show to a page.
 */
export const REFUSAL = {
  /**
   * The account holds no role on a document of this name, or there is none:
   * the two are one answer (the owner's answer to Q8 of the plan). The client
   * does not try again.
   */
  NO_ACCESS: 'no-access',
  /** The server could not open the document, or is stopping. The client tries again. */
  UNAVAILABLE: 'unavailable',
  /**
   * The account reached the limit of NFR-SE-07, 30 in any minute for each
   * user, against which a handshake counts once and each document opened on
   * the socket once more. The reason carries no time: the client tries again
   * after a pause, never at once, and lengthens the pause each time up to a
   * minute, which is the period of the limit.
   *
   * It is also the reason of the close of an open connection: the account
   * sent this server more than 600 messages that carry an update in a minute,
   * on all its connections together (the owner's decision of 12 October 2026;
   * a row to be added to NFR-SE-07). The message past the limit was not
   * applied. The client does the same about it: it keeps the changes, pauses
   * 5 seconds, asks for the document again, and sends what the server lacks
   * as one message, which is refused in the same way while the minute lasts.
   */
  LIMITED: 'limited',
  /**
   * The document holds its limit of connections (NFR-PE-05, FR-ED-18), and
   * this one was not opened: the reason of the refusal of a document's
   * authentication, sent after the authorisation and before any state of the
   * document. The client shows the fixed statement of FR-ED-18, neither the
   * reconnecting state nor the error state, and asks again no more often than
   * once in 30 seconds.
   */
  CAPACITY: 'capacity',
  /**
   * The account's access to the document has ended (FR-ED-40, FR-ED-41). It is
   * the reason of the close of an open connection, sent for the deletion of
   * the document (FR-ED-40 (c)) and, by the re-check of FR-ED-41, for a role
   * that is gone and a document that is deleted. The client does not try again,
   * discards what the server had not acknowledged, leaves the document, and
   * states that access has ended, as no fault (FR-ED-41).
   */
  ACCESS_ENDED: 'access-ended',
  /**
   * The session the connection was opened under no longer stands (NFR-SE-03
   * (e), FR-ED-41): its row is gone, or expired under either period of
   * FR-AU-84, or its account is deleted. Sent by the re-check, which alone
   * detects an expiry. The client does as for `access-ended`.
   */
  SESSION_ENDED: 'session-ended',
  /**
   * What this client sent would take the document past one of its three
   * limits (src/lib/collab/state.ts): the 5 MB of its state, the 50 levels of
   * its elements, or the 2,000 parts that may wait for content the document
   * was never sent. The owner's decisions of 12 October 2026 (their register
   * rows are pending). Each is the reason of the close of an open connection.
   * Nothing of what was sent was applied, stored, or sent on. The client does
   * not try again, since it would send the same and be refused the same: it
   * keeps the text in the tab, read-only, says which limit, and offers to
   * copy the text before the document is loaded again.
   */
  TOO_LARGE: 'too-large',
  TOO_DEEP: 'too-deep',
  /** The third: the change refers to content the document does not hold, and more of it than may wait. */
  TOO_DANGLING: 'too-dangling',
  /**
   * What this client sent would break a rule of the shape of a document
   * (src/lib/collab/shape.ts), and is refused as a change past a limit is,
   * with the same consequences for the client. `incomplete`: it creates an
   * element without the content the editor's schema requires of it (register
   * D170, D180). `table-bounds`: it takes a table past a bound (D171, D172).
   * The two names are provisional, for the owner's approval.
   */
  INCOMPLETE: 'incomplete',
  TABLE_BOUNDS: 'table-bounds',
  /**
   * A limit of the document (`LIMITS` of src/lib/collab/shape.ts; register
   * D184, D192, D193), refused in the same way: the change would leave the
   * document with more of a block than its limit and more than it had, a list
   * with more items or nested deeper, or a code block longer. One reason for
   * each limit; the names are provisional, for the owner's approval.
   */
  TOO_MANY_TABLES: 'too-many-tables',
  TOO_MANY_CODE_BLOCKS: 'too-many-code-blocks',
  TOO_MANY_CALLOUTS: 'too-many-callouts',
  TOO_MANY_TABLES_OF_CONTENTS: 'too-many-tables-of-contents',
  TOO_MANY_PAGE_BREAKS: 'too-many-page-breaks',
  TOO_MANY_DIVIDERS: 'too-many-dividers',
  TOO_MANY_QUOTES: 'too-many-quotes',
  LIST_TOO_LONG: 'list-too-long',
  LIST_TOO_DEEP: 'list-too-deep',
  CODE_BLOCK_TOO_LARGE: 'code-block-too-large',
  /** The total of 5,000 blocks (D192; the owner's decision of 18 October 2026). */
  TOO_MANY_BLOCKS: 'too-many-blocks',
} as const;

export type Refusal = (typeof REFUSAL)[keyof typeof REFUSAL];

/** The reason for each limit of a document. */
export const LIMIT_REFUSAL = {
  tables: REFUSAL.TOO_MANY_TABLES,
  codeBlocks: REFUSAL.TOO_MANY_CODE_BLOCKS,
  callouts: REFUSAL.TOO_MANY_CALLOUTS,
  tablesOfContents: REFUSAL.TOO_MANY_TABLES_OF_CONTENTS,
  pageBreaks: REFUSAL.TOO_MANY_PAGE_BREAKS,
  dividers: REFUSAL.TOO_MANY_DIVIDERS,
  quotes: REFUSAL.TOO_MANY_QUOTES,
  listItems: REFUSAL.LIST_TOO_LONG,
  listDepth: REFUSAL.LIST_TOO_DEEP,
  codeBytes: REFUSAL.CODE_BLOCK_TOO_LARGE,
  blocks: REFUSAL.TOO_MANY_BLOCKS,
} as const satisfies Record<Limit, Refusal>;

/**
 * FR-ED-40 (b), (g), FR-ED-41: the role of an open connection changed, and
 * the connection stays open. The server sends this as a stateless message
 * (`Connection.sendStateless`); the editor makes itself editable or read-only
 * and says the role. `canEdit` is what the server now holds of the connection:
 * it is read-only at the protocol (NFR-SE-03 (a)) where it is false.
 */
export interface RoleNotice {
  role: DocumentRole;
  canEdit: boolean;
}

export function roleNotice({ role, canEdit }: RoleNotice): string {
  return JSON.stringify({ kind: 'role', role, canEdit });
}

/**
 * FR-ED-40 (g): the permissions of the role of an open connection changed, and
 * the connection stays as it is. The server sends it where the role did not
 * change and the permissions it holds on this document did: a change of role
 * is told by the notice above. The client states that the permissions of the
 * role have changed. It carries the role and nothing of the set.
 */
export interface PermissionsNotice {
  role: DocumentRole;
}

export function permissionsNotice({ role }: PermissionsNotice): string {
  return JSON.stringify({ kind: 'permissions', role });
}

/** The notice of `permissionsNotice`, or null for anything else, read field by field as the role notice is. */
export function readPermissionsNotice(payload: string): PermissionsNotice | null {
  let read: unknown;
  try {
    read = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return null;
  const { kind, role, ...rest } = read as Record<string, unknown>;
  if (kind !== 'permissions' || Object.keys(rest).length > 0) return null;
  return (ROLES as readonly unknown[]).includes(role) ? { role: role as DocumentRole } : null;
}

/**
 * The notice a stateless message holds, or null for anything else: text that
 * is not JSON, another kind, a role that is not one, a field more or fewer.
 * Read field by field. A client sends this server nothing of the kind and no
 * peer is relayed it, so it comes from the server alone.
 */
export function readRoleNotice(payload: string): RoleNotice | null {
  let read: unknown;
  try {
    read = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return null;
  const { kind, role, canEdit, ...rest } = read as Record<string, unknown>;
  if (kind !== 'role' || Object.keys(rest).length > 0 || typeof canEdit !== 'boolean') return null;
  return (ROLES as readonly unknown[]).includes(role) ? { role: role as DocumentRole, canEdit } : null;
}

/**
 * FR-ED-17, the owner's decision of 18 October 2026: who has the document open.
 * The server sends this to each open connection of the document, in its own
 * words, when a connection is made or closed and when one is switched; the
 * editor shows the people present as a row of pictures, Viewers included.
 *
 * It is a stateless message and not a field of awareness (register row PR-4 of
 * docs/plan/presence-row.md): awareness is one state for every peer under the
 * client's own clock, and a role that the server changes cannot be written
 * into it again without racing the client's next update, nor be left out for
 * the one recipient whose permission set hides the people.
 */
export interface Person {
  /** The colour of the person's connection (`--collab-N`), the server's. */
  slot: number;
  /** The server's: the account's name, or the part of its address before the @ (`displayNameOf`). */
  name: string;
  /**
   * The connection's role as the server holds it. Absent for a recipient whose
   * role does not hold `document.collaborators.view`: the sharing page hides
   * the roles of the people from it, and this list does not show what that
   * page hides (register row PR-2).
   */
  role?: DocumentRole;
  /** This is the recipient's own connection. */
  you?: true;
}

/** The longest name a person is read with: a name the account settings accept is far shorter. */
const PERSON_NAME_MOST = 1000;

export function peopleNotice(people: readonly Person[]): string {
  return JSON.stringify({ kind: 'people', people });
}

/**
 * The people of `peopleNotice`, or null for anything else: text that is not
 * JSON, another kind, more people than a document holds connections, and a
 * person with a field more or fewer than these, a slot outside the colour set,
 * a name that is not text or is very long, or a role that is not one. Read
 * field by field, so nothing else a message carries goes further. A client
 * sends this server nothing of the kind and no peer is relayed it.
 */
export function readPeopleNotice(payload: string): Person[] | null {
  let read: unknown;
  try {
    read = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return null;
  const { kind, people, ...rest } = read as Record<string, unknown>;
  if (kind !== 'people' || Object.keys(rest).length > 0) return null;
  if (!Array.isArray(people) || people.length > COLLABORATOR_COLOURS) return null;
  const present: Person[] = [];
  for (const each of people as unknown[]) {
    if (typeof each !== 'object' || each === null || Array.isArray(each)) return null;
    const { slot, name, role, you, ...more } = each as Record<string, unknown>;
    if (Object.keys(more).length > 0 || !isSlot(slot)) return null;
    if (typeof name !== 'string' || name.length > PERSON_NAME_MOST) return null;
    if (role !== undefined && !(ROLES as readonly unknown[]).includes(role)) return null;
    if (you !== undefined && you !== true) return null;
    present.push({
      slot,
      name,
      ...(role === undefined ? {} : { role: role as DocumentRole }),
      ...(you ? { you } : {}),
    });
  }
  return present;
}
