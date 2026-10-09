// The editor's side of the collaboration connection (FR-ED-15, FR-ED-18,
// FR-ED-22 to FR-ED-24, FR-ED-41): one connection for one open document, what
// it does about each refusal of src/lib/collab/protocol.ts, and the state the
// sync status indicator shows.
//
// Nothing here is of React or of the browser: the page hands it the address of
// the socket and a way to ask the application about the document, and a test
// hands it Node's WebSocket.
import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { documentName, REFUSAL } from './protocol.ts';

/** The refusals after which the client does not try again (FR-ED-41; src/lib/collab/protocol.ts). */
export type Ending = typeof REFUSAL.NO_ACCESS | typeof REFUSAL.ACCESS_ENDED | typeof REFUSAL.SESSION_ENDED;

const ENDINGS: readonly string[] = [REFUSAL.NO_ACCESS, REFUSAL.ACCESS_ENDED, REFUSAL.SESSION_ENDED];

/**
 * - `opening`: no state of the document has arrived yet.
 * - `connected`: the socket is open and the document has been synchronised.
 * - `restoring`: the connection was lost or refused for now, and is being tried again (FR-ED-18).
 * - `lost`: it has not come back within the period of FR-ED-23; the editor is read-only.
 * - `capacity`: refused at the limit of ten connections (FR-ED-18), tried again every 30 seconds.
 * - `ended`: refused for good; `ending` says why. The connection is gone.
 */
export type Phase = 'opening' | 'connected' | 'restoring' | 'lost' | 'capacity' | 'ended';

export interface ConnectionState {
  phase: Phase;
  ending?: Ending;
  /** The document's state has arrived at least once: there is something to edit. */
  opened: boolean;
  /** Changes the server has not acknowledged, which are lost if the tab is closed (FR-ED-18). */
  unsent: boolean;
}

/** FR-ED-18: "tries again no more often than once in 30 seconds". */
export const CAPACITY_RETRY_MS = 30_000;
// How long the verification of FR-ED-24 waits for the server's answer. The
// requirement names no period; it is this module's.
const VERIFY_MS = 5000;
// The server pings every 30 seconds (docs/operations/deployment.md): a socket
// that has been silent for this long is taken for dead and opened again.
const SILENCE_MS = 45_000;

/**
 * How long to wait before the `attempt`-th new try after a refusal, or null
 * where the refusal will not change and the client does not try again.
 *
 * - no access, access ended, session ended: never (FR-ED-41).
 * - capacity: every 30 seconds (FR-ED-18).
 * - limited: "after a pause, never at once", longer each time "up to a
 *   minute, which is the period of the limit" (src/lib/collab/protocol.ts).
 * - unavailable, and a reason that is not listed, which is a fault: 1 second,
 *   then twice as long each time, and at least every 30 seconds.
 */
export function retryDelay(reason: string, attempt: number): number | null {
  if (ENDINGS.includes(reason)) return null;
  if (reason === REFUSAL.CAPACITY) return CAPACITY_RETRY_MS;
  const [first, most] = reason === REFUSAL.LIMITED ? [5000, 60_000] : [1000, 30_000];
  return Math.min(first * 2 ** (attempt - 1), most);
}

export interface ConnectionOptions {
  /** The address of the socket: the application's own origin and `COLLAB_PATH`. */
  url: string;
  documentId: string;
  /** FR-ED-23: how long a lost connection is tried before the error state (`COLLAB_ERROR_AFTER_MS`). */
  errorAfterMs: number;
  /**
   * Asks the application about the document, and resolves with the status of
   * its answer, or 0 where none arrived. A handshake that is refused as a
   * whole is an HTTP status a page is never shown, so the reason is asked for
   * here: 401 is no session, and 404 no document for this account.
   */
  probe: () => Promise<number>;
  /** For a client that is not a browser. */
  WebSocketPolyfill?: unknown;
}

