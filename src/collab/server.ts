// The collaboration server process: the Hocuspocus server of FR-ED-15 and
// FR-ED-16, its handshake (FR-AU-08; NFR-SE-03, lead paragraph, (a) and (f);
// NFR-SE-07), and the storing of a document's state (NFR-RE-07).
//
// What a client must know of it is in src/lib/collab/protocol.ts.
//
// NOT HERE YET, and so true of this process until the slice that ends and
// switches connections is built (NFR-SE-03 (b) to (e), FR-ED-40, FR-ED-41): a
// connection that was accepted outlives a sign-out, a revoked or expired
// session, the loss of the role, a change of the role, and the deletion of
// the document. Each is refused at the next handshake, and none ends a
// connection that is open. Nor is there a limit of connections for a document
// (NFR-PE-05), presence (FR-ED-17), or a second instance (NFR-SC-04).
//
// CARRIED FORWARD from the review of this slice, for the slices named:
// - Presence (slice 14). The library takes awareness from a read-only
//   connection and sends it to every other connection of the document: a
//   Viewer can show the others any name and any cursor. Nothing reads
//   awareness yet; the slice that does decides what a connection may say of
//   itself, in `beforeHandleAwareness`.
// - Deletion (slices 12 and 15). The deletion of a document must close its
//   connections here. Today they stay open, and what they change is received
//   and never stored (FR-ED-36, in src/lib/collab/state.ts).
import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { Server, type Document } from '@hocuspocus/server';
import { messageYjsSyncStep1 } from 'y-protocols/sync';
import { stoppedByFoundingGate } from '../lib/auth/founding-gate.ts';
import { validateSessionRow, type ValidSession } from '../lib/auth/session.ts';
import { isReadOnly, recordConnection, type CollabConnection } from '../lib/collab/connection.ts';
import { COLLAB_PATH, REFUSAL, type Refusal } from '../lib/collab/protocol.ts';
import { applyState, assertUpdate, loadState, storeState } from '../lib/collab/state.ts';
import { db } from '../lib/db.ts';
import { authorise } from '../lib/documents/access.ts';
import { assertContractVersion } from '../lib/istorico/index.ts';
import { isOwnOrigin } from '../lib/origin.ts';
import { logLimitReached, markKey, oncePer, takeLimit } from '../lib/rate-limit.ts';
import { securityLog } from '../lib/security-log.ts';
import { settings, type Settings } from '../lib/settings.ts';

export const HEALTH_PATH = '/collab/health';

type StoreSettings = Pick<Settings, 'collabStoreDelayMs' | 'collabStoreMaxMs'>;

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
// The mark of that period for a refused origin, kept as every such mark is (src/lib/rate-limit.ts).
const ORIGIN_REFUSED = 'collab:origin-refused';

/** How long after the `failures`-th failure in a row a store is tried again: 1 s, 2 s, 4 s … 60 s. */
export function storeRetryDelay(failures: number): number {
  return Math.min(STORE_RETRY_MS * 2 ** (failures - 1), STORE_RETRY_MAX_MS);
}

/** The Valkey key that marks the period in which a refused origin was logged (see `logRefusedOrigin`). */
export function originRefusalMark(): string {
  return markKey(ORIGIN_REFUSED);
}

/** True once for each period, by this process's own clock. */
function oncePerHere(seconds: number): () => boolean {
  let last = -Infinity;
  return () => {
    const now = Date.now();
    if (now - last < seconds * 1000) return false;
    last = now;
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

export function createCollabServer(store: StoreSettings) {
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
  let stopping = false;
  let unstored = false;
  let stopped: Promise<boolean> | undefined;

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
    // cookie is handed on.
    const { session } = await validateSessionRow(new Headers({ cookie: request.headers.cookie ?? '' }));
    if (!session) return { status: 401 };
    const { userId } = session;

    // (d) NFR-SE-07: handshakes, for each authenticated user. After the origin
    // check, so that a page on another origin cannot spend a user's limit.
    const limit = await takeLimit('HANDSHAKES_PER_USER', userId);
    if (!limit.ok) {
      await logLimitReached('HANDSHAKES_PER_USER', userId, limit.retryAfterSeconds, userId);
      return { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } };
    }

    // (e) FR-AU-83: an account of the founding team without two-factor
    // authentication reaches no collaboration handshake. The row is read at
    // each handshake; the list is the process's own setting.
    const account = await db().user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true, twoFactorEnabled: true },
    });
    if (!account) return { status: 401 };
    if (stoppedByFoundingGate(account)) {
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

    async onRequest({ request, response }) {
      // NFR-SE-05 (c): reports whether the service is up and returns nothing else.
      const up = request.method === 'GET' && request.url === HEALTH_PATH;
      response.writeHead(up ? 200 : 404, { 'Cache-Control': 'no-store' }).end();
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
          'Cache-Control: no-store',
          ...Object.entries(outcome.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
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
     */
    async beforeSync({ type, payload }) {
      if (type === messageYjsSyncStep1) return;
      try {
        assertUpdate(payload);
      } catch {
        // An object, which the library reads a close code from, and with no
        // message for it to print: what Yjs throws can quote the update.
        throw {};
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
        // False for a deleted document, to which nothing is written (FR-ED-36).
        await storeState(documentName, document);
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
          await storeState(documentName, document);
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
    stop,
    /** How many handshakes are recorded and how many sockets are held, for the tests. */
    held: () => ({ handshakes: admitted.size, sockets: sockets.size }),
  };
}

if (import.meta.main) {
  assertContractVersion();
  // Refuses to start where a setting is absent or out of its bounds.
  const collab = createCollabServer(settings());
  collab.httpServer.listen(Number(process.env.COLLAB_PORT ?? 1234), () => {
    const address = collab.httpServer.address();
    console.log(`collaboration server listening on ${typeof address === 'object' ? address?.port : address}`);
  });
  let signalled = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // A second signal exits at once.
      if (signalled) process.exit(1);
      signalled = true;
      void collab.stop().then((stored) => process.exit(stored ? 0 : 1));
    });
  }
}
