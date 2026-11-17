// The collaboration server process: the Hocuspocus server of FR-ED-15 and
// FR-ED-16, its handshake (FR-AU-08; NFR-SE-03, lead paragraph, (a) and (f);
// NFR-SE-07), and the storing of a document's state (NFR-RE-07).
//
// What a client must know of it is in src/lib/collab/protocol.ts.
//
// HERE of FR-ED-41 (the re-check, `recheck`) and of NFR-PE-05 (the limit of
// connections, `onConnect`; the count is kept in this one instance, register
// D174): every 60 seconds each open connection's session row and access are
// read again, and a connection whose session no longer stands, whose role is
// gone, or whose document is deleted is closed; one whose role changed is
// switched in place. Presence (FR-ED-17) is `beforeHandleAwareness`: what a
// connection may say of itself is its cursor, under the name and the slot that
// this server holds for it (src/lib/collab/presence.ts).
//
// HERE of FR-ED-40 (a), (b), (d), NFR-SE-03 (b) to (d): the removal of a
// collaborator, a leave, a change of role, and the end of a session by
// sign-out, revocation, or a change of the password or address. The web
// application publishes each on the channel of src/lib/collab/events.ts after
// its commit, and the connections it reaches are closed or switched within 5
// seconds (`look`, `recheckOnce` with a scope). There is no second instance
// (NFR-SC-04, withdrawn from α by D168).
//
// HERE of FR-ED-40 (g): a change of a document's permission set. The event
// names the document, `look` reads the rows for every connection to it, and
// `decide` finds what each role holds now (the permission set, and not the
// role alone); a connection whose permissions differ is switched in place and,
// where its role did not change, told with `permissionsNotice`.
//
// HERE of FR-ED-40: event (c), the deletion of a document. Every instance is
// told of it on the channel of src/lib/collab/events.ts, reads the document's
// row, and where the row says so stores what it had received and closes its
// connections to the document (`endDocument`). The channel can lose a
// notice, and the re-check then closes the connection (FR-ED-41): a
// connection whose notice was lost is closed within 60 seconds, and what it
// changed meanwhile is received and never stored. The same holds for every
// other event: the channel is the fast path, and the re-check the guarantee.
import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { Server, type Connection, type Document } from '@hocuspocus/server';
import { messageYjsSyncStep1 } from 'y-protocols/sync';
import { validateSessionRow, type ValidSession } from '../lib/auth/session.ts';
import { isReadOnly, recordConnection, sameList, type CollabConnection } from '../lib/collab/connection.ts';
import {
  subscribeCollabEvents,
  type CollabEvent,
  type CollabEventSubscription,
} from '../lib/collab/events.ts';
import { Places, type Place } from '../lib/collab/places.ts';
import {
  awarenessClients,
  awarenessTooLong,
  AwarenessRate,
  isAwareness,
  isQueryAwareness,
  CONNECTIONS_PER_DOCUMENT,
  displayNameOf,
  pinAwareness,
} from '../lib/collab/presence.ts';
import {
  COLLAB_PATH,
  LIMIT_REFUSAL,
  peopleNotice,
  permissionsNotice,
  REFUSAL,
  roleNotice,
  type Person,
  type Refusal,
} from '../lib/collab/protocol.ts';
import { decide, RECHECK_MS, sessionStands, type SessionRow } from '../lib/collab/recheck.ts';
import { ISOLATION_HEADERS, STATIC_POLICY } from '../lib/csp.ts';
import {
  applyState,
  assertUpdate,
  limitsOf,
  loadState,
  MAX_MESSAGE_BYTES,
  type Limit,
  storeFinalState,
  storeState,
} from '../lib/collab/state.ts';
import { shapeOf, type Shape } from '../lib/collab/shape.ts';
import { db } from '../lib/db.ts';
import { authorise, type Access } from '../lib/documents/access.ts';
import { faultOf } from '../lib/fault.ts';
import { assertContractVersion } from '../lib/istorico/index.ts';
import { isOwnOrigin } from '../lib/origin.ts';
import { limitHere, logLimitReached, markKey, oncePer, takeLimit } from '../lib/rate-limit.ts';
import { securityLog } from '../lib/security-log.ts';
import { collabSettings, refuseSinkAwayFromDevelopment, settings, type Settings } from '../lib/settings.ts';

export const HEALTH_PATH = '/collab/health';

// What every answer over HTTP carries, the health check and each refusal of a
// handshake: none is kept, none is a page, and none is read as anything but
// what it is (src/lib/csp.ts).
const ANSWER_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': STATIC_POLICY,
  'X-Content-Type-Options': 'nosniff',
  ...Object.fromEntries(ISOLATION_HEADERS.map(({ key, value }) => [key, value])),
};

type StoreSettings = Pick<Settings, 'collabStoreDelayMs' | 'collabStoreMaxMs'>;
type ServerSettings = StoreSettings & {
  limits: Pick<Settings['limits'], 'COLLAB_MESSAGES_PER_USER'>;
  /** FR-AU-84: read at the first re-check where it is not given (a test of the health check gives none). */
  sessionMaxSeconds?: number;
  /** FR-ED-41: `COLLAB_RECHECK_MS`, 60 seconds where it is not given. */
  collabRecheckMs?: number;
};

/**
 * What a test may set. The limit of connections is `CONNECTIONS_PER_DOCUMENT`,
 * and a process takes it from nowhere else: it is coupled to the colour set and
 * to the fixed statement of FR-ED-18, which says the number. The period of the
 * re-check is a setting (`COLLAB_RECHECK_MS`, at most the 60 seconds of
 * FR-ED-41), and the option wins over it.
 */
export interface CollabOptions {
  connectionsPerDocument?: number;
  recheckMs?: number;
  /** How long a switch of a connection waits for the messages it has received (`PENDING_WAIT_MS`). */
  pendingWaitMs?: number;
}

/**
 * The context of a connection: the record of NFR-SE-03 (a), and the place it
 * holds on its document (NFR-PE-05), which carries its slot and the name of
 * its cursor (FR-ED-17).
 */
/** `handle` names the record of the socket's handshake (`admitted`), which the end of its session forgets. */
export type CollabContext = CollabConnection & { place: Place; handle: string };

// What the write itself may take and still be inside the period.
const STORE_WRITE_MARGIN_MS = 500;
// A store that failed is tried again after this long, then after twice as
// long each time, and never less often than the last of these; and this many
// times in all, a second apart, once the process is stopping.
const STORE_RETRY_MS = 1000;
const STORE_RETRY_MAX_MS = 60_000;
const STORE_ATTEMPTS_WHEN_STOPPING = 3;
// What the orderly stop may take. The database client bounds each write
// (src/lib/db.ts), but every open document is stored, each up to three times,
// and a platform kills a process that does not stop: better to say so first.
const STOP_DEADLINE_MS = 30_000;
// One entry, and one line, for each of these periods and not for each request
// (see `logRefusedOrigin`).
const LOG_PERIOD_SECONDS = 60;
// How long the deletion of a document is remembered by an instance that was
// told of it (see `endDocument`): longer than the authorisation and the load
// of a handshake can take, each of which the database client bounds at 5
// seconds (src/lib/db.ts).
const ENDED_MEMORY_MS = 15_000;
// And how many are remembered at most. Anything that reaches Valkey can
// publish a notice, for any identifier: without a bound, a flood of them would
// be kept for 15 seconds each. Past the bound the oldest is forgotten early,
// and all that is lost with it is the second look at a handshake that crossed
// its deletion (the `connected` hook).
export const ENDED_MEMORY_MAX = 1000;
// What the two steps of a notice may take, the reading of the row and the
// last store, so that the connections are closed "within 5 seconds of the
// change being committed" (FR-ED-40) where the database is slow to answer.
const NOTICE_READ_MS = 2000;
const FINAL_STORE_MS = 2500;
// What each read of the re-check may take: the database client bounds a query
// at 5 seconds (src/lib/db.ts), and this is the same bound for the whole read.
const RECHECK_READ_MS = 5000;
// How long a socket whose session has ended is given to close after it was ended, before it is destroyed
// (`endSockets`).
const SOCKET_END_MS = 1000;
/**
 * How long a switch of a connection between editable and read-only waits for
 * the messages the connection has already received (F14-2; register row PR-7).
 * FR-ED-40 gives the whole change 5 seconds, and a client that never stops
 * sending would otherwise keep a downgrade from ever taking effect.
 */