export class DocumentConnection {
  /** The document the editor is bound to. What it holds unacknowledged goes with it (FR-ED-41). */
  readonly document = new Y.Doc();
  private state: ConnectionState = { phase: 'opening', opened: false, unsent: false };
  private readonly listeners = new Set<() => void>();
  // Both are made by `start`, and neither is used before it.
  private socket!: HocuspocusProviderWebsocket;
  private provider!: HocuspocusProvider;
  private started = false;
  private readonly options: ConnectionOptions;
  private lostTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private refusals = 0;

  /** Opens nothing: `start` does. */
  constructor(options: ConnectionOptions) {
    this.options = options;
  }

  /** Opens the connection. After `stop` it opens a new one, for the same document. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { options } = this;
    this.state = { phase: 'opening', opened: this.state.opened, unsent: false };
    this.socket = new HocuspocusProviderWebsocket({
      url: options.url,
      messageReconnectTimeout: SILENCE_MS,
      ...(options.WebSocketPolyfill ? { WebSocketPolyfill: options.WebSocketPolyfill } : {}),
      // FR-ED-18: a lost socket is opened again by the library, after 1 second
      // and then twice as long each time, at least every 30 seconds.
      onStatus: ({ status }) => {
        if (status === WebSocketStatus.Disconnected) this.dropped();
      },
    });
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: documentName(options.documentId),
      document: this.document,
      // Presence is another slice's (FR-ED-17): nothing is said of this client.
      awareness: null,
      onSynced: () => this.connected(),
      onAuthenticationFailed: ({ reason }) => this.refused(reason),
      // The close of this document's connection on a socket that stays open.
      // The close of the socket itself is `dropped`, by its status.
      onClose: ({ event }) => {
        if (this.socket.status === WebSocketStatus.Connected) this.refused(event.reason);
      },
      onUnsyncedChanges: ({ number }) => this.set({ unsent: number > 0 }),
    });
    this.provider.attach();
    this.expectConnection();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ConnectionState => this.state;

  private set(change: Partial<ConnectionState>): void {
    if (this.state.phase === 'ended') return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** FR-ED-23: the error state, where no connection is made within the period. */
  private expectConnection(): void {
    if (this.lostTimer || this.state.phase === 'lost') return;
    this.lostTimer = setTimeout(() => {
      this.lostTimer = undefined;
      this.set({ phase: 'lost' });
    }, this.options.errorAfterMs);
  }

  private clearTimers(): void {
    clearTimeout(this.lostTimer);
    clearTimeout(this.retryTimer);
    this.lostTimer = this.retryTimer = undefined;
  }

  private connected(): void {
    this.clearTimers();
    this.refusals = 0;
    this.set({ phase: 'connected', opened: true });
  }

  /** The server refused this document, or closed its connection, with a reason. */
  private refused(reason: string): void {
    if (this.state.phase === 'ended') return;
    const delay = retryDelay(reason, ++this.refusals);
    if (delay === null) return this.end(reason as Ending);
    clearTimeout(this.retryTimer);
    if (reason === REFUSAL.CAPACITY) {
      // FR-ED-18: "neither the reconnecting state nor the error state".
      clearTimeout(this.lostTimer);
      this.lostTimer = undefined;
      this.set({ phase: 'capacity' });
    } else {
      if (this.state.phase !== 'lost') this.set({ phase: 'restoring' });
      this.expectConnection();
    }
    // The socket is open: the document is asked for again on it.
    this.retryTimer = setTimeout(() => {
      this.provider.detach();
      this.provider.attach();
    }, delay);
  }

