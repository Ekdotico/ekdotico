// The contract of the collaboration connection (API design, "Collaboration
// connection"; FR-AU-08, NFR-SE-03), as far as a client must know it. The
// collaboration server (src/collab/server.ts) and the editor both import this
// module and neither writes any of it a second time.
//
// Nothing here reads a setting, the database, or anything of Next.js or of
// Node.js: it loads in a browser as it is.
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
  /** Reserved for the limit of ten connections (NFR-PE-05, FR-ED-18); not sent yet. */
  CAPACITY: 'capacity',
  /**
   * The account's access to the document has ended (FR-ED-40, FR-ED-41). It is
   * the reason of the close of an open connection, sent so far for one event:
   * the document was deleted (FR-ED-40 (c)). The client does not try again,
   * discards what the server had not acknowledged, leaves the document, and
   * states that access has ended, as no fault (FR-ED-41).
   */
  ACCESS_ENDED: 'access-ended',
  /** Reserved for the end of the session the connection was opened under (NFR-SE-03 (b), (e)); not sent yet. */
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
} as const satisfies Record<Limit, Refusal>;