export const PENDING_WAIT_MS = 1000;
// The mark of that period for a refused origin, kept as every such mark is (src/lib/rate-limit.ts).
const ORIGIN_REFUSED = 'collab:origin-refused';
// And for an update refused for a limit of its document, one for each document and user.
const documentLimitRefused = (documentId: string, userId: string) =>
  `collab:document-limit-refused:${documentId}:${userId}`;

/** How long after the `failures`-th failure in a row a store is tried again: 1 s, 2 s, 4 s … 60 s. */
export function storeRetryDelay(failures: number): number {
  return Math.min(STORE_RETRY_MS * 2 ** (failures - 1), STORE_RETRY_MAX_MS);
}

/** The Valkey key that marks the period in which a refused origin was logged (see `logRefusedOrigin`). */
export function originRefusalMark(): string {
  return markKey(ORIGIN_REFUSED);
}

/** The Valkey key that marks the period in which a refused update of a document was logged for a user (see `logDocumentLimitRefused`). */
export function documentLimitRefusalMark(documentId: string, userId: string): string {
  return markKey(documentLimitRefused(documentId, userId));
}

/** True once for each period (and each `key`, where there is one), by this process's own clock. */
function oncePerHere(seconds: number): (key?: string) => boolean {
  const last = new Map<string, number>();
  return (key = '') => {
    const now = Date.now();
    if (now - (last.get(key) ?? -Infinity) < seconds * 1000) return false;
    // Forget the keys whose period is over, so that the map holds only this period's.
    for (const [each, at] of last) if (now - at >= seconds * 1000) last.delete(each);
    last.set(key, now);
    return true;
  };
}

/**
 * NFR-RE-07: the state is stored "no later than 2 seconds after the last
 * change it received, and at least every 10 seconds while changes continue".
 * The library's two timers do not mean that by themselves. Its `debounce`
 * starts the write that long after the last change, so the write ends later
 * than that: it is given the period less a margin. Its `maxDebounce` is tested
 * only when a change arrives, so under changes that keep arriving a write
 * starts as late as `maxDebounce` and one `debounce` after the first change
 * that is not yet stored, which itself came as late as one `debounce` after
 * the write before: it is given the period less both.
 */
export function storeTimers({ collabStoreDelayMs, collabStoreMaxMs }: StoreSettings) {
  return {
    debounce: collabStoreDelayMs - STORE_WRITE_MARGIN_MS,
    maxDebounce: collabStoreMaxMs - 2 * collabStoreDelayMs,
  };
}

// NFR-SE-19: the class of a fault and never its message, which can quote a
// row, and so a title or the content of a document.
// `faultOf` (src/lib/fault.ts, on a lower branch) replaces this when it arrives.
function fault(what: string, error: unknown): void {
  console.error(`collab: ${what} failed (${error instanceof Error ? error.name : 'unknown'})`);
}

/** A wait that ran out. No message: the class says it all. */
class TimedOut extends Error {
  name = 'TimedOut';
}

/** What `work` resolves or rejects with, or a rejection once `ms` have passed. The timer keeps no process alive. */
function within<T>(ms: number, work: PromiseLike<T>): Promise<T> {
  const late = wait(ms, undefined, { ref: false }).then(() => {
    throw new TimedOut();
  });
  return Promise.race([work, late]);
}

/** The key of one user's connections to one document, in the scope of a look (`recheckOnce`). Neither part holds a space. */
const pairKey = (documentId: string, userId: string) => `${documentId} ${userId}`;
/** The key of every connection to one document, for a change that is about the document and no one in particular (FR-ED-40 (g)). The prefix holds a space, as `pairKey` does, so that it is no user's identifier. */
const documentKey = (documentId: string) => `document ${documentId}`;
// How many keys wait for the next look before the next look is the whole re-check: anything
// that reaches Valkey can publish an event, so what waits is bounded (`onEvent`).
const LOOK_KEYS_MOST = 1000;

// The library carries on to its own answer unless a hook rejects, and throws
// a rejection on where it carries a value (@hocuspocus/server, Server.ts). A
// hook that has answered rejects with none.
const answered = (): Promise<never> => Promise.reject();

// The library answers the client with the `reason` of what a hook threw, and
// prints the `message` of anything that has one: so never an Error.
const refuse = (reason: Refusal) => ({ reason });

type Refused = { status: number; headers?: Record<string, string> };

// The header under which a handshake's record is found again. The library
// hands a hook the headers of the upgrade request and nothing else of it, so
// the request is given one more, here, after it was parsed: a random handle,
// which overwrites whatever a client sent under the name and names no one.
const HANDLE_HEADER = 'x-ekdotico-handshake';