  /** The socket closed, or could not be opened. The library opens it again. */
  private dropped(): void {
    if (this.state.phase === 'ended') return;
    clearTimeout(this.retryTimer);
    if (this.state.phase !== 'lost') this.set({ phase: 'restoring' });
    this.expectConnection();
    // FOR THE SLICE THAT BUILDS SHARING (slice 13): the socket that the library
    // opens next carries whatever session cookie the browser holds then. Once a
    // document can have two accounts, a tab opened by one could resume as
    // another, with the first account's unsent changes in it. This probe is
    // where the page learns of the account again: it should then answer whose
    // session it is, and a session of another account should end the
    // connection as an ended session does, before anything is sent.
    void this.options.probe().then(
      (status) => {
        if (status === 401) this.end(REFUSAL.SESSION_ENDED);
        // No document for this account now: one that was open has ended, and
        // one that never opened was never there (FR-ED-41; the answer to Q8).
        if (status === 404) this.end(this.state.opened ? REFUSAL.ACCESS_ENDED : REFUSAL.NO_ACCESS);
      },
      () => {},
    );
  }

  /** FR-ED-41: no further try, and nothing kept of what the server had not acknowledged. */
  private end(ending: Ending): void {
    if (this.state.phase === 'ended') return;
    this.set({ phase: 'ended', ending, unsent: false });
    this.stop();
  }

  /**
   * FR-ED-24: the working version against the server's. Both ways of the
   * synchronisation are run again and the server's acknowledgement awaited:
   * true where it arrives, and false where there is no connection or no
   * answer in time.
   */
  async verify(timeoutMs = VERIFY_MS): Promise<boolean> {
    const acknowledged = () =>
      new Promise<boolean>((resolve) => {
        if (this.provider.unsyncedChanges === 0) return resolve(true);
        const done = (answer: boolean) => {
          clearTimeout(timer);
          this.provider.off('unsyncedChanges', heard);
          resolve(answer);
        };
        const heard = ({ number }: { number: number }) => {
          if (number === 0) done(true);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        this.provider.on('unsyncedChanges', heard);
      });
    if (this.state.phase !== 'connected' || !(await acknowledged())) return false;
    this.provider.forceSync();
    return (await acknowledged()) && this.state.phase === 'connected';
  }

  /** Closes the connection, and tries nothing further. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearTimers();
    this.provider.destroy();
    // FR-ED-41: "shall not attempt to reconnect". After a socket closes, the
    // library (4.7.0) opens the next one from a timer that its `destroy` does
    // not clear, and that call says again that a connection is wanted. So the
    // socket that is being put away is left nothing to call.
    this.socket.connect = () => Promise.resolve();
    this.socket.destroy();
  }
}

// The words of the sync status indicator. FR-ED-22 to FR-ED-24 and FR-ED-18
// say what each state must tell and give no wording, so these are written
// under the Expression Guidelines (system feedback) and approved by the owner
// with the pull request (the answer to Q6 of the plan).
const UNSENT = 'Changes that are not yet sent are lost if this tab is closed.';

/**
 * FR-ED-23, and the owner's decision E3 of 8 October 2026: one of the three
 * states, and its words. A connection that is being restored is the syncing
 * state, "with words that say the connection is being restored"; and while
 * there are changes the server has not acknowledged, the words say that they
 * are lost if the tab is closed (FR-ED-18). `capacity` and `ended` are shown
 * by a statement and not by the indicator.
 */
export function syncStatus({ phase, unsent }: ConnectionState): {
  state: 'synced' | 'syncing' | 'error';
  label: string;
} {
  const tail = unsent ? ` ${UNSENT}` : '';
  switch (phase) {
    case 'connected':
      return unsent
        ? { state: 'syncing', label: `Syncing. ${UNSENT}` }
        : { state: 'synced', label: 'In sync' };
    case 'opening':
      return { state: 'syncing', label: 'Opening the document' };
    case 'lost':
      return {
        state: 'error',
        label: `Not connected. The document is read-only until the connection returns.${tail}`,
      };
    default:
      return {
        state: 'syncing',
        label: `Restoring the connection. Changes are kept in this tab and are sent when the connection returns.${tail}`,
      };
  }
}
