// The collaboration server process: the Hocuspocus server of FR-ED-15 and
// FR-ED-16, its handshake (FR-AU-08; NFR-SE-03, lead paragraph, (a) and (f);
// NFR-SE-07), and the storing of a document's state (NFR-RE-07).
//
// What a client must know of it is in src/lib/collab/protocol.ts.
//
// NOT HERE YET, and so true of this process until the slice that ends and
// switches connections is built (NFR-SE-03 (b) to (e), FR-ED-40, FR-ED-41): a
// connection that was accepted outlives a sign-out, a revoked or expired
// session, the loss of the role, and a change of the role. Each is refused at
// the next handshake, and none ends a connection that is open. Nor is there a
// limit of connections for a document (NFR-PE-05), presence (FR-ED-17), or a
// second instance (NFR-SC-04).
//
// HERE of FR-ED-40: event (c), the deletion of a document. Every instance is
// told of it on the channel of src/lib/collab/events.ts, reads the document's
// row, and where the row says so stores what it had received and closes its
// connections to the document (`endDocument`). The channel can lose a
// notice, and the re-check that would then close the connection (FR-ED-41) is
// not built yet: until it is, a connection whose notice was lost stays open,
// and what it changes is received and never stored.
//
// CARRIED FORWARD from the review of this slice, for the slices named:
// - Presence (slice 14). The library takes awareness from a read-only
//   connection and sends it to every other connection of the document: a
//   Viewer can show the others any name and any cursor. Nothing reads
//   awareness yet; the slice that does decides what a connection may say of
//   itself, in `beforeHandleAwareness`.
import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { Server, type Document } from '@hocuspocus/server';
import { messageYjsSyncStep1 } from 'y-protocols/sync';
import { validateSessionRow, type ValidSession } from '../lib/auth/session.ts';
import { isReadOnly, recordConnection, type CollabConnection } from '../lib/collab/connection.ts';
import {
  subscribeCollabEvents,
  type CollabEvent,
  type CollabEventSubscription,
} from '../lib/collab/events.ts';
import { COLLAB_PATH, LIMIT_REFUSAL, REFUSAL, type Refusal } from '../lib/collab/protocol.ts';
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
import { authorise } from '../lib/documents/access.ts';
import { faultOf } from '../lib/fault.ts';
import { assertContractVersion } from '../lib/istorico/index.ts';
import { isOwnOrigin } from '../lib/origin.ts';
import { limitHere, logLimitReached, markKey, oncePer, takeLimit } from '../lib/rate-limit.ts';
import { securityLog } from '../lib/security-log.ts';
import { settings, type Settings } from '../lib/settings.ts';

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
type ServerSettings = StoreSettings & { limits: Pick<Settings['limits'], 'COLLAB_MESSAGES_PER_USER'> };

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

export function createCollabServer(store: ServerSettings) {
  const messages = store.limits.COLLAB_MESSAGES_PER_USER;
  // The messages each user has sent this instance (see `beforeSync`).
  const takeMessage = limitHere(messages);
  const messageLogDueHere = oncePerHere(messages.windowSeconds);
  // The session each accepted handshake presented, by its handle, for as long
  // as its socket lives.
  const admitted = new Map<string, ValidSession>();
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

  function closeDocument(documentId: string, reason: Refusal): void {
    const document = server.hocuspocus.documents.get(documentId);
    for (const connection of document?.getConnections() ?? []) {
      connection.close({ code: 1000, reason });
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

  /** What this instance does for each event of the channel: one case for each kind of FR-ED-40 that is built. */
  async function onEvent(event: CollabEvent): Promise<void> {
    if (stopping) return;
    if (event.kind === 'document-deleted') await endDocument(event.documentId);
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

  const server = new Server<CollabConnection>({
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
      admitted.set(handle, outcome);
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
      const session = admitted.get(requestHeaders.get(HANDLE_HEADER) ?? '');
      // No record of a handshake, or the process is stopping: nothing is opened.
      if (!session || stopping) throw refuse(REFUSAL.UNAVAILABLE);

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
      // (i) NFR-SE-03 (a): what is recorded for the connection.
      const connection = recordConnection(session, access.document, access.role);
      // (h) The library discards every update it receives on a read-only connection.
      connectionConfig.readOnly = isReadOnly(connection);
      return connection;
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
    async onLoadDocument({ documentName, document }) {
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
      throw refuse(REFUSAL.UNAVAILABLE);
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
     * the keeper's numbers higher than the document with every message.
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

  /**
   * The orderly stop of NFR-RE-07: no new handshake and no new document; every
   * open document stored; then the sockets closed. True where every store
   * succeeded, and false where one did not or the deadline passed first.
   */
  function stop(deadlineMs = STOP_DEADLINE_MS): Promise<boolean> {
    stopping = true;
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
  };
}

if (import.meta.main) {
  assertContractVersion();
  // Refuses to start where a setting is absent or out of its bounds.
  const collab = createCollabServer(settings());
  let signalled = false;
  // FR-ED-40: it accepts no connection before it can be told to close one. An
  // instance that cannot reach Valkey therefore does not listen, and its
  // health check says so; it could admit no one either (NFR-SE-07).
  void collab.listenForEvents().then(() => {
    if (signalled) return;
    collab.httpServer.listen(Number(process.env.COLLAB_PORT ?? 1234), () => {
      const address = collab.httpServer.address();
      console.log(
        `collaboration server listening on ${typeof address === 'object' ? address?.port : address}`,
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