export function createCollabServer(store: ServerSettings, options: CollabOptions = {}) {
  const messages = store.limits.COLLAB_MESSAGES_PER_USER;
  // NFR-PE-05: the places of every document's connections, in this instance (register D174).
  const places = new Places(options.connectionsPerDocument ?? CONNECTIONS_PER_DOCUMENT);
  // The client identifiers of the awareness message each connection is being handled for (see `beforeHandleMessage`).
  const speaking = new WeakMap<Connection<CollabContext>, ReadonlySet<number>>();
  // S14-5: the awareness messages each connection has sent in the last second (see `beforeHandleMessage`).
  const awarenessRates = new WeakMap<Connection<CollabContext>, AwarenessRate>();
  // The connections whose place is held: those `tellPeople` counts (see `connected`).
  const confirmed = new WeakSet<Connection<CollabContext>>();
  const pendingWaitMs = options.pendingWaitMs ?? PENDING_WAIT_MS;
  // The messages each user has sent this instance (see `beforeSync`).
  const takeMessage = limitHere(messages);
  const messageLogDueHere = oncePerHere(messages.windowSeconds);
  // The session each accepted handshake presented, and its socket, by its handle, for as long
  // as its socket lives or until its session is found ended (`endSockets`).
  const admitted = new Map<string, { session: ValidSession; socket: Duplex }>();
  const sockets = new Set<Duplex>();
  // The documents whose store failed and is being tried again (see `retryStore`).
  const retrying = new Map<string, { skipped: boolean }>();
  // Aborted when the stop begins: it wakes every retry that is waiting.
  const halt = new AbortController();
  const socketFaultDue = oncePerHere(LOG_PERIOD_SECONDS);
  const originLogDueHere = oncePerHere(LOG_PERIOD_SECONDS);
  const documentLimitLogDueHere = oncePerHere(LOG_PERIOD_SECONDS);
  let stopping = false;
  let unstored = false;
  let stopped: Promise<boolean> | undefined;
  // The documents this instance was just told were deleted, each with the time
  // it was told (see `endDocument` and the `connected` hook).
  const ended = new Map<string, number>();
  let events: CollabEventSubscription | undefined;
  // How many changes each document in memory has taken since it was loaded,
  // and how many of them its last store held: where the two differ, this
  // instance holds changes that are stored nowhere.
  const changes = new WeakMap<Document, number>();
  const storedChanges = new WeakMap<Document, number>();
  // What asks the limits of each document in memory (`limitsOf`), made at its first update.
  const keepers = new WeakMap<Document, ReturnType<typeof limitsOf>>();
  // The number of the reading that each connection's last decision rested on, and the last number
  // given (see `recheckOnce`).
  const decided = new WeakMap<Connection<CollabContext>, number>();
  let readings = 0;
  // The keys of the events that are waiting to be looked at, whether the next look is the whole
  // re-check, and whether a look is running (see `onEvent`).
  let waiting = new Set<string>();
  let everything = false;
  let looking = false;

  /** One store, by either of the two of src/lib/collab/state.ts, which notes what it stored. */
  async function storeNow(write: typeof storeState, documentName: string, document: Document) {
    const held = changes.get(document) ?? 0;
    const done = await write(documentName, document);
    if (done) storedChanges.set(document, held);
    return done;
  }

  /**
   * Remembers that a document was deleted, for `ENDED_MEMORY_MS`, and forgets
   * what is older. The map keeps the order in which it was written, which is
   * the order of the times, so what has expired is at its head: each call
   * looks at what it removes and one entry more, and never at the whole map.
   */
  function rememberEnded(documentId: string): void {
    const now = Date.now();
    ended.delete(documentId);
    ended.set(documentId, now);
    for (const [each, at] of ended) {
      if (now - at <= ENDED_MEMORY_MS && ended.size <= ENDED_MEMORY_MAX) break;
      ended.delete(each);
    }
  }

  const sessionMaxMs = () => (store.sessionMaxSeconds ?? settings().sessionMaxSeconds) * 1000;

  /**
   * FR-ED-41: the rows of these sessions, with the one fact of each account that matters, by one
   * query that is given up after `ms`. Read from the table and never through the identity library,
   * whose `getSession` answers from the signed copy in the cookie (NFR-SE-17 (c)).
   */
  async function readSessions(ids: string[], ms: number): Promise<Map<string, SessionRow>> {
    const rows = await within(
      ms,
      db().session.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          userId: true,
          createdAt: true,
          expiresAt: true,
          // FR-ED-41: "an account that is not deleted". FR-AU-58 (a): from the confirmation of
          // its deletion, which is the row of `deletion`, every connection of the account is
          // closed (FR-ED-40 (d)); the tombstone has no address, and that is the same fact once
          // the personal fields are cleared.
          user: { select: { email: true, deletion: { select: { id: true } } } },
        },
      }),
    );
    const sessions = new Map<string, SessionRow>();
    for (const { id, userId, createdAt, expiresAt, user } of rows) {
      sessions.set(id, {
        userId,
        createdAt,
        expiresAt,
        accountStands: user.email !== null && user.deletion === null,
      });
    }
    return sessions;
  }

  /**
   * NFR-SE-03 (f), S-04 of the audit of November 2026: every socket accepted under a session that has
   * ended is ended, and its record forgotten at once, so that nothing more is opened on it. The library
   * closes a document's connection and leaves the WebSocket open, and the record of the handshake would
   * admit the next document the socket asks for.
   *
   * Ended on the next turn and not now, so that what is being written to it (the close of a document's
   * connection, or the refusal the library sends for a hook that threw) goes before it: `end` sends what
   * is buffered and then closes, and a socket whose client does not close it in turn is destroyed.
   */
  function endSockets(sessionId: string): void {
    // Every document the session holds open is closed first, on every socket: `end` closes only the
    // server's side, and a client that does not close its own could write to them until the destroy.
    for (const document of server.hocuspocus.documents.values()) {
      for (const connection of document.getConnections()) {
        if (connection.context.sessionId === sessionId) {
          connection.close({ code: 1000, reason: REFUSAL.SESSION_ENDED });
        }
      }
    }
    for (const [handle, { session, socket }] of admitted) {
      if (session.sessionId !== sessionId) continue;
      admitted.delete(handle);
      setImmediate(() => {
        socket.end();
        setTimeout(() => socket.destroy(), SOCKET_END_MS).unref();
      });
    }
  }

  function closeDocument(documentId: string, reason: Refusal): void {
    const document = server.hocuspocus.documents.get(documentId);
    for (const connection of document?.getConnections() ?? []) {
      connection.close({ code: 1000, reason });
    }
  }

  /**
   * FR-ED-41: the re-check, once. Every open connection's session row and
   * access are read again, and the connection is kept, closed, or switched as
   * `decide` (src/lib/collab/recheck.ts) says.
   *
   * THE SESSION IS READ FROM ITS ROW, by one query for all the sessions the
   * connections were opened under, and never through the identity library:
   * its `getSession` answers from the signed copy in the cookie, for up to a
   * minute after the session ended (NFR-SE-17 (c)). The access is `authorise`,
   * the one function every request asks (NFR-SE-04), once for each user and
   * document.
   *
   * WHERE A READING FAILS the connections it was for are closed `unavailable`
   * (register row S14-3), as the notice of a deletion does where it cannot
   * read the row (`endDocument`): each client keeps its changes, asks again,
   * and its handshake reads the row. Nothing is kept open on what could not
   * be read.
   *
   * WITH A SCOPE it is the look that an event of FR-ED-40 (a), (b), (d) asks
   * for (`onEvent`): the same readings and the same decision, for the open
   * connections the scope names and no others, with each read bounded at the
   * 2 seconds of a notice and the sessions read once, so that a connection is
   * closed or switched "within 5 seconds of the change being committed". The
   * scope holds keys: a user's identifier (every connection of the user), a
   * document's and a user's (`pairKey`), or a document's (`documentKey`: every
   * connection to it, for a change of its permission set).
   *
   * A READING NEVER UNDOES A FRESHER ONE. A run of the timer and a run of an
   * event can overlap. Each reading of access takes its number before it
   * starts, and a connection keeps the number its last decision rested on: a
   * decision made on an earlier reading is dropped. Without this, a reading
   * of "Editor" taken a moment before a downgrade could make the connection
   * editable again after the event had made it read-only.
   */
  async function recheckOnce(scope?: ReadonlySet<string>): Promise<void> {
    const open: { document: Document; connection: Connection<CollabContext> }[] = [];
    for (const document of server.hocuspocus.documents.values()) {
      for (const connection of document.getConnections()) {
        const { userId, documentId } = connection.context;
        if (
          scope &&
          !scope.has(userId) &&
          !scope.has(pairKey(documentId, userId)) &&
          !scope.has(documentKey(documentId))
        ) {
          continue;
        }
        open.push({ document, connection });
      }
    }
    // The sessions to read, with the user each was opened by: those of the open connections, and those of
    // the accepted sockets the scope names, whether or not they carry a document (the review of pull
    // request 74): a socket that carries none, or whose only document is still being opened, would
    // otherwise outlive the end of its session until the next run of the timer.
    const held = new Map<string, string>();
    for (const { session } of admitted.values()) {
      if (!scope || scope.has(session.userId)) held.set(session.sessionId, session.userId);
    }
    for (const { connection } of open) held.set(connection.context.sessionId, connection.context.userId);
    if (held.size === 0) return;
    const readMs = scope ? NOTICE_READ_MS : RECHECK_READ_MS;
    const attempts = scope ? 1 : 2;
    const unreadable = (entries: typeof open) => {
      for (const { connection } of entries) connection.close({ code: 1000, reason: REFUSAL.UNAVAILABLE });
    };

    let sessions: Map<string, SessionRow>;
    const ids = [...held.keys()];
    // Read twice at most before every connection of the run is given up: one query that fails is
    // no reason to drop them all, and an outage fails the second as it failed the first.
    // (Once for an event, which has 5 seconds.)
    for (let attempt = 1; ; attempt++) {
      try {
        sessions = await readSessions(ids, readMs);
        break;
      } catch (error) {
        console.error(`collab: re-check not read for sessions (${faultOf(error)})`);
        if (attempt === attempts || stopping) return unreadable(open);
      }
    }

    // The same user in several tabs of one document is one reading, with the number it was taken under.
    const access = new Map<string, { read: Access | null; reading: number }>();
    const now = Date.now();
    const maxMs = sessionMaxMs();
    // What `decide` is given where the session ended, which it answers before it looks at this.
    const NOT_READ: Access = { outcome: 'not_found' };
    // A session that ended closes its connections before any access is read: the readings below are one
    // after another, and a close that waits behind another pair's reading could pass the 5 seconds.
    // `endSockets` closes them, every one the session holds, and its sockets (S-04 of the audit of
    // November 2026): a socket outlives the connections it carries, and would open the next document it
    // is asked for.
    for (const [sessionId, userId] of held) {
      if (!sessionStands(sessions.get(sessionId), userId, now, maxMs)) endSockets(sessionId);
    }
    const switches: Promise<void>[] = [];
    for (const entry of open) {
      if (stopping) return;
      const { connection } = entry;
      const { userId, documentId, sessionId } = connection.context;
      const row = sessions.get(sessionId);
      let seen: Access | null = NOT_READ;
      let reading = 0;
      // A session that ended closes its connections whatever the access: it is not read.
      if (sessionStands(row, userId, now, maxMs)) {
        const key = pairKey(documentId, userId);
        if (!access.has(key)) {
          // The number first, and then the reading: whatever begins later has a greater one.
          const number = ++readings;
          let read: Access | null = null;
          try {
            read = await within(readMs, authorise(userId, documentId, 'document.view'));
          } catch (error) {
            console.error(`collab: re-check not read for access (${faultOf(error)})`);
          }
          access.set(key, { read, reading: number });
        }
        ({ read: seen, reading } = access.get(key)!);
      }
      // Closed while the readings were made: nothing is done to a connection that is gone.
      if (!entry.document.hasConnection(connection)) continue;
      if (!seen) {
        unreadable([entry]);
        continue;
      }
      const decision = decide(connection.context, row, seen, now, maxMs);
      if (decision.action === 'close') {
        connection.close({ code: 1000, reason: decision.reason });
        continue;
      }
      // A decision that rests on an earlier reading than the last one applied to this connection
      // is dropped, a `keep` too: it says the connection is as it was, which a fresher one may
      // since have changed.
      if ((decided.get(connection) ?? 0) > reading) continue;
      decided.set(connection, reading);
      // Not awaited here: a switch may wait for the connection's messages, and the closes of the
      // other connections of the run must not wait behind it (the 5 seconds of FR-ED-40).
      if (decision.action === 'switch') {
        switches.push(applySwitch(entry.document, connection, decision.record, reading));
      }
    }
    await Promise.all(switches);
  }

  /**
   * Whether the messages this connection has already received have been
   * handled, waiting at most `pendingWaitMs` for them (F14-2; register row PR-7).
   * A client that keeps sending would otherwise keep the switch of its own
   * connection from ever being made.
   */
  async function settled(connection: Connection<CollabContext>): Promise<boolean> {
    try {
      await within(pendingWaitMs, connection.waitForPendingMessages());
      return true;
    } catch (error) {
      if (!(error instanceof TimedOut)) console.error(`collab: messages not awaited (${faultOf(error)})`);
      return false;
    }
  }

  /**
   * FR-ED-40 (b), (g): the connection stays open with the record of the role it
   * holds now, and is read-only or editable in place as that record says. The
   * library reads the flag at each message it applies, after the hook that
   * checks an update (`beforeSync`), and a read-only connection's updates are
   * not checked. So a connection changes between the two only between its
   * messages, and nothing is awaited from the last wait to the flag.
   *
   * - Made editable: after the messages it has received, so that none that
   *   was not checked is applied. Where they have not been handled within
   *   `pendingWaitMs` it is not made editable: it waits for the next look,
   *   which is the next event that names the connection or, at the latest, the
   *   next re-check (up to 60 seconds, FR-ED-41).
   * - Made read-only (F14-2): after the messages it has received too, so that
   *   what the server had received while the person was an Editor is kept, as
   *   a document that merged it before the change. The wait is for the
   *   connection's queue to empty, so a message that arrives during it is
   *   handled too, as the old role, up to the bound. Where the queue has not
   *   emptied within `pendingWaitMs` it is made read-only all the same: the
   *   downgrade takes effect, and what still waits is discarded. After the
   *   flag turns the library applies nothing the connection sends.
   *
   * THE BUDGET of FR-ED-40's 5 seconds, for a change that an event announces:
   * the sessions are read for at most 2 seconds, the access for at most 2, and
   * this wait for at most 1 (`pendingWaitMs`). They add to 5, so a slow database
   * and a connection that never stops sending together use all of it.
   */
  async function applySwitch(
    document: Document,
    connection: Connection<CollabContext>,
    record: CollabConnection,
    reading: number,
  ): Promise<void> {
    const readOnly = isReadOnly(record);
    if (readOnly !== connection.readOnly) {
      const handled = await settled(connection);
      // Closed while it waited: nothing is done to a connection that is gone.
      if (!document.hasConnection(connection)) return;
      // A fresher decision was applied while this one waited for the messages in flight.
      if (decided.get(connection) !== reading) return;
      if (!handled && !readOnly) {
        console.error('collab: an upgrade waits for the next look: the connection still holds messages');
        return;
      }
      if (!handled) console.error('collab: a downgrade did not wait for all the messages it had received');
    }
    const { role: was, permissions: held, deletedOn: day } = connection.context;
    const changed = readOnly !== connection.readOnly;
    Object.assign(connection.context, {
      role: record.role,
      permissions: record.permissions,
      deletedOn: record.deletedOn,
    });
    connection.readOnly = readOnly;
    // FR-ED-40 (i): the day of a clearing is told as a role is: a connection that was read-only already
    // (a Viewer) still learns that the document will be deleted, and that it will not be.
    if (changed || record.role !== was || record.deletedOn !== day) {
      connection.sendStateless(
        roleNotice({
          role: record.role,
          canEdit: !readOnly,
          ...(record.deletedOn === null ? {} : { deletedOn: record.deletedOn }),
        }),
      );
    } else if (!sameList(held, record.permissions)) {
      // FR-ED-40 (g): the role is the same and what it holds on this document is not. The
      // connection stays open and stays as editable as it was: that is fixed by role.
      connection.sendStateless(permissionsNotice({ role: record.role }));
    }
    tellPeople(document);
  }

  /**
   * FR-ED-17, the owner's decision of 18 October 2026: tells every open
   * connection of the document who has it open (`peopleNotice` of
   * src/lib/collab/protocol.ts). Each is sent its own list: its own entry is
   * marked, and the roles are left out for a connection whose role does not
   * hold `document.collaborators.view` (register row PR-2). Name, slot and role
   * are the server's, read from the connections' records and places.
   */
  function tellPeople(document: Document): void {
    if (stopping) return;
    try {
      // Only a connection whose place is held (the `connected` hook has run): one that is still being
      // made has no place of its own yet, and may be closed at once if its place expired meanwhile.
      const present = (document.getConnections() as Connection<CollabContext>[])
        .filter((each) => confirmed.has(each))
        .sort((a, b) => a.context.place.slot - b.context.place.slot);
      for (const to of present) {
        const mayKnow = to.context.permissions.includes('document.collaborators.view');
        const people: Person[] = present.map(({ context }) => ({
          slot: context.place.slot,
          name: context.place.name,
          ...(mayKnow ? { role: context.role } : {}),
          ...(context === to.context ? { you: true as const } : {}),
        }));
        to.sendStateless(peopleNotice(people));
      }
    } catch (error) {
      console.error(`collab: people not told (${faultOf(error)})`);
    }
  }

  let rechecking = false;
  /**
   * One run at a time: where a run outlasts its period (a slow database), the
   * next period's does not start, and none piles up behind it. It never
   * rejects.
   */
  async function recheck(): Promise<void> {
    if (stopping || rechecking) return;
    rechecking = true;
    try {
      await recheckOnce();
    } catch (error) {
      console.error(`collab: re-check failed (${faultOf(error)})`);
    } finally {
      rechecking = false;
    }
  }

  /**
   * FR-ED-40 (c), NFR-SE-03 (b): a notice says the document was deleted.
   *
   * THE ROW DECIDES, and not the notice. Anything that reaches Valkey can
   * publish one for a document that is live, and a genuine one can arrive
   * after the Owner restored the document; a client that is closed with
   * `access-ended` does not come back (FR-ED-41). So the row is read, one
   * query by its identifier, and only where it is deleted, or is not there at
   * all, is anything done. Otherwise nothing is done and nothing is printed.
   * Where the row cannot be read, the connections are closed as `unavailable`:
   * each client tries again, and its handshake reads the row.
   *
   * THE LAST STORE. FR-ED-41: "Changes already merged into the document before
   * the close remain"; FR-ED-36: a restore returns the document as it was at
   * deletion. A change this instance received in the 2 seconds before the
   * deletion, or the 10 under changes that kept arriving (NFR-RE-07), is not
   * stored yet, and `storeState` writes nothing to a deleted document. So what
   * is held is stored here, once, by the store whose condition is that the row
   * exists (`storeFinalState`), before the connections are closed. Only where
   * this instance holds a change it has not stored: one that holds none would
   * write an older state over what another instance had just stored.
   *
   * Nothing a client sends can arrive between that store and the close. Every
   * connection is made read-only, and the state is encoded, in one step with
   * nothing awaited between them: an update the library had applied is in the
   * state, and one it has yet to apply meets a read-only connection, on which
   * the library applies nothing and acknowledges nothing (it tests the flag in
   * the same step as it applies). A connection made after that step, by a
   * handshake that crossed the deletion, can still change the document in
   * memory: nothing stores it, and the `connected` hook closes it.
   *
   * Where the last store fails, the connections are closed all the same, one
   * line says so, and what is lost is what this instance had not yet stored:
   * the stored state stays as the last store before the deletion left it.
   *
   * After the close nothing is stored: the library runs the store that was
   * waiting when the last connection goes, and `storeState` leaves a deleted
   * document alone.
   *
   * A handshake for the document that was authorised a moment before the
   * deletion was committed has no connection yet, and would gain one a moment
   * after this ran. So the deletion is remembered for a while, and such a
   * connection is asked again when it is made (the `connected` hook).
   */
  async function endDocument(documentId: string): Promise<void> {
    let row;
    try {
      row = await within(
        NOTICE_READ_MS,
        db().document.findUnique({ where: { id: documentId }, select: { deletedAt: true } }),
      );
    } catch (error) {
      console.error(`collab: document ${documentId} not read for a notice (${faultOf(error)})`);
      closeDocument(documentId, REFUSAL.UNAVAILABLE);
      return;
    }
    // Live: forged, or restored since. Stopping: the stop stores and closes everything itself.
    if ((row && row.deletedAt === null) || stopping) return;

    rememberEnded(documentId);
    const document = server.hocuspocus.documents.get(documentId);
    if (!document) return;
    for (const connection of document.getConnections()) connection.readOnly = true;
    if ((changes.get(document) ?? 0) !== (storedChanges.get(document) ?? 0)) {
      try {
        // Its state is encoded as it is called, before anything is awaited.
        await within(FINAL_STORE_MS, storeNow(storeFinalState, documentId, document));
      } catch (error) {
        console.error(`collab: last store of document ${documentId} failed (${faultOf(error)})`);
      }
    }
    // The reason is the only thing that tells the client why: the library
    // closes with one code always (src/lib/collab/protocol.ts).
    closeDocument(documentId, REFUSAL.ACCESS_ENDED);
  }

  /**
   * FR-ED-40 (a), (b), (d), (g): an event says that the access of a user to one
   * document, or the session of a user, or the permission set of a document,
   * changed. THE ROWS DECIDE, as for the
   * deletion of a document: the event names only whom to look at, and the look
   * is the re-check's own, for the connections it names (`recheckOnce`). So an
   * event that is forged, late, or for no one here changes nothing that the
   * rows do not.
   *
   * One look at a time. Events that come while one runs wait as keys, and are
   * looked at together by the next; past `LOOK_KEYS_MOST` of them the next look
   * is the whole re-check. A flood of events therefore costs one look more, and
   * never a look for each.
   */
  async function look(key: string): Promise<void> {
    if (waiting.size >= LOOK_KEYS_MOST) {
      // One line when the bound is first met, naming no one: the next look is the whole re-check.
      if (!everything)
        console.error(`collab: ${LOOK_KEYS_MOST} notices wait, the next look is the whole re-check`);
      everything = true;
    } else waiting.add(key);
    if (looking) return;
    looking = true;
    try {
      while (!stopping && (everything || waiting.size > 0)) {
        const scope = everything ? undefined : waiting;
        waiting = new Set();
        everything = false;
        try {
          await recheckOnce(scope);
        } catch (error) {
          console.error(`collab: look at an event failed (${faultOf(error)})`);
        }
      }
    } finally {
      looking = false;
    }
  }

  /** What this instance does for each event of the channel: one case for each kind of FR-ED-40 that is built. */
  async function onEvent(event: CollabEvent): Promise<void> {
    if (stopping) return;
    if (event.kind === 'document-deleted') await endDocument(event.documentId);
    else if (event.kind === 'collaborator-changed') await look(pairKey(event.documentId, event.userId));
    else if (event.kind === 'permission-set-changed' || event.kind === 'clearing-changed')
      await look(documentKey(event.documentId));
    else await look(event.userId);
  }

  /**
   * NFR-SE-19 asks for an entry for "a 403 response". This 403 is answered
   * before any session is read and before any limit, to anyone who can reach
   * the port, so an entry for each would let a flood write to the database
   * without bound. It is read as the limits and a signature that does not
   * verify are read: one entry for each minute in which a handshake was
   * refused for its origin (the owner has been asked to confirm that reading
   * for the three). An entry holds no detail, so nothing is lost but the count.
   *
   * The mark is in Valkey, so that it holds across instances. Without Valkey
   * the entry is still written, a log too full and never one too empty, but
   * the bound holds: one for each period from this process. It never rejects,
   * and the refusal does not wait for it.
   */
  async function logRefusedOrigin(): Promise<void> {
    let first: boolean;
    try {
      first = await oncePer(ORIGIN_REFUSED, LOG_PERIOD_SECONDS);
    } catch {
      first = originLogDueHere();
    }
    if (first) await securityLog({ kind: 'forbidden' });
  }

  /**
   * NFR-SE-19, as the owner amended it on 12 October 2026: an entry for an
   * update refused for a limit of its document, with the user and the
   * document and nothing of the update. A client whose connection is closed
   * can reconnect and send it again, so one entry for each period for a
   * document and a user and not one for each refusal, as for a refused origin
   * (`logRefusedOrigin`): the same fallback without Valkey, the entry written
   * and the bound held by this process. It never rejects, and the refusal does
   * not wait for it.
   */
  async function logDocumentLimitRefused(userId: string, documentId: string): Promise<void> {
    let first: boolean;
    try {
      first = await oncePer(documentLimitRefused(documentId, userId), LOG_PERIOD_SECONDS);
    } catch {
      first = documentLimitLogDueHere(`${documentId}:${userId}`);
    }
    if (first) await securityLog({ kind: 'document_limit_refused', userId, documentId });
  }

  /**
   * NFR-SE-19: the entry for the limit of messages reached, with the user. One
   * for each period of the limit and each user, whatever number of connections
   * is closed in it, as for every limit (`logLimitReached`); and, as for a
   * refused update (`logDocumentLimitRefused`), written without Valkey too,
   * the bound held by this process. It never rejects, and the refusal does not
   * wait for it.
   */
  async function logMessageLimitReached(userId: string): Promise<void> {
    try {
      await logLimitReached('COLLAB_MESSAGES_PER_USER', userId, messages.windowSeconds, userId);
    } catch {
      // Valkey did not answer for the mark: nothing was written.
      if (messageLogDueHere(userId)) await securityLog({ kind: 'rate_limit_reached', userId });
    }
  }

  /**
   * The handshake (FR-AU-08; API design, "Collaboration connection"), in its
   * order. Each refusal is an HTTP status on the upgrade request: no
   * WebSocket exists until every check has passed.
   */
  async function admit(request: IncomingMessage): Promise<ValidSession | Refused> {
    if (stopping) return { status: 503 };
    // (a) The one path, exactly (src/lib/collab/protocol.ts).
    if (request.url !== COLLAB_PATH) return { status: 404 };

    // (b) FR-AU-08: "It refuses, before it reads the cookie, a handshake whose
    // `Origin` header is not on the allow-list of NFR-SE-17 (c)". NFR-SE-19: a
    // 403 is logged, once for each period; there is no user to name yet.
    if (!isOwnOrigin(request.headers.origin)) {
      void logRefusedOrigin();
      return { status: 403 };
    }

    // (c) The session, by its row and never by the copy in a cookie
    // (NFR-SE-03 (e), NFR-SE-17 (c), (f)). Nothing of the request but the
    // cookie is handed on. For an account that the founding-team gate stops
    // the validation gives no session and says whose it would be (`stopped`):
    // it is no 401. It goes on to its limit and is refused at (e), so that the
    // order of the answers stays as it is written here.
    const { session, stopped } = await validateSessionRow(
      new Headers({ cookie: request.headers.cookie ?? '' }),
    );
    const held = session ?? stopped;
    if (!held) return { status: 401 };
    const { userId } = held;

    // (d) NFR-SE-07: handshakes, for each authenticated user. After the origin
    // check, so that a page on another origin cannot spend a user's limit.
    const limit = await takeLimit('HANDSHAKES_PER_USER', userId);
    if (!limit.ok) {
      await logLimitReached('HANDSHAKES_PER_USER', userId, limit.retryAfterSeconds, userId);
      return { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } };
    }

    // (e) FR-AU-83: an account of the founding team without two-factor
    // authentication reaches no collaboration handshake. The gate is the one
    // of the session validation (src/lib/auth/session.ts), which read the
    // account's row at (c) for this handshake; the list is the process's own
    // setting. Nothing but a session that the gate let through is returned.
    if (!session) {
      await securityLog({ kind: 'forbidden', userId });
      return { status: 403 };
    }
    return session;
  }

  const server = new Server<CollabContext>({
    ...storeTimers(store),
    quiet: true,
    // Stopping is this file's own: see `stop`.
    stopOnSignals: false,
    // Handed to the socket library as they are (@hocuspocus/server 4.7.0,
    // Server.ts: `serverOptions` of crossws, which are those of `ws`). A
    // message longer than this is never read to its end: the socket is closed
    // with the code 1009.
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES },

    async onRequest({ request, response }) {
      // NFR-SE-05 (c): reports whether the service is up and returns nothing
      // else. It checks no dependency (plan, C20) but one, by the owner's
      // amendment of 8 October 2026: an instance that is not subscribed to
      // the channel of deletions cannot be told to close a connection
      // (FR-ED-40), and is not up. Nothing is asked of Valkey or of the
      // database for the answer: it is what the subscription last said.
      const health = request.method === 'GET' && request.url === HEALTH_PATH;
      const status = !health ? 404 : events?.isSubscribed() ? 200 : 503;
      response.writeHead(status, ANSWER_HEADERS).end();
      return answered();
    },

    async onUpgrade({ request, socket }: { request: IncomingMessage; socket: Duplex }) {
      // FIRST, before anything is awaited. Node takes its own listener off the
      // socket before it emits 'upgrade', and an 'error' with no listener ends
      // the process: a client that resets the connection while the checks run,
      // or that has gone when the refusal is written, would stop the server
      // for everyone, with nothing stored (NFR-RE-07). A client that goes away
      // is no fault of the server's: one line for each period, however many.
      socket.on('error', (error) => {
        if (socketFaultDue()) fault('socket', error);
      });
      let outcome: ValidSession | Refused;
      try {
        outcome = await admit(request);
      } catch (error) {
        // NFR-SE-06, A10: where the database or Valkey cannot answer, the
        // handshake is refused, and the answer says nothing of the fault.
        fault('handshake', error);
        outcome = { status: 500 };
      }
      // The socket ended while the checks ran: nothing is answered and nothing
      // is recorded. Its 'close' has been emitted or is about to be, and a
      // listener added now might never be called, so the record of the
      // handshake would outlive its socket. Nothing is awaited from here to
      // the listener below, so a socket that passes this has not closed.
      if (socket.destroyed) return answered();
      if ('status' in outcome) {
        const head = [
          `HTTP/1.1 ${outcome.status} ${STATUS_CODES[outcome.status]}`,
          'Connection: close',
          'Content-Length: 0',
          ...Object.entries({ ...ANSWER_HEADERS, ...outcome.headers }).map(
            ([name, value]) => `${name}: ${value}`,
          ),
        ];
        socket.end(`${head.join('\r\n')}\r\n\r\n`, () => socket.destroy());
        return answered();
      }
      // (f) Accepted: the library makes the WebSocket when this returns.
      const handle = randomUUID();
      request.headers[HANDLE_HEADER] = handle;
      admitted.set(handle, { session: outcome, socket });
      sockets.add(socket);
      socket.once('close', () => {
        admitted.delete(handle);
        sockets.delete(socket);
      });
    },

    /**
     * Runs for EVERY document a socket opens, before anything of the document
     * is read or sent: a socket carries several documents, and the name of
     * each is in its messages, so nothing about a document was decided at the
     * handshake. What it returns becomes the context of the connection.
     */
    async onConnect({ documentName, requestHeaders, connectionConfig }) {
      const handle = requestHeaders.get(HANDLE_HEADER) ?? '';
      const session = admitted.get(handle)?.session;
      // No record of a handshake, or the process is stopping: nothing is opened.
      if (!session || stopping) throw refuse(REFUSAL.UNAVAILABLE);
      // Whether the record still stands after an await: the end of the session, found by the re-check or
      // an event while this ran, forgets it (`endSockets`), and nothing is then opened on the socket.
      const stands = () => {
        if (!admitted.has(handle)) throw refuse(REFUSAL.SESSION_ENDED);
      };

      // NFR-SE-07, "Collaboration handshakes, for each authenticated user":
      // opening a document is the handshake of that document, and costs what
      // the limit is there to bound, a query and perhaps an entry in the log.
      // So it is counted against the same limit as the upgrade, which leaves a
      // page that opens one document on one socket 15 loads in a minute. The
      // library bounds only the documents of one socket that are waiting for
      // this answer at one moment (100, then it closes the socket), never how
      // many are opened one after another.
      let limit;
      try {
        limit = await takeLimit('HANDSHAKES_PER_USER', session.userId);
        if (!limit.ok) {
          await logLimitReached(
            'HANDSHAKES_PER_USER',
            session.userId,
            limit.retryAfterSeconds,
            session.userId,
          );
        }
      } catch (error) {
        // NFR-SE-06, A10: without Valkey nothing is opened.
        fault('limit', error);
        throw refuse(REFUSAL.UNAVAILABLE);
      }
      if (!limit.ok) throw refuse(REFUSAL.LIMITED);

      // NFR-SE-03 (e), (f), S-04 of the audit of November 2026: the session is read from its row again,
      // as at the upgrade, for every document. The record of the handshake says only which session the
      // socket was accepted under, not that it stands: it may have been signed out, revoked by a change
      // of the password, or have expired since. Where it has ended every socket accepted under it is
      // ended, and nothing more is opened on them. AFTER THE LIMIT, unlike the upgrade (the review of
      // pull request 74): an open costs a client a few bytes on a socket it holds, not a new connection,
      // so an open past the limit must cost no query. A session that has ended spends one unit, once:
      // its socket is ended with it.
      let row: SessionRow | undefined;
      try {
        row = (await readSessions([session.sessionId], RECHECK_READ_MS)).get(session.sessionId);
      } catch (error) {
        // NFR-SE-06, A10: without the database nothing is opened.
        fault('session', error);
        throw refuse(REFUSAL.UNAVAILABLE);
      }
      if (!sessionStands(row, session.userId, Date.now(), sessionMaxMs())) {
        endSockets(session.sessionId);
        throw refuse(REFUSAL.SESSION_ENDED);
      }
      stands();

      let access;
      try {
        // (g) NFR-SE-04, FR-ED-39: the one function every route asks.
        access = await authorise(session.userId, documentName, 'document.view');
      } catch (error) {
        fault('authorisation', error);
        throw refuse(REFUSAL.UNAVAILABLE);
      }
      if (access.outcome !== 'allowed') {
        // NFR-SE-19: the refusal of a role that lacks the permission is a 403
        // of a route, and is logged as one. No document and no role are one
        // answer to the client either way (the answer to Q8).
        if (access.outcome === 'forbidden') {
          await securityLog({ kind: 'forbidden', userId: session.userId, documentId: documentName });
        }
        throw refuse(REFUSAL.NO_ACCESS);
      }
      // (h) NFR-PE-05, FR-ED-18: the place on the document, after the
      // authorisation, so that an account with no role is told nothing of how
      // full a document is (it was refused above, as for a document that does
      // not exist), and before the load, so that nothing of the document is
      // sent to a connection that is refused. `reserve` counts and takes in one
      // step with nothing awaited between: handshakes that run side by side
      // cannot pass the limit between them. `access.document.id` is the name,
      // which `authorise` admits only where it is a document's own identifier.
      stands();
      const place = places.reserve(access.document.id);
      if (!place) throw refuse(REFUSAL.CAPACITY);
      try {
        // FR-ED-17: the name of the cursor is the account's, read here and
        // never taken from the client.
        const account = await db().user.findUnique({
          where: { id: session.userId },
          select: { name: true, email: true },
        });
        place.name = displayNameOf({ name: account?.name ?? null, email: account?.email ?? null });
      } catch (error) {
        places.release(place);
        fault('account', error);
        throw refuse(REFUSAL.UNAVAILABLE);
      }
      // The record is asked once more, after the last await: nothing is awaited from here to the return.
      if (!admitted.has(handle)) {
        places.release(place);
        throw refuse(REFUSAL.SESSION_ENDED);
      }
      // (i) NFR-SE-03 (a): what is recorded for the connection.
      const connection = recordConnection(session, access.document, access.role);
      // (j) The library discards every update it receives on a read-only connection.
      connectionConfig.readOnly = isReadOnly(connection);
      return { ...connection, place, handle };
    },

    /**
     * Runs when the connection to a document has been made. Where this
     * instance was told of the document's deletion in the last moments, the
     * authorisation that admitted the connection may be older than the
     * deletion (see `endDocument`): it is asked again, and a connection that
     * would not be admitted now is closed. Asked, and not closed outright,
     * because the Owner may have restored the document since.
     *
     * WHAT SUCH A CONNECTION RECEIVED FIRST. The library answers the messages
     * that were waiting before it calls this hook, so the connection has been
     * sent the state of the document, as the last store left it, and is then
     * closed. That is recorded and not closed off, and is no disclosure: the
     * account held the role when its handshake was authorised, the state is
     * what a handshake a moment earlier would have been sent, and the
     * connection is closed inside the 5 seconds FR-ED-40 gives every instance.
     * Refusing the state would take a second authorisation of every
     * connection, deleted document or not, before its first message. What
     * the connection sends meanwhile changes the copy in memory and is stored
     * by nothing (`storeState`).
     */
    async connected({ documentName, context, connection }) {
      // NFR-PE-05: the place becomes the connection's, and is given back the
      // moment the connection closes, by whatever closes it: a callback on the
      // connection itself, which runs inside `close()`, and not the library's
      // `onDisconnect`, which runs only after the messages being processed.
      // (`onDisconnect` gives it back too, for a connection that was closed
      // before this hook ran.)
      // Closed before this hook ran (the socket went while the document loaded): `onDisconnect`
      // gives its place back, and there is no connection to hold it for.
      if (!connection.document.hasConnection(connection)) return;
      // The session ended after `onConnect` returned, while the library made the connection (`beforeHandleMessage`).
      if (!admitted.has(context.handle)) {
        connection.close({ code: 1000, reason: REFUSAL.SESSION_ENDED });
        return;
      }
      if (!places.hold(context.place)) {
        // Its place expired while it was made, and was taken by another: it
        // has none, and the client asks again.
        connection.close({ code: 1000, reason: REFUSAL.UNAVAILABLE });
        return;
      }
      confirmed.add(connection);
      connection.onClose((document) => {
        places.release(context.place);
        // The others are told that this connection is gone (FR-ED-17).
        tellPeople(document);
      });
      // FR-ED-40 (b), FR-ED-41: the role of this connection, told at every
      // connection and not only at a change. A client that was away while its
      // role changed learns it here (its scope says whether it may edit, and
      // this says in which role); one that was not takes it for what it knows.
      connection.sendStateless(
        roleNotice({
          role: context.role,
          canEdit: !isReadOnly(context),
          ...(context.deletedOn === null ? {} : { deletedOn: context.deletedOn }),
        }),
      );
      // And who is present, the new connection among them (FR-ED-17).
      tellPeople(connection.document);
      const at = ended.get(documentName);
      if (at === undefined || Date.now() - at > ENDED_MEMORY_MS) return;
      let reason: Refusal | undefined;
      try {
        const access = await authorise(context.userId, documentName, 'document.view');
        if (access.outcome !== 'allowed') reason = REFUSAL.ACCESS_ENDED;
      } catch (error) {
        fault('authorisation', error);
        reason = REFUSAL.UNAVAILABLE;
      }
      if (reason) connection.close({ code: 1000, reason });
    },

    /**
     * A load that fails opens nothing: the client is answered `unavailable`
     * and may try again, the process goes on, and stderr says which of the
     * two failed, by the class of the fault alone (NFR-SE-19).
     *
     * A stored state that cannot be applied fails every time it is tried: the
     * document can be opened by no one until an administrator repairs or
     * clears `Document.yjsState`, or restores it from a backup. Nothing is
     * built for that. `storeState` and `assertUpdate` are what keeps such a
     * state from being written (src/lib/collab/state.ts).
     */
    async onLoadDocument({ documentName, document, context }) {
      let step = 'load';
      try {
        const state = await loadState(documentName);
        // Not where the stop began while the query ran: the connections were
        // closed before this document had one, so it would gain one that
        // nothing closes, and the stop would wait for it for ever.
        if (!stopping) {
          step = 'stored state';
          if (state) applyState(document, state);
          // Counted from here: what was loaded is stored already (see `endDocument`).
          document.on('update', () => changes.set(document, (changes.get(document) ?? 0) + 1));
          return;
        }
      } catch (error) {
        fault(step, error);
      }
      // The library drops a document that did not load without destroying it,
      // and a document that is not destroyed keeps its timer, and so itself,
      // for as long as the process runs.
      document.destroy();
      // NFR-PE-05: no connection will be made, so nothing else gives the place back. The
      // handshakes that were waiting for the same load fail with it, and the library calls this
      // hook for one of them: the places of the others would count until they expire.
      places.dropPending(documentName);
      places.release(context.place);
      throw refuse(REFUSAL.UNAVAILABLE);
    },

    /**
     * NFR-PE-05: the second way a place is given back (see `connected`): for a
     * connection that closed before that hook ran, and where the first did not.
     */
    async onDisconnect({ context }) {
      places.release(context.place);
    },

    /**
     * FR-ED-17: what a connection may say of itself, which is its cursor, and
     * nothing else (src/lib/collab/presence.ts, `pinAwareness`). The library
     * takes awareness from a connection of any role, a read-only one too, and
     * sends it as it is to every other: without this a Viewer could show the
     * others any name, any colour, and a state for any client. A change made
     * by the server itself has no connection and is left as it is.
     */
    async beforeHandleAwareness({ states, document, connection, context }) {
      if (!connection || !context) return;
      // What the message speaks for, as `beforeHandleMessage` read it from the
      // message itself. The map holds one more state: the library's scratch
      // `Awareness` has one of its own, for an identifier that is no one's.
      const spoken = speaking.get(connection) ?? new Set<number>();
      for (const id of [...states.keys()]) if (!spoken.has(id)) states.delete(id);
      const others = new Set<number>();
      for (const each of document.getConnections()) {
        if (each !== connection) for (const id of document.getClients(each)) others.add(id);
      }
      pinAwareness(states, {
        own: document.getClients(connection),
        others,
        who: { name: context.place.name, slot: context.place.slot },
      });
    },

    /**
     * Awareness longer than a state can be closes the connection, before the
     * library decodes it (`AWARENESS_MAX_BYTES`). An object with no message,
     * as in `beforeSync`: what is closed with it is not the client's to read.
     */
    async beforeHandleMessage({ update, connection, context }) {
      // NFR-SE-03 (f), B1 of the second review of pull request 74: nothing more is taken on a socket whose
      // session has ended (`endSockets`). Here, and not only in `connected`: the library made the connection
      // after `onConnect` and applies what the client sent meanwhile before that hook, through this one.
      if (!admitted.has(context.handle)) throw refuse(REFUSAL.SESSION_ENDED);
      if (awarenessTooLong(update)) throw {};
      // The identifiers of an awareness message are noted for `beforeHandleAwareness`, which
      // runs for this same message: the connection's messages are handled one at a time.
      // An awareness message that does not read to its end speaks for no one (the library may
      // still decode it): the set of the message before is never the set of this one.
      const asks = isQueryAwareness(update);
      if (!asks && !isAwareness(update)) return;
      // S14-5: a message past the limit of the connection speaks for no one either, so that
      // `beforeHandleAwareness` takes every state out of it and nothing goes on to any peer. It is
      // dropped and the connection is kept: the library offers no way to refuse one message but
      // by closing the connection, and a client that moves its cursor fast has done no wrong.
      let rate = awarenessRates.get(connection);
      if (!rate) awarenessRates.set(connection, (rate = new AwarenessRate()));
      const within = rate.take();
      // A request for everyone's awareness counts under the same limit, and the library can no more
      // drop one: it builds the answer of every state for each. The client of this application
      // sends none, so a connection past the limit with these is closed, and not one that moves its cursor.
      if (asks) {
        if (!within) throw {};
        return;
      }
      speaking.set(connection, within ? new Set(awarenessClients(update) ?? []) : new Set());
    },

    /**
     * The library hands an update a client sent straight to Yjs, whatever it
     * holds. Checked here first (src/lib/collab/state.ts says why); what does
     * not pass closes the connection to the document, and is neither applied,
     * nor acknowledged, nor sent to anyone. The first step of a
     * synchronisation carries no update.
     *
     * THE LIMIT OF MESSAGES (the owner's decision of 12 October 2026; a row to
     * be added to NFR-SE-07) is taken first, so that a message past it costs
     * neither the reading of its update nor the check of the document's
     * limits, which copies a document that is at its limit for every message
     * (src/lib/collab/state.ts). The library calls this hook for the two
     * messages that carry an update and for the first step, and for nothing
     * else (@hocuspocus/server 4.7.0, MessageReceiver.ts, `readSyncMessage`):
     * awareness, which a cursor sends many times a second, never comes here.
     * A read-only connection is counted too: the hook runs before the library
     * looks at the flag.
     *
     * AND NOTHING MORE IS DONE FOR A READ-ONLY CONNECTION. The library applies
     * nothing it sends (MessageReceiver.ts tests the flag before each of the
     * two), so there is nothing to check; and a check of what is never applied
     * would let a Viewer cost the copy of a document at its limit, and leave
     * the keeper's numbers higher than the document with every message. The
     * library tests the flag only after this hook has returned, so the flag
     * must not turn to editable while a message of the connection is in
     * flight, or an update that was not checked would be applied: the re-check
     * waits for the connection's messages before it makes it editable
     * (`recheckOnce`).
     *
     * Counted for the user and not for the connection: a count on the
     * connection begins again with the next one, and a user may hold as many
     * as the limit of handshakes lets through, 30 more each minute. Past the
     * limit the connection that sent the message is closed with the reason of
     * a limit; the client waits before it asks for the document again
     * (src/lib/collab/protocol.ts).
     */
    async beforeSync({ type, payload, document, documentName, context, connection }) {
      if (type === messageYjsSyncStep1) return;
      if (!takeMessage(context.userId).ok) {
        void logMessageLimitReached(context.userId);
        throw refuse(REFUSAL.LIMITED);
      }
      if (connection.readOnly) return;
      let past: Limit | Shape | null;
      try {
        assertUpdate(payload);
        // The limits of a document (src/lib/collab/state.ts): an update that
        // would take it past one is not applied either. Asked of the keeper of
        // this document, which copies the document only when it must; nothing
        // is awaited between its answer and the library's applying the update.
        let limits = keepers.get(document);
        if (!limits) keepers.set(document, (limits = limitsOf(document)));
        // Then the shape (src/lib/collab/shape.ts; register D170, D171, D180),
        // of an update inside the limits, so that one the limits refuse costs
        // nothing more. One the shape refuses was counted by the keeper as let
        // through, which leaves its numbers higher than the document: a
        // measure, and nothing else.
        past = limits(payload) ?? shapeOf(document, payload);
      } catch {
        // An object, which the library reads a close code from, and with no
        // message for it to print: what Yjs throws can quote the update.
        throw {};
      }
      if (past) {
        // NFR-SE-19, as the owner amended it on 12 October 2026: a kind of its
        // own, with the user and the document and nothing of the update. One
        // for each period, not for each refusal: the client can send it again.
        void logDocumentLimitRefused(context.userId, documentName);
        // The client is told which limit, and does not send the same again
        // (src/lib/collab/protocol.ts).
        // One reason for each limit, so that the words the page shows are true.
        // A rule of the shape is logged as a limit is: NFR-SE-19 has no kind of
        // its own for it, and its list is closed.
        throw refuse(
          {
            size: REFUSAL.TOO_LARGE,
            depth: REFUSAL.TOO_DEEP,
            waiting: REFUSAL.TOO_DANGLING,
            incomplete: REFUSAL.INCOMPLETE,
            table: REFUSAL.TABLE_BOUNDS,
            image: REFUSAL.IMAGE_ATTRIBUTES,
            footnote: REFUSAL.FOOTNOTE_ATTRIBUTES,
            leaf: REFUSAL.LEAF_CONTENT,
            raw: REFUSAL.RAW_CONTENT,
            ...LIMIT_REFUSAL,
          }[past],
        );
      }
    },

    /**
     * NFR-RE-07. It never rejects: the library prints what a store rejects
     * with, and then holds the document without trying again. A store that
     * fails is reported once and tried again by `retryStore`; while that runs
     * there is nothing for this to do, but to tell it that there is more to
     * store.
     */
    async onStoreDocument({ documentName, document }) {
      const retry = retrying.get(documentName);
      if (retry) {
        retry.skipped = true;
        return;
      }
      try {
        // False for a deleted document, to which nothing is written (FR-ED-36)
        // but once, by `endDocument`.
        await storeNow(storeState, documentName, document);
      } catch (error) {
        fault('store', error);
        const state = { skipped: false };
        retrying.set(documentName, state);
        void retryStore(documentName, document, state);
      }
    },

    // A document whose store is being tried again stays in memory, whoever
    // leaves it: there is nowhere else its changes are.
    async beforeUnloadDocument({ documentName }) {
      if (retrying.has(documentName)) return answered();
    },
  });

  /**
   * One loop for each document whose store failed, whatever number of stores
   * the library asks for meanwhile: it waits longer after each failure
   * (`storeRetryDelay`), stores the state as it is when it tries, and says so
   * once when a store succeeds. The first failure was reported by the caller.
   */
  async function retryStore(documentName: string, document: Document, state: { skipped: boolean }) {
    let whileStopping = stopping ? 1 : 0;
    for (let failures = 1; ; failures++) {
      if (whileStopping >= STORE_ATTEMPTS_WHEN_STOPPING) {
        unstored = true;
        break;
      }
      await (stopping
        ? wait(STORE_RETRY_MS)
        : wait(storeRetryDelay(failures), undefined, { signal: halt.signal }).catch(() => {}));
      try {
        // Again at once where the library asked for a store while this one ran:
        // what it asked for may hold a change this one did not.
        do {
          state.skipped = false;
          await storeNow(storeState, documentName, document);
        } while (state.skipped);
        console.error('collab: store recovered');
        break;
      } catch {
        if (stopping) whileStopping++;
      }
    }
    retrying.delete(documentName);
    // What `beforeUnloadDocument` held back; it does nothing where a connection is open.
    void server.hocuspocus.unloadDocument(document);
  }

  // FR-ED-41: "at least once every 60 seconds". The timer keeps no process alive.
  const recheckTimer = setInterval(
    () => void recheck(),
    options.recheckMs ?? store.collabRecheckMs ?? RECHECK_MS,
  );
  recheckTimer.unref();

  /**
   * The orderly stop of NFR-RE-07: no new handshake and no new document; every
   * open document stored; then the sockets closed. True where every store
   * succeeded, and false where one did not or the deadline passed first.
   */
  function stop(deadlineMs = STOP_DEADLINE_MS): Promise<boolean> {
    stopping = true;
    clearInterval(recheckTimer);
    halt.abort();
    // No further event is acted on: the stop closes every connection itself.
    events?.client.disconnect();
    return (stopped ??= (async () => {
      const deadline = new AbortController();
      const stored = await Promise.race([
        // Closes the listener, tells every connection that it is closed, runs
        // each store that is waiting, and returns when no document is in memory.
        server.destroy().then(() => !unstored),
        wait(deadlineMs, undefined, { signal: deadline.signal }).then(
          () => {
            console.error('collab: stop failed (deadline)');
            return false;
          },
          // Stopped in time: the timer was put out below.
          () => false,
        ),
      ]);
      deadline.abort();
      for (const socket of sockets) socket.destroy();
      return stored;
    })());
  }

  return {
    httpServer: server.httpServer,
    hocuspocus: server.hocuspocus,
    /**
     * Subscribes this instance to the changes the web application publishes
     * (NFR-SE-03 (d)), once. The promise resolves when it first hears them.
     */
    listenForEvents: (): Promise<void> => (events ??= subscribeCollabEvents(onEvent)).subscribed,
    /** The connection of that subscription, for the tests. */
    eventsClient: () => events?.client,
    stop,
    /** How many handshakes are recorded and how many sockets are held, for the tests. */
    held: () => ({ handshakes: admitted.size, sockets: sockets.size }),
    /** How many deletions are remembered, for the tests. */
    remembered: () => ended.size,
    /** How many places a document holds, for the tests. */
    placesOf: (documentId: string) => places.count(documentId),
    /** One re-check, now, for the tests; it is the one the timer runs, and never overlaps itself. */
    recheck,
  };
}

