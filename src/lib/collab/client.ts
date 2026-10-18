// The editor's side of the collaboration connection (FR-ED-15, FR-ED-18,
// FR-ED-22 to FR-ED-24, FR-ED-41): one connection for one open document, what
// it does about each refusal of src/lib/collab/protocol.ts, and the state the
// sync status indicator shows.
//
// Nothing here is of React or of the browser: the page hands it the address of
// the socket and a way to ask the application about the document, and a test
// hands it Node's WebSocket.
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  MessageType,
  WebSocketStatus,
} from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { documentName, LIMIT_REFUSAL, readRoleNotice, REFUSAL, type RoleNotice } from './protocol.ts';

/** The refusals after which the client does not try again (FR-ED-41; src/lib/collab/protocol.ts). */
export type Ending = typeof REFUSAL.NO_ACCESS | typeof REFUSAL.ACCESS_ENDED | typeof REFUSAL.SESSION_ENDED;

const ENDINGS: readonly string[] = [REFUSAL.NO_ACCESS, REFUSAL.ACCESS_ENDED, REFUSAL.SESSION_ENDED];

/**
 * The refusals of what this client sent, for a limit of the document (the
 * owner's decision of 12 October 2026; src/lib/collab/protocol.ts) or for a
 * rule of its shape (register D170, D171, D180, D184, D192, D193). The
 * client does not try again either, since it would send the same; but the
 * text stays.
 */
export type Held =
  | typeof REFUSAL.TOO_LARGE
  | typeof REFUSAL.TOO_DEEP
  | typeof REFUSAL.TOO_DANGLING
  | typeof REFUSAL.INCOMPLETE
  | typeof REFUSAL.TABLE_BOUNDS
  | (typeof LIMIT_REFUSAL)[keyof typeof LIMIT_REFUSAL];

const HELD: readonly string[] = [
  REFUSAL.TOO_LARGE,
  REFUSAL.TOO_DEEP,
  REFUSAL.TOO_DANGLING,
  REFUSAL.INCOMPLETE,
  REFUSAL.TABLE_BOUNDS,
  ...Object.values(LIMIT_REFUSAL),
];
// The code a socket is closed with for a message longer than it takes (RFC
// 6455, "Message Too Big"; `MAX_MESSAGE_BYTES` of src/lib/collab/state.ts):
// what this client sent was longer than the largest document.
const MESSAGE_TOO_BIG = 1009;

/**
 * - `opening`: no state of the document has arrived yet.
 * - `connected`: the socket is open and the document has been synchronised.
 * - `restoring`: the connection was lost or refused for now, and is being tried again (FR-ED-18).
 * - `lost`: it has not come back within the period of FR-ED-23; the editor is read-only.
 * - `capacity`: refused at the limit of ten connections (FR-ED-18), tried again every 30 seconds.
 * - `ended`: refused for good; `ending` says why. The connection is gone.
 * - `held`: the server refused what this tab sent, for a limit of the document; `held` says
 *   which. The connection is gone and is not tried again; the text stays, read-only.
 */
export type Phase = 'opening' | 'connected' | 'restoring' | 'lost' | 'capacity' | 'ended' | 'held';

