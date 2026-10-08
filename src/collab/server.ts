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
import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { Server } from '@hocuspocus/server';
import { stoppedByFoundingGate } from '../lib/auth/founding-gate.ts';
import { validateSessionRow, type ValidSession } from '../lib/auth/session.ts';
import { isReadOnly, recordConnection, type CollabConnection } from '../lib/collab/connection.ts';
import { COLLAB_PATH, REFUSAL, type Refusal } from '../lib/collab/protocol.ts';
import { applyState, loadState, storeState } from '../lib/collab/state.ts';
import { db } from '../lib/db.ts';
import { authorise } from '../lib/documents/access.ts';
import { assertContractVersion } from '../lib/istorico/index.ts';
import { isOwnOrigin } from '../lib/origin.ts';
import { logLimitReached, takeLimit } from '../lib/rate-limit.ts';
import { securityLog } from '../lib/security-log.ts';
import { settings, type Settings } from '../lib/settings.ts';

export const HEALTH_PATH = '/collab/health';

type StoreSettings = Pick<Settings, 'collabStoreDelayMs' | 'collabStoreMaxMs'>;

// What the write itself may take and still be inside the period.
const STORE_WRITE_MARGIN_MS = 500;
// A store that failed is tried again after this long, for as long as the
// process runs; and this many times in all once the process is stopping.
const STORE_RETRY_MS = 1000;
const STORE_ATTEMPTS_WHEN_STOPPING = 3;

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
  let stopping = false;
  let unstored = false;
  let stopped: Promise<boolean> | undefined;

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
    // 403 is logged; there is no user to name yet.
    if (!isOwnOrigin(request.headers.origin)) {
      await securityLog({ kind: 'forbidden' });
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
      let outcome: ValidSession | Refused;
      try {
        outcome = await admit(request);
      } catch (error) {
        // NFR-SE-06, A10: where the database or Valkey cannot answer, the
        // handshake is refused, and the answer says nothing of the fault.
        fault('handshake', error);
        outcome = { status: 500 };
      }
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

    async onLoadDocument({ documentName, document }) {
      try {
        const state = await loadState(documentName);
        if (state) applyState(document, state);
      } catch (error) {
        fault('load', error);
        throw refuse(REFUSAL.UNAVAILABLE);
      }
    },

    /**
     * NFR-RE-07. It never rejects: the library prints what a store rejects
     * with, and then holds the document without trying again. A store that
     * fails is reported and tried again here, with the state as it then is,
     * and the document stays in memory meanwhile.
     */
    async onStoreDocument({ documentName, document }) {
      for (let attempt = 1; ; attempt++) {
        try {
          // False for a deleted document, to which nothing is written (FR-ED-36).
          await storeState(documentName, document);
          return;
        } catch (error) {
          fault('store', error);
          if (stopping && attempt >= STORE_ATTEMPTS_WHEN_STOPPING) {
            unstored = true;
            return;
          }
          await wait(STORE_RETRY_MS);
        }
      }
    },
  });

  /**
   * The orderly stop of NFR-RE-07: no new handshake and no new document; every
   * open document stored; then the sockets closed. True where every store
   * succeeded.
   */
  function stop(): Promise<boolean> {
    stopping = true;
    return (stopped ??= (async () => {
      // Closes the listener, tells every connection that it is closed, runs
      // each store that is waiting, and returns when no document is in memory.
      await server.destroy();
      for (const socket of sockets) socket.destroy();
      return !unstored;
    })());
  }

  return { httpServer: server.httpServer, hocuspocus: server.hocuspocus, stop };
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