if (import.meta.main) {
  assertContractVersion();
  // Refuses to start where a setting is absent or out of its bounds.
  const loaded = collabSettings();
  // Register D270: the sink is for a development machine, in this process as in the web application's.
  try {
    refuseSinkAwayFromDevelopment(loaded);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const collab = createCollabServer(loaded);
  let signalled = false;
  // FR-ED-40: it accepts no connection before it can be told to close one. An
  // instance that cannot reach Valkey therefore does not listen, and its
  // health check says so; it could admit no one either (NFR-SE-07).
  void collab.listenForEvents().then(() => {
    if (signalled) return;
    // On the loopback address unless COLLAB_HOST says otherwise: the proxy is the only way in (deployment.md, item 8).
    collab.httpServer.listen(Number(process.env.COLLAB_PORT ?? 1234), loaded.collabHost, () => {
      const address = collab.httpServer.address();
      console.log(
        // The address it bound to and the port, so that the log shows the bind (deployment.md, item 8).
        `collaboration server listening on ${typeof address === 'object' && address ? `${address.address}:${address.port}` : address}`,
      );
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // A second signal exits at once.
      if (signalled) process.exit(1);
      signalled = true;
      void collab.stop().then((stored) => process.exit(stored ? 0 : 1));
    });
  }
}