export interface ConnectionState {
  phase: Phase;
  ending?: Ending;
  held?: Held;
  /** The document's state has arrived at least once: there is something to edit. */
  opened: boolean;
  /**
   * FR-ED-40 (b): the last change of role the server told this client of, with
   * whether the connection may now edit. Absent until one arrives: then the
   * role is the one the page was opened with.
   */
  notice?: RoleNotice;
  /**
   * Whether this connection may edit, as the server last said: its scope at
   * every handshake, and the role it tells of after. It is read at each
   * (re)connection, so a role that changed while the socket was lost is the
   * connection's from the moment it is back. Absent until the first handshake:
   * then it is what the page was opened with.
   */
  canEdit?: boolean;
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

// HOW OFTEN THE EDITOR SENDS (the owner's decision of 12 October 2026). The
// server counts 600 messages that carry an update, for each account, in any
// minute (`COLLAB_MESSAGES_PER_USER`), and a key held down repeats up to 30
// times a second. The sending is a bucket of tokens: a message costs one, a
// token returns every BATCH_MS, and the bucket holds BURST_MESSAGES.
// - A change is sent at once while the bucket holds a token, so typing keeps
//   the budget of SRS 2.4 for "Yjs sync propagation to collaborator" (P50
//   under 150 ms, P99 under 400 ms): a burst of 8 keys, and 4 keys a second
//   for as long as that lasts, wait for nothing.
// - With no token, the changes that come are merged into one message, which
//   the library (`flushDelay`, @hocuspocus/provider 4.7.0) sends BATCH_MS
//   after the first of them; by then a token has returned. A change waits
//   250 ms at most.
// - A key held at 30 a second is 8 messages at once and then 4 a second. In
//   any period of L seconds a tab sends at most BURST_MESSAGES + 4 L update
//   messages: 8 + 240 = 248 in a minute, and 496 for two tabs of one account,
//   under the 600. No pattern of keys passes it, however it oscillates around
//   a rate: the bound is the bucket's, and not an observed rate. The two
//   steps of a synchronisation, sent when a connection opens, are charged to
//   the bucket as they leave and come on top.
export const BATCH_MS = 250;
export const BURST_MESSAGES = 8;

/**
 * How long to wait before the `attempt`-th new try after a refusal, or null
 * where the refusal will not change and the client does not try again.
 *
 * - no access, access ended, session ended: never (FR-ED-41).
 * - too large, too deep: never. The client would send the same and be refused the same.
 * - capacity: every 30 seconds (FR-ED-18).
 * - limited: "after a pause, never at once", longer each time "up to a
 *   minute, which is the period of the limit" (src/lib/collab/protocol.ts).
 * - unavailable, and a reason that is not listed, which is a fault: 1 second,
 *   then twice as long each time, and at least every 30 seconds.
 */
export function retryDelay(reason: string, attempt: number): number | null {
  if (ENDINGS.includes(reason) || HELD.includes(reason)) return null;
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
  // What the tab last showed of the role: the editability of the first handshake, and what each
  // statement of a change said (the role is known once the server has told it). A handshake or a
  // notice that differs from it is a change of role the writer is told of (FR-ED-40 (b)).
  private shown: { canEdit: boolean; role?: RoleNotice['role'] } | undefined;
  private readonly options: ConnectionOptions;
  private lostTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private refusals = 0;
  // The bucket of tokens (above), refilled when it is looked at.
  private tokens = BURST_MESSAGES;
  private tokensAt = Date.now();
  // Changes are merged into a batch that the library sends BATCH_MS after the first of them.
  private waiting = false;

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
    this.shown = undefined;
    this.waiting = false;
    this.socket = new HocuspocusProviderWebsocket({
      url: options.url,
      messageReconnectTimeout: SILENCE_MS,
      ...(options.WebSocketPolyfill ? { WebSocketPolyfill: options.WebSocketPolyfill } : {}),
      // FR-ED-18: a lost socket is opened again by the library, after 1 second
      // and then twice as long each time, at least every 30 seconds.
      onStatus: ({ status }) => {
        if (status === WebSocketStatus.Disconnected) this.dropped();
      },
      // The socket was closed for the length of a message: a change longer
      // than the largest document, which the next socket would be sent again.
      onClose: ({ event }) => {
        if (event.code === MESSAGE_TOO_BIG) this.hold(REFUSAL.TOO_LARGE);
      },
    });
    this.provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: documentName(options.documentId),
      document: this.document,
      // FR-ED-17: the library's own awareness, which carries this client's
      // cursor. What peers are told of this client is not what it says: the
      // server holds the name and the slot (src/lib/collab/presence.ts).
      // Switches the library's batching on. `changed` sends a change at once while the bucket allows it.
      flushDelay: BATCH_MS,
      onOutgoingMessage: ({ message }) => this.sending(message.type),
      // FR-ED-40 (b): the server says that the role of this connection changed.
      onStateless: ({ payload }) => this.told(payload),
      // The scope of each handshake, the one after a lost socket included (FR-ED-40 (b), FR-ED-41).
      onAuthenticated: ({ scope }) => this.authenticated(scope),
      onSynced: () => this.connected(),
      onAuthenticationFailed: ({ reason }) => this.refused(reason),
      // The close of this document's connection on a socket that stays open.
      // The close of the socket itself is `dropped`, by its status.
      onClose: ({ event }) => {
        if (this.socket.status === WebSocketStatus.Connected) this.refused(event.reason);
      },
      // Read after `changed` has placed the change in a batch or sent it.
      onUnsyncedChanges: () => queueMicrotask(() => this.refreshUnsent()),
    });
    this.provider.attach();
    // After the library's own handler, which has placed the change in a batch.
    this.document.on('update', this.changed);
    // The last change before the tab goes is not held back for its batch.
    // `pagehide` is the end of a page; `visibilitychange` to hidden is the
    // last event that some browsers give a page that is closed on a phone.
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.flush);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.hidden);
    this.expectConnection();
  }

  /** Sends what waits in a batch, now: for a tab that is closed or hidden, and for a check. */
  private flush = (): void => {
    this.provider?.flushPendingUpdates();
  };

  private hidden = (): void => {
    if (document.visibilityState === 'hidden') this.flush();
  };

  /** A change of this tab's document: sent at once while the bucket holds a token, else left to the batch. */
  private changed = (_update: Uint8Array, origin: unknown): void => {
    if (origin === this.provider) return;
    this.refill();
    if (this.tokens >= 1) this.flush();
    else this.waiting = true;
  };

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(BURST_MESSAGES, this.tokens + Math.max(0, now - this.tokensAt) / BATCH_MS);
    this.tokensAt = now;
  }

  /** Each message of a synchronisation that leaves costs a token: a batch, an update, a step. */
  private sending(type: MessageType | undefined): void {
    if (type !== MessageType.Sync) return;
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
    this.waiting = false;
    this.refreshUnsent();
  }

  /**
   * FR-ED-18: changes the server has not acknowledged. A batch that only
   * waits its 250 ms is not one of them while the connection is up, or the
   * indicator would turn to "syncing" at every pause in typing. The library
   * counts one for a batch, and one for each message sent.
   */
  private refreshUnsent(): void {
    const waits = this.waiting && this.state.phase === 'connected' ? 1 : 0;
    const unsent = this.provider.unsyncedChanges - waits > 0;
    if (unsent !== this.state.unsent) this.set({ unsent });
  }

  /** What the server said, as a stateless message: the one kind there is, a change of role. Anything else is ignored. */
  private told(payload: string): void {
    const notice = readRoleNotice(payload);
    if (!notice) return;
    const { shown } = this;
    const differs =
      shown !== undefined &&
      (shown.canEdit !== notice.canEdit || (shown.role !== undefined && shown.role !== notice.role));
    const wasEditable = this.state.canEdit;
    this.shown = { canEdit: notice.canEdit, role: notice.role };
    this.set(differs ? { notice, canEdit: notice.canEdit } : { canEdit: notice.canEdit });
    // Where the connection may edit again, what it holds that the server dropped
    // while it could not (a change not yet acknowledged when the role was taken)
    // is sent now: the server applies a later change only once the earlier ones
    // it depends on have arrived, so without this nothing written after the
    // change of role would ever be applied. After a reconnection the library
    // synchronises by itself.
    if (notice.canEdit && wasEditable === false && this.started) this.provider.forceSync();
  }

  /**
   * The server accepted the connection, at the first handshake and at each
   * the library makes after a lost socket: its scope says whether it may edit
   * now (FR-ED-40 (b), FR-ED-41). The tab follows that and not the role it
   * was opened with, which a change made while the socket was lost has
   * outdated, in either direction. A statement that was made before the
   * connection was lost and no longer holds is taken away; the server then
   * tells the role (`connected` of src/collab/server.ts), and the statement is
   * made where it differs from what the tab showed.
   */
  private authenticated(scope: string): void {
    const canEdit = scope === 'read-write';
    const stale = this.shown !== undefined && this.shown.canEdit !== canEdit;
    this.shown ??= { canEdit };
    this.set(stale ? { canEdit, notice: undefined } : { canEdit });
  }

  /** FR-ED-17: where the cursors of the others are read from, and this client's own is set. Null before `start`. */
  get awareness(): Awareness | null {
    return this.provider?.awareness ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): ConnectionState => this.state;

  /** Nothing further is tried or shown as changing: the connection is put away. */
  private over(): boolean {
    return this.state.phase === 'ended' || this.state.phase === 'held';
  }

  private set(change: Partial<ConnectionState>): void {
    if (this.over()) return;
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
    if (this.over()) return;
    if (HELD.includes(reason)) return this.hold(reason as Held);
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
    // The socket is open: the document is asked for again on it, as the
    // library asks when a socket opens. Not by its `detach` and `attach`: the
    // first tells the server to close a connection the server no longer has,
    // and the server (@hocuspocus/server 4.7.0, ClientConnection.ts) keeps what
    // arrives for a document that is not open and hands it to the connection
    // made next, which that message then closes, with the client left
    // synchronised to a server that hears nothing from it.
    this.retryTimer = setTimeout(() => {
      const opened = this.socket.receivedOnOpenPayload;
      if (opened) void this.provider.onOpen(opened);
    }, delay);
  }

  /** The socket closed, or could not be opened. The library opens it again. */
  private dropped(): void {
    if (this.over()) return;
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
    if (this.over()) return;
    this.set({ phase: 'ended', ending, unsent: false });
    this.stop();
  }

  /**
   * The server refused what this tab sent, for a limit of the document. No
   * further try: the same would be sent and refused, a minute's worth of
   * handshakes at a time. The document stays in the tab with the change in
   * it, for the text to be copied, and nothing of it is sent again.
   */
  private hold(held: Held): void {
    if (this.over()) return;
    this.set({ phase: 'held', held });
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
    this.flush();
    if (this.state.phase !== 'connected' || !(await acknowledged())) return false;
    this.provider.forceSync();
    return (await acknowledged()) && this.state.phase === 'connected';
  }

  /** Closes the connection, and tries nothing further. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearTimers();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.flush);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.hidden);
    this.document.off('update', this.changed);
    // The library sends what is waiting when it is destroyed (4.7.0, `destroy`).
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
 * are lost if the tab is closed (FR-ED-18). `capacity`, `ended` and `held` are
 * shown by a statement and not by the indicator.
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
        label: `Not connected. The document is read-only until the connection returns. Check the connection. Ekdotico tries again automatically.${tail}`,
      };
    default:
      return {
        state: 'syncing',
        label: `Restoring the connection. Ekdotico keeps changes in this tab and sends them when the connection returns.${tail}`,
      };
  }
}
